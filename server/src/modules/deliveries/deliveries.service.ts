import { publicTrackingUrl } from '../../common/public-link.js'
import { CustomerMailService } from './customer-mail.service.js'
import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import QRCode from 'qrcode'
import { z } from 'zod'
import { AuditService, FileService, NotificationService, RealtimeService, SequenceService } from '../../common/core.services.js'
import { LimitsService } from '../../common/limits.service.js'
import { assertWarehouse, deliveryWarehouseScope, warehouseScope, type TenantContext } from '../../common/context.js'
import { paged, parsePeriod, type PageQuery } from '../../common/http.js'
import { PrismaService, type Tx } from '../../common/prisma.service.js'
import { DELIVERY_STATUS_LABELS, DELIVERY_TRANSITIONS, type DeliveryStatus, RECALLED } from '../../common/constants.js'
import { D, opaqueToken, readableCode } from '../../common/util.js'
import { StockService, type Allocation } from '../stock/stock.service.js'
import type { assignSchema, confirmSchema, deliverySchema, failSchema, incidentSchema, opSchema, packageSchema, partialSchema, pickupSchema, proofSchema, rescheduleSchema, returnSchema, scanSchema, recallSchema } from './deliveries.schemas.js'

const ACTIVE_ON_VEHICLE: DeliveryStatus[] = ['ASSIGNED', 'LOADED', 'IN_TRANSIT', 'ARRIVED']
/** Le chauffeur reste occupé tant qu'il a l'une de ces missions, mais il n'est suivi que sur la route. */
const ON_MISSION: DeliveryStatus[] = ['LOADED', 'IN_TRANSIT', 'ARRIVED']
const STEP_ORDER: DeliveryStatus[] = ['ASSIGNED', 'LOADED', 'IN_TRANSIT', 'ARRIVED', 'PARTIALLY_DELIVERED', 'DELIVERED']
/** Étapes avant le chargement : le mode de remise et l'entrepôt de retrait y restent modifiables. */
const BEFORE_LOADING: DeliveryStatus[] = ['DRAFT', 'PENDING', 'VALIDATED', 'PREPARING', 'READY', 'ASSIGNED']

/** Entrepôt où se trouve la marchandise : l'entrepôt de départ, sauf si elle a été réceptionnée ailleurs pour un retrait. */
const location = (d: { warehouseId: string; heldAtWarehouseId: string | null }) => d.heldAtWarehouseId ?? d.warehouseId

export const DELIVERY_INCLUDE = {
  customer: { select: { id: true, name: true, code: true, phone: true } },
  deliveryPoint: true,
  warehouse: { select: { id: true, name: true, address: true, latitude: true, longitude: true } },
  pickupWarehouse: { select: { id: true, name: true, address: true, phone: true, latitude: true, longitude: true } },
  driver: { select: { id: true, fullName: true, phone: true } },
  vehicle: { select: { id: true, registration: true, type: true } },
  order: { select: { id: true, number: true } },
  items: { include: { product: { select: { id: true, name: true, reference: true, baseUnit: true } } } },
  packages: { include: { items: { include: { product: { select: { name: true, baseUnit: true } } } } } },
} satisfies Prisma.DeliveryInclude

type Op = z.infer<typeof opSchema>

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly prisma: PrismaService, private readonly seq: SequenceService, private readonly stock: StockService,
    private readonly audit: AuditService, private readonly notifications: NotificationService, private readonly realtime: RealtimeService,
    private readonly limits: LimitsService, private readonly files: FileService, private readonly customerMail: CustomerMailService,
  ) {}

  // ---------- Colis ----------

  async createPackage(ctx: TenantContext, body: z.infer<typeof packageSchema>) {
    assertWarehouse(ctx, body.warehouseId)
    return this.prisma.atomic(async (tx) => {
      const warehouse = await tx.warehouse.findFirst({ where: { id: body.warehouseId, companyId: ctx.companyId } })
      if (!warehouse) throw new NotFoundException('Entrepôt introuvable.')
      const order = body.orderId ? await tx.order.findFirst({ where: { id: body.orderId, companyId: ctx.companyId }, include: { items: true } }) : null
      if (body.orderId && !order) throw new NotFoundException('Commande introuvable.')
      if (order && order.warehouseId !== body.warehouseId) throw new ConflictException('Cette commande est préparée dans un autre entrepôt.')

      let weight = D(0)
      let volume = D(0)
      const lines: { productId: string; orderItemId?: string; quantity: number }[] = []
      for (const line of body.items) {
        const product = await tx.product.findFirst({ where: { id: line.productId, companyId: ctx.companyId, deletedAt: null } })
        if (!product) throw new NotFoundException('Produit introuvable.')
        weight = weight.plus(D(product.unitWeightKg).times(line.quantity))
        volume = volume.plus(D(product.unitVolumeM3).times(line.quantity))
        let orderItemId: string | undefined
        if (order) {
          const item = order.items.find((i) => i.id === line.orderItemId) ?? order.items.find((i) => i.productId === line.productId)
          if (!item || item.productId !== line.productId) throw new UnprocessableEntityException(`${product.name} ne figure pas dans la commande.`)
          if (item.quantityPackaged.plus(line.quantity).greaterThan(item.quantityPrepared)) {
            throw new UnprocessableEntityException(`Quantité en colis supérieure à la quantité préparée pour ${product.name}.`)
          }
          const moved = await tx.orderItem.updateMany({ where: { id: item.id, quantityPackaged: item.quantityPackaged }, data: { quantityPackaged: item.quantityPackaged.plus(line.quantity) } })
          if (moved.count !== 1) throw new ConflictException('Préparation modifiée entre-temps, veuillez réessayer.')
          item.quantityPackaged = item.quantityPackaged.plus(line.quantity)
          orderItemId = item.id
        }
        lines.push({ productId: line.productId, orderItemId, quantity: line.quantity })
      }
      return tx.package.create({
        data: {
          companyId: ctx.companyId, warehouseId: body.warehouseId, orderId: order?.id, unitType: body.unitType,
          trackingNumber: `LT${readableCode(10)}`, trackingToken: opaqueToken(), qrToken: opaqueToken(),
          weightKg: body.weightKg ?? (weight.isZero() ? null : weight), volumeM3: body.volumeM3 ?? (volume.isZero() ? null : volume),
          dimensions: body.dimensions, transportNote: body.transportNote, items: { create: lines },
        },
        include: { items: { include: { product: { select: { name: true, baseUnit: true } } } } },
      })
    })
  }

  async listPackages(ctx: TenantContext, p: PageQuery) {
    const where: Prisma.PackageWhereInput = {
      companyId: ctx.companyId, ...warehouseScope(ctx),
      ...(p.status ? { status: p.status } : {}), ...(p.orderId ? { orderId: String(p.orderId) } : {}),
      ...(p.unassigned === 'true' ? { deliveryId: null } : {}),
      ...(p.q ? { trackingNumber: { contains: p.q } } : {}),
    }
    const [items, total] = await Promise.all([
      this.prisma.package.findMany({
        where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' },
        include: { items: { include: { product: { select: { name: true, baseUnit: true } } } }, order: { select: { number: true } }, delivery: { select: { id: true, number: true, status: true } }, warehouse: { select: { name: true } } },
      }),
      this.prisma.package.count({ where }),
    ])
    return paged(items, total, p)
  }

  private async ownedPackage(ctx: TenantContext, id: string) {
    const pack = await this.prisma.package.findFirst({
      where: { id, companyId: ctx.companyId, ...warehouseScope(ctx) },
      include: { items: { include: { product: { select: { name: true, baseUnit: true } } } }, delivery: { select: { id: true, number: true, status: true, driverId: true } }, order: { select: { number: true } } },
    })
    if (!pack) throw new NotFoundException('Colis introuvable.')
    return pack
  }

  getPackage(ctx: TenantContext, id: string) {
    return this.ownedPackage(ctx, id)
  }

  /** QR Code : ne contient qu'un jeton opaque, jamais de données exploitables. */
  async packageQr(ctx: TenantContext, id: string) {
    const pack = await this.ownedPackage(ctx, id)
    return { trackingNumber: pack.trackingNumber, token: pack.qrToken, dataUrl: await QRCode.toDataURL(pack.qrToken, { margin: 1, width: 320 }) }
  }

  async packageTracking(ctx: TenantContext, id: string) {
    const pack = await this.ownedPackage(ctx, id)
    const events = pack.deliveryId ? await this.prisma.deliveryEvent.findMany({ where: { deliveryId: pack.deliveryId }, orderBy: { occurredAt: 'asc' } }) : []
    return { package: pack, events }
  }

  async scan(ctx: TenantContext, body: z.infer<typeof scanSchema>) {
    const pack = await this.prisma.package.findFirst({
      where: { qrToken: body.token, companyId: ctx.companyId },
      include: { items: { include: { product: { select: { name: true, baseUnit: true } } } }, delivery: { select: { id: true, number: true, status: true, driverId: true, pickupWarehouseId: true, heldAtWarehouseId: true } } },
    })
    if (!pack) throw new NotFoundException('QR Code inconnu pour cette entreprise.')
    if (ctx.driverId && pack.delivery?.driverId !== ctx.driverId) throw new ForbiddenException('Ce colis ne fait pas partie de vos missions.')
    // Retrait : l'entrepôt de retrait scanne aussi les colis qu'il reçoit et remet au client.
    const sites = [pack.warehouseId, pack.delivery?.pickupWarehouseId, pack.delivery?.heldAtWarehouseId]
    if (!ctx.driverId && !sites.some((w) => w && ctx.warehouseIds?.includes(w))) assertWarehouse(ctx, pack.warehouseId)
    if (body.action === 'VIEW') return pack
    if (!pack.deliveryId || !pack.delivery) throw new ConflictException("Ce colis n'est rattaché à aucune livraison.")
    if (body.deliveryId && body.deliveryId !== pack.deliveryId) throw new ConflictException('Ce colis appartient à une autre livraison.')
    const data = body.action === 'LOAD' ? { loadScannedAt: pack.loadScannedAt ?? new Date() } : { deliverScannedAt: pack.deliverScannedAt ?? new Date() }
    await this.prisma.package.update({ where: { id: pack.id }, data })
    await this.prisma.deliveryEvent.create({
      data: {
        companyId: ctx.companyId, deliveryId: pack.deliveryId, type: `SCAN_${body.action}`,
        label: `Colis ${pack.trackingNumber} scanné (${body.action === 'LOAD' ? 'chargement' : 'remise'})`, userId: ctx.userId,
        latitude: body.latitude, longitude: body.longitude, clientOpId: body.clientOpId, occurredAt: body.occurredAt ?? new Date(),
      },
    }).catch((err) => {
      // Rejeu hors ligne : le même scan déjà reçu est ignoré.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err
    })
    return { ...pack, ...data }
  }

  // ---------- Livraisons : lecture ----------

  /** Un chauffeur ne voit que ses missions ; les autres profils restent dans leur périmètre d'entrepôts. */
  private scope(ctx: TenantContext): Prisma.DeliveryWhereInput {
    if (ctx.driverId && ctx.role === 'DRIVER') return { companyId: ctx.companyId, driverId: ctx.driverId }
    return { companyId: ctx.companyId, ...deliveryWarehouseScope(ctx) }
  }

  private async getOwned(ctx: TenantContext, id: string, tx?: Tx) {
    const delivery = await (tx ?? this.prisma).delivery.findFirst({ where: { id, ...this.scope(ctx) }, include: DELIVERY_INCLUDE })
    if (!delivery) throw new NotFoundException('Livraison introuvable.')
    return delivery
  }

  async detail(ctx: TenantContext, id: string) {
    const delivery = await this.getOwned(ctx, id)
    const [history, events, proofs, incidents, assignments, tracking] = await Promise.all([
      this.prisma.deliveryStatusHistory.findMany({ where: { deliveryId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.deliveryEvent.findMany({ where: { deliveryId: id }, orderBy: { occurredAt: 'asc' } }),
      this.prisma.proofOfDelivery.findMany({ where: { deliveryId: id }, orderBy: { capturedAt: 'asc' } }),
      this.prisma.deliveryIncident.findMany({ where: { deliveryId: id }, orderBy: { reportedAt: 'desc' } }),
      this.prisma.deliveryAssignment.findMany({ where: { deliveryId: id }, orderBy: { createdAt: 'desc' }, include: { driver: { select: { fullName: true } }, vehicle: { select: { registration: true } } } }),
      this.prisma.trackingSession.findFirst({ where: { deliveryId: id }, orderBy: { startedAt: 'desc' } }),
    ])
    return { ...delivery, history, events, proofs, incidents, assignments, trackingSessionId: tracking?.id ?? null }
  }

  async list(ctx: TenantContext, p: PageQuery) {
    const statuses = p.status?.split(',')
    const period = parsePeriod(p)
    const where: Prisma.DeliveryWhereInput = {
      AND: [
        this.scope(ctx),
        // La date d'une mission est sa date prévue, ou sa création si elle n'en a pas.
        ...(period ? [{ OR: [{ scheduledAt: period }, { scheduledAt: null, createdAt: period }] }] : []),
        {
          ...(statuses ? { status: { in: statuses } } : {}),
          ...(p.driverId ? { driverId: String(p.driverId) } : {}),
          ...(p.warehouseId ? { warehouseId: String(p.warehouseId) } : {}),
          ...(p.customerId ? { customerId: String(p.customerId) } : {}),
          ...(p.mode ? { mode: String(p.mode) } : {}),
          ...(p.pickupWarehouseId ? { pickupWarehouseId: String(p.pickupWarehouseId) } : {}),
        },
        ...(p.q ? [{ OR: [{ number: { contains: p.q } }, { customer: { name: { contains: p.q } } }] }] : []),
      ],
    }
    const [items, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where, skip: p.skip, take: p.take, orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }],
        include: {
          customer: { select: { name: true } }, deliveryPoint: { select: { name: true, commune: true, city: true } },
          driver: { select: { fullName: true } }, vehicle: { select: { registration: true } }, warehouse: { select: { name: true } }, pickupWarehouse: { select: { name: true } },
          _count: { select: { packages: true } },
        },
      }),
      this.prisma.delivery.count({ where }),
    ])
    return paged(items, total, p)
  }

  /** Vue mobile : prochaines missions du chauffeur connecté. */
  async missions(ctx: TenantContext, scope: string) {
    const active: DeliveryStatus[] = ['ASSIGNED', 'LOADED', 'IN_TRANSIT', 'ARRIVED']
    // Retrait : une fois la marchandise déposée à l'entrepôt, la mission du chauffeur est terminée.
    const finished: DeliveryStatus[] = ['DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNED', 'AWAITING_PICKUP']
    const items = await this.prisma.delivery.findMany({
      where: { companyId: ctx.companyId, driverId: ctx.driverId!, status: { in: scope === 'history' ? finished : active } },
      orderBy: scope === 'history' ? { updatedAt: 'desc' } : [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
      take: scope === 'history' ? 100 : 200,
      include: DELIVERY_INCLUDE,
    })
    const stops = await this.prisma.routeStop.findMany({ where: { deliveryId: { in: items.map((d) => d.id) } }, include: { route: { select: { id: true, number: true } } } })
    return items.map((d) => {
      const stop = stops.find((s) => s.deliveryId === d.id)
      return { ...d, route: stop ? { id: stop.route.id, number: stop.route.number, position: stop.position } : null }
    })
  }

  // ---------- Livraisons : cycle de vie ----------

  private async move(tx: Tx, ctx: TenantContext, delivery: { id: string; status: string }, to: DeliveryStatus, note?: string, extra: Prisma.DeliveryUncheckedUpdateManyInput = {}) {
    const from = delivery.status as DeliveryStatus
    if (!DELIVERY_TRANSITIONS[from]?.includes(to)) {
      throw new ConflictException({ message: `Transition impossible : ${DELIVERY_STATUS_LABELS[from]} vers ${DELIVERY_STATUS_LABELS[to]}.`, code: 'INVALID_TRANSITION' })
    }
    const r = await tx.delivery.updateMany({ where: { id: delivery.id, status: from }, data: { ...extra, status: to } })
    if (r.count !== 1) throw new ConflictException({ message: "Cette livraison a changé d'état entre-temps.", code: 'STALE_STATE' })
    await tx.deliveryStatusHistory.create({ data: { deliveryId: delivery.id, fromStatus: from, status: to, userId: ctx.userId, note } })
    delivery.status = to
  }

  private async event(tx: Tx, ctx: TenantContext, deliveryId: string, type: string, label: string, isPublic: boolean, op?: Op) {
    await tx.deliveryEvent.create({
      data: {
        companyId: ctx.companyId, deliveryId, type, label, isPublic, userId: ctx.userId, note: op?.note,
        latitude: op?.latitude, longitude: op?.longitude, clientOpId: op?.clientOpId, occurredAt: op?.occurredAt ?? new Date(),
      },
    })
  }

  private broadcast(ctx: TenantContext, delivery: { id: string; number: string; status: string; driverId?: string | null }) {
    this.realtime.toCompany(ctx.companyId, 'delivery.status', { id: delivery.id, number: delivery.number, status: delivery.status, driverId: delivery.driverId })
    // Pages publiques : ce client, et les autres clients du même chauffeur (un arrêt chez l'un met en pause la carte des autres).
    this.realtime.toPublicDelivery(delivery.id, 'public.refresh', {})
    if (delivery.driverId && this.realtime.server) {
      void this.prisma.delivery.findMany({ where: { driverId: delivery.driverId, status: 'IN_TRANSIT', id: { not: delivery.id } }, select: { id: true } })
        .then((rows) => rows.forEach((r) => this.realtime.toPublicDelivery(r.id, 'public.refresh', {})))
        .catch(() => undefined)
    }
  }

  /** Lien de suivi en direct à transmettre au client (SMS, WhatsApp…), le même que celui de l'e-mail. */
  async trackingLink(ctx: TenantContext, id: string) {
    const d = await this.getOwned(ctx, id)
    const pack = await this.prisma.package.findFirst({ where: { deliveryId: d.id }, orderBy: { createdAt: 'asc' }, select: { trackingToken: true, trackingNumber: true } })
    if (!pack) throw new NotFoundException("Cette livraison n'a pas encore de colis.")
    return { url: publicTrackingUrl(pack.trackingToken), trackingNumber: pack.trackingNumber }
  }

  /** Rejeu hors ligne : une opération déjà reçue renvoie l'état courant sans rien refaire. */
  private async replayed(ctx: TenantContext, id: string, op?: Op) {
    if (!op?.clientOpId) return null
    const seen = await this.prisma.deliveryEvent.findUnique({ where: { clientOpId: op.clientOpId } })
    if (!seen || seen.companyId !== ctx.companyId || seen.deliveryId !== id) return null
    return this.getOwned(ctx, id)
  }

  /**
   * Le bureau et le téléphone peuvent faire la même étape : si le bureau a déjà chargé, le téléphone,
   * parfois hors ligne, ne doit pas rester bloqué. L'étape déjà atteinte est un succès, jamais une erreur.
   * Un échec, un retour ou une annulation restent de vrais conflits, à signaler au chauffeur.
   */
  private async alreadyReached(ctx: TenantContext, id: string, target: DeliveryStatus, op?: Op) {
    if (!op?.clientOpId) return null
    const delivery = await this.getOwned(ctx, id)
    this.assertOperator(ctx, delivery)
    const position = STEP_ORDER.indexOf(delivery.status as DeliveryStatus)
    return position >= STEP_ORDER.indexOf(target) ? delivery : null
  }

  /** Une mission d'un chauffeur doit être la sienne ; un gestionnaire reste dans son périmètre. */
  private assertOperator(ctx: TenantContext, delivery: { driverId: string | null }) {
    if (ctx.role === 'DRIVER' && delivery.driverId !== ctx.driverId) throw new ForbiddenException("Cette mission ne vous est pas affectée.")
  }

  async create(ctx: TenantContext, body: z.infer<typeof deliverySchema>) {
    if (body.mode === 'PICKUP' && !body.pickupWarehouseId) throw new UnprocessableEntityException("Choisissez l'entrepôt où le client retirera sa marchandise.")
    if (body.mode === 'HOME' && body.pickupWarehouseId) throw new UnprocessableEntityException("Un entrepôt de retrait ne s'indique que pour un retrait en entrepôt.")
    await this.limits.assertCanAdd(ctx.companyId, 'deliveries')
    const delivery = await this.prisma.atomic(async (tx) => {
      const packages = await tx.package.findMany({ where: { id: { in: body.packageIds }, companyId: ctx.companyId }, include: { items: true } })
      if (packages.length !== new Set(body.packageIds).size) throw new NotFoundException('Colis introuvable.')
      if (packages.some((p) => p.deliveryId)) throw new ConflictException('Un colis est déjà rattaché à une livraison.')

      const orderIds = new Set(packages.map((p) => p.orderId))
      const warehouseIds = new Set(packages.map((p) => p.warehouseId))
      if (warehouseIds.size > 1) throw new ConflictException('Tous les colis doivent partir du même entrepôt.')
      if (orderIds.size > 1) throw new ConflictException('Tous les colis doivent provenir de la même commande.')
      const orderId = body.orderId ?? packages[0]?.orderId ?? null
      if (body.orderId && packages.some((p) => p.orderId !== body.orderId)) throw new ConflictException('Un colis ne provient pas de cette commande.')
      const order = orderId ? await tx.order.findFirst({ where: { id: orderId, companyId: ctx.companyId } }) : null
      if (orderId && !order) throw new NotFoundException('Commande introuvable.')

      if (!order) {
        // Livraison sans commande : justification et permission spécifique obligatoires.
        if (!ctx.permissions.has('delivery.create_without_order')) throw new ForbiddenException('Permission requise pour une livraison sans commande.')
        if (!body.justification?.trim()) throw new UnprocessableEntityException('Une justification est obligatoire pour une livraison sans commande.')
      }
      const customerId = order?.customerId ?? body.customerId
      const deliveryPointId = body.deliveryPointId ?? order?.deliveryPointId
      const warehouseId = packages[0].warehouseId
      if (!customerId || !deliveryPointId) throw new UnprocessableEntityException('Le client et le point de livraison sont obligatoires.')
      assertWarehouse(ctx, warehouseId)
      const point = await tx.deliveryPoint.findFirst({ where: { id: deliveryPointId, customerId, companyId: ctx.companyId } })
      if (!point) throw new NotFoundException("Ce point de livraison n'appartient pas à ce client.")
      // Retrait : n'importe quel entrepôt de l'entreprise, même hors du périmètre de l'utilisateur.
      const pickupWarehouseId = body.mode === 'PICKUP' ? (await this.companyWarehouse(tx, ctx, body.pickupWarehouseId!)).id : null

      // Agrégation des contenus des colis en lignes de livraison.
      const lines = new Map<string, { productId: string; orderItemId: string | null; quantity: Prisma.Decimal }>()
      for (const line of packages.flatMap((p) => p.items)) {
        const key = `${line.productId}|${line.orderItemId ?? ''}`
        const current = lines.get(key)
        if (current) current.quantity = current.quantity.plus(line.quantity)
        else lines.set(key, { productId: line.productId, orderItemId: line.orderItemId, quantity: line.quantity })
      }
      const number = await this.seq.next(tx, ctx.companyId, 'delivery', 'LVR')
      const created = await tx.delivery.create({
        data: {
          companyId: ctx.companyId, number, orderId, customerId, deliveryPointId, warehouseId, mode: body.mode, pickupWarehouseId,
          scheduledAt: body.scheduledAt, priority: body.priority, instructions: body.instructions, justification: body.justification,
          createdById: ctx.userId, items: { create: [...lines.values()] },
          history: { create: { status: 'DRAFT', userId: ctx.userId } },
        },
      })
      await tx.package.updateMany({ where: { id: { in: body.packageIds } }, data: { deliveryId: created.id } })
      await this.event(tx, ctx, created.id, 'CREATED', 'Marchandise enregistrée', true)
      await this.audit.log(ctx, 'delivery.create', 'Delivery', created.id, { number }, tx)
      return this.getOwned(ctx, created.id, tx)
    })
    await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'LOGISTICS_MANAGER'], 'ORDER_CREATED', { number: delivery.number }, { type: 'Delivery', id: delivery.id })
    return delivery
  }

  async update(ctx: TenantContext, id: string, body: { scheduledAt?: Date | null; priority?: string; instructions?: string | null }) {
    const delivery = await this.getOwned(ctx, id)
    if (['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED', 'CANCELLED'].includes(delivery.status)) throw new ConflictException('Cette livraison est terminée.')
    await this.prisma.delivery.update({ where: { id }, data: body })
    return this.getOwned(ctx, id)
  }

  /** Validation : réserve le stock des livraisons sans commande, puis rend la livraison prête. */
  async validate(ctx: TenantContext, id: string) {
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      await this.move(tx, ctx, d, 'VALIDATED')
      if (!d.orderId) {
        for (const item of d.items) await this.stock.reserve(tx, ctx.companyId, d.warehouseId, item.productId, item.quantity, { deliveryItemId: item.id })
      }
      await this.move(tx, ctx, d, 'READY')
      await this.event(tx, ctx, id, 'READY', 'Préparation terminée', true)
      await this.audit.log(ctx, 'delivery.validate', 'Delivery', id, undefined, tx)
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    return delivery
  }

  /** Contrôle d'affectation : chauffeur, permis, véhicule, poids, volume, compatibilité, documents. */
  async checkAssignment(tx: Tx, companyId: string, deliveryId: string, driverId: string, vehicleId: string, excludeOthers = false) {
    const [driver, vehicle, packages, items] = await Promise.all([
      tx.driver.findFirst({ where: { id: driverId, companyId, deletedAt: null } }),
      tx.vehicle.findFirst({ where: { id: vehicleId, companyId, deletedAt: null } }),
      tx.package.findMany({ where: { deliveryId } }),
      tx.deliveryItem.findMany({ where: { deliveryId }, include: { product: true } }),
    ])
    const problems: string[] = []
    const now = new Date()
    if (!driver) throw new NotFoundException('Chauffeur introuvable.')
    if (!vehicle) throw new NotFoundException('Véhicule introuvable.')
    if (['inactive', 'suspended'].includes(driver.status)) problems.push("Le chauffeur n'est pas disponible.")
    if (!driver.licenseExpiry) problems.push("La date d'expiration du permis n'est pas renseignée.")
    else if (driver.licenseExpiry < now) problems.push('Le permis du chauffeur est expiré.')
    if (['maintenance', 'inactive'].includes(vehicle.status)) problems.push("Le véhicule n'est pas disponible.")
    // Un véhicule n'a qu'un seul chauffeur à la fois, tant qu'une mission l'utilise.
    const taken = await tx.delivery.findFirst({
      where: { companyId, vehicleId, id: { not: deliveryId }, driverId: { not: driverId }, status: { in: ACTIVE_ON_VEHICLE } },
      select: { number: true, driver: { select: { fullName: true } } },
    })
    if (taken) problems.push(`Le véhicule ${vehicle.registration} est déjà affecté à ${taken.driver?.fullName ?? 'un autre chauffeur'} (livraison ${taken.number}).`)
    if (vehicle.insuranceExpiry && vehicle.insuranceExpiry < now) problems.push("L'assurance du véhicule est expirée.")
    if (vehicle.inspectionExpiry && vehicle.inspectionExpiry < now) problems.push('Le contrôle technique du véhicule est expiré.')

    let load = packages.reduce((s, p) => s.plus(D(p.weightKg)), D(0))
    let volume = packages.reduce((s, p) => s.plus(D(p.volumeM3)), D(0))
    if (!excludeOthers) {
      const others = await tx.package.findMany({
        where: { delivery: { vehicleId, status: { in: ACTIVE_ON_VEHICLE }, id: { not: deliveryId } } },
        select: { weightKg: true, volumeM3: true },
      })
      load = others.reduce((s, p) => s.plus(D(p.weightKg)), load)
      volume = others.reduce((s, p) => s.plus(D(p.volumeM3)), volume)
    }
    if (vehicle.weightCapacityKg && load.greaterThan(vehicle.weightCapacityKg)) problems.push(`Charge de ${load} kg supérieure à la capacité du véhicule (${vehicle.weightCapacityKg} kg).`)
    if (vehicle.volumeCapacityM3 && volume.greaterThan(vehicle.volumeCapacityM3)) problems.push(`Volume de ${volume} m³ supérieur à la capacité du véhicule (${vehicle.volumeCapacityM3} m³).`)
    for (const item of items) {
      if (item.product.requiredVehicle && item.product.requiredVehicle !== vehicle.type) problems.push(`${item.product.name} exige un véhicule de type ${item.product.requiredVehicle}.`)
    }
    if (packages.some((p) => ['TANK', 'COMPARTMENT'].includes(p.unitType)) && vehicle.type !== 'TANKER') problems.push('Un chargement en citerne exige un camion-citerne.')
    if (problems.length) {
      throw new ConflictException({ message: problems[0], code: 'ASSIGNMENT_REJECTED', errors: problems.map((message) => ({ message })) })
    }
    return { driver, vehicle }
  }

  /** Affectation dans une transaction existante, réutilisée par les tournées. */
  async assignTx(tx: Tx, ctx: TenantContext, id: string, body: z.infer<typeof assignSchema>) {
    const d = await this.getOwned(ctx, id, tx)
    this.assertNeedsDriver(d)
    await this.checkAssignment(tx, ctx.companyId, id, body.driverId, body.vehicleId)
    const data = { driverId: body.driverId, vehicleId: body.vehicleId, driverResponse: null }
    if (d.status === 'ASSIGNED') {
      await tx.delivery.update({ where: { id }, data })
    } else {
      await this.move(tx, ctx, d, 'ASSIGNED', undefined, data)
    }
    await tx.deliveryAssignment.create({ data: { deliveryId: id, driverId: body.driverId, vehicleId: body.vehicleId, assignedBy: ctx.userId } })
    await this.audit.log(ctx, 'delivery.assign', 'Delivery', id, body, tx)
    return this.getOwned(ctx, id, tx)
  }

  async assign(ctx: TenantContext, id: string, body: z.infer<typeof assignSchema>) {
    const delivery = await this.prisma.atomic((tx) => this.assignTx(tx, ctx, id, body))
    this.broadcast(ctx, delivery)
    await this.notifyDriver(ctx.companyId, body.driverId, 'DELIVERY_ASSIGNED', delivery)
    return delivery
  }

  /** Après une affectation groupée de tournée : informe le chauffeur et les écrans connectés. */
  async afterBulkAssign(ctx: TenantContext, deliveries: { id: string; number: string; status: string; driverId: string | null }[]) {
    for (const d of deliveries) {
      this.broadcast(ctx, d)
      if (d.driverId) await this.notifyDriver(ctx.companyId, d.driverId, 'DELIVERY_ASSIGNED', d)
    }
  }

  private async notifyDriver(companyId: string, driverId: string, type: string, delivery: { id: string; number: string }) {
    const driver = await this.prisma.driver.findUnique({ where: { id: driverId } })
    if (driver) await this.notifications.notify(companyId, [driver.userId], type, { number: delivery.number }, { type: 'Delivery', id: delivery.id })
  }

  /** Réponse du chauffeur à une mission, selon les règles de l'entreprise. */
  async respond(ctx: TenantContext, id: string, accept: boolean, note?: string) {
    const settings = await this.prisma.companySettings.findUnique({ where: { companyId: ctx.companyId } })
    if (!accept && settings && !settings.driversCanRefuse) throw new ForbiddenException('Votre entreprise ne permet pas de refuser une mission.')
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      if (d.driverId !== ctx.driverId) throw new ForbiddenException('Cette mission ne vous est pas affectée.')
      if (d.status !== 'ASSIGNED') throw new ConflictException('Cette mission ne peut plus recevoir de réponse.')
      if (accept) {
        await tx.delivery.update({ where: { id }, data: { driverResponse: 'ACCEPTED' } })
      } else {
        await this.move(tx, ctx, d, 'READY', note, { driverId: null, vehicleId: null, driverResponse: 'REFUSED' })
      }
      await tx.deliveryAssignment.updateMany({ where: { deliveryId: id, driverId: ctx.driverId!, response: null }, data: { response: accept ? 'ACCEPTED' : 'REFUSED' } })
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    if (!accept) await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'LOGISTICS_MANAGER', 'FLEET_MANAGER'], 'DELIVERY_REFUSED', { number: delivery.number }, { type: 'Delivery', id })
    return delivery
  }

  /** Chargement confirmé : le stock réservé sort physiquement de l'entrepôt. */
  async load(ctx: TenantContext, id: string, op?: Op) {
    const replay = await this.replayed(ctx, id, op)
    if (replay) return replay
    const reached = await this.alreadyReached(ctx, id, 'LOADED', op)
    if (reached) return reached
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      this.assertOperator(ctx, d)
      if (!d.driverId || !d.vehicleId) throw new ConflictException('Un chauffeur et un véhicule doivent être affectés avant le chargement.')
      const settings = await tx.companySettings.findUnique({ where: { companyId: ctx.companyId } })
      if (settings?.requireQrOnLoad && d.packages.some((p) => !p.loadScannedAt)) {
        throw new UnprocessableEntityException({ message: 'Tous les colis doivent être scannés avant le chargement.', code: 'SCAN_REQUIRED' })
      }
      await this.move(tx, ctx, d, 'LOADED')
      await this.issueStock(tx, ctx, d)
      await tx.package.updateMany({ where: { deliveryId: id }, data: { status: 'LOADED' } })
      await this.event(tx, ctx, id, 'LOADED', 'Chargement confirmé', true, op)
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    this.realtime.toCompany(ctx.companyId, 'stock.changed', { warehouseId: delivery.warehouseId })
    for (const item of delivery.items) await this.stock.checkLow(ctx.companyId, delivery.warehouseId, item.productId)
    return delivery
  }

  /**
   * Un chauffeur ne fait qu'un trajet à la fois. Une tournée est une seule mission :
   * ses livraisons peuvent être en cours ensemble, jamais avec une livraison extérieure.
   */
  async assertSingleTrip(tx: Tx, companyId: string, driverId: string | null, deliveryId: string | null, routeId?: string) {
    if (!driverId) return
    const activeStop = (id: string) => tx.routeStop.findFirst({ where: { deliveryId: id, route: { status: { in: ['PLANNED', 'IN_PROGRESS'] } } }, select: { routeId: true } })
    const mission = routeId ?? (deliveryId ? (await activeStop(deliveryId))?.routeId : undefined)
    const others = await tx.delivery.findMany({
      where: { companyId, driverId, status: { in: ['IN_TRANSIT', 'ARRIVED'] }, ...(deliveryId ? { id: { not: deliveryId } } : {}) },
      select: { id: true, number: true },
    })
    for (const other of others) {
      if (!mission || (await activeStop(other.id))?.routeId !== mission) {
        throw new ConflictException({ message: `Ce chauffeur est déjà en mission (livraison ${other.number}). Terminez-la avant de démarrer un autre trajet.`, code: 'DRIVER_BUSY' })
      }
    }
  }

  /** Démarre le transport et ouvre la session GPS du chauffeur. */
  async start(ctx: TenantContext, id: string, op?: Op) {
    const replay = await this.replayed(ctx, id, op)
    if (replay) return replay
    const reached = await this.alreadyReached(ctx, id, 'IN_TRANSIT', op)
    if (reached) return reached
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      this.assertOperator(ctx, d)
      await this.assertSingleTrip(tx, ctx.companyId, d.driverId, id)
      await this.move(tx, ctx, d, 'IN_TRANSIT')
      await tx.package.updateMany({ where: { deliveryId: id }, data: { status: 'IN_TRANSIT' } })
      await this.event(tx, ctx, id, 'STARTED', d.mode === 'PICKUP' ? "En route vers l'entrepôt de retrait" : 'En route vers le destinataire', true, op)
      if (d.driverId) await tx.driver.update({ where: { id: d.driverId }, data: { status: 'on_mission' } })
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'LOGISTICS_MANAGER'], 'DRIVER_EN_ROUTE', { number: delivery.number }, { type: 'Delivery', id })
    // Retrait : le client est prévenu quand la marchandise l'attend à l'entrepôt, pas au départ.
    if (delivery.mode !== 'PICKUP') this.customerMail.notify(ctx.companyId, id, 'EN_ROUTE')
    return delivery
  }

  async arrive(ctx: TenantContext, id: string, op?: Op) {
    const replay = await this.replayed(ctx, id, op)
    if (replay) return replay
    const reached = await this.alreadyReached(ctx, id, 'ARRIVED', op)
    if (reached) return reached
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      this.assertOperator(ctx, d)
      await this.move(tx, ctx, d, 'ARRIVED')
      await this.event(tx, ctx, id, 'ARRIVED', d.mode === 'PICKUP' ? "Chauffeur arrivé à l'entrepôt de retrait" : 'Chauffeur arrivé à destination', true, op)
      await this.closeTracking(tx, d.driverId, id, op?.occurredAt)
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'LOGISTICS_MANAGER'], 'DRIVER_ARRIVED', { number: delivery.number }, { type: 'Delivery', id })
    return delivery
  }

  // ---------- Preuves ----------

  async addProof(ctx: TenantContext, id: string, body: z.infer<typeof proofSchema>, file?: { buffer: Buffer; mimetype: string; originalname?: string }) {
    if (body.clientOpId) {
      const seen = await this.prisma.proofOfDelivery.findUnique({ where: { clientOpId: body.clientOpId } })
      if (seen && seen.companyId === ctx.companyId) return seen
    }
    const d = await this.getOwned(ctx, id)
    this.assertOperator(ctx, d)
    // L'entrepôt de retrait (sans droit de clôture) n'ajoute des preuves qu'au guichet.
    const counter = d.mode === 'PICKUP' && d.status === 'AWAITING_PICKUP'
    if (!ctx.driverId && !ctx.permissions.has('delivery.resolve') && !counter) throw new ForbiddenException('Permission insuffisante.')
    if (counter) assertWarehouse(ctx, location(d))
    if (!['ARRIVED', 'FAILED', 'IN_TRANSIT', 'AWAITING_PICKUP', 'DELIVERED', 'PARTIALLY_DELIVERED'].includes(d.status)) throw new ConflictException('Cette livraison ne peut pas recevoir de preuve.')
    if (['SIGNATURE', 'PHOTO_GOODS', 'PHOTO_PLACE'].includes(body.type) && !file) throw new UnprocessableEntityException('Un fichier est obligatoire pour cette preuve.')
    const saved = file ? await this.files.save(ctx, file) : null
    const proof = await this.prisma.proofOfDelivery.create({
      data: {
        companyId: ctx.companyId, deliveryId: id, type: body.type, value: body.value, fileId: saved?.id, sha256: saved?.sha256,
        latitude: body.latitude, longitude: body.longitude, capturedAt: body.capturedAt ?? new Date(), clientOpId: body.clientOpId, createdById: ctx.userId,
      },
    })
    await this.audit.log(ctx, 'delivery.proof_added', 'Delivery', id, { proofId: proof.id, type: body.type })
    return proof
  }

  async proofs(ctx: TenantContext, id: string) {
    await this.getOwned(ctx, id)
    return this.prisma.proofOfDelivery.findMany({ where: { deliveryId: id }, orderBy: { capturedAt: 'asc' } })
  }

  async proofDownload(ctx: TenantContext, proofId: string) {
    const proof = await this.prisma.proofOfDelivery.findFirst({ where: { id: proofId, companyId: ctx.companyId } })
    if (!proof) throw new NotFoundException('Preuve introuvable.')
    await this.getOwned(ctx, proof.deliveryId)
    if (!proof.fileId) throw new NotFoundException('Cette preuve ne contient pas de fichier.')
    await this.audit.log(ctx, 'delivery.proof_accessed', 'ProofOfDelivery', proof.id)
    return this.files.signedUrl(ctx, proof.fileId)
  }

  /** Une livraison n'est jamais confirmée sans les preuves exigées par la politique de l'entreprise. */
  private async assertProofs(tx: Tx, ctx: TenantContext, d: { id: string; mode: string }, body: { recipientName?: string; latitude?: number; longitude?: number }) {
    const settings = await tx.companySettings.findUnique({ where: { companyId: ctx.companyId } })
    const proofs = await tx.proofOfDelivery.findMany({ where: { deliveryId: d.id } })
    const has = (type: string) => proofs.some((p) => p.type === type)
    const missing: string[] = []
    if (settings?.requireSignature && !has('SIGNATURE')) missing.push('signature')
    if (settings?.requirePhoto && !has('PHOTO_GOODS') && !has('PHOTO_PLACE')) missing.push('photo')
    if (settings?.requireRecipientName && !body.recipientName) missing.push('nom du réceptionnaire')
    // Au guichet de l'entrepôt de retrait, la position n'apporte rien : elle n'est pas exigée.
    if (settings?.requireGpsOnProof && d.mode !== 'PICKUP' && (body.latitude === undefined || body.longitude === undefined) && !has('GPS')) missing.push('position GPS')
    if (missing.length) {
      throw new UnprocessableEntityException({ message: `Preuves manquantes : ${missing.join(', ')}.`, code: 'PROOF_MISSING', errors: missing.map((message) => ({ message })) })
    }
  }

  private async finalProofs(tx: Tx, ctx: TenantContext, id: string, body: { recipientName?: string; recipientPhone?: string; latitude?: number; longitude?: number; occurredAt?: Date | null }) {
    const when = body.occurredAt ?? new Date()
    if (body.recipientName) await tx.proofOfDelivery.create({ data: { companyId: ctx.companyId, deliveryId: id, type: 'RECIPIENT', value: `${body.recipientName}${body.recipientPhone ? ` / ${body.recipientPhone}` : ''}`, capturedAt: when, createdById: ctx.userId } })
    if (body.latitude !== undefined && body.longitude !== undefined) await tx.proofOfDelivery.create({ data: { companyId: ctx.companyId, deliveryId: id, type: 'GPS', latitude: body.latitude, longitude: body.longitude, capturedAt: when, createdById: ctx.userId } })
  }

  /** `counter` : remise au guichet de l'entrepôt de retrait, réservée aux livraisons en retrait. */
  async confirm(ctx: TenantContext, id: string, body: z.infer<typeof confirmSchema>, counter = false) {
    const replay = await this.replayed(ctx, id, body)
    if (replay) return replay
    const reached = await this.alreadyReached(ctx, id, 'DELIVERED', body)
    if (reached) return reached
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      this.assertOperator(ctx, d)
      if (d.status === 'DELIVERED') throw new ConflictException({ message: 'Cette livraison est déjà confirmée.', code: 'ALREADY_CONFIRMED' })
      this.assertHandover(ctx, d, counter)
      await this.assertProofs(tx, ctx, d, body)
      await this.move(tx, ctx, d, 'DELIVERED', undefined, { deliveredAt: body.occurredAt ?? new Date(), recipientName: body.recipientName, recipientPhone: body.recipientPhone })
      await this.finalProofs(tx, ctx, id, body)
      for (const item of d.items) {
        await tx.deliveryItem.update({ where: { id: item.id }, data: { quantityDelivered: item.quantity } })
        if (item.orderItemId) await tx.orderItem.update({ where: { id: item.orderItemId }, data: { quantityDelivered: { increment: item.quantity } } })
      }
      await tx.package.updateMany({ where: { deliveryId: id }, data: { status: 'DELIVERED' } })
      await this.event(tx, ctx, id, 'DELIVERED', d.mode === 'PICKUP' ? 'Marchandise retirée par le client' : 'Livraison confirmée', true, body)
      if (d.orderId) await this.syncOrder(tx, ctx, d.orderId)
      await this.audit.log(ctx, 'delivery.confirm', 'Delivery', id, { recipient: body.recipientName }, tx)
      // Retrait : le chauffeur a été libéré à la réception par l'entrepôt.
      if (d.mode !== 'PICKUP') await this.releaseTracking(tx, d.driverId, id)
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'LOGISTICS_MANAGER'], 'DELIVERY_DONE', { number: delivery.number }, { type: 'Delivery', id })
    this.customerMail.notify(ctx.companyId, id, 'DELIVERED')
    return delivery
  }

  async partialConfirm(ctx: TenantContext, id: string, body: z.infer<typeof partialSchema>, counter = false) {
    const replay = await this.replayed(ctx, id, body)
    if (replay) return replay
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      this.assertOperator(ctx, d)
      this.assertHandover(ctx, d, counter)
      await this.assertProofs(tx, ctx, d, body)
      let anyDelivered = false
      let anyShort = false
      for (const item of d.items) {
        const line = body.items.find((l) => l.deliveryItemId === item.id)
        if (!line) throw new UnprocessableEntityException(`Quantités manquantes pour ${item.product.name}.`)
        const sum = D(line.delivered).plus(line.refused).plus(line.missing)
        if (!sum.equals(item.quantity)) throw new UnprocessableEntityException(`Pour ${item.product.name}, remis + refusé + manquant doit être égal à ${item.quantity}.`)
        if ((line.refused > 0 || line.missing > 0) && !line.reason) throw new UnprocessableEntityException(`Motif obligatoire pour l'écart sur ${item.product.name}.`)
        anyDelivered ||= line.delivered > 0
        anyShort ||= line.refused > 0 || line.missing > 0
        await tx.deliveryItem.update({ where: { id: item.id }, data: { quantityDelivered: line.delivered, quantityRefused: line.refused, quantityMissing: line.missing, discrepancyReason: line.reason } })
        if (item.orderItemId) await tx.orderItem.update({ where: { id: item.orderItemId }, data: { quantityDelivered: { increment: line.delivered } } })
      }
      if (!anyDelivered) throw new UnprocessableEntityException("Aucune quantité remise : déclarez plutôt un échec de livraison.")
      if (!anyShort) throw new UnprocessableEntityException('Aucun écart : utilisez la confirmation complète.')
      await this.move(tx, ctx, d, 'PARTIALLY_DELIVERED', undefined, { deliveredAt: body.occurredAt ?? new Date(), recipientName: body.recipientName, recipientPhone: body.recipientPhone })
      await this.finalProofs(tx, ctx, id, body)
      await this.event(tx, ctx, id, 'PARTIALLY_DELIVERED', d.mode === 'PICKUP' ? 'Marchandise retirée en partie par le client' : 'Livraison partielle confirmée', true, body)
      if (d.orderId) await this.syncOrder(tx, ctx, d.orderId)
      await this.audit.log(ctx, 'delivery.partial_confirm', 'Delivery', id, { items: body.items }, tx)
      if (d.mode !== 'PICKUP') await this.releaseTracking(tx, d.driverId, id)
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'LOGISTICS_MANAGER'], 'DELIVERY_DONE', { number: delivery.number }, { type: 'Delivery', id })
    this.customerMail.notify(ctx.companyId, id, 'PARTIAL')
    return delivery
  }

  async fail(ctx: TenantContext, id: string, body: z.infer<typeof failSchema>) {
    const replay = await this.replayed(ctx, id, body)
    if (replay) return replay
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      this.assertOperator(ctx, d)
      await this.move(tx, ctx, d, 'FAILED', body.comment, { failureReason: body.reason, failureComment: body.comment })
      await tx.package.updateMany({ where: { deliveryId: id }, data: { status: 'FAILED' } })
      await this.event(tx, ctx, id, 'FAILED', 'Livraison non effectuée', true, { ...body, note: body.comment })
      await this.audit.log(ctx, 'delivery.fail', 'Delivery', id, { reason: body.reason }, tx)
      await this.releaseTracking(tx, d.driverId, id)
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'LOGISTICS_MANAGER', 'WAREHOUSE_MANAGER'], 'DELIVERY_FAILED', { number: delivery.number, reason: body.reason }, { type: 'Delivery', id })
    this.customerMail.notify(ctx.companyId, id, 'FAILED')
    return delivery
  }

  /**
   * Le bureau arrête une mission en cours (client qui annule, erreur d'adresse…). Le suivi s'arrête,
   * le chauffeur est prévenu, et la marchandise suit ensuite le chemin d'un échec : retour ou reprogrammation.
   */
  async recall(ctx: TenantContext, id: string, body: z.infer<typeof recallSchema>) {
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      if (!['IN_TRANSIT', 'ARRIVED'].includes(d.status)) throw new ConflictException({ message: "Seule une livraison en route ou arrivée peut être rappelée. Avant le départ, utilisez l'annulation ou le retour.", code: 'NOT_ON_ROAD' })
      await this.move(tx, ctx, d, 'FAILED', body.reason, { failureReason: RECALLED, failureComment: body.reason })
      await tx.package.updateMany({ where: { deliveryId: id }, data: { status: 'FAILED' } })
      await this.event(tx, ctx, id, 'RECALLED', "Livraison interrompue par l'entreprise", true, { note: body.reason })
      await this.audit.log(ctx, 'delivery.recall', 'Delivery', id, { reason: body.reason }, tx)
      await this.releaseTracking(tx, d.driverId, id)
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    if (delivery.driverId) await this.notifyDriver(ctx.companyId, delivery.driverId, 'DELIVERY_RECALLED', delivery)
    return delivery
  }

  /** Reprogrammation : l'historique est conservé et le stock n'est pas sorti une seconde fois. */
  async reschedule(ctx: TenantContext, id: string, body: z.infer<typeof rescheduleSchema>) {
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      const driverId = body.driverId ?? d.driverId
      const vehicleId = body.vehicleId ?? d.vehicleId
      if (!driverId || !vehicleId) throw new UnprocessableEntityException('Un chauffeur et un véhicule sont nécessaires.')
      this.assertNeedsDriver(d)
      await this.checkAssignment(tx, ctx.companyId, id, driverId, vehicleId)
      await this.move(tx, ctx, d, 'ASSIGNED', body.note, { scheduledAt: body.scheduledAt, driverId, vehicleId, driverResponse: null, failureReason: null, failureComment: null, attempts: d.attempts + 1 })
      await tx.deliveryAssignment.create({ data: { deliveryId: id, driverId, vehicleId, assignedBy: ctx.userId } })
      await tx.package.updateMany({ where: { deliveryId: id }, data: { status: 'CREATED', loadScannedAt: null, deliverScannedAt: null } })
      await this.event(tx, ctx, id, 'RESCHEDULED', 'Livraison reprogrammée', true, { note: body.note })
      await this.audit.log(ctx, 'delivery.reschedule', 'Delivery', id, { scheduledAt: body.scheduledAt }, tx)
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    if (delivery.driverId) await this.notifyDriver(ctx.companyId, delivery.driverId, 'DELIVERY_ASSIGNED', delivery)
    return delivery
  }

  /** Retour physique : seules les quantités non remises et non manquantes réintègrent le stock. */
  async returnGoods(ctx: TenantContext, id: string, body: z.infer<typeof returnSchema>) {
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      if (d.stockReturned) throw new ConflictException('Le retour de cette livraison est déjà enregistré.')
      // Retrait : un client qui ne vient pas, la marchandise rentre dans le stock de l'entrepôt qui la garde.
      const fullReturn = d.status === 'FAILED' || d.status === 'LOADED' || d.status === 'AWAITING_PICKUP'
      const target = location(d)
      await this.move(tx, ctx, d, 'RETURNED', body.note, { stockReturned: true })
      for (const item of d.items) {
        const quantity = fullReturn ? item.quantity : item.quantityRefused
        if (quantity.greaterThan(0) && d.stockIssued) {
          let remaining = quantity
          for (const a of JSON.parse(item.allocations ?? '[]') as Allocation[]) {
            if (!remaining.greaterThan(0)) break
            const take = Prisma.Decimal.min(D(a.quantity), remaining)
            await this.stock.apply(
              tx,
              {
                // Les emplacements de l'entrepôt de départ n'existent pas ailleurs : le lot est conservé.
                companyId: ctx.companyId, warehouseId: target, productId: item.productId, locationId: target === d.warehouseId ? a.locationId : null, batchId: a.batchId,
                onHand: take, damaged: body.condition === 'DAMAGED' ? take : 0, blocked: body.condition === 'QUARANTINE' ? take : 0,
              },
              { direction: 'IN', reason: 'CUSTOMER_RETURN', refType: 'Delivery', refId: id, note: body.note, userId: ctx.userId },
            )
            remaining = remaining.minus(take)
          }
        }
        await tx.deliveryItem.update({ where: { id: item.id }, data: { quantityReturned: quantity } })
      }
      await tx.package.updateMany({ where: { deliveryId: id, status: { not: 'DELIVERED' } }, data: { status: 'RETURNED' } })
      await this.event(tx, ctx, id, 'RETURNED', "Marchandise retournée à l'entrepôt", true, { note: body.note })
      if (d.orderId) await this.syncOrder(tx, ctx, d.orderId)
      await this.audit.log(ctx, 'delivery.return', 'Delivery', id, body, tx)
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    this.realtime.toCompany(ctx.companyId, 'stock.changed', { warehouseId: location(delivery) })
    return delivery
  }

  async cancel(ctx: TenantContext, id: string, note?: string) {
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      if (d.stockIssued && !d.stockReturned) throw new ConflictException('La marchandise est sortie du stock : enregistrez d\'abord son retour.')
      await this.move(tx, ctx, d, 'CANCELLED', note, { driverId: null, vehicleId: null })
      if (!d.orderId) await this.stock.releaseReservations(tx, ctx.companyId, { deliveryItemId: { in: d.items.map((i) => i.id) } })
      // Les colis redeviennent disponibles pour une autre livraison.
      await tx.package.updateMany({ where: { deliveryId: id }, data: { deliveryId: null, status: 'CREATED', loadScannedAt: null } })
      await tx.routeStop.deleteMany({ where: { deliveryId: id } })
      await this.event(tx, ctx, id, 'CANCELLED', 'Livraison annulée', true, { note })
      await this.audit.log(ctx, 'delivery.cancel', 'Delivery', id, { note }, tx)
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    return delivery
  }

  async incident(ctx: TenantContext, id: string, body: z.infer<typeof incidentSchema>) {
    if (body.clientOpId) {
      const seen = await this.prisma.deliveryIncident.findUnique({ where: { clientOpId: body.clientOpId } })
      if (seen && seen.companyId === ctx.companyId) return seen
    }
    const d = await this.getOwned(ctx, id)
    this.assertOperator(ctx, d)
    const row = await this.prisma.deliveryIncident.create({
      data: { companyId: ctx.companyId, deliveryId: id, type: body.type, description: body.description, clientOpId: body.clientOpId, reportedAt: body.occurredAt ?? new Date(), reportedById: ctx.userId },
    })
    await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'LOGISTICS_MANAGER'], 'INCIDENT', { number: d.number, reason: body.type }, { type: 'Delivery', id })
    return row
  }

  // ---------- Retrait en entrepôt ----------
  //
  // Une livraison en mode PICKUP n'est pas remise à l'adresse du client : il vient la chercher dans
  // un entrepôt de l'entreprise (même agence ou autre agence). Deux parcours :
  // - retrait dans l'entrepôt où se trouve la marchandise : prête → disponible au retrait, sans chauffeur ;
  // - retrait ailleurs : le parcours chauffeur habituel jusqu'à l'entrepôt de retrait, qui réceptionne.
  // Puis l'entrepôt de retrait remet la marchandise au guichet (preuves habituelles), ou la retourne en stock.
  // Une livraison à domicile (HOME, par défaut) ne passe jamais par ces étapes.

  private async companyWarehouse(tx: Tx, ctx: TenantContext, id: string) {
    const warehouse = await tx.warehouse.findFirst({ where: { id, companyId: ctx.companyId, status: 'active' } })
    if (!warehouse) throw new NotFoundException('Entrepôt de retrait introuvable.')
    return warehouse
  }

  private assertPickup(d: { mode: string }) {
    if (d.mode !== 'PICKUP') throw new ConflictException({ message: 'Cette livraison se fait à domicile, pas en retrait.', code: 'NOT_PICKUP' })
  }

  /** Un retrait dans l'entrepôt où se trouve déjà la marchandise n'a pas de trajet : aucun chauffeur. */
  private assertNeedsDriver(d: { mode: string; pickupWarehouseId: string | null; warehouseId: string; heldAtWarehouseId: string | null }) {
    if (d.mode === 'PICKUP' && d.pickupWarehouseId === location(d)) {
      throw new ConflictException({ message: "Le client retire sa marchandise dans l'entrepôt où elle se trouve : mettez-la à disposition, sans chauffeur.", code: 'PICKUP_ON_SITE' })
    }
  }

  /** Retrait : la remise se fait au guichet de l'entrepôt qui garde la marchandise, jamais par le chauffeur. */
  private assertHandover(ctx: TenantContext, d: { mode: string; status: string; warehouseId: string; heldAtWarehouseId: string | null }, counter: boolean) {
    if (d.mode !== 'PICKUP') {
      if (counter) this.assertPickup(d)
      return
    }
    if (ctx.role === 'DRIVER') throw new ForbiddenException("Retrait en entrepôt : déposez la marchandise à l'entrepôt, qui la remettra au client.")
    if (d.status !== 'AWAITING_PICKUP') throw new ConflictException({ message: "La marchandise doit d'abord être disponible au retrait.", code: 'NOT_AVAILABLE' })
    assertWarehouse(ctx, location(d))
  }

  /** Sortie physique du stock réservé, une seule fois par livraison. */
  private async issueStock(tx: Tx, ctx: TenantContext, d: Awaited<ReturnType<DeliveriesService['getOwned']>>) {
    if (d.stockIssued) return
    for (const item of d.items) {
      const where = item.orderItemId ? { orderItemId: item.orderItemId } : { deliveryItemId: item.id }
      const allocations = await this.stock.consume(tx, ctx.companyId, where, item.quantity, {
        direction: 'OUT', reason: 'DELIVERY', refType: 'Delivery', refId: d.id, userId: ctx.userId,
      })
      await tx.deliveryItem.update({ where: { id: item.id }, data: { allocations: JSON.stringify(allocations) } })
      if (item.orderItemId) await tx.orderItem.update({ where: { id: item.orderItemId }, data: { quantityShipped: { increment: item.quantity } } })
    }
    await tx.delivery.update({ where: { id: d.id }, data: { stockIssued: true } })
    d.stockIssued = true
    if (d.orderId) await this.syncOrder(tx, ctx, d.orderId)
  }

  private async available(tx: Tx, ctx: TenantContext, d: Awaited<ReturnType<DeliveriesService['getOwned']>>, op?: Op) {
    await this.move(tx, ctx, d, 'AWAITING_PICKUP', op?.note, { availableAt: op?.occurredAt ?? new Date(), heldAtWarehouseId: d.pickupWarehouseId })
    await tx.package.updateMany({ where: { deliveryId: d.id }, data: { status: 'AVAILABLE' } })
    await this.event(tx, ctx, d.id, 'AVAILABLE', `Disponible au retrait : ${d.pickupWarehouse?.name ?? 'entrepôt'}`, true, op)
  }

  private async afterAvailable(ctx: TenantContext, delivery: Awaited<ReturnType<DeliveriesService['getOwned']>>) {
    this.broadcast(ctx, delivery)
    await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'LOGISTICS_MANAGER', 'WAREHOUSE_MANAGER'], 'PICKUP_READY', { number: delivery.number, warehouse: delivery.pickupWarehouse?.name ?? '' }, { type: 'Delivery', id: delivery.id })
    this.customerMail.notify(ctx.companyId, delivery.id, 'PICKUP_READY')
  }

  /** Retrait dans l'entrepôt où se trouve la marchandise : elle sort du stock et attend le client. */
  async makeAvailable(ctx: TenantContext, id: string, op?: Op) {
    const replay = await this.replayed(ctx, id, op)
    if (replay) return replay
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      this.assertPickup(d)
      if (d.pickupWarehouseId !== location(d)) {
        throw new ConflictException({ message: "La marchandise n'est pas dans l'entrepôt de retrait : affectez un chauffeur pour l'y acheminer.", code: 'PICKUP_ELSEWHERE' })
      }
      assertWarehouse(ctx, location(d))
      await this.available(tx, ctx, d, op)
      await this.issueStock(tx, ctx, d)
      await this.audit.log(ctx, 'delivery.pickup_available', 'Delivery', id, undefined, tx)
      return this.getOwned(ctx, id, tx)
    })
    await this.afterAvailable(ctx, delivery)
    this.realtime.toCompany(ctx.companyId, 'stock.changed', { warehouseId: delivery.warehouseId })
    for (const item of delivery.items) await this.stock.checkLow(ctx.companyId, delivery.warehouseId, item.productId)
    return delivery
  }

  /** L'entrepôt de retrait réceptionne la marchandise apportée par le chauffeur, dont la mission s'arrête là. */
  async receiveAtPickup(ctx: TenantContext, id: string, op?: Op) {
    const replay = await this.replayed(ctx, id, op)
    if (replay) return replay
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      this.assertPickup(d)
      assertWarehouse(ctx, d.pickupWarehouseId!)
      if (!['IN_TRANSIT', 'ARRIVED'].includes(d.status)) throw new ConflictException('Seule une marchandise en route ou arrivée peut être réceptionnée.')
      await this.available(tx, ctx, d, op)
      await this.audit.log(ctx, 'delivery.pickup_received', 'Delivery', id, { warehouseId: d.pickupWarehouseId }, tx)
      await this.releaseTracking(tx, d.driverId, id)
      return this.getOwned(ctx, id, tx)
    })
    await this.afterAvailable(ctx, delivery)
    return delivery
  }

  /**
   * Mode de remise et entrepôt de retrait. Avant le chargement : simple modification.
   * Marchandise disponible au retrait : le client la veut dans un autre entrepôt de l'entreprise,
   * elle redevient prête et repart avec un chauffeur (le stock n'est pas sorti une seconde fois).
   */
  async changePickup(ctx: TenantContext, id: string, body: z.infer<typeof pickupSchema>) {
    const delivery = await this.prisma.atomic(async (tx) => {
      const d = await this.getOwned(ctx, id, tx)
      if (body.mode === 'HOME') {
        if (!BEFORE_LOADING.includes(d.status as DeliveryStatus) || d.stockIssued) throw new ConflictException('La livraison à domicile ne se choisit plus une fois la marchandise sortie du stock.')
        await tx.delivery.update({ where: { id }, data: { mode: 'HOME', pickupWarehouseId: null } })
        await this.event(tx, ctx, id, 'MODE_CHANGED', 'Livraison à domicile', false, { note: body.note })
      } else {
        if (!body.pickupWarehouseId) throw new UnprocessableEntityException("Choisissez l'entrepôt où le client retirera sa marchandise.")
        const target = await this.companyWarehouse(tx, ctx, body.pickupWarehouseId)
        if (d.status === 'AWAITING_PICKUP') {
          if (target.id === location(d)) throw new ConflictException('La marchandise est déjà dans cet entrepôt.')
          assertWarehouse(ctx, location(d))
          await this.move(tx, ctx, d, 'READY', body.note, { pickupWarehouseId: target.id, availableAt: null })
          await tx.package.updateMany({ where: { deliveryId: id }, data: { status: 'CREATED', loadScannedAt: null, deliverScannedAt: null } })
          await this.event(tx, ctx, id, 'PICKUP_CHANGED', `Envoi vers un autre point de retrait : ${target.name}`, true, { note: body.note })
        } else if (BEFORE_LOADING.includes(d.status as DeliveryStatus)) {
          if (d.status === 'ASSIGNED' && target.id === location(d)) {
            throw new ConflictException("Un chauffeur est affecté : le retrait ne peut pas se faire dans l'entrepôt où se trouve la marchandise.")
          }
          await tx.delivery.update({ where: { id }, data: { mode: 'PICKUP', pickupWarehouseId: target.id } })
          await this.event(tx, ctx, id, 'PICKUP_CHANGED', `Retrait prévu : ${target.name}`, false, { note: body.note })
        } else {
          throw new ConflictException("Le point de retrait ne peut plus être modifié pendant le transport.")
        }
      }
      await this.audit.log(ctx, 'delivery.pickup_changed', 'Delivery', id, body, tx)
      return this.getOwned(ctx, id, tx)
    })
    this.broadcast(ctx, delivery)
    return delivery
  }

  // ---------- Effets de bord ----------

  /** État de la commande recalculé depuis ses lignes. */
  private async syncOrder(tx: Tx, ctx: TenantContext, orderId: string) {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } })
    if (['CANCELLED', 'CLOSED'].includes(order.status)) return
    const allDelivered = order.items.every((i) => i.quantityDelivered.greaterThanOrEqualTo(i.quantity))
    const allShipped = order.items.every((i) => i.quantityShipped.greaterThanOrEqualTo(i.quantity))
    const anyShipped = order.items.some((i) => i.quantityShipped.greaterThan(0))
    const active = await tx.delivery.count({ where: { orderId, status: { notIn: ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED', 'CANCELLED', 'FAILED'] } } })
    const pendingReturn = await tx.delivery.count({ where: { orderId, status: { in: ['FAILED', 'PARTIALLY_DELIVERED'] }, stockReturned: false, items: { some: { OR: [{ quantityRefused: { gt: 0 } }, { quantityDelivered: 0 }] } } } })
    let next = order.status
    if (allDelivered) next = 'CLOSED'
    else if (allShipped && active === 0 && pendingReturn === 0) next = 'CLOSED'
    else if (allShipped) next = 'SHIPPED'
    else if (anyShipped) next = 'PARTIALLY_SHIPPED'
    if (next !== order.status) {
      await tx.order.update({ where: { id: orderId }, data: { status: next } })
      await tx.orderStatusHistory.create({ data: { orderId, status: next, userId: ctx.userId } })
    }
    if (next === 'CLOSED') await this.stock.releaseReservations(tx, ctx.companyId, { orderItemId: { in: order.items.map((i) => i.id) } })
  }

  /**
   * Le chauffeur n'est suivi que pendant ses trajets : le suivi se ferme dès qu'il n'est plus en route.
   * À l'heure réelle de l'arrivée, y compris hors ligne : le serveur refuse toute position ultérieure.
   */
  private async closeTracking(tx: Tx, driverId: string | null, deliveryId: string, at?: Date | null) {
    if (!driverId) return
    const onTheRoad = await tx.delivery.count({ where: { driverId, id: { not: deliveryId }, status: 'IN_TRANSIT' } })
    if (onTheRoad > 0) return
    const now = new Date()
    await tx.trackingSession.updateMany({ where: { driverId, stoppedAt: null }, data: { stoppedAt: at && at < now ? at : now } })
  }

  /** Fin d'une mission : le suivi est fermé, et le chauffeur redevient disponible s'il n'a plus rien en cours. */
  private async releaseTracking(tx: Tx, driverId: string | null, finishedDeliveryId: string) {
    if (!driverId) return
    await this.closeTracking(tx, driverId, finishedDeliveryId)
    const remaining = await tx.delivery.count({ where: { driverId, id: { not: finishedDeliveryId }, status: { in: ON_MISSION } } })
    if (remaining === 0) await tx.driver.update({ where: { id: driverId }, data: { status: 'available' } })
  }

}
