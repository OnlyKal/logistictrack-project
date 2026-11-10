import { BadGatewayException, BadRequestException, ForbiddenException, forwardRef, Inject, Injectable, Logger, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common'
import { createReadStream, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Server } from 'socket.io'
import { PrismaService, type Tx } from './prisma.service.js'
import type { AuthContext, TenantContext } from './context.js'
import nodemailer, { type Transporter } from 'nodemailer'
import { brandName, loadBrand, mailLayout, mailText, platformLogo, readLogo, type Brand, type MailContent } from './pdf.js'
import { decryptSecret, detectFileType, encryptSecret, hmac, safeEqual, secret, sha256 } from './util.js'

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(ctx: Pick<AuthContext, 'companyId' | 'userId' | 'ip'> | null, action: string, entity?: string, entityId?: string, details?: unknown, tx?: Tx) {
    await (tx ?? this.prisma).auditLog.create({
      data: {
        companyId: ctx?.companyId ?? null,
        userId: ctx?.userId ?? null,
        ip: ctx?.ip,
        action,
        entity,
        entityId,
        details: details === undefined ? undefined : JSON.stringify(details),
      },
    })
  }
}

@Injectable()
export class SequenceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Numéro métier séquentiel par entreprise, ex. LVR-2026-000025. */
  async next(tx: Tx, companyId: string, name: string, prefix: string): Promise<string> {
    await tx.sequence.upsert({
      where: { companyId_name: { companyId, name } },
      create: { companyId, name, value: 1 },
      update: { value: { increment: 1 } },
    })
    const row = await tx.sequence.findUniqueOrThrow({ where: { companyId_name: { companyId, name } } })
    return `${prefix}-${new Date().getFullYear()}-${String(row.value).padStart(6, '0')}`
  }
}

/** Diffusion temps réel, toujours limitée à la salle de l'entreprise ou de l'utilisateur. */
@Injectable()
export class RealtimeService {
  server: Server | null = null
  toCompany(companyId: string, event: string, payload: unknown) {
    this.server?.to(`company:${companyId}`).emit(event, payload)
  }
  toTracking(companyId: string, event: string, payload: unknown) {
    this.server?.to(`tracking:${companyId}`).emit(event, payload)
  }
  toUser(userId: string, event: string, payload: unknown) {
    this.server?.to(`user:${userId}`).emit(event, payload)
  }
  /** Page publique de suivi d'une livraison : uniquement des données filtrées pour le client. */
  toPublicDelivery(deliveryId: string, event: string, payload: unknown) {
    this.server?.to(`public:delivery:${deliveryId}`).emit(event, payload)
  }
}

/** Point d'extension : brancher ici un fournisseur SMS, e-mail ou WhatsApp Business. */
export interface OutboundChannel {
  send(to: string, kind: 'sms' | 'email', title: string, body: string): Promise<void>
}

/** Réglages SMTP saisis par le Super Administrateur. Le mot de passe vide conserve celui déjà enregistré. */
export interface MailSettingsInput {
  host: string
  port: number
  secure: boolean
  user: string
  password?: string
  from?: string | null
}

interface MailConfig {
  source: 'admin' | 'env'
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
}

const MAIL_PURPOSE = 'mail-password'

/**
 * Envoi des e-mails par SMTP (Gmail par défaut). Les réglages saisis dans l'administration priment ;
 * sans eux, le serveur utilise MAIL_HOST, MAIL_USER, MAIL_PASSWORD et MAIL_FROM du fichier .env.
 * Les SMS n'ont pas encore de fournisseur.
 */
@Injectable()
export class OutboundService implements OutboundChannel {
  constructor(
    private readonly prisma: PrismaService,
    // FileService est déclaré plus bas dans ce fichier : référence différée.
    @Inject(forwardRef(() => FileService)) private readonly files: Pick<FileService, 'readBuffer'>,
  ) {}

  private readonly log = new Logger('Outbound')
  /** Dernier message par destinataire, uniquement hors production (tests et démonstration). */
  readonly lastMessages = new Map<string, string>()
  /** Dernier e-mail complet par destinataire, hors production (tests du design). */
  readonly lastMails = new Map<string, { from: unknown; replyTo?: string; subject: string; html: string; attachments: number }>()
  /**
   * Réglages lus en base, gardés en mémoire une minute au plus : avec plusieurs instances du serveur,
   * une modification faite sur l'une est prise en compte par les autres sans redémarrage.
   */
  private cached?: { config: MailConfig | null; unreadable: boolean; at: number }
  private transport?: Transporter

  private envConfig(): MailConfig | null {
    const user = process.env.MAIL_USER ?? ''
    const pass = process.env.MAIL_PASSWORD ?? ''
    if (!user || !pass) return null
    return {
      source: 'env', host: process.env.MAIL_HOST ?? 'smtp.gmail.com', port: Number(process.env.MAIL_PORT ?? 465),
      secure: (process.env.MAIL_SECURE ?? 'true') === 'true', user, pass, from: process.env.MAIL_FROM ?? user,
    }
  }

  private async load() {
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached
    const previous = this.cached?.config
    const row = await this.prisma.mailSettings.findUnique({ where: { id: 'default' } })
    let next: { config: MailConfig | null; unreadable: boolean; at: number }
    if (!row) {
      next = { config: this.envConfig(), unreadable: false, at: Date.now() }
    } else {
      const pass = decryptSecret(row.passwordEnc, MAIL_PURPOSE)
      if (pass === null) {
        // JWT_SECRET a changé depuis l'enregistrement : le mot de passe doit être ressaisi.
        this.log.error("Mot de passe d'envoi des e-mails illisible : ressaisissez-le dans l'administration.")
        next = { config: null, unreadable: true, at: Date.now() }
      } else {
        next = {
          config: { source: 'admin', host: row.host, port: row.port, secure: row.secure, user: row.user, pass, from: row.fromAddress || row.user },
          unreadable: false, at: Date.now(),
        }
      }
    }
    // Connexion SMTP refaite seulement si les réglages ont changé.
    if (JSON.stringify(previous ?? null) !== JSON.stringify(next.config)) {
      this.transport?.close()
      this.transport = undefined
    }
    return (this.cached = next)
  }

  private reset() {
    this.cached = undefined
    this.transport?.close()
    this.transport = undefined
  }

  /** Vrai si un e-mail peut partir. En test, MAIL_TRANSPORT=json simule l'envoi. */
  async mailConfigured() {
    return process.env.MAIL_TRANSPORT === 'json' || !!(await this.load()).config
  }

  /** État affiché au Super Administrateur. Le mot de passe n'est jamais renvoyé. */
  async mailStatus() {
    const { config, unreadable } = await this.load()
    const row = config?.source === 'admin' || unreadable ? await this.prisma.mailSettings.findUnique({ where: { id: 'default' } }) : null
    const env = this.envConfig()
    return {
      configured: await this.mailConfigured(),
      source: row ? 'admin' : env ? 'env' : null,
      host: row?.host ?? env?.host ?? 'smtp.gmail.com',
      port: row?.port ?? env?.port ?? 465,
      secure: row?.secure ?? env?.secure ?? true,
      // Compte du .env masqué ; celui de l'administration est affiché en clair pour pouvoir le modifier.
      user: row ? row.user : env ? env.user.replace(/^(.{2}).*(@.*)$/, '$1•••$2') : null,
      from: row ? row.fromAddress : env?.from ?? null,
      hasPassword: !!row || !!env,
      passwordUnreadable: unreadable,
      envAvailable: !!env,
    }
  }

  /** Enregistre les réglages de l'administration. Ils remplacent aussitôt ceux du .env, sans redémarrage. */
  async saveMailSettings(input: MailSettingsInput, userId: string) {
    const existing = await this.prisma.mailSettings.findUnique({ where: { id: 'default' } })
    const password = input.password ?? ''
    if (!password && (!existing || decryptSecret(existing.passwordEnc, MAIL_PURPOSE) === null)) {
      throw new BadRequestException('Saisissez le mot de passe du compte d\'envoi.')
    }
    const data = {
      host: input.host, port: input.port, secure: input.secure, user: input.user, fromAddress: input.from || null, updatedById: userId,
      ...(password ? { passwordEnc: encryptSecret(password, MAIL_PURPOSE) } : {}),
    }
    await this.prisma.mailSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...data, passwordEnc: data.passwordEnc ?? '' },
      update: data,
    })
    this.reset()
  }

  /** Supprime les réglages de l'administration : le serveur revient à ceux du .env. */
  async clearMailSettings() {
    await this.prisma.mailSettings.deleteMany({ where: { id: 'default' } })
    this.reset()
  }

  private mailer(config: MailConfig | null) {
    if (this.transport) return this.transport
    this.transport = process.env.MAIL_TRANSPORT === 'json' || !config
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, auth: { user: config.user, pass: config.pass } })
    return this.transport
  }

  /**
   * Envoie un e-mail au design commun. Avec companyId, il porte le logo, le nom et les coordonnées
   * de cette entreprise, et les réponses lui parviennent ; sinon il est signé LogisticTrack.
   * Un refus du serveur d'envoi est signalé clairement (mot de passe d'application Gmail, par exemple).
   */
  async mail(to: string, content: MailContent, companyId?: string | null, extra: { attachments?: Array<{ filename: string; content: Buffer; contentType: string }> } = {}) {
    const { config, unreadable } = await this.load()
    if (!(await this.mailConfigured())) {
      throw new BadGatewayException(unreadable
        ? "Le mot de passe d'envoi des e-mails est illisible : ressaisissez-le dans Mon compte."
        : "L'envoi des e-mails n'est pas configuré : renseignez le compte d'envoi dans Mon compte.")
    }
    const brand: Brand = await loadBrand(this.prisma, companyId)
    // Entreprise : son logo (ou son initiale) ; plateforme : le logo LT de LogisticTrack.
    const logo = brand ? await readLogo(this.files as FileService, brand) : platformLogo()
    const logoCid = logo ? 'logo@logistictrack' : undefined
    const text = mailText(content, brand)
    const html = mailLayout(content, brand, logoCid)
    // L'adresse reste celle du compte d'envoi (sinon Gmail refuse) ; seul le nom affiché change.
    const configured = config?.from ?? process.env.MAIL_FROM ?? process.env.MAIL_USER ?? ''
    const address = /<([^>]+)>/.exec(configured)?.[1] ?? configured
    const from = brand ? { name: `${brandName(brand)} via LogisticTrack`, address } : configured
    const replyTo = brand?.email ?? undefined
    const attachments = [...(logo ? [{ filename: logo.mimeType === 'image/png' ? 'logo.png' : 'logo.jpg', content: logo.buffer, cid: logoCid, contentType: logo.mimeType }] : []), ...(extra.attachments ?? [])]
    if (process.env.NODE_ENV !== 'production') {
      this.lastMessages.set(to, text)
      this.lastMails.set(to, { from, replyTo, subject: content.subject, html, attachments: attachments.length })
    }
    try {
      await this.mailer(config).sendMail({ from, replyTo, to, subject: content.subject, text, html, attachments })
    } catch (error) {
      this.log.error(`E-mail « ${content.subject} » non envoyé : ${(error as Error).message}`)
      throw new BadGatewayException(smtpErrorMessage(error as Error & { code?: string; responseCode?: number }))
    }
  }

  async send(to: string, kind: 'sms' | 'email', title: string, body: string, companyId?: string | null) {
    if (kind === 'email' && (await this.mailConfigured())) {
      await this.mail(to, { subject: title, title, paragraphs: body.split(/\n{2,}/) }, companyId).catch(() => undefined)
      return
    }
    if (process.env.NODE_ENV !== 'production') {
      this.lastMessages.set(to, body)
      this.log.log(`[${kind}] ${to} — ${title} : ${body}`)
    } else {
      // Aucun fournisseur : on signale sans journaliser le contenu.
      this.log.warn(`[${kind}] aucun fournisseur configuré, message « ${title} » non envoyé`)
    }
  }
}

/** Traduit les refus SMTP courants en consignes compréhensibles ; le détail technique reste dans les journaux du serveur. */
export function smtpErrorMessage(error: Error & { code?: string; responseCode?: number }) {
  if (error.code === 'EAUTH' || error.responseCode === 535 || error.responseCode === 534) {
    return "Identifiant ou mot de passe refusé par le serveur d'envoi. Pour Gmail, utilisez un mot de passe d'application (16 lettres, sans espaces), pas le mot de passe du compte, et vérifiez que la validation en deux étapes est activée."
  }
  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(error.code ?? '')) {
    return "Impossible de joindre le serveur d'envoi. Vérifiez le serveur SMTP, le port (465 avec SSL coché, ou 587 décoché) et la connexion Internet du serveur."
  }
  if (error.code === 'EENVELOPE' || error.responseCode === 550 || error.responseCode === 553) {
    return "Adresse refusée par le serveur d'envoi. Vérifiez l'adresse du destinataire et l'expéditeur affiché : avec Gmail, il doit correspondre au compte d'envoi."
  }
  return `Le serveur d'envoi a refusé l'e-mail : ${error.message}`
}

export const NOTIFICATION_DEFAULTS: Record<string, { title: string; body: string }> = {
  ORDER_CREATED: { title: 'Commande créée', body: 'La commande {{number}} a été créée.' },
  ORDER_VALIDATED: { title: 'Commande validée', body: 'La commande {{number}} a été validée.' },
  GOODS_READY: { title: 'Marchandise prête', body: 'La commande {{number}} est prête.' },
  DELIVERY_ASSIGNED: { title: 'Nouvelle mission', body: 'La livraison {{number}} vous a été affectée.' },
  DELIVERY_RECALLED: { title: 'Mission arrêtée', body: "La livraison {{number}} est arrêtée par votre entreprise : retournez à l'entrepôt." },
  DELIVERY_REFUSED: { title: 'Mission refusée', body: 'La livraison {{number}} a été refusée par le chauffeur.' },
  DRIVER_EN_ROUTE: { title: 'Chauffeur en route', body: 'La livraison {{number}} est en route.' },
  DRIVER_ARRIVED: { title: 'Chauffeur arrivé', body: 'Le chauffeur est arrivé pour la livraison {{number}}.' },
  DELIVERY_DONE: { title: 'Livraison terminée', body: 'La livraison {{number}} est terminée.' },
  PICKUP_READY: { title: 'Disponible au retrait', body: 'La livraison {{number}} attend son client à {{warehouse}}.' },
  DELIVERY_FAILED: { title: 'Livraison échouée', body: 'La livraison {{number}} a échoué : {{reason}}.' },
  INCIDENT: { title: 'Incident signalé', body: 'Incident sur la livraison {{number}} : {{reason}}.' },
  STOCK_LOW: { title: 'Stock faible', body: 'Le stock de {{product}} est sous le seuil ({{quantity}}).' },
  BATCH_EXPIRING: { title: 'Produit bientôt expiré', body: 'Le lot {{batch}} de {{product}} expire le {{date}}.' },
  TRANSFER_RECEIVED: { title: 'Transfert reçu', body: 'Le transfert {{number}} a été réceptionné.' },
  LICENSE_EXPIRING: { title: 'Permis bientôt expiré', body: 'Le permis de {{driver}} expire le {{date}}.' },
  SUBSCRIPTION_EXPIRING: { title: 'Abonnement bientôt expiré', body: "L'abonnement expire le {{date}}." },
  PAYMENT_CONFIRMED: { title: 'Paiement confirmé', body: 'Le paiement de la facture {{number}} est confirmé.' },
}

@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService, private readonly realtime: RealtimeService) {}

  private render(tpl: string, vars: Record<string, unknown>) {
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''))
  }

  /** Utilisateurs actifs de l'entreprise détenant l'un des rôles donnés. */
  async usersWithRoles(companyId: string, roles: string[]): Promise<string[]> {
    const rows = await this.prisma.companyMembership.findMany({
      where: { companyId, isActive: true, role: { in: roles }, user: { isActive: true } },
      select: { userId: true },
    })
    return rows.map((r) => r.userId)
  }

  async notify(companyId: string, userIds: string[], type: string, vars: Record<string, unknown>, ref?: { type: string; id: string }) {
    const unique = [...new Set(userIds)]
    if (!unique.length) return
    const custom = await this.prisma.notificationTemplate.findUnique({ where: { companyId_type: { companyId, type } } })
    const tpl = custom ?? NOTIFICATION_DEFAULTS[type] ?? { title: type, body: '' }
    const title = this.render(tpl.title, vars)
    const body = this.render(tpl.body, vars)
    for (const userId of unique) {
      const row = await this.prisma.notification.create({
        data: { companyId, userId, type, title, body, refType: ref?.type, refId: ref?.id },
      })
      this.realtime.toUser(userId, 'notification', row)
    }
  }

  async notifyRoles(companyId: string, roles: string[], type: string, vars: Record<string, unknown>, ref?: { type: string; id: string }) {
    await this.notify(companyId, await this.usersWithRoles(companyId, roles), type, vars, ref)
  }
}

/**
 * Stockage privé des fichiers. Implémentation disque ; un stockage S3 compatible peut
 * remplacer ce service sans toucher aux modules métier.
 */
@Injectable()
export class FileService {
  private readonly root = resolve(process.env.STORAGE_DIR ?? './storage')
  constructor(private readonly prisma: PrismaService) {
    mkdirSync(this.root, { recursive: true })
  }

  async save(ctx: { companyId: string | null; userId: string }, file: { buffer: Buffer; mimetype: string; originalname?: string }) {
    // Le contenu réel décide : un fichier renommé ou mal déclaré est refusé.
    const detected = detectFileType(file.buffer)
    if (!detected) throw new UnsupportedMediaTypeException('Seules les images (PNG, JPEG, WebP) et les PDF sont acceptés.')
    const storageKey = `${ctx.companyId ?? 'platform'}/${randomUUID()}`
    mkdirSync(join(this.root, ctx.companyId ?? 'platform'), { recursive: true })
    await writeFile(join(this.root, storageKey), file.buffer)
    return this.prisma.uploadedFile.create({
      data: {
        companyId: ctx.companyId,
        uploadedById: ctx.userId,
        storageKey,
        originalName: file.originalname?.slice(0, 180),
        mimeType: detected,
        size: file.buffer.length,
        sha256: sha256(file.buffer),
      },
    })
  }

  /** URL temporaire signée pour un document privé. */
  async signedUrl(ctx: TenantContext, id: string, ttlSeconds = 300) {
    const file = await this.prisma.uploadedFile.findFirst({ where: { id, companyId: ctx.companyId } })
    if (!file) throw new NotFoundException('Fichier introuvable.')
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds
    const signature = hmac(secret('FILE_URL_SECRET'), `${id}.${expires}`)
    return { url: `/api/v1/files/${id}/content?expires=${expires}&signature=${signature}`, expiresIn: ttlSeconds }
  }

  async openSigned(id: string, expires: number, signature: string) {
    const valid = safeEqual(hmac(secret('FILE_URL_SECRET'), `${id}.${expires}`), signature ?? '')
    if (!valid || !(expires > Date.now() / 1000)) throw new ForbiddenException('Lien expiré ou invalide.')
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } })
    if (!file) throw new NotFoundException('Fichier introuvable.')
    return { file, stream: createReadStream(join(this.root, file.storageKey)) }
  }

  async readBuffer(id: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } })
    if (!file) return null
    const chunks: Buffer[] = []
    for await (const chunk of createReadStream(join(this.root, file.storageKey))) chunks.push(chunk as Buffer)
    return { buffer: Buffer.concat(chunks), mimeType: file.mimeType }
  }
}

