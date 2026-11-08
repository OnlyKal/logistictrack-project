/**
 * Import CSV : marchandises, clients (avec un point de livraison) et stock initial.
 * Tout le fichier est vérifié d'abord ; à la moindre erreur, rien n'est enregistré.
 */
import { BadRequestException, Controller, Get, Header, HttpCode, Injectable, Module, Param, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common'
import { ForbiddenException } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Prisma } from '@prisma/client'
import { AuditService, SequenceService } from '../../common/core.services.js'
import { Ctx, RequirePerm, type TenantContext } from '../../common/context.js'
import { columnKey, parseCsv, toCsv } from '../../common/csv.js'
import { PrismaService } from '../../common/prisma.service.js'
import { PHYSICAL_NATURES } from '../../common/constants.js'
import { StockModule } from '../stock/stock.module.js'
import { StockService } from '../stock/stock.service.js'

type Kind = 'products' | 'customers' | 'stock'
type Row = Record<string, string>
interface LineError { line: number; message: string }
export interface ImportResult { dryRun: boolean; total: number; created: number; updated: number; errors: LineError[] }

const MAX_ROWS = 5000
const PERMISSION: Record<Kind, string> = { products: 'product.manage', customers: 'customer.manage', stock: 'stock.receive' }

/** Colonnes de chaque modèle ; « * » signale une colonne obligatoire. Une ligne d'exemple accompagne chaque modèle. */
const TEMPLATES: Record<Kind, { columns: string[]; example: string[] }> = {
  products: {
    columns: ['reference*', 'nom*', 'unite', 'categorie', 'marque', 'code_barres', 'nature', 'poids_kg', 'volume_m3', 'cout_unitaire', 'prix_vente', 'seuil_alerte', 'suivi_lots', 'description'],
    example: ['CIM-50', 'Ciment 50 kg', 'sac', 'Matériaux', 'Lafarge', '6111234567890', 'poudre', '50', '0,03', '9,50', '12', '20', 'non', 'Sac de ciment gris'],
  },
  customers: {
    columns: ['nom*', 'code', 'type', 'telephone', 'email', 'adresse', 'notes', 'point_nom', 'point_adresse', 'point_commune', 'point_ville', 'point_latitude', 'point_longitude', 'point_contact', 'point_telephone'],
    example: ['Supermarché Kin Marché', '', 'entreprise', '+243 81 000 0000', 'achats@kinmarche.cd', '12 avenue du Commerce, Gombe', '', 'Dépôt Limete', '7 boulevard Lumumba', 'Limete', 'Kinshasa', '-4.36', '15.35', 'Aline', '+243 82 000 0000'],
  },
  stock: {
    columns: ['entrepot*', 'reference*', 'quantite*', 'lot', 'expiration', 'cout_unitaire', 'emplacement'],
    example: ['ENT-2026-000001', 'CIM-50', '250', '', '', '9,50', ''],
  },
}

const NATURES: Record<string, string> = { solide: 'SOLID', liquide: 'LIQUID', poudre: 'POWDER', granule: 'GRANULE', granules: 'GRANULE', gaz: 'GAS', mixte: 'MIXED', autre: 'OTHER' }

const text = (v?: string) => (v ?? '').trim()
function number(v: string | undefined, label: string, errors: string[], { min = 0, required = false } = {}) {
  const raw = text(v).replace(/\s/g, '').replace(',', '.')
  if (!raw) {
    if (required) errors.push(`${label} est obligatoire.`)
    return null
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min) {
    errors.push(`${label} : « ${v} » n'est pas un nombre valide.`)
    return null
  }
  return n
}
function bool(v?: string) { return ['oui', 'o', 'yes', 'y', 'true', 'vrai', '1', 'x'].includes(text(v).toLowerCase()) }
function date(v: string | undefined, label: string, errors: string[]) {
  const raw = text(v)
  if (!raw) return null
  const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw)
  const value = fr ? new Date(Date.UTC(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]))) : new Date(raw)
  if (Number.isNaN(value.getTime())) errors.push(`${label} : « ${raw} » n'est pas une date (JJ/MM/AAAA).`)
  return value
}

@Injectable()
export class ImportsService {
  constructor(private readonly prisma: PrismaService, private readonly seq: SequenceService, private readonly stock: StockService, private readonly audit: AuditService) {}

  template(kind: Kind) {
    const t = TEMPLATES[kind]
    return toCsv([t.columns, t.example])
  }

  private read(csv: string): { rows: Row[]; errors: LineError[] } {
    const lines = parseCsv(csv)
    if (!lines.length) throw new BadRequestException('Le fichier est vide.')
    if (lines.length - 1 > MAX_ROWS) throw new BadRequestException(`Au plus ${MAX_ROWS} lignes par fichier.`)
    const headers = lines[0].map(columnKey)
    const rows = lines.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])))
    return { rows, errors: [] }
  }

  private missing(kind: Kind, csv: string) {
    const headers = parseCsv(csv)[0]?.map(columnKey) ?? []
    return TEMPLATES[kind].columns.filter((c) => c.endsWith('*')).map((c) => columnKey(c)).filter((c) => !headers.includes(c))
  }

  async run(ctx: TenantContext, kind: Kind, csv: string, dryRun: boolean): Promise<ImportResult> {
    if (!ctx.permissions.has(PERMISSION[kind])) throw new ForbiddenException('Permission insuffisante.')
    const absent = this.missing(kind, csv)
    if (absent.length) throw new BadRequestException(`Colonne(s) obligatoire(s) absente(s) : ${absent.join(', ')}. Partez du modèle à télécharger.`)
    const { rows } = this.read(csv)
    if (!rows.length) throw new BadRequestException('Aucune ligne à importer.')
    const result = kind === 'products' ? await this.products(ctx, rows, dryRun) : kind === 'customers' ? await this.customers(ctx, rows, dryRun) : await this.stockRows(ctx, rows, dryRun)
    if (!dryRun && !result.errors.length) await this.audit.log(ctx, `import.${kind}`, 'Import', undefined, { total: result.total, created: result.created, updated: result.updated })
    return result
  }

  private async products(ctx: TenantContext, rows: Row[], dryRun: boolean): Promise<ImportResult> {
    const errors: LineError[] = []
    const seen = new Set<string>()
    const parsed = rows.map((r, i) => {
      const line = i + 2
      const e: string[] = []
      const reference = text(r.reference)
      const name = text(r.nom)
      if (!reference) e.push('La référence est obligatoire.')
      else if (reference.length > 60) e.push('Référence trop longue (60 caractères au plus).')
      if (!name) e.push('Le nom est obligatoire.')
      if (reference && seen.has(reference.toLowerCase())) e.push(`La référence ${reference} apparaît deux fois dans le fichier.`)
      seen.add(reference.toLowerCase())
      const natureText = text(r.nature).toLowerCase()
      const nature = natureText ? NATURES[natureText] ?? (PHYSICAL_NATURES as readonly string[]).find((n) => n.toLowerCase() === natureText) : 'SOLID'
      if (!nature) e.push(`Nature inconnue : « ${r.nature} » (solide, liquide, poudre, granulé, gaz, mixte, autre).`)
      const data = {
        reference, name, baseUnit: text(r.unite) || 'unité', brand: text(r.marque) || null, barcode: text(r.code_barres) || null, description: text(r.description) || null,
        physicalNature: nature ?? 'SOLID', unitWeightKg: number(r.poids_kg, 'Poids', e), unitVolumeM3: number(r.volume_m3, 'Volume', e),
        unitCost: number(r.cout_unitaire, 'Coût unitaire', e), salePrice: number(r.prix_vente, 'Prix de vente', e), lowStockLevel: number(r.seuil_alerte, 'Seuil d\'alerte', e),
        trackBatches: bool(r.suivi_lots),
      }
      e.forEach((message) => errors.push({ line, message }))
      return { data, category: text(r.categorie) }
    })
    const existing = await this.prisma.product.findMany({ where: { companyId: ctx.companyId, reference: { in: parsed.map((p) => p.data.reference) } }, select: { id: true, reference: true } })
    const byRef = new Map(existing.map((p) => [p.reference, p.id]))
    const result: ImportResult = { dryRun, total: rows.length, created: parsed.filter((p) => !byRef.has(p.data.reference)).length, updated: parsed.filter((p) => byRef.has(p.data.reference)).length, errors }
    if (dryRun || errors.length) return result
    await this.prisma.atomic(async (tx) => {
      const categories = new Map<string, string>()
      for (const p of parsed) {
        let categoryId: string | undefined
        if (p.category) {
          categoryId = categories.get(p.category.toLowerCase())
          if (!categoryId) {
            const found = await tx.productCategory.findFirst({ where: { companyId: ctx.companyId, name: p.category } })
            categoryId = found?.id ?? (await tx.productCategory.create({ data: { companyId: ctx.companyId, name: p.category } })).id
            categories.set(p.category.toLowerCase(), categoryId)
          }
        }
        const id = byRef.get(p.data.reference)
        // Mise à jour : seules les colonnes remplies remplacent les valeurs existantes.
        const filled = Object.fromEntries(Object.entries(p.data).filter(([, v]) => v !== null && v !== ''))
        if (id) await tx.product.update({ where: { id }, data: { ...filled, ...(categoryId ? { categoryId } : {}) } })
        else await tx.product.create({ data: { ...p.data, companyId: ctx.companyId, categoryId } as Prisma.ProductUncheckedCreateInput })
      }
    })
    return result
  }

  private async customers(ctx: TenantContext, rows: Row[], dryRun: boolean): Promise<ImportResult> {
    const errors: LineError[] = []
    const parsed = rows.map((r, i) => {
      const line = i + 2
      const e: string[] = []
      const name = text(r.nom)
      if (!name) e.push('Le nom est obligatoire.')
      const kindText = text(r.type).toLowerCase()
      const type = !kindText || kindText.startsWith('entreprise') || kindText === 'company' ? 'COMPANY' : kindText.startsWith('particulier') || kindText === 'individual' ? 'INDIVIDUAL' : null
      if (!type) e.push(`Type inconnu : « ${r.type} » (entreprise ou particulier).`)
      const email = text(r.email)
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.push(`Adresse e-mail invalide : « ${email} ».`)
      const pointName = text(r.point_nom)
      const pointAddress = text(r.point_adresse)
      if (pointName && !pointAddress) e.push("L'adresse du point de livraison est obligatoire quand son nom est renseigné.")
      const latitude = number(r.point_latitude, 'Latitude', e, { min: -90 })
      const longitude = number(r.point_longitude, 'Longitude', e, { min: -180 })
      if (latitude !== null && latitude > 90) e.push('Latitude hors limites.')
      if (longitude !== null && longitude > 180) e.push('Longitude hors limites.')
      e.forEach((message) => errors.push({ line, message }))
      return {
        code: text(r.code) || null,
        data: { name, type: type ?? 'COMPANY', phone: text(r.telephone) || null, email: email.toLowerCase() || null, address: text(r.adresse) || null, notes: text(r.notes) || null },
        point: pointName ? { name: pointName, address: pointAddress, commune: text(r.point_commune) || null, city: text(r.point_ville) || null, latitude, longitude, contactName: text(r.point_contact) || null, phone: text(r.point_telephone) || null } : null,
      }
    })
    const codes = parsed.map((p) => p.code).filter((c): c is string => !!c)
    const existing = await this.prisma.customer.findMany({ where: { companyId: ctx.companyId, code: { in: codes } }, select: { id: true, code: true } })
    const byCode = new Map(existing.map((c) => [c.code, c.id]))
    const result: ImportResult = { dryRun, total: rows.length, created: parsed.filter((p) => !p.code || !byCode.has(p.code)).length, updated: parsed.filter((p) => p.code && byCode.has(p.code)).length, errors }
    if (dryRun || errors.length) return result
    await this.prisma.atomic(async (tx) => {
      for (const p of parsed) {
        let id = p.code ? byCode.get(p.code) : undefined
        if (id) await tx.customer.update({ where: { id }, data: Object.fromEntries(Object.entries(p.data).filter(([, v]) => v !== null && v !== '')) })
        else id = (await tx.customer.create({ data: { ...p.data, companyId: ctx.companyId, code: p.code ?? (await this.seq.next(tx, ctx.companyId, 'customer', 'CLI')) } })).id
        if (p.point && !(await tx.deliveryPoint.findFirst({ where: { customerId: id, name: p.point.name } }))) {
          await tx.deliveryPoint.create({ data: { ...p.point, customerId: id, companyId: ctx.companyId } })
        }
      }
    })
    return result
  }

  private async stockRows(ctx: TenantContext, rows: Row[], dryRun: boolean): Promise<ImportResult> {
    const errors: LineError[] = []
    const warehouses = await this.prisma.warehouse.findMany({ where: { companyId: ctx.companyId, ...(ctx.warehouseIds ? { id: { in: ctx.warehouseIds } } : {}) }, select: { id: true, code: true, name: true } })
    const products = await this.prisma.product.findMany({ where: { companyId: ctx.companyId, deletedAt: null }, select: { id: true, reference: true, name: true, trackBatches: true } })
    const findWarehouse = (v: string) => warehouses.find((w) => w.code.toLowerCase() === v.toLowerCase() || w.name.toLowerCase() === v.toLowerCase())
    const groups = new Map<string, { productId: string; quantity: number; batchNumber?: string; expiresAt?: Date | null; unitCost?: number; location?: string; line: number }[]>()
    for (const [i, r] of rows.entries()) {
      const line = i + 2
      const e: string[] = []
      const wh = findWarehouse(text(r.entrepot))
      if (!wh) e.push(`Entrepôt inconnu : « ${r.entrepot} » (code ou nom d'un de vos entrepôts).`)
      const product = products.find((p) => p.reference.toLowerCase() === text(r.reference).toLowerCase())
      if (!product) e.push(`Référence inconnue : « ${r.reference} ». Importez d'abord les marchandises.`)
      const quantity = number(r.quantite, 'Quantité', e, { required: true })
      if (quantity === 0) e.push('La quantité doit être supérieure à 0.')
      const batchNumber = text(r.lot) || undefined
      if (product?.trackBatches && !batchNumber) e.push(`Le numéro de lot est obligatoire pour ${product.name}.`)
      const expiresAt = date(r.expiration, 'Expiration', e)
      const unitCost = number(r.cout_unitaire, 'Coût unitaire', e) ?? undefined
      e.forEach((message) => errors.push({ line, message }))
      if (!e.length && wh && product && quantity) {
        const list = groups.get(wh.id) ?? []
        list.push({ productId: product.id, quantity, batchNumber, expiresAt, unitCost, location: text(r.emplacement) || undefined, line })
        groups.set(wh.id, list)
      }
    }
    // Emplacements : vérifiés avant tout enregistrement.
    const locations = new Map<string, string>()
    for (const [warehouseId, items] of groups) {
      for (const item of items.filter((x) => x.location)) {
        const loc = await this.prisma.warehouseLocation.findFirst({ where: { warehouseId, companyId: ctx.companyId, code: item.location } })
        if (!loc) errors.push({ line: item.line, message: `Emplacement « ${item.location} » introuvable dans cet entrepôt.` })
        else locations.set(`${warehouseId}|${item.location}`, loc.id)
      }
    }
    const result: ImportResult = { dryRun, total: rows.length, created: rows.length, updated: 0, errors }
    if (dryRun || errors.length) return result
    for (const [warehouseId, items] of groups) {
      await this.stock.receive(ctx, {
        warehouseId, reason: 'ADJUSTMENT', note: 'Stock initial importé (CSV)',
        items: items.map((x) => ({ productId: x.productId, quantity: x.quantity, batchNumber: x.batchNumber, expiresAt: x.expiresAt, unitCost: x.unitCost, locationId: x.location ? locations.get(`${warehouseId}|${x.location}`) : undefined })),
      })
    }
    return result
  }
}

const KINDS: Kind[] = ['products', 'customers', 'stock']
const TEMPLATE_NAMES: Record<Kind, string> = { products: 'marchandises', customers: 'clients', stock: 'stock-initial' }
const kindOf = (value: string): Kind => {
  if (!KINDS.includes(value as Kind)) throw new BadRequestException('Import inconnu : products, customers ou stock.')
  return value as Kind
}

@Controller('imports')
export class ImportsController {
  constructor(private readonly svc: ImportsService) {}

  /** Fichier modèle à remplir dans Excel, renvoyé tel quel (et non dans l'enveloppe JSON habituelle). */
  @RequirePerm('product.manage', 'customer.manage', 'stock.receive') @Get(':kind/template')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  template(@Param('kind') kind: string) {
    const k = kindOf(kind)
    return new StreamableFile(Buffer.from(this.svc.template(k), 'utf8'), { disposition: `attachment; filename="modele-${TEMPLATE_NAMES[k]}.csv"` })
  }

  /** dryRun=true : vérification seule. Sinon, import complet, ou rien du tout en cas d'erreur. */
  @RequirePerm('product.manage', 'customer.manage', 'stock.receive') @Post(':kind') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  run(@Ctx() ctx: TenantContext, @Param('kind') kind: string, @UploadedFile() file: Express.Multer.File, @Query('dryRun') dryRun?: string) {
    if (!file) throw new BadRequestException('Fichier CSV manquant.')
    return this.svc.run(ctx, kindOf(kind), file.buffer.toString('utf8'), dryRun === 'true')
  }
}

@Module({ imports: [StockModule], controllers: [ImportsController], providers: [ImportsService] })
export class ImportsModule {}
