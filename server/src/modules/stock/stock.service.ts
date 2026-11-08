import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { AuditService, NotificationService, RealtimeService, SequenceService } from '../../common/core.services.js'
import { assertWarehouse, warehouseScope, type TenantContext } from '../../common/context.js'
import { paged, type PageQuery, parsePeriod } from '../../common/http.js'
import { PrismaService, VersionConflict, type Tx } from '../../common/prisma.service.js'
import { D } from '../../common/util.js'
import { companyTimeZone, dayBound, isPastDay } from '../../common/time.js'

const ZERO = new Prisma.Decimal(0)

export interface Delta {
  companyId: string
  warehouseId: string
  productId: string
  locationId?: string | null
  batchId?: string | null
  onHand?: Prisma.Decimal.Value
  reserved?: Prisma.Decimal.Value
  blocked?: Prisma.Decimal.Value
  damaged?: Prisma.Decimal.Value
}
export interface MovementInfo {
  direction: 'IN' | 'OUT'
  reason: string
  refType?: string
  refId?: string
  note?: string
  userId?: string
}
export interface Allocation {
  balanceId: string
  batchId: string | null
  locationId: string | null
  quantity: number
}

export const available = (b: { onHand: Prisma.Decimal; reserved: Prisma.Decimal; blocked: Prisma.Decimal; damaged: Prisma.Decimal }) =>
  b.onHand.minus(b.reserved).minus(b.blocked).minus(b.damaged)

/** Journal des stocks : aucun solde ne change sans mouvement traçable. */
@Injectable()
export class StockService {
  constructor(
    readonly prisma: PrismaService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationService,
  ) {}

  private key(d: Delta) {
    return [d.companyId, d.warehouseId, d.locationId ?? '-', d.productId, d.batchId ?? '-'].join('|')
  }

  /**
   * Applique une variation de solde avec verrouillage optimiste (colonne version), portable
   * SQLite/MySQL. Un conflit déclenche le rejeu de la transaction par PrismaService.atomic.
   */
  async apply(tx: Tx, delta: Delta, movement?: MovementInfo) {
    const balanceKey = this.key(delta)
    let balance = await tx.stockBalance.findUnique({ where: { balanceKey } })
    if (!balance) {
      balance = await tx.stockBalance.create({
        data: {
          companyId: delta.companyId, balanceKey, warehouseId: delta.warehouseId, productId: delta.productId,
          locationId: delta.locationId ?? null, batchId: delta.batchId ?? null,
        },
      })
    }
    const onHand = balance.onHand.plus(D(delta.onHand))
    const reserved = balance.reserved.plus(D(delta.reserved))
    const blocked = balance.blocked.plus(D(delta.blocked))
    const damaged = balance.damaged.plus(D(delta.damaged))
    if (onHand.lessThan(0) || reserved.lessThan(0) || blocked.lessThan(0) || damaged.lessThan(0) || available({ onHand, reserved, blocked, damaged }).lessThan(0)) {
      throw new ConflictException({ message: 'Stock disponible insuffisant.', code: 'INSUFFICIENT_STOCK' })
    }
    const updated = await tx.stockBalance.updateMany({
      where: { id: balance.id, version: balance.version },
      data: { onHand, reserved, blocked, damaged, version: { increment: 1 } },
    })
    if (updated.count !== 1) throw new VersionConflict()
    if (movement) {
      await tx.stockMovement.create({
        data: {
          companyId: delta.companyId, direction: movement.direction, reason: movement.reason,
          warehouseId: delta.warehouseId, locationId: delta.locationId ?? null, productId: delta.productId, batchId: delta.batchId ?? null,
          quantity: D(delta.onHand).abs(), quantityBefore: balance.onHand, quantityAfter: onHand,
          refType: movement.refType, refId: movement.refId, note: movement.note, createdById: movement.userId,
        },
      })
    }
    return { ...balance, onHand, reserved, blocked, damaged }
  }

  /**
   * Répartit une quantité entre les soldes selon la stratégie de l'entreprise :
   * FIFO, le lot reçu le plus tôt d'abord ; FEFO, le lot qui expire le plus tôt d'abord (à égalité, FIFO).
   * Sans numéro de lot, une marchandise forme un seul tas par emplacement : la stratégie ne départage que des lots.
   */
  async allocate(tx: Tx, companyId: string, warehouseId: string, productId: string, quantity: Prisma.Decimal.Value): Promise<Allocation[]> {
    const settings = await tx.companySettings.findUnique({ where: { companyId } })
    const balances = await tx.stockBalance.findMany({ where: { companyId, warehouseId, productId }, include: { batch: true } })
    const now = new Date()
    // Un lot reste utilisable jusqu'à la fin de son jour d'expiration ; périmé, il ne sort jamais automatiquement.
    const usable = balances.filter((b) => available(b).greaterThan(0) && !(b.batch?.expiresAt && isPastDay(b.batch.expiresAt, settings?.timezone, now)))
    const fifoTime = (b: (typeof usable)[number]) => (b.batch?.receivedAt ?? b.createdAt).getTime()
    usable.sort((a, b) => {
      if (settings?.stockStrategy === 'FEFO') {
        const ea = a.batch?.expiresAt?.getTime() ?? Infinity
        const eb = b.batch?.expiresAt?.getTime() ?? Infinity
        if (ea !== eb) return ea - eb
      }
      return fifoTime(a) - fifoTime(b)
    })
    let remaining = D(quantity)
    const allocations: Allocation[] = []
    for (const b of usable) {
      if (!remaining.greaterThan(0)) break
      const take = Prisma.Decimal.min(available(b), remaining)
      allocations.push({ balanceId: b.id, batchId: b.batchId, locationId: b.locationId, quantity: take.toNumber() })
      remaining = remaining.minus(take)
    }
    if (remaining.greaterThan(0)) {
      const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true } })
      throw new ConflictException({
        message: `Stock disponible insuffisant pour ${product?.name ?? 'ce produit'} (il manque ${remaining.toString()}).`,
        code: 'INSUFFICIENT_STOCK',
        errors: [{ productId, missing: remaining.toNumber() }],
      })
    }
    return allocations
  }

  /** Réserve du stock et lie la réservation à son origine (commande, transfert, livraison). */
  async reserve(
    tx: Tx, companyId: string, warehouseId: string, productId: string, quantity: Prisma.Decimal.Value,
    link: { orderItemId?: string; transferItemId?: string; deliveryItemId?: string },
  ) {
    for (const a of await this.allocate(tx, companyId, warehouseId, productId, quantity)) {
      await this.apply(tx, { companyId, warehouseId, productId, locationId: a.locationId, batchId: a.batchId, reserved: a.quantity })
      await tx.stockReservation.create({ data: { companyId, balanceId: a.balanceId, quantity: a.quantity, ...link } })
    }
  }

  async releaseReservations(tx: Tx, companyId: string, where: Prisma.StockReservationWhereInput) {
    const rows = await tx.stockReservation.findMany({ where: { ...where, companyId, status: 'ACTIVE' }, include: { balance: true } })
    for (const r of rows) {
      await this.apply(tx, {
        companyId, warehouseId: r.balance.warehouseId, productId: r.balance.productId,
        locationId: r.balance.locationId, batchId: r.balance.batchId, reserved: r.quantity.negated(),
      })
      await tx.stockReservation.update({ where: { id: r.id }, data: { status: 'RELEASED' } })
    }
  }

  /** Transforme des réservations en sortie physique. Renvoie le détail par lot, utile aux retours. */
  async consume(tx: Tx, companyId: string, where: Prisma.StockReservationWhereInput, quantity: Prisma.Decimal.Value, movement: MovementInfo): Promise<Allocation[]> {
    const rows = await tx.stockReservation.findMany({ where: { ...where, companyId, status: 'ACTIVE' }, include: { balance: true }, orderBy: { createdAt: 'asc' } })
    let remaining = D(quantity)
    const allocations: Allocation[] = []
    for (const r of rows) {
      if (!remaining.greaterThan(0)) break
      const take = Prisma.Decimal.min(r.quantity, remaining)
      await this.apply(
        tx,
        {
          companyId, warehouseId: r.balance.warehouseId, productId: r.balance.productId, locationId: r.balance.locationId,
          batchId: r.balance.batchId, onHand: take.negated(), reserved: take.negated(),
        },
        movement,
      )
      const left = r.quantity.minus(take)
      await tx.stockReservation.update({ where: { id: r.id }, data: { quantity: left, status: left.isZero() ? 'CONSUMED' : 'ACTIVE' } })
      allocations.push({ balanceId: r.balanceId, batchId: r.balance.batchId, locationId: r.balance.locationId, quantity: take.toNumber() })
      remaining = remaining.minus(take)
    }
    if (remaining.greaterThan(0)) {
      throw new ConflictException({ message: 'Réservation de stock insuffisante pour cette opération.', code: 'RESERVATION_MISSING' })
    }
    return allocations
  }

  // --- API métier ---

  async ownedWarehouse(ctx: TenantContext, id: string, tx?: Tx) {
    assertWarehouse(ctx, id)
    const wh = await (tx ?? this.prisma).warehouse.findFirst({ where: { id, companyId: ctx.companyId } })
    if (!wh) throw new NotFoundException('Entrepôt introuvable.')
    return wh
  }

  async ownedProduct(ctx: TenantContext, id: string, tx?: Tx) {
    const p = await (tx ?? this.prisma).product.findFirst({ where: { id, companyId: ctx.companyId, deletedAt: null } })
    if (!p) throw new NotFoundException('Produit introuvable.')
    return p
  }

  private async resolveLocation(tx: Tx, ctx: TenantContext, warehouseId: string, locationId?: string | null) {
    if (locationId) {
      const loc = await tx.warehouseLocation.findFirst({ where: { id: locationId, warehouseId, companyId: ctx.companyId } })
      if (!loc) throw new NotFoundException('Emplacement introuvable dans cet entrepôt.')
      return loc.id
    }
    const settings = await tx.companySettings.findUnique({ where: { companyId: ctx.companyId } })
    if (settings?.useLocations) throw new UnprocessableEntityException("L'emplacement est obligatoire pour cette entreprise.")
    return null
  }

  private async capacityCheck(tx: Tx, warehouseId: string, adding: Prisma.Decimal.Value, maxCapacity: Prisma.Decimal | null) {
    if (!maxCapacity) return
    const sum = await tx.stockBalance.aggregate({ where: { warehouseId }, _sum: { onHand: true } })
    if (D(sum._sum.onHand).plus(D(adding)).greaterThan(maxCapacity)) {
      throw new ConflictException({ message: "La capacité maximale de l'entrepôt serait dépassée.", code: 'WAREHOUSE_CAPACITY' })
    }
  }

  async receive(ctx: TenantContext, body: {
    warehouseId: string; supplierId?: string; purchaseOrderId?: string; reason: string; note?: string;
    items: { productId: string; quantity: number; locationId?: string | null; unitCost?: number; batchNumber?: string; manufacturedAt?: Date | null; expiresAt?: Date | null; packagingId?: string; packagingQuantity?: number }[]
  }) {
    const wh = await this.ownedWarehouse(ctx, body.warehouseId)
    const result = await this.prisma.atomic(async (tx) => {
      if (body.supplierId && !(await tx.supplier.findFirst({ where: { id: body.supplierId, companyId: ctx.companyId } }))) {
        throw new NotFoundException('Fournisseur introuvable.')
      }
      const po = body.purchaseOrderId
        ? await tx.purchaseOrder.findFirst({ where: { id: body.purchaseOrderId, companyId: ctx.companyId }, include: { items: true } })
        : null
      if (body.purchaseOrderId && !po) throw new NotFoundException('Bon de commande introuvable.')
      if (po && !['VALIDATED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw new ConflictException("Ce bon de commande n'est pas ouvert à la réception.")
      if (po && po.warehouseId !== body.warehouseId) throw new ConflictException('Ce bon de commande vise un autre entrepôt.')

      const number = await this.seq.next(tx, ctx.companyId, 'receipt', 'REC')
      const receipt = await tx.goodsReceipt.create({
        data: {
          companyId: ctx.companyId, number, warehouseId: wh.id, supplierId: body.supplierId ?? po?.supplierId, purchaseOrderId: po?.id,
          reason: body.reason, note: body.note, createdById: ctx.userId,
        },
      })
      for (const item of body.items) {
        const product = await this.ownedProduct(ctx, item.productId, tx)
        let quantity = D(item.quantity)
        // Conversion : 10 bidons de 20 litres = 200 litres en unité de base.
        if (item.packagingId) {
          const packaging = await tx.productPackaging.findFirst({ where: { id: item.packagingId, productId: product.id } })
          if (!packaging) throw new NotFoundException('Conditionnement introuvable pour ce produit.')
          quantity = D(item.packagingQuantity ?? item.quantity).times(packaging.quantityPerUnit)
        }
        await this.capacityCheck(tx, wh.id, quantity, wh.maxCapacity)
        const locationId = await this.resolveLocation(tx, ctx, wh.id, item.locationId)
        let batchId: string | null = null
        if (product.trackBatches && !item.batchNumber) throw new UnprocessableEntityException(`Le numéro de lot est obligatoire pour ${product.name}.`)
        if (item.batchNumber) {
          const batch = await tx.productBatch.upsert({
            where: { productId_batchNumber: { productId: product.id, batchNumber: item.batchNumber } },
            create: {
              companyId: ctx.companyId, productId: product.id, batchNumber: item.batchNumber, supplierId: receipt.supplierId,
              manufacturedAt: item.manufacturedAt, expiresAt: item.expiresAt, quantityReceived: quantity,
            },
            update: { quantityReceived: { increment: quantity } },
          })
          batchId = batch.id
        }
        await tx.goodsReceiptItem.create({ data: { receiptId: receipt.id, productId: product.id, batchId, locationId, quantity, unitCost: item.unitCost } })
        await this.apply(
          tx,
          { companyId: ctx.companyId, warehouseId: wh.id, productId: product.id, locationId, batchId, onHand: quantity },
          { direction: 'IN', reason: body.reason, refType: 'GoodsReceipt', refId: receipt.id, note: body.note, userId: ctx.userId },
        )
        if (po) {
          const line = po.items.find((l) => l.productId === product.id)
          if (!line) throw new UnprocessableEntityException(`${product.name} ne figure pas sur le bon de commande.`)
          await tx.purchaseOrderItem.update({ where: { id: line.id }, data: { quantityReceived: { increment: quantity } } })
        }
      }
      if (po) {
        const lines = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } })
        const complete = lines.every((l) => l.quantityReceived.greaterThanOrEqualTo(l.quantity))
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED' } })
      }
      await this.audit.log(ctx, 'stock.receive', 'GoodsReceipt', receipt.id, { number }, tx)
      return tx.goodsReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: { items: { include: { product: { select: { name: true, baseUnit: true } }, batch: true } } } })
    })
    this.realtime.toCompany(ctx.companyId, 'stock.changed', { warehouseId: wh.id })
    return result
  }

  /** Sortie directe (perte, dommage, usage interne). Les sorties de livraison passent par les réservations. */
  async issue(ctx: TenantContext, body: { warehouseId: string; productId: string; quantity: number; reason: string; locationId?: string | null; batchId?: string | null; note?: string }) {
    await this.ownedWarehouse(ctx, body.warehouseId)
    await this.ownedProduct(ctx, body.productId)
    const result = await this.prisma.atomic(async (tx) => {
      const allocations = body.batchId !== undefined || body.locationId !== undefined
        ? [{ locationId: body.locationId ?? null, batchId: body.batchId ?? null, quantity: body.quantity }]
        : await this.allocate(tx, ctx.companyId, body.warehouseId, body.productId, body.quantity)
      for (const a of allocations) {
        await this.apply(
          tx,
          { companyId: ctx.companyId, warehouseId: body.warehouseId, productId: body.productId, locationId: a.locationId, batchId: a.batchId, onHand: D(a.quantity).negated() },
          { direction: 'OUT', reason: body.reason, note: body.note, userId: ctx.userId },
        )
      }
      await this.audit.log(ctx, 'stock.issue', 'Product', body.productId, { quantity: body.quantity, reason: body.reason, warehouseId: body.warehouseId }, tx)
      return { allocations }
    })
    this.realtime.toCompany(ctx.companyId, 'stock.changed', { warehouseId: body.warehouseId })
    await this.checkLow(ctx.companyId, body.warehouseId, body.productId)
    return result
  }

  async adjust(ctx: TenantContext, body: { balanceId: string; countedQuantity: number; reason: string }) {
    const result = await this.prisma.atomic(async (tx) => {
      const balance = await tx.stockBalance.findFirst({ where: { id: body.balanceId, companyId: ctx.companyId } })
      if (!balance) throw new NotFoundException('Solde de stock introuvable.')
      assertWarehouse(ctx, balance.warehouseId)
      const diff = D(body.countedQuantity).minus(balance.onHand)
      if (diff.isZero()) return { difference: 0 }
      await this.apply(
        tx,
        { companyId: ctx.companyId, warehouseId: balance.warehouseId, productId: balance.productId, locationId: balance.locationId, batchId: balance.batchId, onHand: diff },
        { direction: diff.greaterThan(0) ? 'IN' : 'OUT', reason: 'ADJUSTMENT', refType: 'Adjustment', note: body.reason, userId: ctx.userId },
      )
      await this.audit.log(ctx, 'stock.adjust', 'StockBalance', balance.id, { before: balance.onHand, after: body.countedQuantity, reason: body.reason }, tx)
      return { difference: diff.toNumber() }
    })
    this.realtime.toCompany(ctx.companyId, 'stock.changed', {})
    return result
  }

  async checkLow(companyId: string, warehouseId: string, productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } })
    if (!product?.lowStockLevel) return
    const balances = await this.prisma.stockBalance.findMany({ where: { companyId, warehouseId, productId } })
    const total = balances.reduce((sum, b) => sum.plus(available(b)), ZERO)
    if (total.lessThanOrEqualTo(product.lowStockLevel)) {
      await this.notifications.notifyRoles(companyId, ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER'], 'STOCK_LOW', { product: product.name, quantity: total.toString() }, { type: 'Product', id: productId })
    }
  }

  async listBalances(ctx: TenantContext, p: PageQuery) {
    const period = parsePeriod(p)
    const where: Prisma.StockBalanceWhereInput = {
      companyId: ctx.companyId, ...warehouseScope(ctx), ...(period ? { updatedAt: period } : {}),
      ...(p.warehouseId ? { warehouseId: String(p.warehouseId) } : {}),
      ...(p.productId ? { productId: String(p.productId) } : {}),
      ...(p.q ? { product: { OR: [{ name: { contains: p.q } }, { reference: { contains: p.q } }] } } : {}),
      OR: [{ onHand: { gt: 0 } }, { reserved: { gt: 0 } }],
    }
    const [items, total] = await Promise.all([
      this.prisma.stockBalance.findMany({
        where, skip: p.skip, take: p.take, orderBy: { updatedAt: 'desc' },
        include: {
          product: { select: { id: true, name: true, reference: true, baseUnit: true, lowStockLevel: true, physicalNature: true } },
          warehouse: { select: { id: true, name: true, code: true } },
          location: { select: { id: true, code: true } },
          batch: { select: { id: true, batchNumber: true, expiresAt: true } },
        },
      }),
      this.prisma.stockBalance.count({ where }),
    ])
    return paged(items.map((b) => ({ ...b, available: available(b) })), total, p)
  }

  /**
   * Stock physique tel qu'il était à la fin d'un jour donné, dans le fuseau de l'entreprise.
   * Pour chaque solde, c'est la quantité après le dernier mouvement enregistré avant cette heure.
   */
  async asOf(ctx: TenantContext, p: PageQuery) {
    if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BadRequestException('Date attendue au format AAAA-MM-JJ.')
    const tz = await companyTimeZone(this.prisma, ctx.companyId)
    const until = dayBound(p.date, tz, true)
    const movements = await this.prisma.stockMovement.findMany({
      where: { companyId: ctx.companyId, ...warehouseScope(ctx), createdAt: { lte: until }, ...(p.warehouseId ? { warehouseId: String(p.warehouseId) } : {}), ...(p.q ? { product: { OR: [{ name: { contains: p.q } }, { reference: { contains: p.q } }] } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        warehouseId: true, locationId: true, productId: true, batchId: true, quantityAfter: true, createdAt: true,
        product: { select: { name: true, reference: true, baseUnit: true } }, warehouse: { select: { name: true } }, location: { select: { code: true } }, batch: { select: { batchNumber: true } },
      },
    })
    const latest = new Map<string, (typeof movements)[number]>()
    for (const m of movements) {
      const key = [m.warehouseId, m.locationId ?? '-', m.productId, m.batchId ?? '-'].join('|')
      if (!latest.has(key)) latest.set(key, m)
    }
    const items = [...latest.values()].filter((m) => m.quantityAfter.greaterThan(0)).map((m) => ({
      key: [m.warehouseId, m.locationId ?? '-', m.productId, m.batchId ?? '-'].join('|'), product: m.product, warehouse: m.warehouse, location: m.location, batch: m.batch, quantity: m.quantityAfter, lastMovementAt: m.createdAt,
    })).sort((a, b) => a.product.name.localeCompare(b.product.name) || a.warehouse.name.localeCompare(b.warehouse.name))
    return { date: p.date, until, timezone: tz, items }
  }

  async listMovements(ctx: TenantContext, p: PageQuery) {
    const period = parsePeriod(p)
    const where: Prisma.StockMovementWhereInput = {
      companyId: ctx.companyId, ...warehouseScope(ctx), ...(period ? { createdAt: period } : {}),
      ...(p.warehouseId ? { warehouseId: String(p.warehouseId) } : {}),
      ...(p.productId ? { productId: String(p.productId) } : {}),
      ...(p.direction ? { direction: String(p.direction) } : {}),
      ...(p.q ? { product: { name: { contains: p.q } } } : {}),
    }
    const [items, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' },
        include: {
          product: { select: { name: true, baseUnit: true } }, warehouse: { select: { name: true } },
          batch: { select: { batchNumber: true } }, createdBy: { select: { fullName: true } },
        },
      }),
      this.prisma.stockMovement.count({ where }),
    ])
    return paged(items, total, p)
  }

  // --- Transferts inter-entrepôts ---

  async createTransfer(ctx: TenantContext, body: { fromWarehouseId: string; toWarehouseId: string; note?: string; items: { productId: string; quantity: number }[] }) {
    if (body.fromWarehouseId === body.toWarehouseId) throw new BadRequestException("L'origine et la destination doivent être différentes.")
    await this.ownedWarehouse(ctx, body.fromWarehouseId)
    // La destination appartient à l'entreprise, mais peut sortir du périmètre du demandeur.
    const destination = await this.prisma.warehouse.findFirst({ where: { id: body.toWarehouseId, companyId: ctx.companyId } })
    if (!destination) throw new NotFoundException('Entrepôt de destination introuvable.')
    for (const i of body.items) await this.ownedProduct(ctx, i.productId)
    return this.prisma.atomic(async (tx) => {
      const number = await this.seq.next(tx, ctx.companyId, 'transfer', 'TRF')
      return tx.stockTransfer.create({
        data: {
          companyId: ctx.companyId, number, fromWarehouseId: body.fromWarehouseId, toWarehouseId: body.toWarehouseId, note: body.note,
          createdById: ctx.userId, status: 'PENDING', items: { create: body.items },
        },
        include: { items: true },
      })
    })
  }

  private async getTransfer(ctx: TenantContext, id: string, tx: Tx) {
    const t = await tx.stockTransfer.findFirst({ where: { id, companyId: ctx.companyId }, include: { items: { include: { product: true } } } })
    if (!t) throw new NotFoundException('Transfert introuvable.')
    return t
  }

  /** Marque la transition d'état en une écriture conditionnelle : deux appels simultanés ne passent pas. */
  private async stepTransfer(tx: Tx, id: string, from: string, data: Prisma.StockTransferUpdateManyMutationInput) {
    const r = await tx.stockTransfer.updateMany({ where: { id, status: from }, data })
    if (r.count !== 1) throw new ConflictException('Ce transfert a changé d\'état entre-temps.')
  }

  async validateTransfer(ctx: TenantContext, id: string) {
    return this.prisma.atomic(async (tx) => {
      const t = await this.getTransfer(ctx, id, tx)
      assertWarehouse(ctx, t.fromWarehouseId)
      if (t.status !== 'PENDING') throw new ConflictException('Seul un transfert en attente peut être validé.')
      await this.stepTransfer(tx, id, 'PENDING', { status: 'VALIDATED', validatedAt: new Date() })
      for (const i of t.items) {
        await this.reserve(tx, ctx.companyId, t.fromWarehouseId, i.productId, i.quantity, { transferItemId: i.id })
      }
      await this.audit.log(ctx, 'stock.transfer_validated', 'StockTransfer', id, undefined, tx)
      return this.getTransfer(ctx, id, tx)
    })
  }

  async dispatchTransfer(ctx: TenantContext, id: string) {
    return this.prisma.atomic(async (tx) => {
      const t = await this.getTransfer(ctx, id, tx)
      assertWarehouse(ctx, t.fromWarehouseId)
      if (t.status !== 'VALIDATED') throw new ConflictException('Le transfert doit être validé avant son expédition.')
      await this.stepTransfer(tx, id, 'VALIDATED', { status: 'SHIPPED', dispatchedAt: new Date() })
      for (const i of t.items) {
        const allocations = await this.consume(tx, ctx.companyId, { transferItemId: i.id }, i.quantity, {
          direction: 'OUT', reason: 'TRANSFER_OUT', refType: 'StockTransfer', refId: id, userId: ctx.userId,
        })
        await tx.stockTransferItem.update({ where: { id: i.id }, data: { allocations: JSON.stringify(allocations) } })
      }
      return this.getTransfer(ctx, id, tx)
    })
  }

  /** La marchandise n'entre dans le stock de destination qu'à sa réception effective. */
  async receiveTransfer(ctx: TenantContext, id: string, body: { items: { itemId: string; quantityReceived: number }[]; note?: string }) {
    const result = await this.prisma.atomic(async (tx) => {
      const t = await this.getTransfer(ctx, id, tx)
      assertWarehouse(ctx, t.toWarehouseId)
      if (t.status !== 'SHIPPED') throw new ConflictException('Ce transfert n\'est pas en transit.')
      await this.stepTransfer(tx, id, 'SHIPPED', { status: 'CLOSED', receivedAt: new Date(), note: body.note ?? t.note })
      for (const i of t.items) {
        const line = body.items.find((x) => x.itemId === i.id)
        const received = D(line ? line.quantityReceived : i.quantity)
        if (received.greaterThan(i.quantity)) throw new UnprocessableEntityException(`Quantité reçue supérieure à la quantité expédiée pour ${i.product.name}.`)
        let remaining = received
        for (const a of JSON.parse(i.allocations ?? '[]') as Allocation[]) {
          if (!remaining.greaterThan(0)) break
          const take = Prisma.Decimal.min(D(a.quantity), remaining)
          // Les emplacements de l'origine n'existent pas à destination : le lot est conservé.
          await this.apply(
            tx,
            { companyId: ctx.companyId, warehouseId: t.toWarehouseId, productId: i.productId, batchId: a.batchId, onHand: take },
            { direction: 'IN', reason: 'TRANSFER_IN', refType: 'StockTransfer', refId: id, userId: ctx.userId },
          )
          remaining = remaining.minus(take)
        }
        await tx.stockTransferItem.update({ where: { id: i.id }, data: { quantityReceived: received } })
      }
      await this.audit.log(ctx, 'stock.transfer_received', 'StockTransfer', id, { number: t.number }, tx)
      return this.getTransfer(ctx, id, tx)
    })
    this.realtime.toCompany(ctx.companyId, 'stock.changed', {})
    await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER'], 'TRANSFER_RECEIVED', { number: result.number }, { type: 'StockTransfer', id })
    return result
  }

  async cancelTransfer(ctx: TenantContext, id: string) {
    return this.prisma.atomic(async (tx) => {
      const t = await this.getTransfer(ctx, id, tx)
      assertWarehouse(ctx, t.fromWarehouseId)
      if (!['PENDING', 'VALIDATED'].includes(t.status)) throw new ConflictException('Un transfert expédié ne peut plus être annulé.')
      await this.releaseReservations(tx, ctx.companyId, { transferItemId: { in: t.items.map((i) => i.id) } })
      await this.stepTransfer(tx, id, t.status, { status: 'CANCELLED' })
      return this.getTransfer(ctx, id, tx)
    })
  }

  async listTransfers(ctx: TenantContext, p: PageQuery) {
    const scope = ctx.warehouseIds ? { OR: [{ fromWarehouseId: { in: ctx.warehouseIds } }, { toWarehouseId: { in: ctx.warehouseIds } }] } : {}
    const where: Prisma.StockTransferWhereInput = { companyId: ctx.companyId, ...scope, ...(p.status ? { status: p.status } : {}) }
    const [items, total] = await Promise.all([
      this.prisma.stockTransfer.findMany({
        where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' },
        include: { fromWarehouse: { select: { name: true } }, toWarehouse: { select: { name: true } }, items: { include: { product: { select: { name: true, baseUnit: true } } } } },
      }),
      this.prisma.stockTransfer.count({ where }),
    ])
    return paged(items, total, p)
  }

  // --- Inventaires ---

  async openInventory(ctx: TenantContext, body: { warehouseId: string; kind: string; productIds?: string[]; locationId?: string }) {
    await this.ownedWarehouse(ctx, body.warehouseId)
    const productIds = [...new Set(body.productIds ?? [])]
    if (productIds.length && (await this.prisma.product.count({ where: { id: { in: productIds }, companyId: ctx.companyId } })) !== productIds.length) throw new NotFoundException('Produit introuvable.')
    if (body.locationId && !(await this.prisma.warehouseLocation.findFirst({ where: { id: body.locationId, companyId: ctx.companyId, warehouseId: body.warehouseId } }))) throw new NotFoundException('Emplacement introuvable.')
    return this.prisma.atomic(async (tx) => {
      const balances = await tx.stockBalance.findMany({
        where: {
          companyId: ctx.companyId, warehouseId: body.warehouseId,
          ...(body.productIds?.length ? { productId: { in: body.productIds } } : {}),
          ...(body.locationId ? { locationId: body.locationId } : {}),
        },
      })
      const number = await this.seq.next(tx, ctx.companyId, 'inventory', 'INV')
      return tx.inventorySession.create({
        data: {
          companyId: ctx.companyId, warehouseId: body.warehouseId, number, kind: body.kind, createdById: ctx.userId,
          items: { create: balances.map((b) => ({ balanceId: b.id, theoretical: b.onHand })) },
        },
        include: { items: true },
      })
    })
  }

  async getInventory(ctx: TenantContext, id: string) {
    const s = await this.prisma.inventorySession.findFirst({
      where: { id, companyId: ctx.companyId, ...warehouseScope(ctx) },
      include: {
        warehouse: { select: { name: true } },
        items: { include: { balance: { include: { product: { select: { name: true, reference: true, baseUnit: true } }, location: { select: { code: true } }, batch: { select: { batchNumber: true } } } } } },
      },
    })
    if (!s) throw new NotFoundException('Inventaire introuvable.')
    return s
  }

  async countInventory(ctx: TenantContext, id: string, body: { items: { itemId: string; counted: number; justification?: string }[] }) {
    const session = await this.getInventory(ctx, id)
    if (session.status !== 'OPEN') throw new ConflictException('Cet inventaire est clôturé.')
    for (const line of body.items) {
      if (!session.items.some((i) => i.id === line.itemId)) throw new NotFoundException('Ligne d\'inventaire introuvable.')
      await this.prisma.inventoryItem.update({ where: { id: line.itemId }, data: { counted: line.counted, justification: line.justification } })
    }
    return this.getInventory(ctx, id)
  }

  /** Clôture : chaque écart compté génère un ajustement traçable et doit être justifié. */
  async closeInventory(ctx: TenantContext, id: string) {
    const result = await this.prisma.atomic(async (tx) => {
      const session = await tx.inventorySession.findFirst({ where: { id, companyId: ctx.companyId, ...warehouseScope(ctx) }, include: { items: { include: { balance: true } } } })
      if (!session) throw new NotFoundException('Inventaire introuvable.')
      if (session.status !== 'OPEN') throw new ConflictException('Cet inventaire est déjà clôturé.')
      const adjustments: { itemId: string; difference: number }[] = []
      for (const item of session.items) {
        if (item.counted === null) continue
        // Écart constaté par rapport à l'ouverture, appliqué au solde courant : les mouvements postérieurs sont préservés.
        const expected = item.theoretical
        const diff = item.counted.minus(expected)
        if (diff.isZero()) continue
        if (!item.justification) throw new UnprocessableEntityException('Chaque écart doit être justifié avant la clôture.')
        const b = item.balance
        await this.apply(
          tx,
          { companyId: ctx.companyId, warehouseId: b.warehouseId, productId: b.productId, locationId: b.locationId, batchId: b.batchId, onHand: diff },
          { direction: diff.greaterThan(0) ? 'IN' : 'OUT', reason: 'ADJUSTMENT', refType: 'InventorySession', refId: id, note: item.justification, userId: ctx.userId },
        )
        adjustments.push({ itemId: item.id, difference: diff.toNumber() })
      }
      await tx.inventorySession.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: ctx.userId } })
      await this.audit.log(ctx, 'stock.inventory_closed', 'InventorySession', id, { adjustments }, tx)
      return { adjustments }
    })
    this.realtime.toCompany(ctx.companyId, 'stock.changed', {})
    return result
  }

  async listInventories(ctx: TenantContext, p: PageQuery) {
    const where: Prisma.InventorySessionWhereInput = { companyId: ctx.companyId, ...warehouseScope(ctx), ...(p.status ? { status: p.status } : {}) }
    const [items, total] = await Promise.all([
      this.prisma.inventorySession.findMany({ where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' }, include: { warehouse: { select: { name: true } }, _count: { select: { items: true } } } }),
      this.prisma.inventorySession.count({ where }),
    ])
    return paged(items, total, p)
  }
}
