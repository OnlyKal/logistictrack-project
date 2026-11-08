import { PublicTrackingService } from './public-tracking.service.js'
/**
 * Suivi GPS : le téléphone du chauffeur est le seul traceur. Seules les données réellement
 * émises sont conservées (aucune interpolation, aucune valeur inventée). Portail public de suivi.
 */
import { Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, Post, Query } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { RealtimeService } from '../../common/core.services.js'
import { LimitsService } from '../../common/limits.service.js'
import { Ctx, DriverOnly, FinishesMission, Public, RequirePerm, type TenantContext } from '../../common/context.js'
import { lat, lng, uuid, zod } from '../../common/http.js'
import { PrismaService } from '../../common/prisma.service.js'
import { DELIVERY_STATUS_LABELS, GPS_LIVE_SECONDS, type DeliveryStatus } from '../../common/constants.js'

const sessionStart = z.object({ deliveryId: uuid.optional(), routeId: uuid.optional(), startedAt: z.coerce.date().optional() }).refine((v) => v.deliveryId || v.routeId, 'Mission obligatoire.')
const position = z.object({
  clientId: z.string().min(8).max(64), latitude: lat, longitude: lng,
  accuracyM: z.coerce.number().min(0).max(100000).nullish(), speedMs: z.coerce.number().min(0).max(150).nullish(),
  headingDeg: z.coerce.number().min(0).max(360).nullish(), altitudeM: z.coerce.number().min(-1000).max(20000).nullish(),
  batteryLevel: z.coerce.number().int().min(0).max(100).nullish(), isOnline: z.boolean().nullish(), recordedAt: z.coerce.date(),
})
const batch = z.object({ sessionId: uuid, positions: z.array(position).min(1).max(500) })

/** Avant le départ : au retour du réseau, le téléphone envoie ses positions avant son opération de départ. Jamais après l'arrivée. */
const ACTIVE = ['ASSIGNED', 'LOADED', 'IN_TRANSIT']
const ENDED = ['ARRIVED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'FAILED', 'RETURNED']
/** Au-delà, une mesure trop imprécise ferait zigzaguer le tracé. Elle reste enregistrée, mais hors de la ligne. */
const TRAIL_MAX_ACCURACY_M = 100

export function freshness(recordedAt: Date, now = Date.now()) {
  const age = Math.max(0, Math.round((now - recordedAt.getTime()) / 1000))
  return { ageSeconds: age, isLive: age <= GPS_LIVE_SECONDS }
}

@Injectable()
export class TrackingService {
  constructor(private readonly prisma: PrismaService, private readonly realtime: RealtimeService, private readonly limits: LimitsService, private readonly publicTracking: PublicTrackingService) {}

  /** Le suivi ne s'ouvre que pour un trajet affecté au chauffeur connecté. */
  async start(ctx: TenantContext, body: z.infer<typeof sessionStart>) {
    const subscription = await this.limits.subscription(ctx.companyId)
    if (subscription && !subscription.gpsEnabled) throw new ForbiddenException({ message: "Le suivi GPS n'est pas inclus dans votre abonnement.", code: 'GPS_NOT_INCLUDED' })
    if (body.deliveryId) {
      const d = await this.prisma.delivery.findFirst({ where: { id: body.deliveryId, companyId: ctx.companyId, driverId: ctx.driverId! } })
      if (!d) throw new ForbiddenException("Ce trajet n'est pas actif pour vous.")
      if (!ACTIVE.includes(d.status)) {
        const closed = await this.lateSession(ctx, d.id, d.status, body.startedAt)
        if (!closed) throw new ForbiddenException("Ce trajet n'est pas actif pour vous.")
        return closed
      }
    }
    if (body.routeId) {
      const r = await this.prisma.route.findFirst({ where: { id: body.routeId, companyId: ctx.companyId, driverId: ctx.driverId!, status: { in: ['PLANNED', 'IN_PROGRESS'] } } })
      if (!r) throw new ForbiddenException("Cette tournée n'est pas active pour vous.")
    }
    // Une seule session active par chauffeur : un téléphone ne suit pas plusieurs missions à la fois.
    const active = await this.prisma.trackingSession.findFirst({ where: { driverId: ctx.driverId!, stoppedAt: null } })
    if (active) return active
    // Après une période hors ligne, le suivi reprend à l'heure de démarrage réelle, sans date future ni trop ancienne.
    const now = Date.now()
    const startedAt = body.startedAt && body.startedAt.getTime() <= now && now - body.startedAt.getTime() <= 3 * 86400_000 ? body.startedAt : new Date(now)
    return this.prisma.trackingSession.create({ data: { companyId: ctx.companyId, driverId: ctx.driverId!, deliveryId: body.deliveryId, routeId: body.routeId, startedAt } })
  }

  /**
   * Téléphone resté hors ligne pendant que la mission s'est terminée (arrivée déclarée par le bureau, par exemple) :
   * les positions déjà mesurées sont conservées dans une session fermée d'emblée. Aucune position ultérieure n'est acceptée.
   */
  private async lateSession(ctx: TenantContext, deliveryId: string, status: string, startedAt?: Date) {
    if (!startedAt || !ENDED.includes(status)) return null
    const ended = await this.prisma.deliveryEvent.findFirst({ where: { deliveryId, type: { in: ['ARRIVED', 'FAILED'] } }, orderBy: { occurredAt: 'desc' } })
    if (!ended || startedAt >= ended.occurredAt || ended.occurredAt.getTime() - startedAt.getTime() > 3 * 86400_000) return null
    // Un nouvel essai du téléphone reprend la même session, élargie si besoin à ses positions plus anciennes.
    const existing = await this.prisma.trackingSession.findFirst({ where: { deliveryId, driverId: ctx.driverId!, stoppedAt: ended.occurredAt } })
    if (existing) return existing.startedAt <= startedAt ? existing : this.prisma.trackingSession.update({ where: { id: existing.id }, data: { startedAt } })
    return this.prisma.trackingSession.create({ data: { companyId: ctx.companyId, driverId: ctx.driverId!, deliveryId, startedAt, stoppedAt: ended.occurredAt } })
  }

  async stop(ctx: TenantContext, sessionId: string) {
    const r = await this.prisma.trackingSession.updateMany({ where: { id: sessionId, driverId: ctx.driverId!, stoppedAt: null }, data: { stoppedAt: new Date() } })
    return { stopped: r.count === 1 }
  }

  async ingest(ctx: TenantContext, body: z.infer<typeof batch>) {
    const session = await this.prisma.trackingSession.findFirst({ where: { id: body.sessionId, companyId: ctx.companyId, driverId: ctx.driverId! } })
    if (!session) throw new NotFoundException('Session de suivi introuvable.')
    const now = Date.now()
    const accepted = body.positions.filter((p) => {
      if (p.recordedAt.getTime() > now + 5 * 60_000) return false // Horloge incohérente : position écartée.
      // Après la fin de session, seules les positions mesurées avant l'arrêt (hors ligne) sont acceptées.
      if (session.stoppedAt && p.recordedAt > session.stoppedAt) return false
      return p.recordedAt >= session.startedAt
    })
    const existing = await this.prisma.gpsPosition.findMany({ where: { clientId: { in: accepted.map((p) => p.clientId) } }, select: { clientId: true } })
    const known = new Set(existing.map((e) => e.clientId))
    const fresh = [...new Map(accepted.filter((p) => !known.has(p.clientId)).map((p) => [p.clientId, p])).values()]
    let stored = 0
    if (fresh.length) {
      try {
        const r = await this.prisma.gpsPosition.createMany({ data: fresh.map((p) => ({ ...p, companyId: ctx.companyId, sessionId: session.id, driverId: session.driverId })) })
        stored = r.count
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err
      }
    }
    const latest = fresh.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())[0]
    if (latest) {
      this.realtime.toTracking(ctx.companyId, 'position.update', {
        driverId: session.driverId, sessionId: session.id, latitude: latest.latitude, longitude: latest.longitude, accuracyM: latest.accuracyM,
        speedMs: latest.speedMs, headingDeg: latest.headingDeg, batteryLevel: latest.batteryLevel, recordedAt: latest.recordedAt, ...freshness(latest.recordedAt),
        // Plusieurs positions reçues d'un coup (retour du réseau) : l'écran recharge le tracé complet.
        batch: fresh.length,
      })
      await this.publicTracking.publishPosition(session.driverId, latest, fresh.length).catch(() => undefined)
    }
    return { received: body.positions.length, stored, duplicates: known.size, rejected: body.positions.length - accepted.length, sessionActive: !session.stoppedAt }
  }

  /** Chauffeurs en mission et leur dernier signal, jamais présenté comme direct s'il est ancien. */
  async live(ctx: TenantContext) {
    const sessions = await this.prisma.trackingSession.findMany({
      where: { companyId: ctx.companyId, stoppedAt: null },
      include: { driver: { select: { id: true, fullName: true, phone: true } } },
    })
    const out = []
    for (const s of sessions) {
      const [last, deliveries, trail] = await Promise.all([
        this.prisma.gpsPosition.findFirst({ where: { sessionId: s.id }, orderBy: { recordedAt: 'desc' } }),
        this.prisma.delivery.findMany({
          where: { companyId: ctx.companyId, driverId: s.driverId, status: { in: ['LOADED', 'IN_TRANSIT', 'ARRIVED'] } },
          select: {
            id: true, number: true, status: true, vehicle: { select: { registration: true, type: true } }, customer: { select: { name: true } },
            deliveryPoint: { select: { name: true, address: true, commune: true, city: true, contactName: true, phone: true, latitude: true, longitude: true } },
            warehouse: { select: { name: true, address: true, latitude: true, longitude: true } },
          },
        }),
        // Tracé du trajet en cours : uniquement cette session, donc jamais après l'arrivée.
        this.prisma.gpsPosition.findMany({
          where: { sessionId: s.id, OR: [{ accuracyM: null }, { accuracyM: { lte: TRAIL_MAX_ACCURACY_M } }] }, orderBy: { recordedAt: 'asc' }, take: 5000,
          select: { latitude: true, longitude: true, recordedAt: true },
        }),
      ])
      out.push({
        sessionId: s.id, startedAt: s.startedAt, driver: s.driver, deliveries, position: last ? { ...last, ...freshness(last.recordedAt) } : null,
        trail: trail.map((p) => [p.latitude, p.longitude, p.recordedAt.getTime()]),
      })
    }
    return out
  }

  /** Chauffeurs arrivés, en attente de remise. Leur position n'est plus suivie : seule l'heure de l'arrivée est connue. */
  async onSite(ctx: TenantContext) {
    const rows = await this.prisma.delivery.findMany({
      where: { companyId: ctx.companyId, status: 'ARRIVED' }, orderBy: { updatedAt: 'desc' }, take: 100,
      select: {
        id: true, number: true, driver: { select: { id: true, fullName: true, phone: true } }, customer: { select: { name: true } }, deliveryPoint: { select: { name: true, commune: true } },
        events: { where: { type: 'ARRIVED' }, orderBy: { occurredAt: 'desc' }, take: 1, select: { occurredAt: true } },
      },
    })
    return rows.map(({ events, ...row }) => ({ ...row, arrivedAt: events[0]?.occurredAt ?? null }))
  }

  async driverPosition(ctx: TenantContext, driverId: string) {
    const last = await this.prisma.gpsPosition.findFirst({ where: { companyId: ctx.companyId, driverId }, orderBy: { recordedAt: 'desc' } })
    if (!last) throw new NotFoundException('Aucune position connue pour ce chauffeur.')
    return { ...last, ...freshness(last.recordedAt) }
  }

  private track(companyId: string, driverId: string, from: Date, to: Date) {
    return this.prisma.gpsPosition.findMany({
      where: { companyId, driverId, recordedAt: { gte: from, lte: to } },
      orderBy: { recordedAt: 'asc' },
      take: 10000,
      select: { latitude: true, longitude: true, accuracyM: true, speedMs: true, headingDeg: true, batteryLevel: true, recordedAt: true },
    })
  }

  async deliveryHistory(ctx: TenantContext, id: string) {
    const d = await this.prisma.delivery.findFirst({ where: { id, companyId: ctx.companyId } })
    if (!d) throw new NotFoundException('Livraison introuvable.')
    if (!d.driverId) return { positions: [] }
    // Heures réelles des événements, y compris hors ligne : le tracé s'arrête à l'arrivée ou à l'échec, jamais sur les trajets suivants.
    const started = await this.prisma.deliveryEvent.findFirst({ where: { deliveryId: id, type: 'STARTED' }, orderBy: { occurredAt: 'desc' } })
    if (!started) return { positions: [] }
    const ended = await this.prisma.deliveryEvent.findFirst({ where: { deliveryId: id, type: { in: ['ARRIVED', 'FAILED'] }, occurredAt: { gte: started.occurredAt } }, orderBy: { occurredAt: 'asc' } })
    return { positions: await this.track(ctx.companyId, d.driverId, started.occurredAt, ended?.occurredAt ?? new Date()) }
  }

  async routeHistory(ctx: TenantContext, id: string) {
    const r = await this.prisma.route.findFirst({ where: { id, companyId: ctx.companyId } })
    if (!r) throw new NotFoundException('Tournée introuvable.')
    if (!r.driverId || !r.startedAt) return { positions: [] }
    return { positions: await this.track(ctx.companyId, r.driverId, r.startedAt, r.finishedAt ?? new Date()) }
  }
}

@Controller('tracking')
export class TrackingController {
  constructor(private readonly svc: TrackingService) {}

  @DriverOnly() @FinishesMission('session') @Post('sessions/start') @HttpCode(200)
  start(@Ctx() ctx: TenantContext, @Body(zod(sessionStart)) body: z.infer<typeof sessionStart>) { return this.svc.start(ctx, body) }

  @DriverOnly() @FinishesMission('tracking') @Post('sessions/:id/stop') @HttpCode(200)
  stop(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.stop(ctx, id) }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @DriverOnly() @FinishesMission('tracking') @Post('positions') @HttpCode(200)
  positions(@Ctx() ctx: TenantContext, @Body(zod(batch)) body: z.infer<typeof batch>) { return this.svc.ingest(ctx, body) }

  @RequirePerm('tracking.view') @Get('drivers/live')
  live(@Ctx() ctx: TenantContext) { return this.svc.live(ctx) }

  @RequirePerm('tracking.view') @Get('on-site')
  onSite(@Ctx() ctx: TenantContext) { return this.svc.onSite(ctx) }

  @RequirePerm('tracking.view') @Get('drivers/:id/position')
  driver(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.driverPosition(ctx, id) }

  @RequirePerm('tracking.view') @Get('deliveries/:id')
  delivery(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.deliveryHistory(ctx, id) }

  @RequirePerm('tracking.view') @Get('routes/:id')
  route(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.routeHistory(ctx, id) }
}

/** Portail public : uniquement l'état et l'historique public, jamais de donnée interne. */
@Public()
@Controller('public/tracking')
export class PublicTrackingController {
  constructor(private readonly prisma: PrismaService, private readonly publicTracking: PublicTrackingService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('search') @HttpCode(200)
  async search(@Body(zod(z.object({ trackingNumber: z.string().trim().min(6).max(30) }))) body: { trackingNumber: string }) {
    const pack = await this.prisma.package.findUnique({ where: { trackingNumber: body.trackingNumber.toUpperCase() }, select: { trackingToken: true } })
    if (!pack) throw new NotFoundException('Aucun colis ne correspond à ce numéro de suivi.')
    return { token: pack.trackingToken }
  }

  /** Sans clé : l'état et les étapes. Avec la clé du lien reçu par e-mail : la carte en direct pendant le trajet. */
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @Get(':token')
  view(@Param('token') token: string, @Query('k') key?: string) {
    return this.publicTracking.view(token, key)
  }
}

@Module({ controllers: [TrackingController, PublicTrackingController], providers: [TrackingService, PublicTrackingService], exports: [PublicTrackingService] })
export class TrackingModule {}
