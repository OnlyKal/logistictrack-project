import { Body, ConflictException, Controller, Get, HttpCode, Injectable, Module, NotFoundException, Param, Patch, Post, Query, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { AuditService, NotificationService, SequenceService } from '../../common/core.services.js'
import { assertWarehouse, Ctx, RequirePerm, warehouseScope, type TenantContext } from '../../common/context.js'
import { Idempotent, money, Msg, optDate, paged, parsePage, patchOf, qty, uuid, zod, type PageQuery } from '../../common/http.js'
import { PrismaService, type Tx } from '../../common/prisma.service.js'
import { ORDER_TRANSITIONS } from '../../common/constants.js'
import { D } from '../../common/util.js'
import { StockModule } from '../stock/stock.module.js'
import { StockService } from '../stock/stock.service.js'

const itemSchema = z.object({
  productId: uuid, quantity: qty, unitPrice: money.default(0), discount: money.default(0), taxRate: z.coerce.number().min(0).max(100).default(0),
})
const orderSchema = z.object({
  customerId: uuid, deliveryPointId: uuid, warehouseId: uuid, requestedDate: optDate, instructions: z.string().max(2000).nullish(),
  items: z.array(itemSchema).min(1).max(500),
})
const prepareSchema = z.object({ items: z.array(z.object({ orderItemId: uuid, quantity: qty })).min(1).max(500) })

const ORDER_INCLUDE = {
  customer: { select: { id: true, name: true, code: true } },
  deliveryPoint: { select: { id: true, name: true, commune: true, city: true, address: true } },
  warehouse: { select: { id: true, name: true } },
  items: { include: { product: { select: { id: true, name: true, reference: true, baseUnit: true } } } },
} satisfies Prisma.OrderInclude

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService, private readonly seq: SequenceService, private readonly stock: StockService,
    private readonly audit: AuditService, private readonly notifications: NotificationService,
  ) {}

  private totals(items: z.infer<typeof itemSchema>[]) {
    let total = D(0)
    let discountTotal = D(0)
    let taxTotal = D(0)
    for (const i of items) {
      const gross = D(i.quantity).times(i.unitPrice)
      const net = Prisma.Decimal.max(gross.minus(i.discount), 0)
      const tax = net.times(i.taxRate).dividedBy(100).toDecimalPlaces(2)
      discountTotal = discountTotal.plus(i.discount)
      taxTotal = taxTotal.plus(tax)
      total = total.plus(net).plus(tax)
    }
    return { total, discountTotal, taxTotal }
  }

  /** Le client, le point et les produits doivent appartenir à la même entreprise. */
  private async checkRefs(ctx: TenantContext, body: Pick<z.infer<typeof orderSchema>, 'customerId' | 'deliveryPointId' | 'warehouseId' | 'items'>) {
    assertWarehouse(ctx, body.warehouseId)
    const [customer, point, warehouse, products] = await Promise.all([
      this.prisma.customer.findFirst({ where: { id: body.customerId, companyId: ctx.companyId } }),
      this.prisma.deliveryPoint.findFirst({ where: { id: body.deliveryPointId, customerId: body.customerId, companyId: ctx.companyId } }),
      this.prisma.warehouse.findFirst({ where: { id: body.warehouseId, companyId: ctx.companyId } }),
      this.prisma.product.count({ where: { id: { in: body.items.map((i) => i.productId) }, companyId: ctx.companyId, deletedAt: null } }),
    ])
    if (!customer) throw new NotFoundException('Client introuvable.')
    if (!point) throw new NotFoundException('Ce point de livraison n\'appartient pas à ce client.')
    if (!warehouse) throw new NotFoundException('Entrepôt introuvable.')
    if (products !== new Set(body.items.map((i) => i.productId)).size) throw new NotFoundException('Produit introuvable.')
  }

  private async get(ctx: TenantContext, id: string, tx?: Tx) {
    const order = await (tx ?? this.prisma).order.findFirst({ where: { id, companyId: ctx.companyId, ...warehouseScope(ctx) }, include: ORDER_INCLUDE })
    if (!order) throw new NotFoundException('Commande introuvable.')
    return order
  }

  async detail(ctx: TenantContext, id: string) {
    const order = await this.get(ctx, id)
    const [history, deliveries, packages] = await Promise.all([
      this.prisma.orderStatusHistory.findMany({ where: { orderId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.delivery.findMany({ where: { orderId: id, companyId: ctx.companyId }, select: { id: true, number: true, status: true, scheduledAt: true } }),
      this.prisma.package.findMany({ where: { orderId: id, companyId: ctx.companyId }, include: { items: true } }),
    ])
    return { ...order, history, deliveries, packages }
  }

  async list(ctx: TenantContext, p: PageQuery) {
    const where: Prisma.OrderWhereInput = {
      companyId: ctx.companyId, ...warehouseScope(ctx), ...(p.status ? { status: p.status } : {}),
      ...(p.q ? { OR: [{ number: { contains: p.q } }, { customer: { name: { contains: p.q } } }] } : {}),
    }
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({ where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' }, include: ORDER_INCLUDE }),
      this.prisma.order.count({ where }),
    ])
    return paged(items, total, p)
  }

  async create(ctx: TenantContext, body: z.infer<typeof orderSchema>) {
    await this.checkRefs(ctx, body)
    const order = await this.prisma.atomic(async (tx) => {
      const number = await this.seq.next(tx, ctx.companyId, 'order', 'CMD')
      return tx.order.create({
        data: {
          companyId: ctx.companyId, number, customerId: body.customerId, deliveryPointId: body.deliveryPointId, warehouseId: body.warehouseId,
          requestedDate: body.requestedDate, instructions: body.instructions, createdById: ctx.userId, ...this.totals(body.items),
          items: { create: body.items }, history: { create: { status: 'DRAFT', userId: ctx.userId } },
        },
        include: ORDER_INCLUDE,
      })
    })
    await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'LOGISTICS_MANAGER'], 'ORDER_CREATED', { number: order.number }, { type: 'Order', id: order.id })
    return order
  }

  async update(ctx: TenantContext, id: string, body: Partial<z.infer<typeof orderSchema>>) {
    const order = await this.get(ctx, id)
    if (order.status !== 'DRAFT') throw new ConflictException('Seule une commande en brouillon est modifiable.')
    const merged = {
      customerId: body.customerId ?? order.customerId, deliveryPointId: body.deliveryPointId ?? order.deliveryPointId, warehouseId: body.warehouseId ?? order.warehouseId,
      items: body.items ?? order.items.map((i) => ({ productId: i.productId, quantity: i.quantity.toNumber(), unitPrice: i.unitPrice.toNumber(), discount: i.discount.toNumber(), taxRate: i.taxRate.toNumber() })),
    }
    await this.checkRefs(ctx, merged)
    return this.prisma.$transaction(async (tx) => {
      if (body.items) await tx.orderItem.deleteMany({ where: { orderId: id } })
      const { items, ...rest } = body
      return tx.order.update({
        where: { id },
        data: { ...rest, ...this.totals(merged.items), ...(items ? { items: { create: items } } : {}) },
        include: ORDER_INCLUDE,
      })
    })
  }

  /** Transition conditionnelle : une double validation simultanée ne peut réussir qu'une fois. */
  private async move(tx: Tx, ctx: TenantContext, id: string, from: string, to: string, note?: string) {
    if (!ORDER_TRANSITIONS[from]?.includes(to)) throw new ConflictException(`Transition impossible : ${from} vers ${to}.`)
    const r = await tx.order.updateMany({ where: { id, status: from }, data: { status: to } })
    if (r.count !== 1) throw new ConflictException("Cette commande a changé d'état entre-temps.")
    await tx.orderStatusHistory.create({ data: { orderId: id, status: to, userId: ctx.userId, note } })
  }

  async submit(ctx: TenantContext, id: string) {
    return this.prisma.atomic(async (tx) => {
      const order = await this.get(ctx, id, tx)
      await this.move(tx, ctx, id, order.status, 'SUBMITTED')
      return this.get(ctx, id, tx)
    })
  }

  /** Validation commerciale : vérifie et réserve le stock de chaque ligne. */
  async validate(ctx: TenantContext, id: string) {
    const order = await this.prisma.atomic(async (tx) => {
      const current = await this.get(ctx, id, tx)
      await this.move(tx, ctx, id, current.status, 'VALIDATED')
      for (const item of current.items) {
        await this.stock.reserve(tx, ctx.companyId, current.warehouseId, item.productId, item.quantity, { orderItemId: item.id })
      }
      await this.audit.log(ctx, 'order.validate', 'Order', id, { number: current.number }, tx)
      return this.get(ctx, id, tx)
    })
    await this.notifications.notifyRoles(ctx.companyId, ['WAREHOUSE_MANAGER', 'LOGISTICS_MANAGER'], 'ORDER_VALIDATED', { number: order.number }, { type: 'Order', id })
    return order
  }

  /** Une commande peut être préparée en plusieurs fois. */
  async prepare(ctx: TenantContext, id: string, body: z.infer<typeof prepareSchema>) {
    const order = await this.prisma.atomic(async (tx) => {
      const current = await this.get(ctx, id, tx)
      if (!['VALIDATED', 'PREPARING', 'PARTIALLY_PREPARED', 'PARTIALLY_SHIPPED'].includes(current.status)) throw new ConflictException("Cette commande n'est pas en préparation.")
      for (const line of body.items) {
        const item = current.items.find((i) => i.id === line.orderItemId)
        if (!item) throw new NotFoundException('Ligne de commande introuvable.')
        const r = await tx.orderItem.updateMany({ where: { id: item.id, quantityPrepared: item.quantityPrepared }, data: { quantityPrepared: item.quantityPrepared.plus(line.quantity) } })
        if (r.count !== 1) throw new ConflictException('Préparation modifiée entre-temps, veuillez réessayer.')
        if (item.quantityPrepared.plus(line.quantity).greaterThan(item.quantity)) throw new UnprocessableEntityException(`Quantité préparée supérieure à la commande pour ${item.product.name}.`)
      }
      const items = await tx.orderItem.findMany({ where: { orderId: id } })
      const ready = items.every((i) => i.quantityPrepared.greaterThanOrEqualTo(i.quantity))
      const to = ready ? 'READY' : 'PARTIALLY_PREPARED'
      if (current.status !== 'PARTIALLY_SHIPPED' && current.status !== to) await this.move(tx, ctx, id, current.status, to)
      return this.get(ctx, id, tx)
    })
    if (order.status === 'READY') await this.notifications.notifyRoles(ctx.companyId, ['COMPANY_ADMIN', 'LOGISTICS_MANAGER'], 'GOODS_READY', { number: order.number }, { type: 'Order', id })
    return order
  }

  /** L'annulation libère les quantités encore réservées. */
  async cancel(ctx: TenantContext, id: string, note?: string) {
    return this.prisma.atomic(async (tx) => {
      const order = await this.get(ctx, id, tx)
      if (order.items.some((i) => i.quantityShipped.greaterThan(0))) throw new ConflictException('Une commande déjà expédiée ne peut plus être annulée.')
      await this.move(tx, ctx, id, order.status, 'CANCELLED', note)
      await this.stock.releaseReservations(tx, ctx.companyId, { orderItemId: { in: order.items.map((i) => i.id) } })
      await this.audit.log(ctx, 'order.cancel', 'Order', id, { number: order.number, note }, tx)
      return this.get(ctx, id, tx)
    })
  }
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @RequirePerm('order.view') @Get()
  list(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) { return this.orders.list(ctx, parsePage(q)) }

  @RequirePerm('order.create') @Idempotent() @Post() @Msg('Commande créée.')
  create(@Ctx() ctx: TenantContext, @Body(zod(orderSchema)) body: z.infer<typeof orderSchema>) { return this.orders.create(ctx, body) }

  @RequirePerm('order.view') @Get(':id')
  get(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.orders.detail(ctx, id) }

  @RequirePerm('order.create') @Patch(':id')
  update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(patchOf(orderSchema))) body: Partial<z.infer<typeof orderSchema>>) { return this.orders.update(ctx, id, body) }

  @RequirePerm('order.create') @Post(':id/submit') @HttpCode(200) @Msg('Commande soumise.')
  submit(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.orders.submit(ctx, id) }

  @RequirePerm('order.validate') @Idempotent() @Post(':id/validate') @HttpCode(200) @Msg('Commande validée, stock réservé.')
  validate(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.orders.validate(ctx, id) }

  @RequirePerm('order.prepare') @Post(':id/prepare') @HttpCode(200) @Msg('Préparation enregistrée.')
  prepare(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(prepareSchema)) body: z.infer<typeof prepareSchema>) { return this.orders.prepare(ctx, id, body) }

  @RequirePerm('order.validate') @Post(':id/cancel') @HttpCode(200) @Msg('Commande annulée.')
  cancel(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(z.object({ note: z.string().max(500).optional() }))) body: { note?: string }) { return this.orders.cancel(ctx, id, body.note) }
}

@Module({ imports: [StockModule], controllers: [OrdersController], providers: [OrdersService] })
export class OrdersModule {}
