/**
 * Identité visuelle commune des documents : PDF (livraisons, rapports), Excel et e-mails.
 * Un seul design partout ; seules changent les informations de l'entreprise concernée
 * (logo, nom, coordonnées, NIF et RCCM). Sans entreprise, c'est LogisticTrack qui signe.
 */
import type PDFKit from 'pdfkit'
import type { PrismaClient } from '@prisma/client'
import type { FileService } from './core.services.js'

export interface PdfCompany {
  tradeName: string
  legalName?: string | null
  address?: string | null
  city?: string | null
  phone?: string | null
  email?: string | null
  taxId?: string | null
  rccm?: string | null
  logoFileId?: string | null
}

/** null : document de la plateforme, signé LogisticTrack. */
export type Brand = PdfCompany | null

export const PLATFORM_NAME = 'LogisticTrack'
export const BLUE = '#2563EB'
export const NAVY = '#14213D'
export const GREY = '#64748B'
export const LINE = '#E2E8F0'

const BRAND_SELECT = { tradeName: true, legalName: true, address: true, city: true, phone: true, email: true, taxId: true, rccm: true, logoFileId: true } as const

export async function loadBrand(prisma: Pick<PrismaClient, 'company'>, companyId?: string | null): Promise<Brand> {
  if (!companyId) return null
  return prisma.company.findUnique({ where: { id: companyId }, select: BRAND_SELECT })
}

export const brandName = (b: Brand) => b?.tradeName ?? PLATFORM_NAME
export const contactLine = (b: Brand) => (b ? [[b.address, b.city].filter(Boolean).join(', '), b.phone, b.email].filter(Boolean).join('  •  ') : '')
export const legalLine = (b: Brand) => (b ? [b.legalName && b.legalName !== b.tradeName ? b.legalName : null, b.taxId && `NIF ${b.taxId}`, b.rccm && `RCCM ${b.rccm}`].filter(Boolean).join('  •  ') : '')
const initial = (b: Brand) => brandName(b).trim().charAt(0).toUpperCase() || 'L'

/** Logo de l'entreprise, seulement s'il est lisible partout (PNG ou JPEG). */
export async function readLogo(files: FileService, b: Brand) {
  if (!b?.logoFileId) return null
  try {
    const logo = await files.readBuffer(b.logoFileId)
    return logo && ['image/png', 'image/jpeg'].includes(logo.mimeType) ? logo : null
  } catch {
    return null
  }
}

// ---------- PDF ----------

/** Carré bleu à l'initiale : remplace le logo absent, comme dans l'application. */
function drawMonogram(doc: PDFKit.PDFDocument, b: Brand, x: number, y: number, size: number) {
  doc.roundedRect(x, y, size, size, size * 0.24).fill(BLUE)
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(size * 0.5).text(initial(b), x, y + size * 0.26, { width: size, align: 'center', lineBreak: false })
}

/** En-tête : logo (ou initiale) à gauche, nom et coordonnées à droite, filet de séparation. */
export async function drawCompanyHeader(doc: PDFKit.PDFDocument, b: Brand, files: FileService) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const top = doc.y
  const logo = await readLogo(files, b)
  let markBottom = top + 40
  if (logo) {
    doc.image(logo.buffer, left, top, { fit: [120, 48], valign: 'center' })
    markBottom = top + 48
  } else {
    drawMonogram(doc, b, left, top, 40)
  }
  const x = left + 140
  const width = right - x
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text(brandName(b), x, top + 2, { width, align: 'right' })
  doc.fillColor(GREY).font('Helvetica').fontSize(8.5)
  if (!b) doc.text('Plateforme de gestion logistique', x, doc.y, { width, align: 'right' })
  const contact = contactLine(b)
  if (contact) doc.text(contact, x, doc.y, { width, align: 'right' })
  const legal = legalLine(b)
  if (legal) doc.text(legal, x, doc.y, { width, align: 'right' })
  doc.y = Math.max(doc.y, markBottom) + 12
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(LINE).lineWidth(0.6).stroke()
  doc.y += 14
  doc.x = left
}

/** Titre du document et ligne d'informations (numéro, date d'édition…), identiques partout. */
export function drawDocumentTitle(doc: PDFKit.PDFDocument, title: string, meta: string) {
  const left = doc.page.margins.left
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18).text(title, left, doc.y)
  doc.fillColor(GREY).font('Helvetica').fontSize(9.5).text(meta, left, doc.y + 2)
  doc.moveDown(1)
  doc.x = left
}

/**
 * Pied de chaque page : entreprise et identifiants légaux à gauche, numéro de page à droite,
 * et une mention facultative au-dessus. Le document doit être créé avec bufferPages: true.
 */
export function drawFooters(doc: PDFKit.PDFDocument, b: Brand, note?: string) {
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    const { left, right: mr, bottom } = doc.page.margins
    const right = doc.page.width - mr
    const width = right - left
    // Écrire sous la marge basse sans créer de page.
    doc.page.margins.bottom = 0
    const y = doc.page.height - bottom + 10
    if (note) doc.font('Helvetica').fontSize(7).fillColor(GREY).text(note, left, y - 14, { width, align: 'center', lineBreak: false })
    doc.moveTo(left, y - 3).lineTo(right, y - 3).strokeColor(LINE).lineWidth(0.5).stroke()
    const owner = [brandName(b), legalLine(b)].filter(Boolean).join('  •  ')
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY).text(b ? `${owner}  •  édité avec ${PLATFORM_NAME}` : owner, left, y + 2, { width: width - 70, lineBreak: false })
    doc.text(`Page ${i - range.start + 1} / ${range.count}`, right - 70, y + 2, { width: 70, align: 'right', lineBreak: false })
    doc.page.margins.bottom = bottom
  }
}

// ---------- Excel ----------

/** Bandeau en tête de feuille : entreprise, coordonnées, titre et date, puis le tableau. Renvoie la ligne d'en-tête du tableau. */
export function excelBrandRows(ws: { addRow: (v: unknown[]) => { font: unknown; height: number } ; mergeCells: (...a: number[]) => void }, b: Brand, title: string, meta: string, width: number) {
  const span = Math.max(1, width)
  const lines: Array<[string, Record<string, unknown>]> = [
    [brandName(b), { bold: true, size: 14, color: { argb: 'FF2563EB' } }],
    ...(contactLine(b) ? [[contactLine(b).replace(/ {2}• {2}/g, ' • '), { size: 9, color: { argb: 'FF64748B' } }] as [string, Record<string, unknown>]] : []),
    ...(legalLine(b) ? [[legalLine(b).replace(/ {2}• {2}/g, ' • '), { size: 9, color: { argb: 'FF64748B' } }] as [string, Record<string, unknown>]] : []),
    [title, { bold: true, size: 12, color: { argb: 'FF14213D' } }],
    [meta, { size: 9, color: { argb: 'FF64748B' } }],
  ]
  let n = 0
  for (const [text, font] of lines) {
    const row = ws.addRow([text])
    row.font = font
    n++
    if (span > 1) ws.mergeCells(n, 1, n, span)
  }
  ws.addRow([])
  return n + 2
}

// ---------- E-mail ----------

export interface MailContent {
  subject: string
  title: string
  paragraphs: string[]
  action?: { label: string; url: string }
}

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Version texte, pour les messageries qui n'affichent pas le HTML. */
export function mailText(c: MailContent, b: Brand) {
  const footer = [brandName(b), contactLine(b), legalLine(b)].filter(Boolean).join('\n')
  return [...c.paragraphs, ...(c.action ? [`${c.action.label} : ${c.action.url}`] : []), `--\n${footer}`].join('\n\n')
}

/**
 * E-mail au même design que les documents : couleurs unies, lisible sans images.
 * logoCid : identifiant du logo joint au message (les images en data: sont bloquées par Gmail).
 */
export function mailLayout(c: MailContent, b: Brand, logoCid?: string) {
  const mark = logoCid
    ? `<img src="cid:${logoCid}" alt="${esc(brandName(b))}" style="display:block;max-height:44px;max-width:160px;border:0">`
    : `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:34px;height:34px;border-radius:9px;background:${BLUE};color:#ffffff;font-weight:700;font-size:17px;text-align:center;vertical-align:middle">${esc(initial(b))}</td><td style="padding-left:10px;font-weight:700;font-size:17px;color:${NAVY}">${esc(brandName(b))}</td></tr></table>`
  const contact = contactLine(b)
  const legal = legalLine(b)
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:24px 12px;background:#f5f7fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${NAVY}">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${LINE};border-radius:14px;overflow:hidden">
<div style="padding:22px 28px;border-bottom:1px solid ${LINE}">${mark}</div>
<div style="padding:26px 28px 8px">
<h1 style="font-size:20px;line-height:1.3;margin:0 0 14px;color:${NAVY}">${esc(c.title)}</h1>
${c.paragraphs.map((p) => `<p style="font-size:14.5px;line-height:1.55;margin:0 0 12px;color:#334155">${esc(p)}</p>`).join('\n')}
${c.action ? `<p style="margin:22px 0 18px"><a href="${esc(c.action.url)}" style="display:inline-block;background:${BLUE};color:#ffffff;text-decoration:none;font-weight:600;font-size:14.5px;padding:12px 20px;border-radius:10px">${esc(c.action.label)}</a></p>
<p style="font-size:12px;line-height:1.5;color:${GREY};margin:0 0 12px;word-break:break-all">Si le bouton ne fonctionne pas, copiez ce lien : ${esc(c.action.url)}</p>` : ''}
</div>
<div style="padding:16px 28px 20px;background:#f8fafc;border-top:1px solid ${LINE};font-size:12px;line-height:1.6;color:${GREY}">
<div style="font-weight:600;color:${NAVY}">${esc(brandName(b))}</div>
${contact ? `<div>${esc(contact)}</div>` : ''}${legal ? `<div>${esc(legal)}</div>` : ''}
<div style="margin-top:8px">${b ? `Message automatique envoyé par ${PLATFORM_NAME} pour le compte de ${esc(b.tradeName)}.` : 'Message automatique : merci de ne pas y répondre.'}</div>
</div></div></body></html>`
}
