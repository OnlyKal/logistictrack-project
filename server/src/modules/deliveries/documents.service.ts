import { BLUE, drawCompanyHeader, drawDocumentTitle, drawFooters, GREY, LINE, NAVY } from '../../common/pdf.js'
import { formatDateTime } from '../../common/time.js'
import { Injectable, NotFoundException } from '@nestjs/common'
import PDFDocument from 'pdfkit'
import { FileService } from '../../common/core.services.js'
import { DELIVERY_STATUS_LABELS, type DeliveryStatus } from '../../common/constants.js'
import { PrismaService } from '../../common/prisma.service.js'
import { deliveryWarehouseScope, type TenantContext } from '../../common/context.js'

export const DOCUMENT_TYPES = {
  'delivery-note': 'Bon de livraison',
  receipt: 'Accusé de réception',
  partial: 'Rapport de livraison partielle',
  failure: "Rapport d'échec",
  return: 'Rapport de retour',
} as const
export type DocumentType = keyof typeof DOCUMENT_TYPES

export const FAILURE_LABELS: Record<string, string> = {
  CUSTOMER_ABSENT: 'Client absent', WRONG_ADDRESS: 'Adresse incorrecte', NO_ACCESS: 'Accès impossible', CUSTOMER_REFUSED: 'Refus du client',
  DAMAGED: 'Colis endommagé', BREAKDOWN: 'Panne', INCIDENT: 'Incident', OTHER: 'Autre',
}

const PROOF_LABELS: Record<string, string> = {
  SIGNATURE: 'Signature', PHOTO_GOODS: 'Photo de la marchandise', PHOTO_PLACE: 'Photo du lieu', RECIPIENT: 'Réceptionnaire', QR: 'QR Code', GPS: 'Position GPS',
}


/** Distance en mètres entre deux positions (formule de haversine). */
function distanceM(a: [number, number], b: [number, number]) {
  const rad = (v: number) => (v * Math.PI) / 180
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(h))
}
const coords = (lat: number, lng: number) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`
const distanceText = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`)
const IMAGE_TYPES = ['image/png', 'image/jpeg']

type ProofRow = { type: string; value: string | null; fileId: string | null; sha256: string | null; latitude: number | null; longitude: number | null; capturedAt: Date }

@Injectable()
export class DocumentsService {
  constructor(private readonly prisma: PrismaService, private readonly files: FileService) {}

  /** PDF d'une livraison : logo, coordonnées, marchandises, dates, signature et numéro de suivi. */
  async delivery(ctx: TenantContext, id: string, type: DocumentType): Promise<{ buffer: Buffer; filename: string }> {
    const where = ctx.role === 'DRIVER' ? { id, companyId: ctx.companyId, driverId: ctx.driverId } : { id, companyId: ctx.companyId, ...deliveryWarehouseScope(ctx) }
    const d = await this.prisma.delivery.findFirst({
      where,
      include: {
        company: { include: { settings: { select: { timezone: true } } } }, customer: true, deliveryPoint: true, warehouse: true, pickupWarehouse: true, driver: true, vehicle: true, order: true,
        items: { include: { product: true } }, packages: true, proofs: true, history: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!d) throw new NotFoundException('Livraison introuvable.')

    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: `${DOCUMENT_TYPES[type]} ${d.number}`, Author: d.company.tradeName } })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))

    await drawCompanyHeader(doc, d.company, this.files)
    const tz = d.company.settings?.timezone
    drawDocumentTitle(doc, DOCUMENT_TYPES[type], `${d.number}  •  ${DELIVERY_STATUS_LABELS[d.status as DeliveryStatus]}  •  Édité le ${formatDateTime(new Date(), tz)}`)

    const row = (label: string, value?: string | null) => {
      if (!value) return
      doc.fillColor(GREY).font('Helvetica').fontSize(9).text(`${label}  `, { continued: true }).fillColor(NAVY).text(value)
    }
    row('Client', `${d.customer.name} (${d.customer.code})`)
    if (d.mode === 'PICKUP' && d.pickupWarehouse) row('Retrait en entrepôt', [d.pickupWarehouse.name, d.pickupWarehouse.address].filter(Boolean).join(' — '))
    row(d.mode === 'PICKUP' ? 'Adresse du client' : 'Point de livraison', `${d.deliveryPoint.name} — ${[d.deliveryPoint.address, d.deliveryPoint.commune, d.deliveryPoint.city].filter(Boolean).join(', ')}`)
    row('Contact', [d.deliveryPoint.contactName, d.deliveryPoint.phone].filter(Boolean).join(' / '))
    row('Entrepôt de départ', d.warehouse.name)
    row('Commande', d.order?.number)
    row('Chauffeur', d.driver?.fullName)
    row('Véhicule', d.vehicle?.registration)
    row('Date prévue', formatDateTime(d.scheduledAt, tz))
    row('Livrée le', formatDateTime(d.deliveredAt, tz))
    row('Numéros de suivi', d.packages.map((p) => p.trackingNumber).join(', '))
    if (type === 'failure') {
      row('Motif', d.failureReason ? FAILURE_LABELS[d.failureReason] ?? d.failureReason : null)
      row('Commentaire', d.failureComment)
      row('Tentatives', String(d.attempts))
    }
    doc.moveDown(1)

    const columns = type === 'delivery-note'
      ? [{ t: 'Marchandise', w: 299 }, { t: 'Référence', w: 110 }, { t: 'Quantité', w: 90 }]
      : [{ t: 'Marchandise', w: 179 }, { t: 'Prévu', w: 64 }, { t: 'Remis', w: 64 }, { t: 'Refusé', w: 64 }, { t: 'Manquant', w: 64 }, { t: 'Retourné', w: 64 }]
    const drawRow = (cells: string[], bold = false) => {
      const y = doc.y
      let x = 48
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(bold ? GREY : NAVY)
      cells.forEach((cell, i) => {
        doc.text(cell, x, y, { width: columns[i].w - 6 })
        x += columns[i].w
      })
      const bottom = Math.max(doc.y, y + 14)
      doc.moveTo(48, bottom + 3).lineTo(547, bottom + 3).strokeColor(LINE).lineWidth(0.5).stroke()
      doc.y = bottom + 7
      doc.x = 48
    }
    drawRow(columns.map((c) => c.t), true)
    for (const i of d.items) {
      const unit = i.product.baseUnit
      if (type === 'delivery-note') drawRow([i.product.name, i.product.reference, `${i.quantity} ${unit}`])
      else drawRow([i.product.name, `${i.quantity} ${unit}`, String(i.quantityDelivered), String(i.quantityRefused), String(i.quantityMissing), String(i.quantityReturned)])
    }
    const reasons = d.items.filter((i) => i.discrepancyReason)
    if (reasons.length) {
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(9).fillColor(GREY).text('Motifs des écarts')
      for (const i of reasons) doc.font('Helvetica').fillColor(NAVY).text(`${i.product.name} : ${i.discrepancyReason}`)
    }

    if (type !== 'delivery-note' && d.proofs.length) await this.drawProofs(doc, d, tz)

    drawFooters(doc, d.company, type === 'delivery-note' ? undefined : 'Signature électronique interne : preuve opérationnelle, ne constitue pas une signature électronique qualifiée.')
    doc.end()
    return { buffer: await done, filename: `${type}-${d.number}.pdf` }
  }

  /**
   * Preuves présentées pour un lecteur non technique : qui a reçu, où, quand, puis les photos et la signature
   * elles-mêmes, et enfin les empreintes qui permettent de vérifier que les fichiers n'ont pas été modifiés.
   */
  private async drawProofs(
    doc: PDFKit.PDFDocument,
    d: {
      mode: string; recipientName: string | null; recipientPhone: string | null; deliveredAt: Date | null
      deliveryPoint: { latitude: number | null; longitude: number | null }; pickupWarehouse: { name: string } | null; proofs: ProofRow[]
    },
    tz?: string | null,
  ) {
    const left = doc.page.margins.left
    const width = doc.page.width - left - doc.page.margins.right
    const bottom = () => doc.page.height - doc.page.margins.bottom - 20
    const room = (h: number) => { if (doc.y + h > bottom()) { doc.addPage(); doc.y = doc.page.margins.top } }
    const proofs = [...d.proofs].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
    const heading = (text: string) => { room(40); doc.x = left; doc.moveDown(0.8).font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(text, left); doc.moveDown(0.2) }
    const field = (label: string, value: string) => {
      doc.x = left
      doc.font('Helvetica').fontSize(9).fillColor(GREY).text(`${label} : `, left, doc.y, { continued: true, width }).font('Helvetica-Bold').fillColor(NAVY).text(value)
    }

    room(60)
    doc.x = left
    doc.moveDown(1).font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('Preuves de livraison', left)
    const when = d.deliveredAt ?? proofs.at(-1)?.capturedAt ?? null
    doc.font('Helvetica').fontSize(8.5).fillColor(GREY).text(
      `Éléments recueillis par le livreur au moment de la remise${when ? `, le ${formatDateTime(when, tz)}` : ''}. Heures exprimées à l'heure locale de l'entreprise.`,
      left, doc.y, { width },
    )

    // 1. Qui a reçu
    const recipient = proofs.find((p) => p.type === 'RECIPIENT')?.value ?? null
    const [rName, rPhone] = recipient ? recipient.split(' / ') : [null, null]
    const name = d.recipientName ?? rName
    const phone = d.recipientPhone ?? rPhone
    if (name || phone) {
      heading('1. Personne qui a reçu la marchandise')
      if (name) field('Nom', name)
      if (phone) field('Téléphone', phone)
    }

    // 2. Où et quand
    heading(`${name || phone ? 2 : 1}. Lieu et heure de la remise`)
    if (when) field('Date et heure', formatDateTime(when, tz))
    if (d.mode === 'PICKUP' && d.pickupWarehouse) field('Lieu', `remis au guichet de l'entrepôt ${d.pickupWarehouse.name}`)
    const gps = proofs.find((p) => p.type === 'GPS') ?? proofs.find((p) => p.latitude !== null && p.longitude !== null)
    if (gps && gps.latitude !== null && gps.longitude !== null) {
      field('Position relevée par le téléphone du livreur', coords(gps.latitude, gps.longitude))
      const target = d.deliveryPoint.latitude !== null && d.deliveryPoint.longitude !== null ? [d.deliveryPoint.latitude, d.deliveryPoint.longitude] as [number, number] : null
      if (target && d.mode !== 'PICKUP') {
        const m = distanceM([gps.latitude, gps.longitude], target)
        field('Écart avec l\'adresse du client', m <= 200 ? `${distanceText(m)} : la remise a eu lieu à l'adresse prévue` : `${distanceText(m)} de l'adresse enregistrée`)
      }
      const url = `https://www.google.com/maps?q=${gps.latitude.toFixed(6)},${gps.longitude.toFixed(6)}`
      doc.x = left
      doc.font('Helvetica').fontSize(9).fillColor(GREY).text('Voir sur la carte : ', left, doc.y, { continued: true }).fillColor(BLUE).text(url, { link: url, underline: true })
    } else if (d.mode !== 'PICKUP') {
      doc.font('Helvetica').fontSize(9).fillColor(GREY).text('Aucune position GPS n\'a été relevée pour cette livraison.', left)
    }

    // 3. Photos et signature, affichées telles quelles
    const pictures = proofs.filter((p) => p.fileId && ['PHOTO_GOODS', 'PHOTO_PLACE', 'SIGNATURE'].includes(p.type))
    if (pictures.length) {
      heading(`${(name || phone ? 2 : 1) + 1}. Photos et signature`)
      const boxW = (width - 20) / 3
      const boxH = 120
      let col = 0
      let rowY = doc.y
      room(boxH + 40)
      rowY = doc.y
      for (const p of pictures) {
        if (col === 3) { col = 0; doc.y = rowY + boxH + 34; room(boxH + 40); rowY = doc.y }
        const x = left + col * (boxW + 10)
        const caption = p.type === 'SIGNATURE' ? 'Signature du réceptionnaire' : PROOF_LABELS[p.type]
        doc.rect(x, rowY, boxW, boxH).strokeColor(LINE).lineWidth(0.5).stroke()
        const image = await this.files.readBuffer(p.fileId!).catch(() => null)
        if (image && IMAGE_TYPES.includes(image.mimeType)) {
          try { doc.image(image.buffer, x + 4, rowY + 4, { fit: [boxW - 8, boxH - 8], align: 'center', valign: 'center' }) } catch { /* image illisible : le cadre reste vide */ }
        } else {
          doc.font('Helvetica').fontSize(8).fillColor(GREY).text('Aperçu indisponible, fichier consultable dans l\'application.', x + 8, rowY + boxH / 2 - 10, { width: boxW - 16, align: 'center' })
        }
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text(caption, x, rowY + boxH + 4, { width: boxW, lineBreak: false })
        doc.font('Helvetica').fontSize(8).fillColor(GREY).text(`Prise le ${formatDateTime(p.capturedAt, tz)}`, x, rowY + boxH + 15, { width: boxW, lineBreak: false })
        col++
      }
      doc.y = rowY + boxH + 34
      doc.x = left

      // 4. Authenticité : l'empreinte complète, expliquée
      const signed = pictures.filter((p) => p.sha256)
      if (signed.length) {
        heading(`${(name || phone ? 2 : 1) + 2}. Contrôle d'authenticité des fichiers`)
        doc.font('Helvetica').fontSize(8.5).fillColor(GREY).text(
          'Chaque photo et la signature reçoivent une empreinte numérique (SHA-256) au moment de l\'envoi. Si le fichier conservé était modifié, même légèrement, son empreinte ne correspondrait plus à celle ci-dessous.',
          left, doc.y, { width },
        )
        doc.moveDown(0.4)
        for (const p of signed) {
          room(26)
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text(p.type === 'SIGNATURE' ? 'Signature' : PROOF_LABELS[p.type], left)
          doc.font('Courier').fontSize(7.5).fillColor(GREY).text(p.sha256!, left, doc.y, { width })
          doc.moveDown(0.2)
        }
      }
    }
    doc.x = left
  }

}
