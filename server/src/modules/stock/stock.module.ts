import { Body, Controller, Get, HttpCode, Module, Param, Post, Query } from '@nestjs/common'
import { z } from 'zod'
import { Ctx, RequirePerm, type TenantContext } from '../../common/context.js'
import { Idempotent, Msg, optDate, parsePage, qty, qtyOrZero, money, uuid, zod } from '../../common/http.js'
import { STOCK_IN_REASONS, STOCK_OUT_REASONS } from '../../common/constants.js'
import { StockService } from './stock.service.js'

const receiptSchema = z.object({
  warehouseId: uuid,
  supplierId: uuid.optional(),
  purchaseOrderId: uuid.optional(),
  reason: z.enum(STOCK_IN_REASONS.filter((r) => r !== 'TRANSFER_IN' && r !== 'ADJUSTMENT') as [string, ...string[]]).default('SUPPLIER'),
  note: z.string().max(1000).optional(),
  items: z.array(z.object({
    productId: uuid, quantity: qty, locationId: uuid.nullish(), unitCost: money.optional(),
    batchNumber: z.string().trim().min(1).max(80).optional(), manufacturedAt: optDate, expiresAt: optDate,
    packagingId: uuid.optional(), packagingQuantity: qty.optional(),
  })).min(1).max(500),
})
const issueSchema = z.object({
  warehouseId: uuid, productId: uuid, quantity: qty,
  reason: z.enum(STOCK_OUT_REASONS.filter((r) => ['LOSS', 'DAMAGED', 'INTERNAL_USE'].includes(r)) as [string, ...string[]]),
  locationId: uuid.nullish(), batchId: uuid.nullish(), note: z.string().max(1000).optional(),
})
const adjustSchema = z.object({ balanceId: uuid, countedQuantity: qtyOrZero, reason: z.string().trim().min(3).max(500) })
const transferSchema = z.object({
  fromWarehouseId: uuid, toWarehouseId: uuid, note: z.string().max(1000).optional(),
  items: z.array(z.object({ productId: uuid, quantity: qty })).min(1).max(500),
})
const transferReceiveSchema = z.object({
  note: z.string().max(1000).optional(),
  items: z.array(z.object({ itemId: uuid, quantityReceived: qtyOrZero })).max(500).default([]),
})
const inventorySchema = z.object({
  warehouseId: uuid, kind: z.enum(['FULL', 'PARTIAL', 'LOCATION']).default('FULL'),
  productIds: z.array(uuid).max(500).optional(), locationId: uuid.optional(),
})
const countSchema = z.object({
  items: z.array(z.object({ itemId: uuid, counted: qtyOrZero, justification: z.string().trim().max(500).optional() })).min(1).max(2000),
})

@Controller('stocks')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @RequirePerm('stock.view') @Get()
  balances(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) { return this.stock.listBalances(ctx, parsePage(q)) }

  @RequirePerm('stock.view') @Get('as-of')
  asOf(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) { return this.stock.asOf(ctx, parsePage(q)) }

  @RequirePerm('stock.view') @Get('movements')
  movements(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) { return this.stock.listMovements(ctx, parsePage(q)) }

  @RequirePerm('stock.receive') @Idempotent() @Post('receipts') @Msg('Réception enregistrée.')
  receipt(@Ctx() ctx: TenantContext, @Body(zod(receiptSchema)) body: z.infer<typeof receiptSchema>) { return this.stock.receive(ctx, body) }

  @RequirePerm('stock.issue') @Idempotent() @Post('issues') @Msg('Sortie enregistrée.')
  issue(@Ctx() ctx: TenantContext, @Body(zod(issueSchema)) body: z.infer<typeof issueSchema>) { return this.stock.issue(ctx, body) }

  @RequirePerm('stock.adjust') @Idempotent() @Post('adjustments') @Msg('Ajustement enregistré.')
  adjust(@Ctx() ctx: TenantContext, @Body(zod(adjustSchema)) body: z.infer<typeof adjustSchema>) { return this.stock.adjust(ctx, body) }

  @RequirePerm('stock.view') @Get('transfers')
  transfers(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) { return this.stock.listTransfers(ctx, parsePage(q)) }

  @RequirePerm('stock.transfer') @Post('transfers') @Msg('Demande de transfert créée.')
  createTransfer(@Ctx() ctx: TenantContext, @Body(zod(transferSchema)) body: z.infer<typeof transferSchema>) { return this.stock.createTransfer(ctx, body) }

  @RequirePerm('stock.transfer') @Post('transfers/:id/validate') @HttpCode(200) @Msg('Transfert validé, stock réservé.')
  validate(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.stock.validateTransfer(ctx, id) }

  @RequirePerm('stock.transfer') @Post('transfers/:id/dispatch') @HttpCode(200) @Msg('Transfert expédié.')
  dispatch(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.stock.dispatchTransfer(ctx, id) }

  @RequirePerm('stock.transfer') @Post('transfers/:id/receive') @HttpCode(200) @Msg('Transfert réceptionné.')
  receive(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(transferReceiveSchema)) body: z.infer<typeof transferReceiveSchema>) { return this.stock.receiveTransfer(ctx, id, body) }

  @RequirePerm('stock.transfer') @Post('transfers/:id/cancel') @HttpCode(200) @Msg('Transfert annulé.')
  cancel(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.stock.cancelTransfer(ctx, id) }

  @RequirePerm('stock.view') @Get('inventories')
  inventories(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) { return this.stock.listInventories(ctx, parsePage(q)) }

  @RequirePerm('inventory.manage') @Post('inventories') @Msg('Inventaire ouvert.')
  openInventory(@Ctx() ctx: TenantContext, @Body(zod(inventorySchema)) body: z.infer<typeof inventorySchema>) { return this.stock.openInventory(ctx, body) }

  @RequirePerm('stock.view') @Get('inventories/:id')
  inventory(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.stock.getInventory(ctx, id) }

  @RequirePerm('inventory.manage') @Post('inventories/:id/count') @HttpCode(200) @Msg('Comptage enregistré.')
  count(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(countSchema)) body: z.infer<typeof countSchema>) { return this.stock.countInventory(ctx, id, body) }

  @RequirePerm('inventory.manage') @Post('inventories/:id/close') @HttpCode(200) @Msg('Inventaire clôturé.')
  close(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.stock.closeInventory(ctx, id) }
}

@Module({ controllers: [StockController], providers: [StockService], exports: [StockService] })
export class StockModule {}
