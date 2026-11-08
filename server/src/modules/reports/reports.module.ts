/** Tableaux de bord par profil et rapports exportables (PDF, Excel, CSV). */
import { Controller, Get, Injectable, Module, Query, Res, StreamableFile } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import ExcelJS from 'exceljs'
import type { Response } from 'express'
import PDFDocument from 'pdfkit'
import { AuthOnly, Ctx, RequirePerm, SuperAdminOnly, warehouseScope, type AuthContext, type TenantContext } from '../../common/context.js'
import { PrismaService } from '../../common/prisma.service.js'
import { FileService } from '../../common/core.services.js'
import { brandName, drawCompanyHeader, drawDocumentTitle, drawFooters, excelBrandRows, loadBrand } from '../../common/pdf.js'
import { companyTimeZone, dayBound, formatDateTime, startOfDay } from '../../common/time.js'
import { DELIVERY_STATUS_LABELS, type DeliveryStatus } from '../../common/constants.js'
import { D, escapeCsv } from '../../common/util.js'
import { available } from '../stock/stock.service.js'

type Q = Record<string, string | undefined>
interface Column { key: string; label: string }
interface Report { title: string; columns: Column[]; rows: Record<string, unknown>[] }

/** Période saisie à l'écran, comprise dans le fuseau horaire de l'entreprise. */
function range(q: Q, tz: string): { gte?: Date; lte?: Date } | undefined {
  const out: { gte?: Date; lte?: Date } = {}
  if (q.from && !Number.isNaN(dayBound(q.from, tz, false).getTime())) out.gte = dayBound(q.from, tz, false)
  if (q.to && !Number.isNaN(dayBound(q.to, tz, true).getTime())) out.lte = dayBound(q.to, tz, true)
  return out.gte || out.lte ? out : undefined
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly files: FileService) {}

  /** Tous les indicateurs proviennent des opérations enregistrées. */
  async platform() {
    const [companies, active, suspended, warehouses, users, drivers, deliveries, delivered, failed, subscriptions, revenue] = await Promise.all([
      this.prisma.company.count({ where: { deletedAt: null } }),
      this.prisma.company.count({ where: { status: 'active', deletedAt: null } }),
      this.prisma.company.count({ where: { status: 'suspended', deletedAt: null } }),
      this.prisma.warehouse.count(),
      this.prisma.user.count({ where: { isSuperAdmin: false } }),
      this.prisma.driver.count({ where: { deletedAt: null } }),
      this.prisma.delivery.count(),
      this.prisma.delivery.count({ where: { status: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] } } }),
      this.prisma.delivery.count({ where: { status: 'FAILED' } }),
      this.prisma.subscription.groupBy({ by: ['status'], where: { isCurrent: true }, _count: true }),
      this.prisma.payment.groupBy({ by: ['currency'], where: { status: 'SUCCEEDED' }, _sum: { amount: true } }),
    ])
    const done = delivered + failed
    return {
      companies, active, suspended, warehouses, users, drivers, deliveries, delivered, failed,
      successRate: done ? Math.round((delivered / done) * 1000) / 10 : null,
      subscriptions: subscriptions.map((s) => ({ status: s.status, count: s._count })),
      revenue: revenue.map((r) => ({ currency: r.currency, amount: r._sum.amount })),
    }
  }

  async company(ctx: TenantContext) {
    const companyId = ctx.companyId
    const scope = warehouseScope(ctx)
    const start = startOfDay(new Date(), await companyTimeZone(this.prisma, companyId))
    const now = new Date()
    const finished = ['DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED']
    const [balances, warehouses, customers, drivers, activeDrivers, vehiclesAvailable, deliveriesToday, inProgress, deliveredToday, failed, late, ordersOpen, movementsToday, recentMovements, recentDeliveries, pendingTransfers, openInventories] = await Promise.all([
      this.prisma.stockBalance.findMany({ where: { companyId, ...scope }, include: { product: { select: { unitCost: true, lowStockLevel: true, name: true, baseUnit: true } } } }),
      this.prisma.warehouse.count({ where: { companyId, status: 'active', ...(ctx.warehouseIds ? { id: { in: ctx.warehouseIds } } : {}) } }),
      this.prisma.customer.count({ where: { companyId, status: 'active' } }),
      this.prisma.driver.count({ where: { companyId, deletedAt: null } }),
      this.prisma.driver.count({ where: { companyId, deletedAt: null, status: 'on_mission' } }),
      this.prisma.vehicle.count({ where: { companyId, deletedAt: null, status: 'available' } }),
      this.prisma.delivery.count({ where: { companyId, ...scope, scheduledAt: { gte: start } } }),
      this.prisma.delivery.count({ where: { companyId, ...scope, status: { in: ['ASSIGNED', 'LOADED', 'IN_TRANSIT', 'ARRIVED'] } } }),
      this.prisma.delivery.count({ where: { companyId, ...scope, status: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }, deliveredAt: { gte: start } } }),
      this.prisma.delivery.count({ where: { companyId, ...scope, status: 'FAILED' } }),
      this.prisma.delivery.count({ where: { companyId, ...scope, scheduledAt: { lt: now }, status: { notIn: finished } } }),
      this.prisma.order.count({ where: { companyId, ...scope, status: { notIn: ['CLOSED', 'CANCELLED'] } } }),
      this.prisma.stockMovement.groupBy({ by: ['direction'], where: { companyId, ...scope, createdAt: { gte: start } }, _count: true }),
      this.prisma.stockMovement.findMany({ where: { companyId, ...scope }, take: 8, orderBy: { createdAt: 'desc' }, include: { product: { select: { name: true, baseUnit: true } }, warehouse: { select: { name: true } } } }),
      this.prisma.delivery.findMany({ where: { companyId, ...scope }, take: 8, orderBy: { updatedAt: 'desc' }, select: { id: true, number: true, status: true, scheduledAt: true, customer: { select: { name: true } }, driver: { select: { fullName: true } } } }),
      this.prisma.stockTransfer.count({ where: { companyId, status: { in: ['PENDING', 'VALIDATED', 'SHIPPED'] } } }),
      this.prisma.inventorySession.count({ where: { companyId, ...scope, status: 'OPEN' } }),
    ])
    let stockValue = D(0)
    let totalAvailable = D(0)
    let reserved = D(0)
    let damaged = D(0)
    const perProduct = new Map<string, { name: string; unit: string; level: Prisma.Decimal | null; qty: Prisma.Decimal }>()
    for (const b of balances) {
      stockValue = stockValue.plus(b.onHand.times(D(b.product.unitCost)))
      totalAvailable = totalAvailable.plus(available(b))
      reserved = reserved.plus(b.reserved)
      damaged = damaged.plus(b.damaged)
      const row = perProduct.get(b.productId) ?? { name: b.product.name, unit: b.product.baseUnit, level: b.product.lowStockLevel, qty: D(0) }
      row.qty = row.qty.plus(available(b))
      perProduct.set(b.productId, row)
    }
    const lowStock = [...perProduct.values()].filter((p) => p.level && p.qty.lessThanOrEqualTo(p.level)).slice(0, 10)
    const count = (dir: string) => movementsToday.find((m) => m.direction === dir)?._count ?? 0
    return {
      stockValue, totalAvailable, reserved, damaged, warehouses, customers, drivers, activeDrivers, vehiclesAvailable, deliveriesToday, inProgress, deliveredToday, failed, late, ordersOpen,
      entriesToday: count('IN'), exitsToday: count('OUT'), pendingTransfers, openInventories, lowStock, recentMovements, recentDeliveries,
    }
  }

  async stocks(ctx: TenantContext, q: Q): Promise<Report> {
    const rows = await this.prisma.stockBalance.findMany({
      where: { companyId: ctx.companyId, ...warehouseScope(ctx), ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}), ...(q.productId ? { productId: q.productId } : {}) },
      take: 20000, include: { product: true, warehouse: true, batch: true, location: true },
    })
    return {
      title: 'Rapport des stocks',
      columns: [
        { key: 'warehouse', label: 'Entrepôt' }, { key: 'reference', label: 'Référence' }, { key: 'product', label: 'Produit' }, { key: 'batch', label: 'Lot' }, { key: 'location', label: 'Emplacement' },
        { key: 'unit', label: 'Unité' }, { key: 'onHand', label: 'Physique' }, { key: 'reserved', label: 'Réservé' }, { key: 'blocked', label: 'Bloqué' }, { key: 'damaged', label: 'Endommagé' }, { key: 'available', label: 'Disponible' },
      ],
      rows: rows.map((b) => ({
        warehouse: b.warehouse.name, reference: b.product.reference, product: b.product.name, batch: b.batch?.batchNumber ?? '', location: b.location?.code ?? '', unit: b.product.baseUnit,
        onHand: b.onHand.toNumber(), reserved: b.reserved.toNumber(), blocked: b.blocked.toNumber(), damaged: b.damaged.toNumber(), available: available(b).toNumber(),
      })),
    }
  }

  async deliveries(ctx: TenantContext, q: Q): Promise<Report> {
    const rows = await this.prisma.delivery.findMany({
      where: {
        companyId: ctx.companyId, ...warehouseScope(ctx), createdAt: range(q, await companyTimeZone(this.prisma, ctx.companyId)), ...(q.status ? { status: q.status } : {}), ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}),
        ...(q.customerId ? { customerId: q.customerId } : {}), ...(q.driverId ? { driverId: q.driverId } : {}), ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}),
        ...(q.commune ? { deliveryPoint: { commune: q.commune } } : {}), ...(q.routeId ? { stops: { some: { routeId: q.routeId } } } : {}),
      },
      take: 20000, orderBy: { createdAt: 'desc' }, include: { customer: true, deliveryPoint: true, driver: true, vehicle: true, warehouse: true },
    })
    return {
      title: 'Rapport des livraisons',
      columns: [
        { key: 'number', label: 'Numéro' }, { key: 'status', label: 'État' }, { key: 'customer', label: 'Client' }, { key: 'point', label: 'Point de livraison' }, { key: 'commune', label: 'Commune' }, { key: 'warehouse', label: 'Entrepôt' },
        { key: 'driver', label: 'Chauffeur' }, { key: 'vehicle', label: 'Véhicule' }, { key: 'scheduledAt', label: 'Prévue' }, { key: 'deliveredAt', label: 'Livrée' }, { key: 'attempts', label: 'Tentatives' }, { key: 'failure', label: "Motif d'échec" },
      ],
      rows: rows.map((d) => ({
        number: d.number, status: DELIVERY_STATUS_LABELS[d.status as DeliveryStatus], customer: d.customer.name, point: d.deliveryPoint.name, commune: d.deliveryPoint.commune ?? '', warehouse: d.warehouse.name,
        driver: d.driver?.fullName ?? '', vehicle: d.vehicle?.registration ?? '', scheduledAt: d.scheduledAt, deliveredAt: d.deliveredAt, attempts: d.attempts, failure: d.failureReason ?? '',
      })),
    }
  }

  async drivers(ctx: TenantContext, q: Q): Promise<Report> {
    const drivers = await this.prisma.driver.findMany({ where: { companyId: ctx.companyId, deletedAt: null } })
    const stats = await this.prisma.delivery.groupBy({ by: ['driverId', 'status'], where: { companyId: ctx.companyId, driverId: { not: null }, createdAt: range(q, await companyTimeZone(this.prisma, ctx.companyId)) }, _count: true })
    const n = (id: string, statuses: string[]) => stats.filter((s) => s.driverId === id && statuses.includes(s.status)).reduce((sum, s) => sum + s._count, 0)
    return {
      title: 'Performances des chauffeurs',
      columns: [
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Chauffeur' }, { key: 'assigned', label: 'Missions' }, { key: 'delivered', label: 'Livrées' }, { key: 'partial', label: 'Partielles' },
        { key: 'failed', label: 'Échecs' }, { key: 'successRate', label: 'Réussite (%)' },
      ],
      rows: drivers.map((d) => {
        const delivered = n(d.id, ['DELIVERED'])
        const partial = n(d.id, ['PARTIALLY_DELIVERED'])
        const failed = n(d.id, ['FAILED'])
        const done = delivered + partial + failed
        const assigned = stats.filter((s) => s.driverId === d.id).reduce((sum, s) => sum + s._count, 0)
        return { code: d.code, name: d.fullName, assigned, delivered, partial, failed, successRate: done ? Math.round(((delivered + partial) / done) * 1000) / 10 : '' }
      }),
    }
  }

  async warehouses(ctx: TenantContext, q: Q): Promise<Report> {
    const warehouses = await this.prisma.warehouse.findMany({ where: { companyId: ctx.companyId, ...(ctx.warehouseIds ? { id: { in: ctx.warehouseIds } } : {}) } })
    const [moves, balances] = await Promise.all([
      this.prisma.stockMovement.groupBy({ by: ['warehouseId', 'direction'], where: { companyId: ctx.companyId, createdAt: range(q, await companyTimeZone(this.prisma, ctx.companyId)) }, _count: true, _sum: { quantity: true } }),
      this.prisma.stockBalance.groupBy({ by: ['warehouseId'], where: { companyId: ctx.companyId }, _sum: { onHand: true, reserved: true, damaged: true } }),
    ])
    return {
      title: 'Activité des entrepôts',
      columns: [
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Entrepôt' }, { key: 'entries', label: 'Entrées' }, { key: 'exits', label: 'Sorties' }, { key: 'onHand', label: 'Stock physique' }, { key: 'reserved', label: 'Réservé' }, { key: 'damaged', label: 'Endommagé' },
      ],
      rows: warehouses.map((w) => {
        const b = balances.find((x) => x.warehouseId === w.id)
        const q2 = (dir: string) => moves.find((m) => m.warehouseId === w.id && m.direction === dir)?._sum.quantity?.toNumber() ?? 0
        return { code: w.code, name: w.name, entries: q2('IN'), exits: q2('OUT'), onHand: b?._sum.onHand?.toNumber() ?? 0, reserved: b?._sum.reserved?.toNumber() ?? 0, damaged: b?._sum.damaged?.toNumber() ?? 0 }
      }),
    }
  }

  async export(report: Report, format: string, companyId?: string | null): Promise<{ buffer: Buffer; mime: string; ext: string }> {
    if (format === 'csv') {
      const lines = [report.columns.map((c) => escapeCsv(c.label)).join(';'), ...report.rows.map((r) => report.columns.map((c) => escapeCsv(r[c.key])).join(';'))]
      // BOM : Excel reconnaît ainsi l'UTF-8 et les accents.
      return { buffer: Buffer.from(`﻿${lines.join('\r\n')}`, 'utf8'), mime: 'text/csv; charset=utf-8', ext: 'csv' }
    }
    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook()
      const brand = await loadBrand(this.prisma, companyId)
      const tz = companyId ? await companyTimeZone(this.prisma, companyId) : undefined
      wb.creator = brandName(brand)
      const ws = wb.addWorksheet(report.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31))
      ws.columns = report.columns.map((c) => ({ key: c.key, width: Math.max(14, c.label.length + 4) }))
      // Même en-tête que les PDF : entreprise, coordonnées, titre, puis le tableau.
      const headerRow = excelBrandRows(ws, brand, report.title, `Édité le ${formatDateTime(new Date(), tz)} • ${report.rows.length} ligne(s)`, report.columns.length)
      const head = ws.addRow(report.columns.map((c) => c.label))
      head.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } } })
      report.rows.forEach((r) => ws.addRow(report.columns.map((c) => (r[c.key] instanceof Date ? formatDateTime(r[c.key] as Date, tz) : r[c.key] ?? ''))))
      ws.views = [{ state: 'frozen', ySplit: headerRow }]
      return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' }
    }
    const brand = await loadBrand(this.prisma, companyId)
    const tz = companyId ? await companyTimeZone(this.prisma, companyId) : undefined
    const meta = `Édité le ${formatDateTime(new Date(), tz)}  •  ${report.rows.length} ligne(s)`
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, bufferPages: true, info: { Title: report.title, Author: brandName(brand) } })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))
    await drawCompanyHeader(doc, brand, this.files)
    drawDocumentTitle(doc, report.title, meta)
    const width = (doc.page.width - 64) / report.columns.length
    const header = () => {
      const y = doc.y
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#64748B')
      report.columns.forEach((c, i) => doc.text(c.label, 32 + i * width, y, { width: width - 4 }))
      doc.y = y + 16
    }
    header()
    doc.font('Helvetica').fontSize(7.5).fillColor('#14213D')
    for (const row of report.rows) {
      if (doc.y > doc.page.height - 64) {
        doc.addPage()
        header()
        doc.font('Helvetica').fontSize(7.5).fillColor('#14213D')
      }
      const y = doc.y
      let bottom = y
      report.columns.forEach((c, i) => {
        const v = row[c.key]
        doc.text(v instanceof Date ? formatDateTime(v, tz) : String(v ?? ''), 32 + i * width, y, { width: width - 4 })
        bottom = Math.max(bottom, doc.y)
      })
      doc.moveTo(32, bottom + 2).lineTo(doc.page.width - 32, bottom + 2).strokeColor('#E2E8F0').lineWidth(0.4).stroke()
      doc.y = bottom + 5
    }
    drawFooters(doc, brand)
    doc.end()
    return { buffer: await done, mime: 'application/pdf', ext: 'pdf' }
  }
}

@Controller()
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  private async send(report: Report, format: string | undefined, name: string, res: Response, ctx?: TenantContext) {
    if (!format || format === 'json') return report
    if (!['csv', 'xlsx', 'pdf'].includes(format)) return report
    const { buffer, mime, ext } = await this.svc.export(report, format, ctx?.companyId)
    res.setHeader('Content-Type', mime)
    res.setHeader('Content-Disposition', `attachment; filename="${name}.${ext}"`)
    return new StreamableFile(buffer)
  }

  @AuthOnly() @Get('dashboard/overview')
  overview(@Ctx() ctx: AuthContext) {
    if (ctx.companyId) return this.svc.company(ctx as TenantContext)
    if (ctx.isSuperAdmin) return this.svc.platform()
    return {}
  }

  @SuperAdminOnly() @Get('admin/dashboard')
  platform() { return this.svc.platform() }

  @RequirePerm('reports.view') @Get('reports/stocks')
  async stocks(@Ctx() ctx: TenantContext, @Query() q: Q, @Res({ passthrough: true }) res: Response) { return this.send(await this.svc.stocks(ctx, q), q.format, 'stocks', res, ctx) }

  @RequirePerm('reports.view') @Get('reports/deliveries')
  async deliveries(@Ctx() ctx: TenantContext, @Query() q: Q, @Res({ passthrough: true }) res: Response) { return this.send(await this.svc.deliveries(ctx, q), q.format, 'livraisons', res, ctx) }

  @RequirePerm('reports.view') @Get('reports/drivers')
  async drivers(@Ctx() ctx: TenantContext, @Query() q: Q, @Res({ passthrough: true }) res: Response) { return this.send(await this.svc.drivers(ctx, q), q.format, 'chauffeurs', res, ctx) }

  @RequirePerm('reports.view') @Get('reports/warehouses')
  async warehouses(@Ctx() ctx: TenantContext, @Query() q: Q, @Res({ passthrough: true }) res: Response) { return this.send(await this.svc.warehouses(ctx, q), q.format, 'entrepots', res, ctx) }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
