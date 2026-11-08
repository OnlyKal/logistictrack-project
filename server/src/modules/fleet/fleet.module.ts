/** Chauffeurs, véhicules et tournées. */
import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Module, NotFoundException, Param, Patch, Post, Put, Query, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { AuditService, SequenceService } from '../../common/core.services.js'
import { LimitsService } from '../../common/limits.service.js'
import { AllowDriver, assertWarehouse, Ctx, DriverOnly, FinishesMission, RequirePerm, warehouseScope, type TenantContext } from '../../common/context.js'
import { money, Msg, optDate, paged, patchOf, parsePage, qty, uuid, zod } from '../../common/http.js'
import { PrismaService } from '../../common/prisma.service.js'
import { SUBSCRIPTION_USABLE, subscriptionStatus, VEHICLE_TYPES } from '../../common/constants.js'
import { DeliveriesModule } from '../deliveries/deliveries.module.js'
import { DeliveriesService } from '../deliveries/deliveries.service.js'

const driverFields = {
  fullName: z.string().trim().min(2).max(190), phone: z.string().trim().min(6).max(40), address: z.string().trim().max(190).nullish(),
  idDocument: z.string().trim().max(120).nullish(), licenseNumber: z.string().trim().max(60).nullish(), licenseClasses: z.string().trim().max(60).nullish(),
  licenseExpiry: optDate, warehouseId: uuid.nullish(), status: z.enum(['available', 'on_mission', 'off_duty', 'inactive', 'suspended']).optional(),
}
const driverCreate = z.object({ ...driverFields, email: z.string().trim().toLowerCase().email().nullish(), password: z.string().min(8).max(200) })
const driverPatch = z.object(driverFields).partial()

@Controller('drivers')
export class DriversController {
  constructor(private readonly prisma: PrismaService, private readonly limits: LimitsService, private readonly seq: SequenceService, private readonly audit: AuditService, private readonly deliveries: DeliveriesService) {}

  private async owned(ctx: TenantContext, id: string) {
    const d = await this.prisma.driver.findFirst({ where: { id, companyId: ctx.companyId, deletedAt: null } })
    if (!d) throw new NotFoundException('Chauffeur introuvable.')
    return d
  }
  private async checkWarehouse(ctx: TenantContext, warehouseId?: string | null) {
    if (warehouseId && !(await this.prisma.warehouse.findFirst({ where: { id: warehouseId, companyId: ctx.companyId } }))) throw new NotFoundException('Entrepôt introuvable.')
  }

  /** Profil du chauffeur et règles de preuve de son entreprise, utilisables hors connexion. */
  @DriverOnly() @Get('me')
  async me(@Ctx() ctx: TenantContext) {
    const [driver, settings, subscription] = await Promise.all([this.owned(ctx, ctx.driverId!), this.prisma.companySettings.findUnique({ where: { companyId: ctx.companyId } }), this.limits.subscription(ctx.companyId)])
    return {
      ...driver,
      rules: {
        subscriptionActive: !subscription || SUBSCRIPTION_USABLE.includes(subscriptionStatus(subscription)),
        driversCanRefuse: settings?.driversCanRefuse ?? true, requireSignature: settings?.requireSignature ?? false, requirePhoto: settings?.requirePhoto ?? false,
        requireRecipientName: settings?.requireRecipientName ?? false, requireGpsOnProof: settings?.requireGpsOnProof ?? false, requireQrOnLoad: settings?.requireQrOnLoad ?? false,
      },
    }
  }

  @DriverOnly() @Get('me/missions')
  missions(@Ctx() ctx: TenantContext, @Query('scope') scope = 'active') { return this.deliveries.missions(ctx, scope) }

  @DriverOnly() @Post('me/availability') @HttpCode(200)
  async availability(@Ctx() ctx: TenantContext, @Body(zod(z.object({ available: z.boolean() }))) body: { available: boolean }) {
    return this.prisma.driver.update({ where: { id: ctx.driverId! }, data: { status: body.available ? 'available' : 'off_duty' } })
  }

  @RequirePerm('driver.view', 'delivery.assign') @Get()
  async list(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.DriverWhereInput = {
      companyId: ctx.companyId, deletedAt: null, ...(p.status ? { status: p.status } : {}),
      ...(p.q ? { OR: [{ fullName: { contains: p.q } }, { phone: { contains: p.q } }, { code: { contains: p.q } }] } : {}),
    }
    const [items, total] = await Promise.all([
      this.prisma.driver.findMany({ where, skip: p.skip, take: p.take, orderBy: { fullName: 'asc' }, include: { warehouse: { select: { name: true } } } }),
      this.prisma.driver.count({ where }),
    ])
    return paged(items, total, p)
  }

  /** Le compte mobile du chauffeur est créé en même temps que sa fiche. */
  @RequirePerm('driver.manage') @Post() @Msg('Chauffeur créé.')
  async create(@Ctx() ctx: TenantContext, @Body(zod(driverCreate)) body: z.infer<typeof driverCreate>) {
    await this.limits.assertCanAdd(ctx.companyId, 'drivers')
    await this.checkWarehouse(ctx, body.warehouseId)
    const { email, password, ...fields } = body
    const hash = await bcrypt.hash(password, 12)
    return this.prisma.atomic(async (tx) => {
      const exists = await tx.user.findFirst({ where: { OR: [{ phone: body.phone }, ...(email ? [{ email }] : [])] } })
      if (exists) throw new ConflictException('Ce téléphone ou cet e-mail est déjà utilisé.')
      const user = await tx.user.create({ data: { fullName: body.fullName, phone: body.phone, email, passwordHash: hash } })
      await tx.companyMembership.create({ data: { companyId: ctx.companyId, userId: user.id, role: 'DRIVER', isActive: body.status !== 'inactive' && body.status !== 'suspended' } })
      const code = await this.seq.next(tx, ctx.companyId, 'driver', 'CHF')
      const driver = await tx.driver.create({ data: { ...fields, companyId: ctx.companyId, userId: user.id, code } })
      await this.audit.log(ctx, 'driver.create', 'Driver', driver.id, undefined, tx)
      return driver
    })
  }

  @RequirePerm('driver.view', 'delivery.assign') @Get(':id')
  async get(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    await this.owned(ctx, id)
    return this.prisma.driver.findUnique({
      where: { id },
      include: {
        warehouse: { select: { name: true } },
        deliveries: { take: 30, orderBy: { updatedAt: 'desc' }, select: { id: true, number: true, status: true, scheduledAt: true, deliveredAt: true, customer: { select: { name: true } } } },
      },
    })
  }

  @RequirePerm('driver.manage') @Patch(':id')
  async update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(driverPatch)) body: z.infer<typeof driverPatch>) {
    const driver = await this.owned(ctx, id)
    await this.checkWarehouse(ctx, body.warehouseId)
    const cutOff = body.status === 'inactive' || body.status === 'suspended'
    if (cutOff) {
      const running = await this.prisma.delivery.count({ where: { companyId: ctx.companyId, driverId: id, status: { in: ['ASSIGNED', 'LOADED', 'IN_TRANSIT', 'ARRIVED'] } } })
      if (running) throw new ConflictException(`Ce chauffeur a encore ${running} mission(s) en cours. Réaffectez-les ou clôturez-les d'abord.`)
    }
    return this.prisma.atomic(async (tx) => {
      // Le téléphone est l'identifiant de connexion : fiche et compte restent alignés.
      if (body.phone && body.phone !== driver.phone) {
        if (await tx.user.findFirst({ where: { phone: body.phone, id: { not: driver.userId } } })) throw new ConflictException('Ce téléphone est déjà utilisé.')
      }
      if (body.phone || body.fullName) await tx.user.update({ where: { id: driver.userId }, data: { phone: body.phone, fullName: body.fullName } })
      // Inactif ou suspendu : le chauffeur perd son accès tout de suite, et le retrouve à sa réactivation.
      if (body.status) {
        await tx.companyMembership.updateMany({ where: { companyId: ctx.companyId, userId: driver.userId }, data: { isActive: !cutOff } })
        if (cutOff) {
          await tx.userSession.updateMany({ where: { userId: driver.userId, revokedAt: null }, data: { revokedAt: new Date() } })
          await tx.trackingSession.updateMany({ where: { companyId: ctx.companyId, driverId: id, stoppedAt: null }, data: { stoppedAt: new Date() } })
        }
      }
      await this.audit.log(ctx, 'driver.update', 'Driver', id, { status: body.status }, tx)
      return tx.driver.update({ where: { id }, data: body })
    })
  }

  /** L'administrateur redonne l'accès à un chauffeur qui a oublié son mot de passe. */
  @RequirePerm('driver.manage') @Post(':id/reset-password') @HttpCode(200) @Msg('Mot de passe réinitialisé.')
  async resetPassword(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(z.object({ password: z.string().min(8).max(200) }))) body: { password: string }) {
    const driver = await this.owned(ctx, id)
    const passwordHash = await bcrypt.hash(body.password, 12)
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: driver.userId }, data: { passwordHash, failedLogins: 0, lockedUntil: null } }),
      this.prisma.userSession.updateMany({ where: { userId: driver.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ])
    await this.audit.log(ctx, 'driver.reset_password', 'Driver', id)
  }
}

const vehicleSchema = z.object({
  registration: z.string().trim().min(2).max(30), brand: z.string().trim().max(60).nullish(), model: z.string().trim().max(60).nullish(), type: z.enum(VEHICLE_TYPES),
  weightCapacityKg: qty.nullish(), volumeCapacityM3: qty.nullish(), insuranceExpiry: optDate, inspectionExpiry: optDate,
  status: z.enum(['available', 'in_use', 'maintenance', 'inactive']).optional(),
})
const maintenanceSchema = z.object({ description: z.string().trim().min(2).max(500), startedAt: z.coerce.date().optional(), finishedAt: optDate, cost: money.optional() })

@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly prisma: PrismaService, private readonly limits: LimitsService) {}

  private async owned(ctx: TenantContext, id: string) {
    const v = await this.prisma.vehicle.findFirst({ where: { id, companyId: ctx.companyId, deletedAt: null } })
    if (!v) throw new NotFoundException('Véhicule introuvable.')
    return v
  }

  @RequirePerm('vehicle.view', 'delivery.assign') @Get()
  async list(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.VehicleWhereInput = {
      companyId: ctx.companyId, deletedAt: null, ...(p.status ? { status: p.status } : {}),
      ...(p.q ? { OR: [{ registration: { contains: p.q } }, { brand: { contains: p.q } }] } : {}),
    }
    const [items, total] = await Promise.all([this.prisma.vehicle.findMany({ where, skip: p.skip, take: p.take, orderBy: { registration: 'asc' } }), this.prisma.vehicle.count({ where })])
    return paged(items, total, p)
  }

  @RequirePerm('vehicle.manage') @Post() @Msg('Véhicule créé.')
  async create(@Ctx() ctx: TenantContext, @Body(zod(vehicleSchema)) body: z.infer<typeof vehicleSchema>) {
    await this.limits.assertCanAdd(ctx.companyId, 'vehicles')
    return this.prisma.vehicle.create({ data: { ...body, companyId: ctx.companyId } })
  }

  @RequirePerm('vehicle.view') @Get(':id')
  async get(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    await this.owned(ctx, id)
    return this.prisma.vehicle.findUnique({ where: { id }, include: { documents: true, maintenance: { orderBy: { startedAt: 'desc' } } } })
  }

  @RequirePerm('vehicle.manage') @Patch(':id')
  async update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(patchOf(vehicleSchema))) body: Partial<z.infer<typeof vehicleSchema>>) {
    await this.owned(ctx, id)
    return this.prisma.vehicle.update({ where: { id }, data: body })
  }

  @RequirePerm('vehicle.manage') @Post(':id/maintenance') @Msg('Entretien enregistré.')
  async maintenance(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(maintenanceSchema)) body: z.infer<typeof maintenanceSchema>) {
    await this.owned(ctx, id)
    const [row] = await this.prisma.$transaction([
      this.prisma.vehicleMaintenance.create({ data: { ...body, vehicleId: id } }),
      this.prisma.vehicle.update({ where: { id }, data: { status: body.finishedAt ? 'available' : 'maintenance' } }),
    ])
    return row
  }
}

const routeSchema = z.object({
  plannedAt: z.coerce.date(), warehouseId: uuid, driverId: uuid, vehicleId: uuid, deliveryIds: z.array(uuid).min(1).max(100),
})
const ROUTE_INCLUDE = {
  driver: { select: { id: true, fullName: true, phone: true } }, vehicle: { select: { id: true, registration: true, type: true } }, warehouse: { select: { id: true, name: true, latitude: true, longitude: true } },
  stops: { orderBy: { position: 'asc' }, include: { delivery: { select: { id: true, number: true, status: true, customer: { select: { name: true } }, deliveryPoint: { select: { name: true, commune: true, latitude: true, longitude: true } } } } } },
} satisfies Prisma.RouteInclude
const TERMINAL = ['DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED']

@Controller('routes')
export class RoutesController {
  constructor(private readonly prisma: PrismaService, private readonly seq: SequenceService, private readonly deliveries: DeliveriesService, private readonly audit: AuditService) {}

  private async owned(ctx: TenantContext, id: string) {
    const scope = ctx.role === 'DRIVER' ? { driverId: ctx.driverId } : warehouseScope(ctx)
    const route = await this.prisma.route.findFirst({ where: { id, companyId: ctx.companyId, ...scope }, include: ROUTE_INCLUDE })
    if (!route) throw new NotFoundException('Tournée introuvable.')
    return route
  }

  /** Une livraison ne peut pas figurer sur deux tournées actives. */
  private async assertFree(tx: Prisma.TransactionClient, deliveryIds: string[], routeId?: string) {
    const clash = await tx.routeStop.findFirst({
      where: { deliveryId: { in: deliveryIds }, route: { status: { in: ['PLANNED', 'IN_PROGRESS'] }, ...(routeId ? { id: { not: routeId } } : {}) } },
      include: { delivery: { select: { number: true } } },
    })
    if (clash) throw new ConflictException(`La livraison ${clash.delivery.number} figure déjà sur une tournée active.`)
  }

  @RequirePerm('route.manage') @AllowDriver() @Get()
  async list(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const scope = ctx.role === 'DRIVER' ? { driverId: ctx.driverId } : warehouseScope(ctx)
    const where: Prisma.RouteWhereInput = { companyId: ctx.companyId, ...scope, ...(p.status ? { status: p.status } : {}) }
    const [items, total] = await Promise.all([this.prisma.route.findMany({ where, skip: p.skip, take: p.take, orderBy: { plannedAt: 'desc' }, include: ROUTE_INCLUDE }), this.prisma.route.count({ where })])
    return paged(items, total, p)
  }

  @RequirePerm('route.manage') @Post() @Msg('Tournée créée.')
  async create(@Ctx() ctx: TenantContext, @Body(zod(routeSchema)) body: z.infer<typeof routeSchema>) {
    assertWarehouse(ctx, body.warehouseId)
    const { route, assigned } = await this.prisma.atomic(async (tx) => {
      const wh = await tx.warehouse.findFirst({ where: { id: body.warehouseId, companyId: ctx.companyId } })
      if (!wh) throw new NotFoundException('Entrepôt introuvable.')
      await this.assertFree(tx, body.deliveryIds)
      const assigned = []
      for (const id of body.deliveryIds) assigned.push(await this.deliveries.assignTx(tx, ctx, id, { driverId: body.driverId, vehicleId: body.vehicleId }))
      const number = await this.seq.next(tx, ctx.companyId, 'route', 'TRN')
      const route = await tx.route.create({
        data: {
          companyId: ctx.companyId, number, plannedAt: body.plannedAt, warehouseId: body.warehouseId, driverId: body.driverId, vehicleId: body.vehicleId,
          stops: { create: body.deliveryIds.map((deliveryId, position) => ({ deliveryId, position: position + 1 })) },
          history: { create: { status: 'PLANNED', userId: ctx.userId } },
        },
        include: ROUTE_INCLUDE,
      })
      return { route, assigned }
    })
    await this.deliveries.afterBulkAssign(ctx, assigned)
    return route
  }

  @RequirePerm('route.manage') @AllowDriver() @Get(':id')
  get(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.owned(ctx, id) }

  /** Ordre de passage décidé par le gestionnaire (l'optimisation automatique n'est pas retenue). */
  @RequirePerm('route.manage') @Put(':id/stops')
  async reorder(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(z.object({ deliveryIds: z.array(uuid).min(1).max(100) }))) body: { deliveryIds: string[] }) {
    const route = await this.owned(ctx, id)
    if (route.status === 'DONE' || route.status === 'CANCELLED') throw new ConflictException('Cette tournée est terminée.')
    const current = route.stops.map((s) => s.deliveryId).sort()
    if (JSON.stringify(current) !== JSON.stringify([...body.deliveryIds].sort())) throw new UnprocessableEntityException("La liste doit contenir exactement les arrêts de la tournée.")
    await this.prisma.$transaction(body.deliveryIds.map((deliveryId, i) => this.prisma.routeStop.update({ where: { routeId_deliveryId: { routeId: id, deliveryId } }, data: { position: i + 1 } })))
    return this.owned(ctx, id)
  }

  @RequirePerm('route.manage') @Post(':id/stops') @Msg('Arrêt ajouté.')
  async addStop(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(z.object({ deliveryId: uuid }))) body: { deliveryId: string }) {
    const route = await this.owned(ctx, id)
    if (!['PLANNED', 'IN_PROGRESS'].includes(route.status)) throw new ConflictException('Cette tournée est terminée.')
    await this.prisma.atomic(async (tx) => {
      await this.assertFree(tx, [body.deliveryId])
      await this.deliveries.assignTx(tx, ctx, body.deliveryId, { driverId: route.driverId!, vehicleId: route.vehicleId! })
      await tx.routeStop.create({ data: { routeId: id, deliveryId: body.deliveryId, position: route.stops.length + 1 } })
    })
    return this.owned(ctx, id)
  }

  private assertOperator(ctx: TenantContext) {
    if (ctx.role === 'DRIVER' || ctx.permissions.has('route.manage')) return
    throw new ForbiddenException('Permission insuffisante.')
  }

  @RequirePerm('route.manage') @AllowDriver() @Post(':id/start') @HttpCode(200) @Msg('Tournée démarrée.')
  async start(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    this.assertOperator(ctx)
    const route = await this.owned(ctx, id)
    if (route.driverId) {
      const running = await this.prisma.route.findFirst({ where: { companyId: ctx.companyId, driverId: route.driverId, status: 'IN_PROGRESS', id: { not: id } }, select: { number: true } })
      if (running) throw new ConflictException({ message: `Ce chauffeur est déjà sur la tournée ${running.number}. Terminez-la avant d'en démarrer une autre.`, code: 'DRIVER_BUSY' })
      await this.prisma.$transaction((tx) => this.deliveries.assertSingleTrip(tx as never, ctx.companyId, route.driverId, null, id))
    }
    const r = await this.prisma.route.updateMany({ where: { id, status: 'PLANNED' }, data: { status: 'IN_PROGRESS', startedAt: new Date() } })
    if (r.count !== 1) throw new ConflictException('Cette tournée ne peut pas être démarrée.')
    await this.prisma.routeStatusHistory.create({ data: { routeId: id, status: 'IN_PROGRESS', userId: ctx.userId } })
    return this.owned(ctx, id)
  }

  @RequirePerm('route.manage') @AllowDriver() @FinishesMission('route') @Post(':id/finish') @HttpCode(200) @Msg('Tournée clôturée.')
  async finish(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    this.assertOperator(ctx)
    const route = await this.owned(ctx, id)
    const open = route.stops.filter((s) => !TERMINAL.includes(s.delivery.status))
    if (open.length) throw new ConflictException(`${open.length} livraison(s) restent à traiter sur cette tournée.`)
    const r = await this.prisma.route.updateMany({ where: { id, status: 'IN_PROGRESS' }, data: { status: 'DONE', finishedAt: new Date() } })
    if (r.count !== 1) throw new ConflictException("Cette tournée n'est pas en cours.")
    await this.prisma.routeStatusHistory.create({ data: { routeId: id, status: 'DONE', userId: ctx.userId } })
    await this.audit.log(ctx, 'route.finish', 'Route', id)
    return this.owned(ctx, id)
  }
}

@Module({ imports: [DeliveriesModule], controllers: [DriversController, VehiclesController, RoutesController] })
export class FleetModule {}
