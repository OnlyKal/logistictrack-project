/**
 * Suivi public d'un colis, sans compte.
 *
 * Ce que voit le client, et seulement cela :
 * - l'état, les étapes et l'historique public de sa livraison ;
 * - avec le lien reçu par e-mail (clé signée), et uniquement pendant le trajet vers lui :
 *   la position du véhicule, le parcours depuis le départ vers sa destination, l'heure du dernier signal.
 *
 * Jamais : le nom, le téléphone ou la photo du chauffeur, l'immatriculation, les autres clients,
 * l'entrepôt de départ, les quantités, les prix ni les numéros internes.
 * Si le chauffeur livre d'abord d'autres clients, leur trajet et leur adresse restent invisibles.
 */
import { Injectable, NotFoundException } from '@nestjs/common'
import { DELIVERY_STATUS_LABELS, GPS_LIVE_SECONDS, type DeliveryStatus } from '../../common/constants.js'
import { FileService, RealtimeService } from '../../common/core.services.js'
import { isLiveKey } from '../../common/public-link.js'
import { PrismaService } from '../../common/prisma.service.js'

const TRAIL_MAX_ACCURACY_M = 100
const TRAIL_MAX_POINTS = 1500
const TERMINAL = ['DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED']
const STOP_EVENTS = ['ARRIVED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RECALLED']

/** Étapes montrées au client, dans l'ordre. */
const STEPS = [
  { key: 'REGISTERED', label: 'Commande enregistrée', events: ['CREATED'] },
  { key: 'PREPARED', label: 'Colis préparé', events: ['READY', 'LOADED'] },
  { key: 'IN_TRANSIT', label: 'En route', events: ['STARTED'] },
  { key: 'ARRIVED', label: 'Arrivé à destination', events: ['ARRIVED'] },
  { key: 'DELIVERED', label: 'Livré', events: ['DELIVERED', 'PARTIALLY_DELIVERED'] },
] as const

const STEP_OF: Record<string, number> = {
  DRAFT: 0, PENDING: 0, VALIDATED: 0, PREPARING: 0, READY: 1, ASSIGNED: 1, LOADED: 1, IN_TRANSIT: 2, ARRIVED: 3, DELIVERED: 4, PARTIALLY_DELIVERED: 4,
}

/** Ce que le client comprend, sans jargon interne. */
const PUBLIC_STATUS: Record<string, { label: string; hint: string }> = {
  DRAFT: { label: 'Commande enregistrée', hint: 'Votre commande est enregistrée. Elle sera bientôt préparée.' },
  PENDING: { label: 'Commande enregistrée', hint: 'Votre commande est enregistrée. Elle sera bientôt préparée.' },
  VALIDATED: { label: 'Commande validée', hint: 'Votre commande est validée et va être préparée.' },
  PREPARING: { label: 'En préparation', hint: "Votre colis est en cours de préparation à l'entrepôt." },
  READY: { label: 'Prêt au départ', hint: 'Votre colis est prêt. Il partira bientôt.' },
  ASSIGNED: { label: 'Prêt au départ', hint: 'Votre colis est prêt. Il partira bientôt.' },
  LOADED: { label: 'Chargé', hint: 'Votre colis est chargé dans le véhicule de livraison.' },
  IN_TRANSIT: { label: 'En route', hint: 'Votre colis est en route vers vous.' },
  ARRIVED: { label: 'Arrivé', hint: 'Le livreur est arrivé à destination.' },
  DELIVERED: { label: 'Livré', hint: 'Votre colis a été livré.' },
  PARTIALLY_DELIVERED: { label: 'Livré en partie', hint: "Votre colis a été livré en partie. L'expéditeur vous contactera pour le reste." },
  FAILED: { label: 'Livraison non effectuée', hint: "La livraison n'a pas pu avoir lieu. L'expéditeur va vous recontacter." },
  RETURNED: { label: "Retourné à l'expéditeur", hint: "Votre colis est retourné chez l'expéditeur, qui va vous recontacter." },
  CANCELLED: { label: 'Livraison annulée', hint: "Cette livraison a été annulée. Contactez l'expéditeur pour en savoir plus." },
}

function distanceKm(a: [number, number], b: [number, number]) {
  const rad = (v: number) => (v * Math.PI) / 180
  const dLat = rad(b[0] - a[0])
  const dLng = rad(b[1] - a[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(h))
}

/** Allège un long parcours sans en perdre la forme ni le dernier point. */
function thin<T>(points: T[], max: number) {
  if (points.length <= max) return points
  const step = points.length / max
  const out: T[] = []
  for (let i = 0; i < max - 1; i++) out.push(points[Math.floor(i * step)])
  out.push(points[points.length - 1])
  return out
}

export type LiveState = 'LIVE' | 'WAITING' | 'OTHER_STOP' | 'ARRIVED' | 'ENDED' | 'NOT_STARTED'

@Injectable()
export class PublicTrackingService {
  constructor(private readonly prisma: PrismaService, private readonly files: FileService, private readonly realtime: RealtimeService) {}

  /** Colis et livraison d'un jeton ; la clé n'ouvre la carte que si elle correspond à ce jeton. */
  async resolve(token: string, key?: unknown) {
    const pack = await this.prisma.package.findUnique({ where: { trackingToken: token }, select: { trackingNumber: true, deliveryId: true, companyId: true } })
    if (!pack) throw new NotFoundException('Lien de suivi invalide.')
    return { ...pack, live: isLiveKey(token, key) }
  }

  async view(token: string, key?: unknown) {
    const ref = await this.resolve(token, key)
    const pack = await this.prisma.package.findUniqueOrThrow({
      where: { trackingToken: token },
      select: {
        trackingNumber: true,
        company: { select: { id: true, tradeName: true, phone: true, email: true, logoFileId: true } },
        delivery: {
          select: {
            id: true, status: true, scheduledAt: true, deliveredAt: true, driverId: true, _count: { select: { packages: true } },
            deliveryPoint: { select: { name: true, commune: true, city: true, latitude: true, longitude: true } },
            events: { where: { isPublic: true }, orderBy: { occurredAt: 'asc' }, select: { type: true, label: true, occurredAt: true } },
          },
        },
      },
    })
    const d = pack.delivery
    const status = d?.status ?? 'DRAFT'
    const pub = PUBLIC_STATUS[status] ?? { label: DELIVERY_STATUS_LABELS[status as DeliveryStatus] ?? status, hint: '' }
    const events = d?.events ?? []
    const failed = ['FAILED', 'RETURNED', 'CANCELLED'].includes(status)
    const reached = failed ? Math.max(...events.map((e) => STEPS.findIndex((s) => (s.events as readonly string[]).includes(e.type))), 0) : STEP_OF[status] ?? 0
    const steps: Array<{ key: string; label: string; at: Date | null; state: string }> = STEPS.map((s, i) => {
      const at = [...events].reverse().find((e) => (s.events as readonly string[]).includes(e.type))?.occurredAt ?? null
      // Échec : les étapes atteintes restent validées, une dernière étape rouge explique la suite.
      const state = failed ? (i <= reached ? 'done' : 'todo') : i < reached || (i === reached && TERMINAL.includes(status)) ? 'done' : i === reached ? 'current' : 'todo'
      return { key: s.key, label: s.label, at: i <= reached ? at : null, state }
    })
    if (failed) steps.splice(reached + 1, steps.length, { key: status, label: pub.label, at: events.at(-1)?.occurredAt ?? null, state: 'failed' })

    const point = d?.deliveryPoint
    const hasCoords = point?.latitude != null && point?.longitude != null
    let logoUrl: string | null = null
    if (pack.company.logoFileId) {
      const signed = await this.files.signedUrl({ companyId: pack.company.id } as never, pack.company.logoFileId, 3600).catch(() => null)
      logoUrl = signed?.url ?? null
    }
    return {
      trackingNumber: pack.trackingNumber,
      company: { name: pack.company.tradeName, phone: pack.company.phone, email: pack.company.email, logoUrl },
      status, statusLabel: pub.label, statusHint: pub.hint,
      scheduledAt: d?.scheduledAt ?? null, deliveredAt: d?.deliveredAt ?? null, packages: d?._count.packages ?? 1,
      // Sans le lien reçu par e-mail : la commune seulement. Avec : le point exact, qui est celui du client.
      destination: point ? {
        label: ref.live ? [point.name, point.commune, point.city].filter(Boolean).join(', ') : [point.commune, point.city].filter(Boolean).join(', ') || null,
        latitude: ref.live && hasCoords ? Number(point.latitude) : null,
        longitude: ref.live && hasCoords ? Number(point.longitude) : null,
      } : null,
      steps,
      events: events.map((e) => ({ label: e.label, occurredAt: e.occurredAt })),
      live: ref.live,
      tracking: ref.live && d ? await this.liveTrack(d.id, status, d.driverId, hasCoords ? [Number(point!.latitude), Number(point!.longitude)] : null) : null,
      liveSeconds: GPS_LIVE_SECONDS,
    }
  }

  /** Début du trajet vers ce client : le départ, ou la fin du dernier arrêt chez un autre client. */
  private async legStart(deliveryId: string, driverId: string) {
    const started = await this.prisma.deliveryEvent.findFirst({ where: { deliveryId, type: 'STARTED' }, orderBy: { occurredAt: 'desc' } })
    if (!started) return null
    const otherStop = await this.prisma.deliveryEvent.findFirst({
      where: { type: { in: STOP_EVENTS }, occurredAt: { gte: started.occurredAt }, deliveryId: { not: deliveryId }, delivery: { driverId } },
      orderBy: { occurredAt: 'desc' },
    })
    return otherStop && otherStop.occurredAt > started.occurredAt ? otherStop.occurredAt : started.occurredAt
  }

  /** Le chauffeur est-il en ce moment chez un autre client ? Sa position révélerait alors une autre adresse. */
  private async atOtherStop(deliveryId: string, driverId: string) {
    return (await this.prisma.delivery.count({ where: { driverId, status: 'ARRIVED', id: { not: deliveryId } } })) > 0
  }

  private async stopsBefore(deliveryId: string) {
    const stop = await this.prisma.routeStop.findFirst({ where: { deliveryId, route: { status: 'IN_PROGRESS' } }, orderBy: { route: { plannedAt: 'desc' } } })
    if (!stop) return null
    return this.prisma.routeStop.count({ where: { routeId: stop.routeId, position: { lt: stop.position }, delivery: { status: { notIn: TERMINAL } } } })
  }

  private async liveTrack(deliveryId: string, status: string, driverId: string | null, destination: [number, number] | null) {
    const base = { position: null, trail: [] as Array<[number, number]>, stopsBefore: null as number | null, remainingKm: null as number | null, since: null as Date | null }
    if (status === 'ARRIVED') return { ...base, state: 'ARRIVED' as LiveState }
    if (TERMINAL.includes(status)) return { ...base, state: 'ENDED' as LiveState }
    if (status !== 'IN_TRANSIT' || !driverId) return { ...base, state: 'NOT_STARTED' as LiveState }
    const stopsBefore = await this.stopsBefore(deliveryId)
    if (await this.atOtherStop(deliveryId, driverId)) return { ...base, stopsBefore, state: 'OTHER_STOP' as LiveState }
    const since = await this.legStart(deliveryId, driverId)
    if (!since) return { ...base, stopsBefore, state: 'WAITING' as LiveState }
    const rows = await this.prisma.gpsPosition.findMany({
      where: { driverId, recordedAt: { gte: since }, OR: [{ accuracyM: null }, { accuracyM: { lte: TRAIL_MAX_ACCURACY_M } }] },
      orderBy: { recordedAt: 'asc' }, take: 20000,
      select: { latitude: true, longitude: true, headingDeg: true, speedMs: true, accuracyM: true, recordedAt: true },
    })
    const last = rows.at(-1)
    if (!last) return { ...base, stopsBefore, since, state: 'WAITING' as LiveState }
    const age = Math.max(0, Math.round((Date.now() - last.recordedAt.getTime()) / 1000))
    const here: [number, number] = [Number(last.latitude), Number(last.longitude)]
    return {
      state: 'LIVE' as LiveState, since, stopsBefore,
      position: { latitude: here[0], longitude: here[1], headingDeg: last.headingDeg, accuracyM: last.accuracyM, recordedAt: last.recordedAt, ageSeconds: age, isLive: age <= GPS_LIVE_SECONDS },
      trail: thin(rows.map((r) => [Number(r.latitude), Number(r.longitude)] as [number, number]), TRAIL_MAX_POINTS),
      remainingKm: destination ? Math.round(distanceKm(here, destination) * 10) / 10 : null,
    }
  }

  // ---------- Temps réel ----------

  /** Nouvelle position : envoyée aux pages publiques des livraisons vers lesquelles le chauffeur roule. */
  async publishPosition(driverId: string, p: { latitude: number; longitude: number; headingDeg?: number | null; accuracyM?: number | null; recordedAt: Date }, batch: number) {
    if (!this.realtime.server) return
    const active = await this.prisma.delivery.findMany({ where: { driverId, status: { in: ['IN_TRANSIT', 'ARRIVED'] } }, select: { id: true, status: true } })
    if (!active.length) return
    // Chez un autre client : aucune position ne part, les pages affichent « autre livraison en cours ».
    const busyElsewhere = active.some((d) => d.status === 'ARRIVED')
    const reliable = p.accuracyM == null || p.accuracyM <= TRAIL_MAX_ACCURACY_M
    for (const d of active) {
      if (d.status !== 'IN_TRANSIT') continue
      if (busyElsewhere || batch > 1 || !reliable) this.realtime.toPublicDelivery(d.id, 'public.refresh', {})
      else this.realtime.toPublicDelivery(d.id, 'public.position', { latitude: Number(p.latitude), longitude: Number(p.longitude), headingDeg: p.headingDeg ?? null, accuracyM: p.accuracyM ?? null, recordedAt: p.recordedAt })
    }
  }
}
