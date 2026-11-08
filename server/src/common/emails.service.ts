/**
 * E-mails de l'application : comptes, abonnement et facturation. Les e-mails aux clients des
 * entreprises sont dans le module des livraisons (ils joignent le bon de livraison).
 *
 * Règles :
 * - un e-mail ne fait jamais échouer l'opération qui l'a déclenché : il part en arrière-plan,
 *   sauf l'invitation, dont le résultat est montré à celui qui crée le compte ;
 * - chaque envoi est inscrit dans EmailLog (réussite ou échec, jamais le contenu) ;
 * - un rappel porte une clé anti-doublon : il ne part qu'une fois, même si la tâche horaire repasse ;
 * - sans compte d'envoi configuré, rien n'est tenté ni journalisé.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import bcrypt from 'bcryptjs'
import { OutboundService } from './core.services.js'
import type { MailContent } from './pdf.js'
import { PrismaService } from './prisma.service.js'
import { ROLES } from './constants.js'
import { companyTimeZone, formatDate, formatDateTime } from './time.js'
import { opaqueToken, sha256 } from './util.js'

export const INVITE_DAYS = 7
const DAY = 86400_000

export type Attachment = { filename: string; content: Buffer; contentType: string }
export interface SendResult { sent: boolean; skipped?: boolean; error?: string }

/** Adresse publique du web, pour les liens des e-mails. */
export function webUrl(path: string) {
  const base = (process.env.WEB_PUBLIC_URL ?? (process.env.WEB_ORIGINS ?? 'http://localhost:5173').split(',')[0]).trim().replace(/\/$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

export function formatMoney(amount: unknown, currency: string) {
  const value = Number(amount)
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

const durationLabel = (months: number) => (months === 1 ? '1 mois' : months === 12 ? '1 an' : months === 24 ? '2 ans' : `${months} mois`)

@Injectable()
export class EmailsService implements OnModuleDestroy {
  private readonly log = new Logger('Emails')
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly prisma: PrismaService, private readonly outbound: OutboundService) {}

  // ---------- Mécanique ----------

  /** En arrière-plan : la réponse à l'utilisateur n'attend pas le serveur d'envoi. */
  later(job: () => Promise<unknown>) {
    const run: Promise<unknown> = job()
      .catch((error) => this.log.error(`E-mail non envoyé : ${(error as Error).message}`))
      .finally(() => this.pending.delete(run))
    this.pending.add(run)
  }

  /** Attend les envois en cours (arrêt du serveur, tests). */
  async flush() {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  async onModuleDestroy() {
    await this.flush()
  }

  async configured() {
    return this.outbound.mailConfigured()
  }

  /** Envoie un e-mail et l'inscrit au journal. Avec dedupeKey, un e-mail déjà parti n'est jamais renvoyé ; un échec, si. */
  async send(o: { to: string; kind: string; content: MailContent; companyId?: string | null; dedupeKey?: string; attachments?: Attachment[] }): Promise<SendResult> {
    if (!o.to || !(await this.outbound.mailConfigured())) return { sent: false, skipped: true, error: "L'envoi des e-mails n'est pas configuré." }
    if (o.dedupeKey) {
      const done = await this.prisma.emailLog.findUnique({ where: { dedupeKey: o.dedupeKey } })
      if (done?.status === 'SENT') return { sent: false, skipped: true }
    }
    let error: string | undefined
    try {
      await this.outbound.mail(o.to, o.content, o.companyId, { attachments: o.attachments })
    } catch (e) {
      error = (e as Error).message
    }
    const row = { companyId: o.companyId ?? null, kind: o.kind, recipient: o.to, subject: o.content.subject.slice(0, 190), status: error ? 'FAILED' : 'SENT', error: error ?? null }
    if (o.dedupeKey) await this.prisma.emailLog.upsert({ where: { dedupeKey: o.dedupeKey }, create: { ...row, dedupeKey: o.dedupeKey }, update: { ...row, createdAt: new Date() } })
    else await this.prisma.emailLog.create({ data: row })
    return error ? { sent: false, error } : { sent: true }
  }

  /** Un même message à plusieurs personnes : un e-mail chacune, pour ne jamais exposer les adresses des autres. */
  private async sendAll(recipients: string[], o: Omit<Parameters<EmailsService['send']>[0], 'to'>) {
    for (const to of recipients) await this.send({ ...o, to, dedupeKey: o.dedupeKey ? `${o.dedupeKey}:${to}` : undefined })
  }

  /** Administrateurs principaux actifs, et l'adresse officielle de l'entreprise. */
  async companyAdmins(companyId: string) {
    const [company, admins] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { email: true } }),
      this.prisma.companyMembership.findMany({ where: { companyId, role: 'COMPANY_ADMIN', isActive: true, user: { isActive: true } }, select: { user: { select: { email: true } } } }),
    ])
    return [...new Set([...admins.map((a) => a.user.email), company?.email].filter((e): e is string => !!e).map((e) => e.toLowerCase()))]
  }

  private async superAdmins() {
    const rows = await this.prisma.user.findMany({ where: { isSuperAdmin: true, isActive: true, email: { not: null } }, select: { email: true } })
    return rows.map((r) => r.email!)
  }

  /** L'entreprise d'un utilisateur, s'il n'en a qu'une : ses e-mails en portent les couleurs. */
  async userCompany(userId: string) {
    const ids = [...new Set((await this.prisma.companyMembership.findMany({ where: { userId, isActive: true }, select: { companyId: true } })).map((m) => m.companyId))]
    return ids.length === 1 ? ids[0] : null
  }

  // ---------- Comptes ----------

  /** Mot de passe inutilisable, en attendant que l'invité choisisse le sien. */
  static async placeholderPassword() {
    return bcrypt.hash(opaqueToken(32), 10)
  }

  /**
   * Invitation : un lien valable 7 jours pour choisir son mot de passe. Personne d'autre que l'invité
   * ne le connaît. Attendue, pour dire tout de suite à celui qui crée le compte si elle est partie.
   */
  async invite(userId: string, companyId: string | null, invitedBy?: string | null): Promise<SendResult> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } })
    if (!user.email) return { sent: false, error: "Ce compte n'a pas d'adresse e-mail." }
    if (!(await this.configured())) return { sent: false, skipped: true, error: "L'envoi des e-mails n'est pas configuré." }
    const token = opaqueToken(32)
    await this.prisma.passwordReset.create({ data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_DAYS * DAY) } })
    const [company, membership] = await Promise.all([
      companyId ? this.prisma.company.findUnique({ where: { id: companyId }, select: { tradeName: true } }) : null,
      companyId ? this.prisma.companyMembership.findUnique({ where: { companyId_userId: { companyId, userId } }, select: { role: true } }) : null,
    ])
    const role = membership ? ROLES[membership.role]?.label : null
    const space = company ? `l'espace ${company.tradeName}` : 'LogisticTrack'
    return this.send({
      to: user.email, kind: 'account.invite', companyId,
      content: {
        subject: company ? `Votre accès à ${company.tradeName} sur LogisticTrack` : 'Votre accès à LogisticTrack',
        title: `Bienvenue sur ${space}`,
        paragraphs: [
          `Bonjour ${user.fullName},`,
          `${invitedBy ? `${invitedBy} vous a créé` : 'Un compte vous a été créé'} un accès${role ? ` « ${role} »` : ''} sur ${space}.`,
          `Pour l'activer, choisissez votre mot de passe. Ce lien est valable ${INVITE_DAYS} jours et ne sert qu'une fois.`,
          `Votre identifiant de connexion : ${user.email}`,
        ],
        action: { label: 'Choisir mon mot de passe', url: webUrl(`/mot-de-passe-oublie?token=${token}&bienvenue=1`) },
      },
    })
  }

  /** Compte créé avec un mot de passe transmis à part : on prévient, sans jamais écrire le mot de passe. */
  welcome(userId: string, companyId: string | null) {
    this.later(async () => {
      const user = await this.prisma.user.findUnique({ where: { id: userId } })
      if (!user?.email) return
      const company = companyId ? await this.prisma.company.findUnique({ where: { id: companyId }, select: { tradeName: true } }) : null
      await this.send({
        to: user.email, kind: 'account.welcome', companyId,
        content: {
          subject: company ? `Votre accès à ${company.tradeName} sur LogisticTrack` : 'Votre accès à LogisticTrack',
          title: 'Votre compte est prêt',
          paragraphs: [
            `Bonjour ${user.fullName},`,
            `Un accès vous a été créé${company ? ` sur l'espace ${company.tradeName}` : ''}. Votre identifiant : ${user.email}.`,
            'Le mot de passe vous est communiqué par la personne qui a créé votre compte. Changez-le après votre première connexion.',
          ],
          action: { label: 'Se connecter', url: webUrl('/connexion') },
        },
      })
    })
  }

  /** Lien « mot de passe oublié », valable une heure ; 24 heures s'il est envoyé par l'administrateur. */
  async resetLink(userId: string, opts: { byAdmin?: boolean } = {}) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } })
    if (!user.email) return { sent: false, error: "Ce compte n'a pas d'adresse e-mail." } as SendResult
    const token = opaqueToken(32)
    const hours = opts.byAdmin ? 24 : 1
    await this.prisma.passwordReset.create({ data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + hours * 3600_000) } })
    return this.send({
      to: user.email, kind: 'account.reset', companyId: await this.userCompany(userId),
      content: {
        subject: 'Réinitialisation de votre mot de passe',
        title: 'Réinitialisation de votre mot de passe',
        paragraphs: opts.byAdmin
          ? [`Bonjour ${user.fullName},`, "Votre administrateur vous envoie ce lien pour choisir un nouveau mot de passe. Il est valable 24 heures et ne sert qu'une fois.", "Votre mot de passe actuel reste valable tant que vous n'en avez pas choisi un nouveau."]
          : [`Bonjour ${user.fullName},`, 'Vous avez demandé à choisir un nouveau mot de passe. Ce lien est valable une heure.', "Si vous n'avez rien demandé, ignorez ce message : votre mot de passe ne change pas."],
        action: { label: 'Choisir un nouveau mot de passe', url: webUrl(`/mot-de-passe-oublie?token=${token}`) },
      },
    })
  }

  /** Alerte de sécurité : le titulaire apprend tout changement de son mot de passe. */
  passwordChanged(userId: string, how: 'self' | 'link' | 'admin') {
    this.later(async () => {
      const user = await this.prisma.user.findUnique({ where: { id: userId } })
      if (!user?.email) return
      const companyId = await this.userCompany(userId)
      const tz = companyId ? await companyTimeZone(this.prisma, companyId) : undefined
      const by = how === 'admin' ? "par l'administrateur de votre entreprise" : how === 'link' ? 'avec un lien de réinitialisation' : 'depuis votre compte'
      await this.send({
        to: user.email, kind: 'security.password_changed', companyId,
        content: {
          subject: 'Votre mot de passe a été modifié',
          title: 'Votre mot de passe a été modifié',
          paragraphs: [
            `Bonjour ${user.fullName},`,
            `Le mot de passe de votre compte a été modifié ${by}, le ${formatDateTime(new Date(), tz)}. Les autres appareils connectés ont été déconnectés.`,
            "Si vous n'êtes pas à l'origine de ce changement, réinitialisez votre mot de passe tout de suite et prévenez votre administrateur.",
          ],
          action: how === 'admin' ? undefined : { label: 'Réinitialiser mon mot de passe', url: webUrl('/mot-de-passe-oublie') },
        },
      })
    })
  }

  /** Alerte de sécurité : compte bloqué après trop de mots de passe faux. */
  accountLocked(userId: string, minutes: number) {
    this.later(async () => {
      const user = await this.prisma.user.findUnique({ where: { id: userId } })
      if (!user?.email) return
      await this.send({
        to: user.email, kind: 'security.locked', companyId: await this.userCompany(userId),
        content: {
          subject: 'Votre compte est temporairement bloqué',
          title: 'Compte bloqué pour votre sécurité',
          paragraphs: [
            `Bonjour ${user.fullName},`,
            `Plusieurs mots de passe faux ont été saisis de suite sur votre compte. Il est bloqué ${minutes} minutes.`,
            "Si c'était vous, patientez ou choisissez un nouveau mot de passe : cela débloque aussitôt le compte. Sinon, quelqu'un essaie peut-être d'y accéder : changez votre mot de passe.",
          ],
          action: { label: 'Choisir un nouveau mot de passe', url: webUrl('/mot-de-passe-oublie') },
        },
      })
    })
  }

  // ---------- Abonnement et facturation ----------

  /** Facture émise : l'entreprise reçoit le montant à régler ; le Super Administrateur, une facture à encaisser. */
  invoiceIssued(invoiceId: string, reason: 'requested' | 'terms') {
    this.later(async () => {
      const inv = await this.prisma.subscriptionInvoice.findUnique({ where: { id: invoiceId }, include: { company: { select: { id: true, tradeName: true } } } })
      if (!inv) return
      const tz = await companyTimeZone(this.prisma, inv.companyId)
      const amount = formatMoney(inv.amount, inv.currency)
      const period = `${durationLabel(inv.durationMonths)}${inv.discountPercent ? `, remise de ${inv.discountPercent} %` : ''}`
      await this.sendAll(await this.companyAdmins(inv.companyId), {
        kind: 'billing.invoice', companyId: inv.companyId,
        content: {
          subject: `Facture ${inv.number} : ${amount}`,
          title: reason === 'terms' ? 'Votre facture a été mise à jour' : 'Votre facture est prête',
          paragraphs: [
            reason === 'terms' ? 'Les conditions de votre abonnement ont changé : votre facture en attente est remplacée par celle-ci.' : `Votre demande d'abonnement est enregistrée : ${period}.`,
            `Facture ${inv.number} — montant à régler : ${amount}.`,
            `Période couverte : du ${formatDate(inv.periodStart, tz)} au ${formatDate(inv.periodEnd, tz)}. Si votre abonnement a expiré, la période démarre au jour du règlement.`,
            "Rien ne change avant le règlement. Le paiement en ligne n'est pas encore disponible : réglez selon les modalités convenues avec LogisticTrack.",
          ],
          action: { label: 'Voir mon abonnement', url: webUrl('/abonnement') },
        },
      })
      if (reason === 'requested') {
        await this.sendAll(await this.superAdmins(), {
          kind: 'platform.invoice', companyId: null,
          content: {
            subject: `${inv.company.tradeName} : facture ${inv.number} à encaisser`,
            title: 'Nouvelle facture à encaisser',
            paragraphs: [`${inv.company.tradeName} a demandé un abonnement de ${period}.`, `Facture ${inv.number} : ${amount}. Enregistrez le paiement dans Factures dès sa réception.`],
            action: { label: 'Ouvrir les factures', url: webUrl('/admin/factures') },
          },
        })
      }
    })
  }

  /** Reçu de paiement. */
  paymentReceived(invoiceId: string) {
    this.later(async () => {
      const inv = await this.prisma.subscriptionInvoice.findUnique({ where: { id: invoiceId } })
      if (!inv || inv.status !== 'PAID') return
      const tz = await companyTimeZone(this.prisma, inv.companyId)
      const amount = formatMoney(inv.amount, inv.currency)
      await this.sendAll(await this.companyAdmins(inv.companyId), {
        kind: 'billing.receipt', companyId: inv.companyId, dedupeKey: `receipt:${inv.id}`,
        content: {
          subject: `Reçu de paiement — facture ${inv.number}`,
          title: 'Paiement reçu, merci',
          paragraphs: [
            `Nous avons bien reçu votre paiement de ${amount} pour la facture ${inv.number}${inv.paidAt ? `, le ${formatDate(inv.paidAt, tz)}` : ''}.`,
            `Votre abonnement est actif jusqu'au ${formatDate(inv.periodEnd, tz)}.`,
            'Conservez cet e-mail : il vaut reçu.',
          ],
          action: { label: 'Voir mon abonnement', url: webUrl('/abonnement') },
        },
      })
    })
  }

  /** Rappel avant échéance : J-7, J-3, J-1 pour un abonnement ; la veille seulement pour l'essai gratuit. */
  async subscriptionReminder(s: { id: string; companyId: string; status: string; endsAt: Date }, daysLeft: number) {
    const tz = await companyTimeZone(this.prisma, s.companyId)
    const trial = s.status === 'TRIAL'
    const when = daysLeft <= 1 ? 'demain' : `dans ${daysLeft} jours`
    await this.sendAll(await this.companyAdmins(s.companyId), {
      kind: trial ? 'billing.trial_ending' : 'billing.expiring', companyId: s.companyId, dedupeKey: `sub:${s.id}:${s.endsAt.toISOString()}:j-${daysLeft}`,
      content: {
        subject: trial ? `Votre essai gratuit se termine ${when}` : `Votre abonnement expire ${when}`,
        title: trial ? `Votre essai gratuit se termine ${when}` : `Votre abonnement expire ${when}`,
        paragraphs: [
          `${trial ? 'Votre essai gratuit' : 'Votre abonnement'} prend fin le ${formatDate(s.endsAt, tz)}.`,
          trial
            ? "Pour continuer sans interruption, choisissez votre durée d'abonnement : plus elle est longue, plus la remise est importante (jusqu'à 25 % sur 2 ans)."
            : "Pour éviter toute interruption, renouvelez dès maintenant : la nouvelle période s'ajoute à la fin de l'actuelle, sans perdre de jours.",
          "Sans abonnement, votre espace passe en lecture seule : rien n'est supprimé, mais plus aucune opération n'est possible.",
        ],
        action: { label: trial ? "Choisir mon abonnement" : 'Renouveler mon abonnement', url: webUrl('/abonnement') },
      },
    })
  }

  /** Échéance passée : période de grâce, puis lecture seule. */
  async subscriptionEnded(s: { id: string; companyId: string; endsAt: Date; graceEndsAt: Date | null }, state: 'GRACE' | 'EXPIRED') {
    const tz = await companyTimeZone(this.prisma, s.companyId)
    const grace = state === 'GRACE'
    await this.sendAll(await this.companyAdmins(s.companyId), {
      kind: grace ? 'billing.grace' : 'billing.expired', companyId: s.companyId, dedupeKey: `sub:${s.id}:${s.endsAt.toISOString()}:${state}`,
      content: {
        subject: grace ? 'Votre abonnement est arrivé à échéance' : 'Votre espace est en lecture seule',
        title: grace ? 'Votre abonnement est arrivé à échéance' : 'Votre espace est passé en lecture seule',
        paragraphs: grace
          ? [
              `Votre abonnement a pris fin le ${formatDate(s.endsAt, tz)}. Vous bénéficiez d'une période de grâce jusqu'au ${formatDate(s.graceEndsAt, tz)} : tout fonctionne encore normalement.`,
              'Après cette date, votre espace passera en lecture seule. Renouvelez maintenant pour éviter toute interruption.',
            ]
          : [
              "Faute de renouvellement, votre espace est en lecture seule : vos données sont conservées et consultables, mais aucune nouvelle opération n'est possible.",
              "Les missions déjà en route peuvent se terminer. Dès le règlement de votre abonnement, tout redevient normal, et la période payée démarre au jour du règlement.",
            ],
        action: { label: 'Renouveler mon abonnement', url: webUrl('/abonnement') },
      },
    })
  }
}
