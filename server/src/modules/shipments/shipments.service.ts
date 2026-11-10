/**
 * Expéditions (messagerie).
 *
 * Un expéditeur dépose un colis au guichet d'un entrepôt. L'entreprise l'achemine d'entrepôt en entrepôt
 * (autant d'escales que nécessaire, avec ses camions ou un transporteur : bateau, avion, bus…) jusqu'à
 * l'entrepôt de destination, où le destinataire le retire. Chaque départ et chaque arrivée sont enregistrés :
 * l'expéditeur et le destinataire suivent le colis étape par étape, et reçoivent un e-mail s'ils en ont donné un.
 *
 * Indépendant des commandes, des livraisons et du stock : le colis n'appartient pas à l'entreprise.
 */
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import { z } from 'zod'
import { assertWarehouse, type TenantContext } from '../../common/context.js'
import { AuditService, FileService, RealtimeService, SequenceService } from '../../common/core.services.js'
import { EmailsService, webUrl } from '../../common/emails.service.js'
import { paged, parsePeriod, type PageQuery } from '../../common/http.js'
import { drawCompanyHeader, drawDocumentTitle, drawFooters, GREY, loadBrand, NAVY } from '../../common/pdf.js'
import { PrismaService, type Tx } from '../../common/prisma.service.js'
import { SHIPMENT_AT_WAREHOUSE, SHIPMENT_CLOSED, SHIPMENT_STATUS_LABELS, type ShipmentStatus } from '../../common/constants.js'
import { companyTimeZone, formatDateTime } from '../../common/time.js'
import { D, opaqueToken, readableCode } from '../../common/util.js'

const optText = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined))
const optEmail = z.string().trim().email('Adresse e-mail invalide.').max(160).optional().or(z.literal('').transform(() => undefined))
const phone = z.string().trim().min(6, 'Téléphone trop court.').max(40)
const person = z.string().trim().min(2).max(120)
const flag = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])

export const shipmentSchema = z.object({
  senderName: person, senderPhone: phone, senderEmail: optEmail,
  recipientName: person, recipientPhone: phone, recipientEmail: optEmail,
  description: z.string().trim().min(2).max(300), parcels: z.coerce.number().int().min(1).max(1000).default(1),
  weightKg: z.coerce.number().min(0).max(1e6).optional(), declaredValue: z.coerce.number().min(0).max(1e12).optional(),
  fee: z.coerce.number().min(0).max(1e12).default(0), paymentMode: z.enum(['SENDER', 'RECIPIENT']).default('SENDER'),
  originWarehouseId: z.string().uuid(), destinationWarehouseId: z.string().uuid(), instructions: optText(1000),
  /** Escales prévues, dans l'ordre du trajet ; sans escale, le colis va directement à destination. */
  stops: z.array(z.string().uuid()).max(20).default([]),
})
export const stopsSchema = z.object({ stops: z.array(z.string().uuid()).max(20), note: optText(500) })
export const dispatchSchema = z.object({
  shipmentIds: z.array(z.string().uuid()).min(1).max(500),
  /** Escale ; sans elle, le colis part directement vers sa destination. */
  toWarehouseId: z.string().uuid().optional(),
  transportInfo: optText(200), note: optText(500),
})
export const receiveSchema = z.object({
  warehouseId: z.string().uuid(),
  shipmentIds: z.array(z.string().uuid()).max(500).optional(),
  trackingNumbers: z.array(z.string().trim().min(6).max(30)).max(500).optional(),
  note: optText(500),
}).refine((b) => (b.shipmentIds?.length ?? 0) + (b.trackingNumbers?.length ?? 0) > 0, 'Indiquez au moins un colis.')
export const redirectSchema = z.object({ destinationWarehouseId: z.string().uuid(), note: optText(500) })
export const handoverSchema = z.object({
  toSender: flag.default(false), name: person, phone: optText(40), idDocument: optText(80), feeCollected: flag.default(false), note: optText(500),
})
export const cancelSchema = z.object({ note: optText(500) })

const WAREHOUSE = { select: { id: true, name: true, address: true, phone: true, agency: { select: { name: true } } } } satisfies { select: Prisma.WarehouseSelect }
const INCLUDE = {
  originWarehouse: WAREHOUSE, destinationWarehouse: WAREHOUSE, currentWarehouse: WAREHOUSE, nextWarehouse: WAREHOUSE,
  stops: { orderBy: { position: 'asc' }, include: { warehouse: WAREHOUSE } },
} satisfies Prisma.ShipmentInclude

type Stop = { id: string; position: number; warehouseId: string; arrivedAt: Date | null; departedAt: Date | null; skipped: boolean; warehouse: Place }
/** Escales encore à faire, dans l'ordre. */
const pending = (stops: Stop[]) => stops.filter((x) => !x.arrivedAt && !x.skipped)

type Place = { id: string; name: string; address?: string | null; phone?: string | null; agency?: { name: string } | null }
/** Nom d'un lieu tel que le client le comprend : l'entrepôt et son agence. */
export const placeOf = (w: Place) => (w.agency ? `${w.name} (${w.agency.name})` : w.name)

type Mail = 'DEPOSITED' | 'ARRIVED' | 'AVAILABLE' | 'DELIVERED' | 'RETURNED'

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService, private readonly seq: SequenceService, private readonly audit: AuditService,
    private readonly realtime: RealtimeService, private readonly files: FileService, private readonly emails: EmailsService,
  ) {}

  /** Un utilisateur limité à des entrepôts voit les expéditions qui partent, passent ou arrivent chez lui. */
  private scope(ctx: TenantContext): Prisma.ShipmentWhereInput {
    if (!ctx.warehouseIds) return { companyId: ctx.companyId }
    const ids = { in: ctx.warehouseIds }
    return { companyId: ctx.companyId, OR: [{ originWarehouseId: ids }, { destinationWarehouseId: ids }, { currentWarehouseId: ids }, { nextWarehouseId: ids }] }
  }

  private async getOwned(ctx: TenantContext, id: string, tx?: Tx) {
    const s = await (tx ?? this.prisma).shipment.findFirst({ where: { id, ...this.scope(ctx) }, include: INCLUDE })
    if (!s) throw new NotFoundException('Expédition introuvable.')
    return s
  }

  private async warehouse(tx: Tx, ctx: TenantContext, id: string) {
    const w = await tx.warehouse.findFirst({ where: { id, companyId: ctx.companyId, status: 'active' }, select: WAREHOUSE.select })
    if (!w) throw new NotFoundException('Entrepôt introuvable.')
    return w
  }

  private async event(tx: Tx, ctx: TenantContext, shipmentId: string, type: string, label: string, where: Place | null, note?: string, isPublic = true) {
    return tx.shipmentEvent.create({
      data: { companyId: ctx.companyId, shipmentId, type, label, warehouseId: where?.id, place: where ? placeOf(where) : null, note, isPublic, userId: ctx.userId },
    })
  }

  /** Changement d'état conditionnel : deux guichets qui traitent le même colis en même temps ne passent pas tous les deux. */
  private async step(tx: Tx, s: { id: string; number: string; status: string }, data: Prisma.ShipmentUncheckedUpdateManyInput) {
    const r = await tx.shipment.updateMany({ where: { id: s.id, status: s.status }, data })
    if (r.count !== 1) throw new ConflictException(`L'expédition ${s.number} a changé d'état entre-temps.`)
  }

  private changed(ctx: TenantContext, ids: string[]) {
    this.realtime.toCompany(ctx.companyId, 'shipment.changed', { ids })
  }

  // ---------- Lecture ----------

  async list(ctx: TenantContext, p: PageQuery) {
    const period = parsePeriod(p)
    const q = p.q?.trim()
    const where: Prisma.ShipmentWhereInput = {
      AND: [
        this.scope(ctx),
        {
          ...(p.status ? { status: { in: p.status.split(',') } } : {}),
          // Au guichet : les colis présents ici, et ceux en route vers ici.
          ...(p.at ? { currentWarehouseId: String(p.at) } : {}),
          ...(p.incoming ? { nextWarehouseId: String(p.incoming), status: 'IN_TRANSIT' } : {}),
          ...(period ? { createdAt: period } : {}),
        },
        ...(q ? [{ OR: [
          { number: { contains: q } }, { trackingNumber: { contains: q.toUpperCase() } }, { senderName: { contains: q } }, { recipientName: { contains: q } },
          { senderPhone: { contains: q } }, { recipientPhone: { contains: q } },
        ] }] : []),
      ],
    }
    const [items, total] = await Promise.all([
      this.prisma.shipment.findMany({ where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' }, include: INCLUDE }),
      this.prisma.shipment.count({ where }),
    ])
    return paged(items, total, p)
  }

  destinations(ctx: TenantContext) {
    return this.prisma.warehouse.findMany({ where: { companyId: ctx.companyId, status: 'active' }, orderBy: { name: 'asc' }, select: WAREHOUSE.select })
  }

  async detail(ctx: TenantContext, id: string) {
    const s = await this.getOwned(ctx, id)
    const events = await this.prisma.shipmentEvent.findMany({ where: { shipmentId: id }, orderBy: { occurredAt: 'asc' } })
    return { ...s, events, trackingUrl: webUrl(`/suivi-expedition/${s.trackingToken}`) }
  }

  // ---------- Guichet de départ ----------

  async create(ctx: TenantContext, body: z.infer<typeof shipmentSchema>) {
    assertWarehouse(ctx, body.originWarehouseId)
    const { stops, ...data } = body
    const created = await this.prisma.atomic(async (tx) => {
      const origin = await this.warehouse(tx, ctx, body.originWarehouseId)
      // La destination peut être n'importe quel entrepôt de l'entreprise, même hors du périmètre de l'agent.
      const destination = await this.warehouse(tx, ctx, body.destinationWarehouseId)
      const sameSite = origin.id === destination.id
      if (sameSite && stops.length) throw new UnprocessableEntityException('Un colis retiré à son guichet de dépôt ne fait pas d\'escale.')
      await this.checkStops(tx, ctx, stops, [origin.id, destination.id])
      const number = await this.seq.next(tx, ctx.companyId, 'shipment', 'EXP')
      const s = await tx.shipment.create({
        data: {
          ...data, companyId: ctx.companyId, number, trackingNumber: `EX${readableCode(10)}`, trackingToken: opaqueToken(),
          status: sameSite ? 'AVAILABLE' : 'REGISTERED', currentWarehouseId: origin.id, createdById: ctx.userId,
          feePaidAt: body.paymentMode === 'SENDER' && body.fee > 0 ? new Date() : null,
          stops: { create: stops.map((warehouseId, i) => ({ warehouseId, position: i + 1 })) },
        },
      })
      await this.event(tx, ctx, s.id, 'DEPOSITED', `Colis déposé à ${placeOf(origin)}`, origin)
      if (sameSite) await this.event(tx, ctx, s.id, 'AVAILABLE', `Disponible au retrait à ${placeOf(origin)}`, origin)
      await this.audit.log(ctx, 'shipment.create', 'Shipment', s.id, { number }, tx)
      return s
    })
    this.changed(ctx, [created.id])
    this.notify(ctx.companyId, created.id, 'DEPOSITED')
    if (created.status === 'AVAILABLE') this.notify(ctx.companyId, created.id, 'AVAILABLE')
    return this.detail(ctx, created.id)
  }

  /** Départ groupé : les colis présents dans un entrepôt partent ensemble, vers une escale ou leur destination. */
  async dispatch(ctx: TenantContext, body: z.infer<typeof dispatchSchema>) {
    const ids = [...new Set(body.shipmentIds)]
    await this.prisma.atomic(async (tx) => {
      const stopover = body.toWarehouseId ? await this.warehouse(tx, ctx, body.toWarehouseId) : null
      for (const id of ids) {
        const s = await this.getOwned(ctx, id, tx)
        if (!SHIPMENT_AT_WAREHOUSE.includes(s.status as ShipmentStatus) || !s.currentWarehouse) {
          throw new ConflictException(`${s.number} : seul un colis présent dans un entrepôt peut partir (${SHIPMENT_STATUS_LABELS[s.status as ShipmentStatus]}).`)
        }
        assertWarehouse(ctx, s.currentWarehouse.id)
        // Sans choix explicite : la prochaine escale prévue, sinon la destination.
        const next = stopover ?? pending(s.stops).find((x) => x.warehouseId !== s.currentWarehouse!.id)?.warehouse ?? s.destinationWarehouse
        if (next.id === s.currentWarehouse.id) throw new ConflictException(`${s.number} est déjà à ${placeOf(next)}.`)
        await tx.shipmentStop.updateMany({ where: { shipmentId: id, warehouseId: s.currentWarehouse.id, arrivedAt: { not: null }, departedAt: null }, data: { departedAt: new Date() } })
        await this.step(tx, s, { status: 'IN_TRANSIT', currentWarehouseId: null, nextWarehouseId: next.id, transportInfo: body.transportInfo ?? null })
        const transport = [body.transportInfo, body.note].filter(Boolean).join(' · ') || undefined
        await this.event(tx, ctx, id, 'DEPARTED', `Parti de ${placeOf(s.currentWarehouse)} vers ${placeOf(next)}`, s.currentWarehouse, transport)
      }
      await this.audit.log(ctx, 'shipment.dispatch', 'Shipment', undefined, { ids, toWarehouseId: body.toWarehouseId, transport: body.transportInfo }, tx)
    })
    this.changed(ctx, ids)
    return { count: ids.length }
  }

  /**
   * Réception dans un entrepôt, par numéro de suivi (scan) ou par sélection. À destination, le colis
   * devient disponible au retrait ; ailleurs, c'est une escale. Un colis arrivé dans un autre entrepôt
   * que prévu est accepté : il est bien là, et l'historique le dit.
   */
  async receive(ctx: TenantContext, body: z.infer<typeof receiveSchema>) {
    assertWarehouse(ctx, body.warehouseId)
    const numbers = (body.trackingNumbers ?? []).map((n) => n.toUpperCase())
    const results = await this.prisma.atomic(async (tx) => {
      const here = await this.warehouse(tx, ctx, body.warehouseId)
      const rows = await tx.shipment.findMany({
        where: { companyId: ctx.companyId, OR: [{ id: { in: body.shipmentIds ?? [] } }, { trackingNumber: { in: numbers } }] },
        include: INCLUDE,
      })
      const unknown = numbers.filter((n) => !rows.some((r) => r.trackingNumber === n))
      if (unknown.length || rows.length < new Set(body.shipmentIds ?? []).size) {
        throw new NotFoundException(`Colis introuvable${unknown.length ? ` : ${unknown.join(', ')}` : ''}.`)
      }
      const done: Array<{ id: string; mail: Mail }> = []
      for (const s of rows) {
        if (s.status !== 'IN_TRANSIT') throw new ConflictException(`${s.number} n'est pas en transit (${SHIPMENT_STATUS_LABELS[s.status as ShipmentStatus]}).`)
        const arrived = s.destinationWarehouseId === here.id
        await this.step(tx, s, { status: arrived ? 'AVAILABLE' : 'AT_WAREHOUSE', currentWarehouseId: here.id, nextWarehouseId: null })
        // Escale prévue atteinte : les escales prévues avant elle, non faites, sont sautées. À destination, toutes celles qui restent.
        const todo = pending(s.stops)
        const reached = todo.findIndex((x) => x.warehouseId === here.id)
        const skipped = arrived ? todo : reached > 0 ? todo.slice(0, reached) : []
        if (skipped.length) await tx.shipmentStop.updateMany({ where: { id: { in: skipped.map((x) => x.id) } }, data: { skipped: true } })
        if (!arrived && reached >= 0) await tx.shipmentStop.update({ where: { id: todo[reached].id }, data: { arrivedAt: new Date() } })
        const unplanned = s.nextWarehouseId !== here.id ? `Arrivée imprévue (attendu à ${s.nextWarehouse ? placeOf(s.nextWarehouse) : '—'}).` : undefined
        const note = [unplanned, body.note].filter(Boolean).join(' ') || undefined
        if (arrived) await this.event(tx, ctx, s.id, 'AVAILABLE', `Arrivé à ${placeOf(here)} : disponible au retrait`, here, note)
        else await this.event(tx, ctx, s.id, 'ARRIVED', `Arrivé à ${placeOf(here)}`, here, note)
        done.push({ id: s.id, mail: arrived ? 'AVAILABLE' : 'ARRIVED' })
      }
      await this.audit.log(ctx, 'shipment.receive', 'Shipment', undefined, { warehouseId: here.id, ids: done.map((d) => d.id) }, tx)
      return done
    })
    this.changed(ctx, results.map((r) => r.id))
    for (const r of results) this.notify(ctx.companyId, r.id, r.mail)
    return { count: results.length }
  }

  /** Le destinataire veut retirer son colis ailleurs : la destination change, le colis repart s'il le faut. */
  async redirect(ctx: TenantContext, id: string, body: z.infer<typeof redirectSchema>) {
    let available = false
    await this.prisma.atomic(async (tx) => {
      const s = await this.getOwned(ctx, id, tx)
      if (SHIPMENT_CLOSED.includes(s.status as ShipmentStatus)) throw new ConflictException('Cette expédition est terminée.')
      const target = await this.warehouse(tx, ctx, body.destinationWarehouseId)
      if (target.id === s.destinationWarehouseId) throw new ConflictException(`La destination est déjà ${placeOf(target)}.`)
      let status = s.status
      if (s.status !== 'IN_TRANSIT') {
        if (s.currentWarehouseId === target.id) status = 'AVAILABLE'
        else if (s.status === 'AVAILABLE') status = 'AT_WAREHOUSE'
      }
      await this.step(tx, s, { destinationWarehouseId: target.id, status })
      await tx.shipmentStop.updateMany({ where: { shipmentId: id, warehouseId: target.id, arrivedAt: null, skipped: false }, data: { skipped: true } })
      await this.event(tx, ctx, id, 'REDIRECTED', `Nouvelle destination : ${placeOf(target)}`, null, body.note)
      if (status === 'AVAILABLE' && s.status !== 'AVAILABLE') {
        await this.event(tx, ctx, id, 'AVAILABLE', `Disponible au retrait à ${placeOf(target)}`, target)
        available = true
      }
      await this.audit.log(ctx, 'shipment.redirect', 'Shipment', id, body, tx)
    })
    this.changed(ctx, [id])
    if (available) this.notify(ctx.companyId, id, 'AVAILABLE')
    return this.detail(ctx, id)
  }

  /** Escales valides : entrepôts actifs de l'entreprise, sans doublon, ni dépôt ni destination. */
  private async checkStops(tx: Tx, ctx: TenantContext, stops: string[], excluded: string[]) {
    if (new Set(stops).size !== stops.length) throw new UnprocessableEntityException('Une escale figure deux fois dans l\'itinéraire.')
    if (stops.some((w) => excluded.includes(w))) throw new UnprocessableEntityException("Une escale ne peut être ni l'entrepôt de dépôt ni la destination.")
    const places = []
    for (const w of stops) places.push(await this.warehouse(tx, ctx, w))
    return places
  }

  /** Nouvel itinéraire : remplace les escales restant à faire ; celles déjà faites restent dans l'historique. */
  async replaceStops(ctx: TenantContext, id: string, body: z.infer<typeof stopsSchema>) {
    await this.prisma.atomic(async (tx) => {
      const s = await this.getOwned(ctx, id, tx)
      if (SHIPMENT_CLOSED.includes(s.status as ShipmentStatus)) throw new ConflictException('Cette expédition est terminée.')
      if (s.status === 'AVAILABLE' && body.stops.length) throw new ConflictException('Le colis est déjà à destination.')
      const places = await this.checkStops(tx, ctx, body.stops, [s.destinationWarehouseId, ...(s.currentWarehouseId ? [s.currentWarehouseId] : [])])
      const todo = pending(s.stops)
      // Pendant un trajet, l'escale vers laquelle le colis roule reste prévue.
      const keep = s.status === 'IN_TRANSIT' ? todo.filter((x) => x.warehouseId === s.nextWarehouseId) : []
      if (keep.length && body.stops.includes(keep[0].warehouseId)) throw new UnprocessableEntityException(`Le colis roule déjà vers ${placeOf(keep[0].warehouse)} : ne l'ajoutez pas une seconde fois.`)
      const dropped = todo.filter((x) => !keep.includes(x))
      await tx.shipmentStop.deleteMany({ where: { id: { in: dropped.map((x) => x.id) } } })
      // Les nouvelles escales se placent après celles qui restent (faites, sautées ou en cours).
      const start = Math.max(0, ...s.stops.filter((x) => !dropped.includes(x)).map((x) => x.position))
      await tx.shipmentStop.createMany({ data: body.stops.map((warehouseId, i) => ({ shipmentId: id, warehouseId, position: start + i + 1 })) })
      const label = places.length ? `Itinéraire : ${places.map((p) => p.name).join(' → ')} → ${s.destinationWarehouse.name}` : `Itinéraire : direct vers ${s.destinationWarehouse.name}`
      await this.event(tx, ctx, id, 'ROUTE_CHANGED', label, null, body.note, false)
      await this.audit.log(ctx, 'shipment.route', 'Shipment', id, body, tx)
    })
    this.changed(ctx, [id])
    return this.detail(ctx, id)
  }

  // ---------- Guichet d'arrivée ----------

  /** Remise au destinataire (ou rendu à l'expéditeur) : identité, signature si l'entreprise l'exige, frais à encaisser. */
  async handover(ctx: TenantContext, id: string, body: z.infer<typeof handoverSchema>, file?: { buffer: Buffer; mimetype: string; originalname?: string }) {
    const s = await this.getOwned(ctx, id)
    if (SHIPMENT_CLOSED.includes(s.status as ShipmentStatus)) throw new ConflictException('Cette expédition est terminée.')
    if (s.status === 'IN_TRANSIT' || !s.currentWarehouseId) throw new ConflictException("Le colis est en transit : il n'est dans aucun entrepôt.")
    assertWarehouse(ctx, s.currentWarehouseId)
    if (!body.toSender && s.status !== 'AVAILABLE') throw new ConflictException({ message: "Le colis n'est pas encore arrivé à destination.", code: 'NOT_AVAILABLE' })
    const settings = await this.prisma.companySettings.findUnique({ where: { companyId: ctx.companyId } })
    if (settings?.requireSignature && !file) throw new UnprocessableEntityException({ message: 'Preuves manquantes : signature.', code: 'PROOF_MISSING' })
    const feeDue = !body.toSender && s.paymentMode === 'RECIPIENT' && D(s.fee).greaterThan(0) && !s.feePaidAt
    if (feeDue && !body.feeCollected) throw new UnprocessableEntityException({ message: `Encaissez les frais d'envoi (${s.fee}) avant la remise.`, code: 'FEE_DUE' })
    const saved = file ? await this.files.save(ctx, file) : null
    const here = s.currentWarehouse!
    await this.prisma.atomic(async (tx) => {
      await this.step(tx, s, {
        status: body.toSender ? 'RETURNED' : 'DELIVERED', pickedUpAt: new Date(), pickedUpBy: body.name, pickedUpPhone: body.phone ?? null,
        pickedUpIdDocument: body.idDocument ?? null, signatureFileId: saved?.id ?? null, ...(feeDue ? { feePaidAt: new Date() } : {}),
      })
      if (body.toSender) await this.event(tx, ctx, id, 'RETURNED', `Rendu à l'expéditeur à ${placeOf(here)}`, here, body.note)
      else await this.event(tx, ctx, id, 'PICKED_UP', `Retiré à ${placeOf(here)}`, here, body.note)
      await this.audit.log(ctx, body.toSender ? 'shipment.returned' : 'shipment.picked_up', 'Shipment', id, { name: body.name, feeCollected: feeDue }, tx)
    })
    this.changed(ctx, [id])
    this.notify(ctx.companyId, id, body.toSender ? 'RETURNED' : 'DELIVERED')
    return this.detail(ctx, id)
  }

  /** Annulation : seulement avant le premier départ, dans l'entrepôt de dépôt. */
  async cancel(ctx: TenantContext, id: string, body: z.infer<typeof cancelSchema>) {
    await this.prisma.atomic(async (tx) => {
      const s = await this.getOwned(ctx, id, tx)
      if (s.status !== 'REGISTERED' || s.currentWarehouseId !== s.originWarehouseId) throw new ConflictException('Seul un colis encore à son entrepôt de dépôt peut être annulé.')
      assertWarehouse(ctx, s.originWarehouseId)
      await this.step(tx, s, { status: 'CANCELLED' })
      await this.event(tx, ctx, id, 'CANCELLED', 'Expédition annulée', s.originWarehouse, body.note)
      await this.audit.log(ctx, 'shipment.cancel', 'Shipment', id, body, tx)
    })
    this.changed(ctx, [id])
    return this.detail(ctx, id)
  }

  async signature(ctx: TenantContext, id: string) {
    const s = await this.getOwned(ctx, id)
    if (!s.signatureFileId) throw new NotFoundException("Aucune signature pour cette expédition.")
    return this.files.signedUrl(ctx, s.signatureFileId)
  }

  // ---------- Reçu de dépôt ----------

  async receipt(ctx: TenantContext, id: string) {
    const s = await this.detail(ctx, id)
    const brand = await loadBrand(this.prisma, ctx.companyId)
    const tz = await companyTimeZone(this.prisma, ctx.companyId)
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: `Reçu d'expédition ${s.number}` } })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))
    await drawCompanyHeader(doc, brand, this.files)
    drawDocumentTitle(doc, "Reçu d'expédition", `${s.number}  •  Déposé le ${formatDateTime(s.createdAt, tz)}`)
    const top = doc.y
    const qr = await QRCode.toBuffer(s.trackingUrl, { margin: 1, width: 240 })
    doc.image(qr, 427, top, { fit: [120, 120] })
    doc.font('Helvetica').fontSize(8).fillColor(GREY).text('Suivre le colis', 427, top + 122, { width: 120, align: 'center' })
    doc.x = 48
    doc.y = top
    const row = (label: string, value?: string | null) => {
      if (!value) return
      doc.fillColor(GREY).font('Helvetica').fontSize(9).text(`${label}  `, 48, doc.y, { continued: true, width: 360 }).fillColor(NAVY).text(value)
    }
    doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY).text(`N° de suivi : ${s.trackingNumber}`, 48, doc.y, { width: 360 })
    doc.moveDown(0.6)
    row('Expéditeur', `${s.senderName} — ${s.senderPhone}`)
    row('Destinataire', `${s.recipientName} — ${s.recipientPhone}`)
    row('Dépôt', placeOf(s.originWarehouse))
    row('Itinéraire', s.stops.length ? [s.originWarehouse.name, ...s.stops.filter((x) => !x.skipped).map((x) => x.warehouse.name), s.destinationWarehouse.name].join(' → ') : null)
    row('Retrait', [placeOf(s.destinationWarehouse), s.destinationWarehouse.address, s.destinationWarehouse.phone].filter(Boolean).join(' — '))
    row('Contenu', s.description)
    row('Nombre de colis', String(s.parcels))
    row('Poids', s.weightKg ? `${s.weightKg} kg` : null)
    row('Valeur déclarée', s.declaredValue ? String(s.declaredValue) : null)
    row("Frais d'envoi", D(s.fee).greaterThan(0) ? `${s.fee} — ${s.paymentMode === 'SENDER' ? 'payés au dépôt' : 'à payer par le destinataire au retrait'}` : null)
    row('Instructions', s.instructions)
    doc.y = Math.max(doc.y, top + 140)
    doc.moveDown(1).font('Helvetica').fontSize(9).fillColor(NAVY)
      .text(`Suivez votre colis en ligne avec le numéro ${s.trackingNumber}, ou en scannant le QR code : ${s.trackingUrl}`, 48, doc.y, { width: 499 })
    doc.moveDown(0.6).fillColor(GREY).fontSize(8.5)
      .text('Le destinataire présente ce numéro de suivi et une pièce d\'identité au retrait. Une signature peut lui être demandée.', { width: 499 })
    drawFooters(doc, brand)
    doc.end()
    return { buffer: await done, filename: `expedition-${s.number}.pdf` }
  }

  // ---------- E-mails de suivi ----------

  /** Toujours en arrière-plan : un guichet n'attend jamais le serveur d'envoi. */
  private notify(companyId: string, id: string, kind: Mail) {
    this.emails.later(() => this.sendMail(companyId, id, kind))
  }

  private async sendMail(companyId: string, id: string, kind: Mail) {
    const s = await this.prisma.shipment.findFirst({ where: { id, companyId }, include: { ...INCLUDE, company: { select: { tradeName: true } } } })
    if (!s) return
    const last = await this.prisma.shipmentEvent.findFirst({ where: { shipmentId: id }, orderBy: { occurredAt: 'desc' }, select: { id: true } })
    const company = s.company.tradeName
    const url = webUrl(`/suivi-expedition/${s.trackingToken}`)
    const dest = placeOf(s.destinationWarehouse)
    const where = s.currentWarehouse ? placeOf(s.currentWarehouse) : dest
    const destDetails = [s.destinationWarehouse.address, s.destinationWarehouse.phone && `tél. ${s.destinationWarehouse.phone}`].filter(Boolean).join(', ')
    const upcoming = pending(s.stops).find((x) => x.warehouseId !== s.currentWarehouseId)
    const nextStop = upcoming ? placeOf(upcoming.warehouse) : dest
    const toRecipient = ['DEPOSITED', 'ARRIVED', 'AVAILABLE'].includes(kind)
    const recipients = [
      ...(s.senderEmail ? [{ email: s.senderEmail, name: s.senderName, role: 'sender' as const }] : []),
      ...(toRecipient && s.recipientEmail ? [{ email: s.recipientEmail, name: s.recipientName, role: 'recipient' as const }] : []),
    ]
    for (const r of recipients) {
      const forRecipient = r.role === 'recipient'
      const text: Record<Mail, { subject: string; title: string; body: string[] }> = {
        DEPOSITED: forRecipient
          ? { subject: `Un colis vous est envoyé (${s.trackingNumber})`, title: 'Un colis vous est envoyé', body: [`${s.senderName} vous envoie un colis par ${company}. Il sera à retirer à ${dest}${destDetails ? ` (${destDetails})` : ''}.`, 'Vous serez prévenu à chaque étape, et quand il vous attendra.'] }
          : { subject: `Votre colis ${s.trackingNumber} est enregistré`, title: 'Votre colis est enregistré', body: [`Votre colis pour ${s.recipientName} est déposé à ${placeOf(s.originWarehouse)}. Il sera à retirer à ${dest}.`] },
        ARRIVED: { subject: `Colis ${s.trackingNumber} : arrivé à ${where}`, title: `Votre colis est arrivé à ${where}`, body: [`Le colis ${s.trackingNumber} est arrivé à ${where}. Prochaine étape : ${nextStop}.`] },
        AVAILABLE: forRecipient
          ? { subject: `Votre colis ${s.trackingNumber} vous attend`, title: 'Votre colis vous attend', body: [`Votre colis est disponible au retrait à ${dest}${destDetails ? ` (${destDetails})` : ''}.`, `Présentez-vous avec le numéro de suivi ${s.trackingNumber} et une pièce d'identité.${s.paymentMode === 'RECIPIENT' && !s.feePaidAt && D(s.fee).greaterThan(0) ? ` Frais d'envoi à régler au retrait : ${s.fee}.` : ''}`] }
          : { subject: `Colis ${s.trackingNumber} : arrivé à destination`, title: 'Votre colis est arrivé à destination', body: [`Le colis pour ${s.recipientName} est disponible au retrait à ${dest}.`] },
        DELIVERED: { subject: `Colis ${s.trackingNumber} : retiré`, title: 'Votre colis a été retiré', body: [`Le colis ${s.trackingNumber} a été retiré à ${where}${s.pickedUpBy ? ` par ${s.pickedUpBy}` : ''}.`] },
        RETURNED: { subject: `Colis ${s.trackingNumber} : rendu`, title: 'Votre colis vous a été rendu', body: [`Le colis ${s.trackingNumber} a été rendu à ${where}${s.pickedUpBy ? ` à ${s.pickedUpBy}` : ''}.`] },
      }
      const t = text[kind]
      await this.emails.send({
        to: r.email, kind: `shipment.${kind.toLowerCase()}`, companyId, dedupeKey: `shipment:${s.id}:${last?.id ?? kind}:${kind}:${r.role}`,
        content: {
          subject: t.subject, title: t.title,
          paragraphs: [`Bonjour ${r.name},`, ...t.body, `Vous recevez cet e-mail parce que votre adresse a été donnée pour l'envoi ${s.trackingNumber} confié à ${company}.`],
          action: { label: 'Suivre le colis', url },
        },
      })
    }
  }
}
