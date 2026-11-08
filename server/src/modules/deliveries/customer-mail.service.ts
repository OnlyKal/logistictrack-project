/**
 * E-mails aux clients d'une entreprise : en route, livrée (bon signé joint), échec.
 * Désactivés par défaut : l'entreprise les active dans ses Paramètres, et chaque client peut les refuser.
 * Un rappel du chauffeur par le bureau reste interne : le client n'est pas prévenu.
 */
import { Injectable } from '@nestjs/common'
import type { TenantContext } from '../../common/context.js'
import { EmailsService } from '../../common/emails.service.js'
import { publicTrackingUrl } from '../../common/public-link.js'
import { PrismaService } from '../../common/prisma.service.js'
import { RECALLED } from '../../common/constants.js'
import { companyTimeZone, formatDateTime } from '../../common/time.js'
import { DocumentsService, FAILURE_LABELS, type DocumentType } from './documents.service.js'

export type CustomerEvent = 'EN_ROUTE' | 'DELIVERED' | 'PARTIAL' | 'FAILED'

const SETTING: Record<CustomerEvent, 'customerEmailEnRoute' | 'customerEmailDelivered' | 'customerEmailFailed'> = {
  EN_ROUTE: 'customerEmailEnRoute', DELIVERED: 'customerEmailDelivered', PARTIAL: 'customerEmailDelivered', FAILED: 'customerEmailFailed',
}

@Injectable()
export class CustomerMailService {
  constructor(private readonly prisma: PrismaService, private readonly emails: EmailsService, private readonly docs: DocumentsService) {}

  /** Toujours en arrière-plan : la confirmation du chauffeur n'attend jamais le serveur d'envoi. */
  notify(companyId: string, deliveryId: string, event: CustomerEvent) {
    this.emails.later(() => this.send(companyId, deliveryId, event))
  }

  async send(companyId: string, deliveryId: string, event: CustomerEvent) {
    const settings = await this.prisma.companySettings.findUnique({ where: { companyId } })
    if (!settings?.[SETTING[event]]) return
    const d = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, companyId },
      include: { customer: true, deliveryPoint: true, driver: true, vehicle: true, company: { select: { tradeName: true } }, packages: { select: { trackingToken: true, trackingNumber: true }, take: 1 }, items: true },
    })
    if (!d || !d.customer.email || !d.customer.emailNotifications || d.customer.status !== 'active') return
    if (event === 'FAILED' && d.failureReason === RECALLED) return
    const tz = await companyTimeZone(this.prisma, companyId)
    const company = d.company.tradeName
    const place = [d.deliveryPoint.name, d.deliveryPoint.address, d.deliveryPoint.city].filter(Boolean).join(', ')
    // Lien unique et signé : il ouvre la carte en direct pendant le trajet.
    const tracking = d.packages[0]?.trackingToken ? publicTrackingUrl(d.packages[0].trackingToken) : null
    const hello = `Bonjour ${d.customer.name},`
    const optOut = `Vous recevez cet e-mail en tant que client de ${company}. Pour ne plus en recevoir, contactez ${company} en répondant à ce message.`

    if (event === 'EN_ROUTE') {
      await this.emails.send({
        to: d.customer.email, kind: 'customer.en_route', companyId, dedupeKey: `delivery:${d.id}:en_route:${d.attempts}`,
        content: {
          subject: `Votre livraison ${d.number} est en route`,
          title: 'Votre livraison est en route',
          paragraphs: [
            hello,
            `La livraison ${d.number} de ${company} vient de partir vers ${place}.`,
            "Suivez son trajet en direct sur la carte, sans compte ni mot de passe : la position du véhicule s'affiche jusqu'à son arrivée chez vous.",
            "Merci de prévoir une personne pour la réception : une signature pourra lui être demandée.",
            optOut,
          ].filter(Boolean),
          action: tracking ? { label: 'Suivre ma livraison', url: tracking } : undefined,
        },
      })
      return
    }

    if (event === 'FAILED') {
      const reason = d.failureReason ? FAILURE_LABELS[d.failureReason] ?? d.failureReason : null
      await this.emails.send({
        to: d.customer.email, kind: 'customer.failed', companyId, dedupeKey: `delivery:${d.id}:failed:${d.attempts}`,
        content: {
          subject: `Livraison ${d.number} non effectuée`,
          title: "Votre livraison n'a pas pu être effectuée",
          paragraphs: [
            hello,
            `La livraison ${d.number} prévue à ${place} n'a pas pu être effectuée${reason ? ` : ${reason.toLowerCase()}` : ''}.`,
            ...(d.failureComment ? [`Précision du chauffeur : ${d.failureComment}`] : []),
            `${company} va vous recontacter pour convenir d'une nouvelle livraison. Vous pouvez aussi répondre à cet e-mail.`,
            optOut,
          ],
        },
      })
      return
    }

    // Livrée ou partiellement livrée : le document signé est joint.
    const type: DocumentType = event === 'PARTIAL' ? 'partial' : 'receipt'
    const ctx = { companyId, userId: '', role: 'COMPANY_ADMIN', warehouseIds: null, permissions: new Set<string>() } as unknown as TenantContext
    const pdf = await this.docs.delivery(ctx, d.id, type)
    const short = d.items.filter((i) => Number(i.quantityRefused) > 0 || Number(i.quantityMissing) > 0).length
    await this.emails.send({
      to: d.customer.email, kind: event === 'PARTIAL' ? 'customer.partial' : 'customer.delivered', companyId, dedupeKey: `delivery:${d.id}:delivered`,
      attachments: [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }],
      content: {
        subject: event === 'PARTIAL' ? `Livraison ${d.number} : livrée partiellement` : `Livraison ${d.number} : livrée`,
        title: event === 'PARTIAL' ? 'Votre livraison a été livrée partiellement' : 'Votre livraison a été livrée',
        paragraphs: [
          hello,
          `La livraison ${d.number} a été remise à ${place}${d.deliveredAt ? `, le ${formatDateTime(d.deliveredAt, tz)}` : ''}${d.recipientName ? `, à ${d.recipientName}` : ''}.`,
          ...(event === 'PARTIAL' ? [`${short} article(s) n'ont pas été remis en totalité : le détail et les motifs figurent dans le document joint.`] : []),
          `Le ${event === 'PARTIAL' ? 'rapport de livraison' : 'accusé de réception'}, avec les preuves de remise, est joint à cet e-mail.`,
          `Une question ou une réserve ? Répondez simplement à cet e-mail : il parvient à ${company}.`,
          optOut,
        ],
      },
    })
  }
}
