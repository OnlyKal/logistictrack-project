/** Référentiels d'une entreprise : agences, entrepôts, produits, fournisseurs, clients. */
import { Body, ConflictException, Controller, Delete, Get, HttpCode, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { AuditService, SequenceService } from '../../common/core.services.js'
import { LimitsService } from '../../common/limits.service.js'
import { assertWarehouse, Ctx, RequirePerm, warehouseScope, type TenantContext } from '../../common/context.js'
import { lat, lng, money, Msg, optDate, paged, patchOf, parsePage, qty, qtyOrZero, uuid, zod } from '../../common/http.js'
import { PrismaService } from '../../common/prisma.service.js'
import { PACKAGING_TYPES, PHYSICAL_NATURES, VEHICLE_TYPES, WAREHOUSE_TYPES } from '../../common/constants.js'
import { opaqueToken } from '../../common/util.js'

const text = (max = 190) => z.string().trim().min(1).max(max)
const optText = (max = 190) => z.string().trim().max(max).nullish()

// ---------- Agences ----------
const agencySchema = z.object({
  name: text(), address: optText(), phone: optText(40), manager: optText(), latitude: lat.nullish(), longitude: lng.nullish(),
  status: z.enum(['active', 'inactive']).optional(),
})

@Controller('agencies')
export class AgencyController {
  constructor(private readonly prisma: PrismaService, private readonly seq: SequenceService) {}

  @RequirePerm('warehouse.view') @Get()
  list(@Ctx() ctx: TenantContext) { return this.prisma.agency.findMany({ where: { companyId: ctx.companyId }, orderBy: { name: 'asc' } }) }

  @RequirePerm('agency.manage') @Post()
  create(@Ctx() ctx: TenantContext, @Body(zod(agencySchema)) body: z.infer<typeof agencySchema>) {
    // Le code est toujours généré par le serveur : il reste unique, même lors de créations simultanées.
    return this.prisma.atomic(async (tx) => tx.agency.create({ data: { ...body, companyId: ctx.companyId, code: await this.seq.next(tx, ctx.companyId, 'agency', 'AGC') } }))
  }

  @RequirePerm('agency.manage') @Patch(':id')
  async update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(patchOf(agencySchema))) body: Partial<z.infer<typeof agencySchema>>) {
    const row = await this.prisma.agency.findFirst({ where: { id, companyId: ctx.companyId } })
    if (!row) throw new NotFoundException('Agence introuvable.')
    return this.prisma.agency.update({ where: { id }, data: body })
  }
}

// ---------- Entrepôts ----------
const warehouseSchema = z.object({
  name: text(), type: z.enum(WAREHOUSE_TYPES).default('GENERAL'), agencyId: uuid.nullish(), address: optText(),
  latitude: lat.nullish(), longitude: lng.nullish(), manager: optText(), phone: optText(40), maxCapacity: qty.nullish(), surface: qty.nullish(),
  status: z.enum(['active', 'inactive', 'closed']).optional(),
})
const zoneSchema = z.object({ name: text(), code: text(30), kind: z.enum(['STORAGE', 'RECEIVING', 'SHIPPING', 'QUARANTINE']).default('STORAGE') })
const aisleSchema = z.object({ name: text(), code: text(30) })
const locationSchema = z.object({ code: text(40), aisleId: uuid.nullish(), shelf: optText(40), compartment: optText(40) })

@Controller('warehouses')
export class WarehouseController {
  constructor(private readonly prisma: PrismaService, private readonly limits: LimitsService, private readonly audit: AuditService, private readonly seq: SequenceService) {}

  private async owned(ctx: TenantContext, id: string) {
    assertWarehouse(ctx, id)
    const wh = await this.prisma.warehouse.findFirst({ where: { id, companyId: ctx.companyId } })
    if (!wh) throw new NotFoundException('Entrepôt introuvable.')
    return wh
  }

  private async checkAgency(ctx: TenantContext, agencyId?: string | null) {
    if (agencyId && !(await this.prisma.agency.findFirst({ where: { id: agencyId, companyId: ctx.companyId } }))) {
      throw new NotFoundException('Agence introuvable.')
    }
  }

  @RequirePerm('warehouse.view') @Get()
  async list(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.WarehouseWhereInput = {
      companyId: ctx.companyId, ...(ctx.warehouseIds ? { id: { in: ctx.warehouseIds } } : {}),
      ...(p.q ? { OR: [{ name: { contains: p.q } }, { code: { contains: p.q } }] } : {}),
    }
    const [items, total] = await Promise.all([
      this.prisma.warehouse.findMany({ where, skip: p.skip, take: p.take, orderBy: { name: 'asc' }, include: { agency: { select: { name: true } } } }),
      this.prisma.warehouse.count({ where }),
    ])
    return paged(items, total, p)
  }

  @RequirePerm('warehouse.manage') @Post()
  async create(@Ctx() ctx: TenantContext, @Body(zod(warehouseSchema)) body: z.infer<typeof warehouseSchema>) {
    await this.limits.assertCanAdd(ctx.companyId, 'warehouses')
    await this.checkAgency(ctx, body.agencyId)
    const wh = await this.prisma.atomic(async (tx) => tx.warehouse.create({ data: { ...body, companyId: ctx.companyId, code: await this.seq.next(tx, ctx.companyId, 'warehouse', 'ENT') } }))
    await this.audit.log(ctx, 'warehouse.create', 'Warehouse', wh.id)
    return wh
  }

  @RequirePerm('warehouse.view') @Get(':id')
  async get(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    await this.owned(ctx, id)
    return this.prisma.warehouse.findUnique({ where: { id }, include: { agency: true, zones: { include: { aisles: true } } } })
  }

  @RequirePerm('warehouse.manage') @Patch(':id')
  async update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(patchOf(warehouseSchema))) body: Partial<z.infer<typeof warehouseSchema>>) {
    await this.owned(ctx, id)
    await this.checkAgency(ctx, body.agencyId)
    return this.prisma.warehouse.update({ where: { id }, data: body })
  }

  @RequirePerm('warehouse.view') @Get(':id/locations')
  async locations(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    await this.owned(ctx, id)
    return this.prisma.warehouseLocation.findMany({ where: { warehouseId: id }, orderBy: { code: 'asc' }, include: { aisle: { include: { zone: { select: { name: true } } } } } })
  }

  @RequirePerm('warehouse.manage') @Post(':id/zones')
  async addZone(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(zoneSchema)) body: z.infer<typeof zoneSchema>) {
    await this.owned(ctx, id)
    return this.prisma.warehouseZone.create({ data: { ...body, warehouseId: id, companyId: ctx.companyId } })
  }

  @RequirePerm('warehouse.manage') @Post(':id/zones/:zoneId/aisles')
  async addAisle(@Ctx() ctx: TenantContext, @Param('id') id: string, @Param('zoneId') zoneId: string, @Body(zod(aisleSchema)) body: z.infer<typeof aisleSchema>) {
    await this.owned(ctx, id)
    if (!(await this.prisma.warehouseZone.findFirst({ where: { id: zoneId, warehouseId: id } }))) throw new NotFoundException('Zone introuvable.')
    return this.prisma.warehouseAisle.create({ data: { ...body, zoneId } })
  }

  @RequirePerm('warehouse.manage') @Post(':id/locations')
  async addLocation(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(locationSchema)) body: z.infer<typeof locationSchema>) {
    await this.owned(ctx, id)
    if (body.aisleId && !(await this.prisma.warehouseAisle.findFirst({ where: { id: body.aisleId, zone: { warehouseId: id } } }))) throw new NotFoundException('Rayon introuvable.')
    return this.prisma.warehouseLocation.create({ data: { ...body, warehouseId: id, companyId: ctx.companyId, qrToken: opaqueToken() } })
  }
}

// ---------- Produits ----------
const productSchema = z.object({
  name: text(), reference: text(60), description: optText(2000), categoryId: uuid.nullish(), brand: optText(), barcode: optText(60),
  physicalNature: z.enum(PHYSICAL_NATURES).default('SOLID'), baseUnit: text(20).default('unit'),
  unitWeightKg: qtyOrZero.nullish(), unitVolumeM3: qtyOrZero.nullish(), dimensions: optText(60), storageCondition: optText(),
  fragility: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']).default('NONE'), hazardClass: optText(40),
  requiredVehicle: z.enum(VEHICLE_TYPES).nullish(), unitCost: money.nullish(), salePrice: money.nullish(), lowStockLevel: qtyOrZero.nullish(),
  trackBatches: z.boolean().default(false), isActive: z.boolean().optional(),
})
const productPatch = patchOf(productSchema)
const packagingSchema = z.object({ name: text(80), type: z.enum(PACKAGING_TYPES), quantityPerUnit: qty, barcode: optText(60) })
const batchSchema = z.object({ batchNumber: text(80), manufacturedAt: optDate, expiresAt: optDate, supplierId: uuid.nullish() })

@Controller('products')
export class ProductController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async owned(ctx: TenantContext, id: string) {
    const p = await this.prisma.product.findFirst({ where: { id, companyId: ctx.companyId, deletedAt: null } })
    if (!p) throw new NotFoundException('Produit introuvable.')
    return p
  }
  private async checkCategory(ctx: TenantContext, categoryId?: string | null) {
    if (categoryId && !(await this.prisma.productCategory.findFirst({ where: { id: categoryId, companyId: ctx.companyId } }))) throw new NotFoundException('Catégorie introuvable.')
  }

  @RequirePerm('product.view') @Get('categories')
  categories(@Ctx() ctx: TenantContext) { return this.prisma.productCategory.findMany({ where: { companyId: ctx.companyId }, orderBy: { name: 'asc' } }) }

  @RequirePerm('product.manage') @Post('categories')
  addCategory(@Ctx() ctx: TenantContext, @Body(zod(z.object({ name: text(80) }))) body: { name: string }) { return this.prisma.productCategory.create({ data: { ...body, companyId: ctx.companyId } }) }

  @RequirePerm('product.view', 'order.create') @Get()
  async list(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.ProductWhereInput = {
      companyId: ctx.companyId, deletedAt: null,
      ...(p.q ? { OR: [{ name: { contains: p.q } }, { reference: { contains: p.q } }, { barcode: { contains: p.q } }] } : {}),
      ...(p.categoryId ? { categoryId: String(p.categoryId) } : {}),
    }
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({ where, skip: p.skip, take: p.take, orderBy: { name: 'asc' }, include: { category: { select: { name: true } }, packagings: true } }),
      this.prisma.product.count({ where }),
    ])
    return paged(items, total, p)
  }

  @RequirePerm('product.manage') @Post()
  async create(@Ctx() ctx: TenantContext, @Body(zod(productSchema)) body: z.infer<typeof productSchema>) {
    await this.checkCategory(ctx, body.categoryId)
    return this.prisma.product.create({ data: { ...body, companyId: ctx.companyId } })
  }

  @RequirePerm('product.view') @Get(':id')
  async get(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    await this.owned(ctx, id)
    return this.prisma.product.findUnique({ where: { id }, include: { category: true, packagings: true, batches: { orderBy: { receivedAt: 'desc' }, take: 50 } } })
  }

  @RequirePerm('product.manage') @Patch(':id')
  async update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(productPatch)) body: z.infer<typeof productPatch>) {
    await this.owned(ctx, id)
    await this.checkCategory(ctx, body.categoryId)
    return this.prisma.product.update({ where: { id }, data: body })
  }

  /** Suppression logique : l'historique des mouvements reste exploitable. */
  @RequirePerm('product.manage') @Delete(':id') @Msg('Produit archivé.')
  async remove(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    await this.owned(ctx, id)
    const stock = await this.prisma.stockBalance.aggregate({ where: { productId: id }, _sum: { onHand: true } })
    if (stock._sum.onHand?.greaterThan(0)) throw new ConflictException('Ce produit possède encore du stock.')
    await this.prisma.product.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } })
    await this.audit.log(ctx, 'product.archive', 'Product', id)
  }

  @RequirePerm('product.manage') @Post(':id/packagings')
  async addPackaging(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(packagingSchema)) body: z.infer<typeof packagingSchema>) {
    await this.owned(ctx, id)
    return this.prisma.productPackaging.create({ data: { ...body, productId: id, companyId: ctx.companyId } })
  }

  @RequirePerm('product.manage') @Post(':id/batches')
  async addBatch(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(batchSchema)) body: z.infer<typeof batchSchema>) {
    await this.owned(ctx, id)
    if (body.supplierId && !(await this.prisma.supplier.findFirst({ where: { id: body.supplierId, companyId: ctx.companyId } }))) throw new NotFoundException('Fournisseur introuvable.')
    return this.prisma.productBatch.create({ data: { ...body, productId: id, companyId: ctx.companyId } })
  }

  @RequirePerm('stock.view') @Get(':id/stock')
  async stock(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    await this.owned(ctx, id)
    return this.prisma.stockBalance.findMany({ where: { productId: id, companyId: ctx.companyId, ...warehouseScope(ctx) }, include: { warehouse: { select: { name: true } }, batch: true, location: true } })
  }
}

// ---------- Fournisseurs et bons de commande ----------
const supplierSchema = z.object({ name: text(), contact: optText(), phone: optText(40), email: z.string().email().nullish(), address: optText(), isActive: z.boolean().optional() })
const purchaseSchema = z.object({
  supplierId: uuid, warehouseId: uuid, expectedAt: optDate, note: optText(1000),
  items: z.array(z.object({ productId: uuid, quantity: qty, unitCost: money.nullish() })).min(1).max(500),
})

@Controller()
export class SupplierController {
  constructor(private readonly prisma: PrismaService, private readonly seq: SequenceService) {}

  @RequirePerm('supplier.manage', 'stock.receive') @Get('suppliers')
  async list(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.SupplierWhereInput = { companyId: ctx.companyId, ...(p.q ? { name: { contains: p.q } } : {}) }
    const [items, total] = await Promise.all([this.prisma.supplier.findMany({ where, skip: p.skip, take: p.take, orderBy: { name: 'asc' } }), this.prisma.supplier.count({ where })])
    return paged(items, total, p)
  }

  @RequirePerm('supplier.manage') @Post('suppliers')
  create(@Ctx() ctx: TenantContext, @Body(zod(supplierSchema)) body: z.infer<typeof supplierSchema>) { return this.prisma.supplier.create({ data: { ...body, companyId: ctx.companyId } }) }

  @RequirePerm('supplier.manage') @Patch('suppliers/:id')
  async update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(patchOf(supplierSchema))) body: Partial<z.infer<typeof supplierSchema>>) {
    if (!(await this.prisma.supplier.findFirst({ where: { id, companyId: ctx.companyId } }))) throw new NotFoundException('Fournisseur introuvable.')
    return this.prisma.supplier.update({ where: { id }, data: body })
  }

  @RequirePerm('supplier.manage', 'stock.receive') @Get('purchase-orders')
  async orders(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.PurchaseOrderWhereInput = { companyId: ctx.companyId, ...warehouseScope(ctx), ...(p.status ? { status: p.status } : {}) }
    const [items, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' }, include: { supplier: { select: { name: true } }, warehouse: { select: { name: true } }, items: { include: { product: { select: { name: true, baseUnit: true } } } } } }),
      this.prisma.purchaseOrder.count({ where }),
    ])
    return paged(items, total, p)
  }

  @RequirePerm('supplier.manage') @Post('purchase-orders')
  async createOrder(@Ctx() ctx: TenantContext, @Body(zod(purchaseSchema)) body: z.infer<typeof purchaseSchema>) {
    assertWarehouse(ctx, body.warehouseId)
    const [supplier, warehouse, products] = await Promise.all([
      this.prisma.supplier.findFirst({ where: { id: body.supplierId, companyId: ctx.companyId } }),
      this.prisma.warehouse.findFirst({ where: { id: body.warehouseId, companyId: ctx.companyId } }),
      this.prisma.product.count({ where: { id: { in: body.items.map((i) => i.productId) }, companyId: ctx.companyId } }),
    ])
    if (!supplier || !warehouse || products !== new Set(body.items.map((i) => i.productId)).size) throw new NotFoundException('Fournisseur, entrepôt ou produit introuvable.')
    return this.prisma.atomic(async (tx) => {
      const number = await this.seq.next(tx, ctx.companyId, 'purchase', 'BCF')
      return tx.purchaseOrder.create({ data: { companyId: ctx.companyId, number, supplierId: body.supplierId, warehouseId: body.warehouseId, expectedAt: body.expectedAt, note: body.note, items: { create: body.items } }, include: { items: true } })
    })
  }

  @RequirePerm('supplier.manage') @Post('purchase-orders/:id/validate') @HttpCode(200) @Msg('Bon de commande validé.')
  async validate(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    if (!(await this.prisma.purchaseOrder.findFirst({ where: { id, companyId: ctx.companyId } }))) throw new NotFoundException('Bon de commande introuvable.')
    const r = await this.prisma.purchaseOrder.updateMany({ where: { id, companyId: ctx.companyId, status: 'DRAFT' }, data: { status: 'VALIDATED' } })
    if (r.count !== 1) throw new ConflictException('Ce bon de commande ne peut pas être validé.')
    return this.prisma.purchaseOrder.findUnique({ where: { id } })
  }
}

// ---------- Clients et points de livraison ----------
const customerSchema = z.object({
  code: text(40).optional(), name: text(), type: z.enum(['COMPANY', 'INDIVIDUAL']).default('COMPANY'), phone: optText(40),
  email: z.string().email().nullish(), address: optText(), notes: optText(2000), status: z.enum(['active', 'inactive']).optional(), emailNotifications: z.boolean().optional(),
  contacts: z.array(z.object({ name: text(), phone: optText(40), email: z.string().email().nullish(), role: optText(80) })).max(20).optional(),
})
const pointSchema = z.object({
  name: text(), address: text(), commune: optText(80), city: optText(80), latitude: lat.nullish(), longitude: lng.nullish(), contactName: optText(),
  phone: optText(40), openingHours: optText(120), instructions: optText(1000), restrictions: optText(1000), isActive: z.boolean().optional(),
})

@Controller('customers')
export class CustomerController {
  constructor(private readonly prisma: PrismaService, private readonly seq: SequenceService) {}

  private async owned(ctx: TenantContext, id: string) {
    const c = await this.prisma.customer.findFirst({ where: { id, companyId: ctx.companyId } })
    if (!c) throw new NotFoundException('Client introuvable.')
    return c
  }

  @RequirePerm('customer.view') @Get()
  async list(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.CustomerWhereInput = { companyId: ctx.companyId, ...(p.q ? { OR: [{ name: { contains: p.q } }, { code: { contains: p.q } }, { phone: { contains: p.q } }] } : {}) }
    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({ where, skip: p.skip, take: p.take, orderBy: { name: 'asc' }, include: { deliveryPoints: { where: { isActive: true } }, _count: { select: { deliveryPoints: true } } } }),
      this.prisma.customer.count({ where }),
    ])
    return paged(items, total, p)
  }

  @RequirePerm('customer.manage') @Post()
  async create(@Ctx() ctx: TenantContext, @Body(zod(customerSchema)) body: z.infer<typeof customerSchema>) {
    const { contacts, ...data } = body
    return this.prisma.atomic(async (tx) => {
      const code = data.code ?? (await this.seq.next(tx, ctx.companyId, 'customer', 'CLI'))
      return tx.customer.create({ data: { ...data, code, companyId: ctx.companyId, contacts: contacts ? { create: contacts } : undefined }, include: { contacts: true } })
    })
  }

  @RequirePerm('customer.view') @Get(':id')
  async get(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    await this.owned(ctx, id)
    return this.prisma.customer.findUnique({
      where: { id },
      include: {
        contacts: true, deliveryPoints: true,
        orders: { take: 20, orderBy: { createdAt: 'desc' }, select: { id: true, number: true, status: true, total: true, createdAt: true } },
        deliveries: { take: 20, orderBy: { createdAt: 'desc' }, select: { id: true, number: true, status: true, scheduledAt: true, createdAt: true } },
      },
    })
  }

  @RequirePerm('customer.manage') @Patch(':id')
  async update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(patchOf(customerSchema))) body: Partial<z.infer<typeof customerSchema>>) {
    await this.owned(ctx, id)
    const { contacts, ...data } = body
    return this.prisma.$transaction(async (tx) => {
      if (contacts) {
        await tx.customerContact.deleteMany({ where: { customerId: id } })
        await tx.customerContact.createMany({ data: contacts.map((c) => ({ ...c, customerId: id })) })
      }
      return tx.customer.update({ where: { id }, data, include: { contacts: true } })
    })
  }

  @RequirePerm('customer.view') @Get(':id/delivery-points')
  async points(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    await this.owned(ctx, id)
    return this.prisma.deliveryPoint.findMany({ where: { customerId: id }, orderBy: { name: 'asc' } })
  }

  @RequirePerm('customer.manage') @Post(':id/delivery-points')
  async addPoint(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(pointSchema)) body: z.infer<typeof pointSchema>) {
    await this.owned(ctx, id)
    return this.prisma.deliveryPoint.create({ data: { ...body, customerId: id, companyId: ctx.companyId } })
  }

  @RequirePerm('customer.manage') @Patch(':id/delivery-points/:pointId')
  async updatePoint(@Ctx() ctx: TenantContext, @Param('id') id: string, @Param('pointId') pointId: string, @Body(zod(patchOf(pointSchema))) body: Partial<z.infer<typeof pointSchema>>) {
    await this.owned(ctx, id)
    if (!(await this.prisma.deliveryPoint.findFirst({ where: { id: pointId, customerId: id, companyId: ctx.companyId } }))) throw new NotFoundException('Point de livraison introuvable.')
    return this.prisma.deliveryPoint.update({ where: { id: pointId }, data: body })
  }
}

@Module({ controllers: [AgencyController, WarehouseController, ProductController, SupplierController, CustomerController] })
export class CatalogModule {}
