import { drawCompanyHeader, drawDocumentTitle, drawFooters, GREY, LINE, NAVY } from '../../common/pdf.js'
import { formatDateTime } from '../../common/time.js'
import { Injectable, NotFoundException } from '@nestjs/common'
import PDFDocument from 'pdfkit'
import { FileService } from '../../common/core.services.js'
import { DELIVERY_STATUS_LABELS, type DeliveryStatus } from '../../common/constants.js'
import { PrismaService } from '../../common/prisma.service.js'
import type { TenantContext } from '../../common/context.js'

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

@Injectable()
export class DocumentsService {
  constructor(private readonly prisma: PrismaService, private readonly files: FileService) {}

  /** PDF d'une livraison : logo, coordonnées, marchandises, dates, signature et numéro de suivi. */
  async delivery(ctx: TenantContext, id: string, type: DocumentType): Promise<{ buffer: Buffer; filename: string }> {
    const where = ctx.role === 'DRIVER' ? { id, companyId: ctx.companyId, driverId: ctx.driverId } : { id, companyId: ctx.companyId, ...(ctx.warehouseIds ? { warehouseId: { in: ctx.warehouseIds } } : {}) }
    const d = await this.prisma.delivery.findFirst({
      where,
      include: {
        company: { include: { settings: { select: { timezone: true } } } }, customer: true, deliveryPoint: true, warehouse: true, driver: true, vehicle: true, order: true,
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
    row('Point de livraison', `${d.deliveryPoint.name} — ${[d.deliveryPoint.address, d.deliveryPoint.commune, d.deliveryPoint.city].filter(Boolean).join(', ')}`)
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

    if (type !== 'delivery-note' && d.proofs.length) {
      doc.moveDown(1).font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text('Preuves')
      for (const p of d.proofs) {
        const line = `${PROOF_LABELS[p.type] ?? p.type}  •  ${formatDateTime(p.capturedAt, tz)}${p.value ? `  •  ${p.value}` : ''}${p.latitude !== null ? `  •  ${p.latitude}, ${p.longitude}` : ''}${p.sha256 ? `  •  SHA-256 ${p.sha256.slice(0, 16)}…` : ''}`
        doc.font('Helvetica').fontSize(8.5).fillColor(GREY).text(line)
      }
      const signature = d.proofs.find((p) => p.type === 'SIGNATURE' && p.fileId)
      if (signature?.fileId) {
        const image = await this.files.readBuffer(signature.fileId)
        if (image && ['image/png', 'image/jpeg'].includes(image.mimeType)) {
          doc.moveDown(0.8).font('Helvetica-Bold').fontSize(9).fillColor(GREY).text('Signature du réceptionnaire')
          doc.image(image.buffer, { fit: [180, 80] })
        }
      }
    }

    drawFooters(doc, d.company, type === 'delivery-note' ? undefined : 'Signature électronique interne : preuve opérationnelle, ne constitue pas une signature électronique qualifiée.')
    doc.end()
    return { buffer: await done, filename: `${type}-${d.number}.pdf` }
  }
}
