/** Administration du SaaS : entreprises, abonnements, facturation, utilisateurs, journaux. */
import { BadGatewayException, BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException,Get, Headers, HttpCode, Injectable, Module, NotFoundException, Param, Patch, Post, Put, Query, Req, Res, StreamableFile, UploadedFile, UnauthorizedException, UseInterceptors } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Prisma } from '@prisma/client'
import bcrypt from 'bcryptjs'
import type { Response } from 'express'
import { z } from 'zod'
import { AuditService, FileService, NOTIFICATION_DEFAULTS, NotificationService, OutboundService } from '../../common/core.services.js'
import { permissionsFor } from '../../common/auth.guard.js'
import { backupRoot, listBackups, runBackup } from '../../common/backup.js'
import { isTimeZone } from '../../common/time.js'
import { EmailsService, type SendResult } from '../../common/emails.service.js'
import { LimitsService } from '../../common/limits.service.js'
import { AllowAnySubscription, AuthOnly, Ctx, Public, RequirePerm, SuperAdminOnly, type AuthContext, type TenantContext } from '../../common/context.js'
import { money, Msg, paged, parsePage, patchOf, uuid, zod } from '../../common/http.js'
import { PrismaService, type Tx } from '../../common/prisma.service.js'
import { PERMISSIONS, ROLES, SUBSCRIPTION_DISCOUNTS, TRIAL_DAYS, subscriptionStatus } from '../../common/constants.js'
import { D, hmac, readableCode, safeEqual, secret } from '../../common/util.js'

// ---------- Abonnements ----------
const duration = z.coerce.number().int().refine((n) => n in SUBSCRIPTION_DISCOUNTS, 'Durée invalide : 1, 3, 6, 12 ou 24 mois.')
const limit = z.coerce.number().int().min(0).max(1_000_000).nullish()
/** Prix et limites de chaque entreprise, fixés par le Super Administrateur. La durée, elle, est choisie par l'entreprise. */
const subscriptionTerms = z.object({
  monthlyAmount: z.coerce.number().positive().max(1e13), currency: z.string().trim().toUpperCase().length(3).default('USD'),
  maxWarehouses: limit, maxUsers: limit, maxDrivers: limit, maxVehicles: limit, maxDeliveriesMonth: limit,
  gpsEnabled: z.boolean().default(true), graceDays: z.coerce.number().int().min(0).max(90).default(7),
})
const renewSchema = z.object({ durationMonths: duration.optional() })
const paymentSchema = z.object({ invoiceId: uuid, provider: z.string().trim().min(2).max(40).default('manual'), externalRef: z.string().trim().min(2).max(120), amount: money, currency: z.string().length(3) })
const webhookSchema = z.object({ externalRef: z.string().min(2).max(120), invoiceNumber: z.string().min(2).max(40), amount: money, currency: z.string().length(3), status: z.enum(['SUCCEEDED', 'FAILED', 'REFUNDED']) })

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly notifications: NotificationService, private readonly emails: EmailsService) {}

  /** Passe une facture à payée et prolonge l'abonnement. Idempotent par (prestataire, référence). */
  async applyPayment(input: { invoiceId: string; provider: string; externalRef: string; amount: number; currency: string; status: 'SUCCEEDED' | 'FAILED' | 'REFUNDED'; payload?: string }, actor: AuthContext | null) {
    const outcome = await this.prisma.atomic(async (tx) => {
      const existing = await tx.payment.findUnique({ where: { provider_externalRef: { provider: input.provider, externalRef: input.externalRef } } })
      if (existing) return { payment: existing, replay: true, invoiceNumber: null as string | null, companyId: existing.companyId }
      const invoice = await tx.subscriptionInvoice.findUnique({ where: { id: input.invoiceId } })
      if (!invoice) throw new NotFoundException('Facture introuvable.')
      if (input.status === 'SUCCEEDED') {
        if (invoice.status === 'PAID') throw new ConflictException('Cette facture est déjà payée.')
        if (invoice.status !== 'UNPAID') throw new ConflictException("Cette facture n'est plus payable.")
        if (!invoice.amount.equals(input.amount) || invoice.currency !== input.currency) throw new BadRequestException('Le montant ou la devise ne correspond pas à la facture.')
      }
      const payment = await tx.payment.create({
        data: { companyId: invoice.companyId, invoiceId: invoice.id, provider: input.provider, externalRef: input.externalRef, amount: input.amount, currency: input.currency, status: input.status, payload: input.payload },
      })
      if (input.status === 'SUCCEEDED') {
        // Après expiration, la période payée démarre au règlement : les jours d'attente, en lecture seule, ne sont pas perdus.
        const subscription = await tx.subscription.findUniqueOrThrow({ where: { id: invoice.subscriptionId } })
        const now = new Date()
        const periodStart = subscriptionStatus(subscription) === 'EXPIRED' ? now : invoice.periodStart
        const periodEnd = new Date(periodStart)
        periodEnd.setUTCMonth(periodEnd.getUTCMonth() + invoice.durationMonths)
        await tx.subscriptionInvoice.update({ where: { id: invoice.id }, data: { status: 'PAID', paidAt: now, periodStart, periodEnd } })
        await tx.subscription.update({ where: { id: invoice.subscriptionId }, data: { status: 'ACTIVE', isCurrent: true, durationMonths: invoice.durationMonths, startsAt: periodStart, endsAt: periodEnd, graceEndsAt: null } })
      }
      if (input.status === 'REFUNDED') await tx.subscriptionInvoice.update({ where: { id: invoice.id }, data: { status: 'REFUNDED' } })
      return { payment, replay: false, invoiceNumber: invoice.number, companyId: invoice.companyId }
    })
    if (!outcome.replay) {
      await this.audit.log(actor ? { companyId: outcome.companyId, userId: actor.userId, ip: actor.ip } : { companyId: outcome.companyId, userId: null as unknown as string }, 'billing.payment', 'Payment', outcome.payment.id, { status: input.status, provider: input.provider })
      if (input.status === 'SUCCEEDED') {
        await this.notifications.notifyRoles(outcome.companyId, ['COMPANY_ADMIN'], 'PAYMENT_CONFIRMED', { number: outcome.invoiceNumber }, { type: 'Invoice', id: input.invoiceId })
        this.emails.paymentReceived(input.invoiceId)
      }
    }
    return outcome.payment
  }

  /** Montant monétaire exact : mensualité multipliée par la durée, moins la remise fixe de cette durée. */
  quote(monthlyAmount: Prisma.Decimal.Value, durationMonths: number) {
    const discountPercent = SUBSCRIPTION_DISCOUNTS[durationMonths]
    const gross = D(monthlyAmount).times(durationMonths)
    return { durationMonths, discountPercent, gross, total: gross.times(100 - discountPercent).div(100).toDecimalPlaces(2) }
  }

  private async createInvoice(tx: Tx, subscription: { id: string; companyId: string; monthlyAmount: Prisma.Decimal; currency: string }, durationMonths: number, from: Date) {
    const { discountPercent, total } = this.quote(subscription.monthlyAmount, durationMonths)
    const periodEnd = new Date(from)
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + durationMonths)
    return tx.subscriptionInvoice.create({
      data: {
        companyId: subscription.companyId, subscriptionId: subscription.id, monthlyAmount: subscription.monthlyAmount, durationMonths, discountPercent,
        amount: total, currency: subscription.currency, periodStart: from, periodEnd, number: `FAC-${new Date().getFullYear()}-${readableCode(8)}`,
      },
    })
  }

  /** Nouvelle entreprise : essai gratuit, sans facture. C'est elle qui s'abonne ensuite. */
  open(tx: Tx, companyId: string, terms: z.infer<typeof subscriptionTerms>) {
    const now = new Date()
    return tx.subscription.create({ data: { ...terms, companyId, status: 'TRIAL', startsAt: now, endsAt: new Date(now.getTime() + TRIAL_DAYS * 86400_000) } })
  }

  /** L'entreprise s'abonne, change de durée ou se réabonne. Jamais son prix : une facture différente remplace celle en attente. */
  async issueInvoice(companyId: string, durationMonths?: number) {
    const before = await this.prisma.subscriptionInvoice.findFirst({ where: { companyId, status: 'UNPAID' }, select: { id: true } })
    const invoice = await this.prisma.atomic(async (tx) => {
      const current = await tx.subscription.findFirst({ where: { companyId, isCurrent: true } })
      if (!current) throw new NotFoundException('Aucun abonnement.')
      const target = durationMonths ?? current.durationMonths
      const unpaid = await tx.subscriptionInvoice.findFirst({ where: { subscriptionId: current.id, status: 'UNPAID' } })
      if (unpaid?.durationMonths === target) return unpaid
      if (unpaid) await tx.subscriptionInvoice.update({ where: { id: unpaid.id }, data: { status: 'CANCELLED' } })
      const from = unpaid?.periodStart ?? (current.endsAt > new Date() ? current.endsAt : new Date())
      return this.createInvoice(tx, current, target, from)
    })
    // Une nouvelle facture seulement : redemander la même durée ne renvoie pas d'e-mail.
    if (invoice.id !== before?.id) this.emails.invoiceIssued(invoice.id, 'requested')
    return invoice
  }

  /** Le Super Administrateur fait varier les conditions. Une facture en attente est remplacée au nouveau prix. */
  async updateTerms(actor: AuthContext, companyId: string, body: Partial<z.infer<typeof subscriptionTerms>>) {
    let replaced: string | null = null
    const updated = await this.prisma.atomic(async (tx) => {
      const current = await tx.subscription.findFirst({ where: { companyId, isCurrent: true } })
      if (!current) throw new NotFoundException('Aucun abonnement.')
      const subscription = await tx.subscription.update({ where: { id: current.id }, data: body })
      const unpaid = await tx.subscriptionInvoice.findFirst({ where: { subscriptionId: current.id, status: 'UNPAID' } })
      if (unpaid && (!unpaid.monthlyAmount.equals(subscription.monthlyAmount) || unpaid.currency !== subscription.currency)) {
        await tx.subscriptionInvoice.update({ where: { id: unpaid.id }, data: { status: 'CANCELLED' } })
        replaced = (await this.createInvoice(tx, subscription, unpaid.durationMonths, unpaid.periodStart)).id
      }
      return subscription
    })
    if (replaced) this.emails.invoiceIssued(replaced, 'terms')
    await this.audit.log({ companyId, userId: actor.userId, ip: actor.ip }, 'billing.terms', 'Subscription', updated.id, body)
    return updated
  }
}

@Controller()
export class BillingController {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly limits: LimitsService) {}

  @AllowAnySubscription() @RequirePerm('billing.manage') @Get('subscriptions/current')
  async current(@Ctx() ctx: TenantContext) {
    const [subscription, usage] = await Promise.all([this.limits.subscription(ctx.companyId), this.limits.usage(ctx.companyId)])
    const durations = subscription ? Object.keys(SUBSCRIPTION_DISCOUNTS).map((m) => this.billing.quote(subscription.monthlyAmount, Number(m))) : []
    return { subscription: subscription && { ...subscription, status: subscriptionStatus(subscription) }, usage, durations }
  }

  /** État visible par tous les membres de l'entreprise, sans le montant : uniquement pour les prévenir. */
  @AuthOnly() @Get('subscriptions/status')
  async status(@Ctx() ctx: AuthContext) {
    const subscription = ctx.companyId ? await this.limits.subscription(ctx.companyId) : null
    return subscription && { status: subscriptionStatus(subscription), endsAt: subscription.endsAt, graceEndsAt: subscription.graceEndsAt }
  }

  /** L'entreprise choisit sa durée ; le montant vient toujours de son abonnement. */
  @AllowAnySubscription() @RequirePerm('billing.manage') @Post('subscriptions/renew') @HttpCode(200)
  renew(@Ctx() ctx: TenantContext, @Body(zod(renewSchema)) body: z.infer<typeof renewSchema>) { return this.billing.issueInvoice(ctx.companyId, body.durationMonths) }

  @SuperAdminOnly() @Patch('companies/:id/subscription') @Msg('Abonnement mis à jour.')
  updateTerms(@Ctx() ctx: AuthContext, @Param('id') id: string, @Body(zod(patchOf(subscriptionTerms))) body: Partial<z.infer<typeof subscriptionTerms>>) { return this.billing.updateTerms(ctx, id, body) }

  @AllowAnySubscription() @RequirePerm('billing.manage') @Get('subscriptions/invoices')
  invoices(@Ctx() ctx: TenantContext) { return this.prisma.subscriptionInvoice.findMany({ where: { companyId: ctx.companyId }, orderBy: { issuedAt: 'desc' }, take: 100 }) }

  @AllowAnySubscription() @RequirePerm('billing.manage') @Get('subscriptions/payments')
  payments(@Ctx() ctx: TenantContext) { return this.prisma.payment.findMany({ where: { companyId: ctx.companyId }, orderBy: { createdAt: 'desc' }, take: 100, include: { invoice: { select: { number: true } } } }) }

  /** Paiement enregistré manuellement par le Super Administrateur. */
  @SuperAdminOnly() @Post('admin/payments') @Msg('Paiement enregistré.')
  recordPayment(@Ctx() ctx: AuthContext, @Body(zod(paymentSchema)) body: z.infer<typeof paymentSchema>) { return this.billing.applyPayment({ ...body, status: 'SUCCEEDED' }, ctx) }

  @SuperAdminOnly() @Get('admin/invoices')
  async allInvoices(@Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.SubscriptionInvoiceWhereInput = p.status ? { status: p.status } : {}
    const [items, total] = await Promise.all([
      this.prisma.subscriptionInvoice.findMany({ where, skip: p.skip, take: p.take, orderBy: { issuedAt: 'desc' }, include: { company: { select: { tradeName: true } } } }),
      this.prisma.subscriptionInvoice.count({ where }),
    ])
    return paged(items, total, p)
  }

  /** Webhook générique d'un prestataire : authentifié par HMAC du corps brut, et idempotent. */
  @Public() @Post('payments/webhook/:provider') @HttpCode(200)
  async webhook(@Param('provider') provider: string, @Headers('x-signature') signature: string, @Req() req: { rawBody?: Buffer }, @Body(zod(webhookSchema)) body: z.infer<typeof webhookSchema>) {
    const raw = req.rawBody?.toString('utf8') ?? ''
    if (!signature || !safeEqual(hmac(secret('PAYMENT_WEBHOOK_SECRET'), raw), signature)) throw new UnauthorizedException('Signature invalide.')
    const invoice = await this.prisma.subscriptionInvoice.findUnique({ where: { number: body.invoiceNumber } })
    if (!invoice) throw new NotFoundException('Facture introuvable.')
    const payment = await this.billing.applyPayment({ invoiceId: invoice.id, provider, externalRef: body.externalRef, amount: body.amount, currency: body.currency, status: body.status, payload: raw }, null)
    return { id: payment.id, status: payment.status }
  }
}

// ---------- Entreprises (Super Administrateur) et profil de l'entreprise ----------
const companyPatch = z.object({
  tradeName: z.string().trim().min(2).max(190), legalName: z.string().trim().max(190).nullish(), description: z.string().max(2000).nullish(), taxId: z.string().trim().max(60).nullish(),
  rccm: z.string().trim().max(60).nullish(), address: z.string().trim().max(190).nullish(), country: z.string().trim().max(80).nullish(), province: z.string().trim().max(80).nullish(),
  city: z.string().trim().max(80).nullish(), phone: z.string().trim().max(40).nullish(), email: z.string().trim().toLowerCase().email(), sector: z.string().trim().max(80).nullish(),
}).partial()
const companyCreate = z.object({
  tradeName: z.string().trim().min(2).max(190), email: z.string().trim().toLowerCase().email(), adminName: z.string().trim().min(2).max(190),
  adminEmail: z.string().trim().toLowerCase().email(),
  // Facultatif : sans mot de passe, l'administrateur reçoit une invitation pour choisir le sien.
  adminPassword: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().min(8).max(200).optional()),
}).extend(subscriptionTerms.shape)
const settingsSchema = z.object({
  stockStrategy: z.enum(['FIFO', 'FEFO']), useLocations: z.boolean(), driversCanRefuse: z.boolean(), requireSignature: z.boolean(), requirePhoto: z.boolean(),
  requireRecipientName: z.boolean(), requireGpsOnProof: z.boolean(), requireQrOnLoad: z.boolean(), gpsRetentionDays: z.number().int().min(1).max(3650),
  currency: z.string().length(3), timezone: z.string().max(60).refine(isTimeZone, 'Fuseau horaire inconnu, par exemple Africa/Kinshasa.'), locale: z.enum(['fr', 'en']),
  customerEmailEnRoute: z.boolean(), customerEmailDelivered: z.boolean(), customerEmailFailed: z.boolean(),
}).partial()

/** Après la création d'un compte : invitation (pas de mot de passe saisi), ou simple message de bienvenue. */
async function accountEmail(emails: EmailsService, userId: string, companyId: string, invite: boolean, invitedBy: string | null) {
  if (!invite) {
    emails.welcome(userId, companyId)
    return { mode: 'password' as const, sent: null }
  }
  const r: SendResult = await emails.invite(userId, companyId, invitedBy)
  return { mode: 'invite' as const, sent: r.sent, error: r.error ?? null }
}

@Controller('companies')
export class CompaniesController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly files: FileService, private readonly billing: BillingService, private readonly emails: EmailsService) {}

  @SuperAdminOnly() @Get()
  async list(@Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.CompanyWhereInput = { deletedAt: null, ...(p.status ? { status: p.status } : {}), ...(p.q ? { OR: [{ tradeName: { contains: p.q } }, { email: { contains: p.q } }] } : {}) }
    const [items, total] = await Promise.all([
      this.prisma.company.findMany({
        where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' },
        include: {
          subscriptions: { where: { isCurrent: true } },
          _count: { select: { warehouses: true, drivers: true, deliveries: true, companyMemberships: true } },
        },
      }),
      this.prisma.company.count({ where }),
    ])
    return paged(items, total, p)
  }

  @SuperAdminOnly() @Post() @Msg('Entreprise créée.')
  async create(@Ctx() ctx: AuthContext, @Body(zod(companyCreate)) body: z.infer<typeof companyCreate>) {
    if (!body.adminPassword && !(await this.emails.configured())) {
      throw new BadRequestException("L'envoi des e-mails n'est pas configuré : saisissez un mot de passe initial, ou configurez l'envoi dans Mon compte pour inviter l'administrateur.")
    }
    const hash = body.adminPassword ? await bcrypt.hash(body.adminPassword, 12) : await EmailsService.placeholderPassword()
    const { tradeName, email, adminName, adminEmail, adminPassword: _password, ...terms } = body
    const { company, adminId } = await this.prisma.atomic(async (tx) => {
      if (await tx.user.findUnique({ where: { email: adminEmail } })) throw new ConflictException('Cet e-mail administrateur est déjà utilisé.')
      const company = await tx.company.create({ data: { tradeName, email, status: 'active', settings: { create: {} } } })
      const user = await tx.user.create({ data: { fullName: adminName, email: adminEmail, passwordHash: hash } })
      await tx.companyMembership.create({ data: { companyId: company.id, userId: user.id, role: 'COMPANY_ADMIN' } })
      await this.billing.open(tx, company.id, terms)
      await this.audit.log({ companyId: company.id, userId: ctx.userId, ip: ctx.ip }, 'company.create', 'Company', company.id, undefined, tx)
      return { company, adminId: user.id }
    })
    return { ...company, invitation: await accountEmail(this.emails, adminId, company.id, !body.adminPassword, 'LogisticTrack') }
  }

  // Routes de l'entreprise active : aucun identifiant fourni par le client.
  @RequirePerm('company.manage') @AllowAnySubscription() @Get('current')
  current(@Ctx() ctx: TenantContext) { return this.prisma.company.findUnique({ where: { id: ctx.companyId }, include: { settings: true } }) }

  @RequirePerm('company.manage') @Patch('current')
  async updateCurrent(@Ctx() ctx: TenantContext, @Body(zod(companyPatch)) body: z.infer<typeof companyPatch>) {
    await this.audit.log(ctx, 'company.update', 'Company', ctx.companyId, Object.keys(body))
    return this.prisma.company.update({ where: { id: ctx.companyId }, data: body })
  }

  @RequirePerm('company.manage') @Put('current/settings') @Msg('Paramètres enregistrés.')
  async settings(@Ctx() ctx: TenantContext, @Body(zod(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    await this.audit.log(ctx, 'company.settings', 'Company', ctx.companyId, body)
    return this.prisma.companySettings.upsert({ where: { companyId: ctx.companyId }, create: { companyId: ctx.companyId, ...body }, update: body })
  }

  @RequirePerm('company.manage') @Post('current/logo') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 3 * 1024 * 1024 } }))
  async logo(@Ctx() ctx: TenantContext, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Fichier manquant.')
    const saved = await this.files.save(ctx, file)
    return this.prisma.company.update({ where: { id: ctx.companyId }, data: { logoFileId: saved.id } })
  }

  @SuperAdminOnly() @Get(':id')
  async get(@Param('id') id: string) {
    const company = await this.prisma.company.findFirst({
      where: { id, deletedAt: null },
      include: {
        settings: true, subscriptions: { where: { isCurrent: true } }, subscriptionInvoices: { orderBy: { issuedAt: 'desc' }, take: 20 },
        _count: { select: { warehouses: true, drivers: true, deliveries: true, companyMemberships: true, customers: true } },
      },
    })
    if (!company) throw new NotFoundException('Entreprise introuvable.')
    return company
  }

  @SuperAdminOnly() @Patch(':id')
  async update(@Ctx() ctx: AuthContext, @Param('id') id: string, @Body(zod(companyPatch)) body: z.infer<typeof companyPatch>) {
    await this.audit.log({ companyId: id, userId: ctx.userId, ip: ctx.ip }, 'company.update', 'Company', id, Object.keys(body))
    return this.prisma.company.update({ where: { id }, data: body })
  }

  /** Réactivation d'une entreprise suspendue ou expirée. */
  @SuperAdminOnly() @Post(':id/activate') @HttpCode(200) @Msg('Entreprise activée.')
  async activateCompany(@Ctx() ctx: AuthContext, @Param('id') id: string) {
    const company = await this.prisma.company.update({ where: { id }, data: { status: 'active' } })
    await this.audit.log({ companyId: id, userId: ctx.userId, ip: ctx.ip }, 'company.activate', 'Company', id)
    return company
  }

  @SuperAdminOnly() @Post(':id/suspend') @HttpCode(200) @Msg('Entreprise suspendue.')
  async suspend(@Ctx() ctx: AuthContext, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().max(300).optional() }))) body: { reason?: string }) {
    const company = await this.prisma.company.update({ where: { id }, data: { status: 'suspended' } })
    await this.audit.log({ companyId: id, userId: ctx.userId, ip: ctx.ip }, 'company.suspend', 'Company', id, body)
    return company
  }

  @SuperAdminOnly() @Delete(':id') @Msg('Entreprise fermée.')
  async close(@Ctx() ctx: AuthContext, @Param('id') id: string) {
    const company = await this.prisma.company.update({ where: { id }, data: { status: 'closed', deletedAt: new Date() } })
    await this.audit.log({ companyId: id, userId: ctx.userId, ip: ctx.ip }, 'company.close', 'Company', id)
    return { id: company.id, status: company.status }
  }
}

// ---------- Utilisateurs de l'entreprise ----------
const STAFF_ROLES = Object.keys(ROLES).filter((r) => r !== 'DRIVER') as [string, ...string[]]
const userCreate = z.object({
  fullName: z.string().trim().min(2).max(190), email: z.string().trim().toLowerCase().email(), phone: z.string().trim().max(40).nullish(),
  password: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().min(8).max(200).optional()),
  role: z.enum(STAFF_ROLES), customPermissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional(), warehouseIds: z.array(uuid).max(200).optional(),
})
const roleSchema = z.object({ role: z.enum(STAFF_ROLES), customPermissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional(), warehouseIds: z.array(uuid).max(200).nullish() })
const userPatch = z.object({ fullName: z.string().trim().min(2).max(190), phone: z.string().trim().max(40).nullish() }).partial()

@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService, private readonly limits: LimitsService, private readonly audit: AuditService, private readonly emails: EmailsService) {}

  private async membership(ctx: TenantContext, userId: string) {
    const m = await this.prisma.companyMembership.findUnique({ where: { companyId_userId: { companyId: ctx.companyId, userId } }, include: { user: true, scopes: true } })
    if (!m) throw new NotFoundException('Utilisateur introuvable.')
    return m
  }
  /**
   * Seul un administrateur principal gère les administrateurs principaux. Les autres gestionnaires
   * ne donnent jamais plus de droits qu'ils n'en ont, et ne modifient pas leurs propres droits.
   */
  private assertCanGrant(ctx: TenantContext, target?: { role: string; userId: string } | null, next?: { role: string; customPermissions?: string[] }) {
    if (ctx.role === 'COMPANY_ADMIN') return
    if (target?.role === 'COMPANY_ADMIN' || next?.role === 'COMPANY_ADMIN') throw new ForbiddenException('Réservé à un administrateur principal.')
    if (next && target?.userId === ctx.userId) throw new ForbiddenException('Vous ne pouvez pas modifier vos propres droits.')
    if (next) {
      const granted = permissionsFor(next.role, next.customPermissions ? JSON.stringify(next.customPermissions) : null)
      const extra = [...granted].filter((p) => !ctx.permissions.has(p))
      if (extra.length) throw new ForbiddenException(`Vous ne pouvez pas attribuer des droits que vous n'avez pas : ${extra.join(', ')}.`)
    }
  }

  private async checkScopes(ctx: TenantContext, ids?: string[] | null) {
    if (!ids?.length) return
    const n = await this.prisma.warehouse.count({ where: { id: { in: ids }, companyId: ctx.companyId } })
    if (n !== new Set(ids).size) throw new NotFoundException('Entrepôt introuvable.')
  }
  private view(m: Awaited<ReturnType<UsersController['membership']>>) {
    return {
      id: m.userId, fullName: m.user.fullName, email: m.user.email, phone: m.user.phone, isActive: m.isActive && m.user.isActive, role: m.role, roleLabel: ROLES[m.role]?.label,
      customPermissions: m.customPermissions ? JSON.parse(m.customPermissions) : [], allWarehouses: m.allWarehouses, warehouseIds: m.scopes.map((s) => s.warehouseId), lastLoginAt: m.user.lastLoginAt,
    }
  }

  @RequirePerm('user.manage') @Get('roles')
  roles() { return { roles: Object.entries(ROLES).filter(([k]) => k !== 'DRIVER').map(([code, r]) => ({ code, label: r.label, permissions: r.permissions })), permissions: PERMISSIONS } }

  @RequirePerm('user.manage') @Get()
  async list(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.CompanyMembershipWhereInput = { companyId: ctx.companyId, role: { not: 'DRIVER' }, ...(p.q ? { user: { OR: [{ fullName: { contains: p.q } }, { email: { contains: p.q } }] } } : {}) }
    const [items, total] = await Promise.all([
      this.prisma.companyMembership.findMany({ where, skip: p.skip, take: p.take, orderBy: { createdAt: 'asc' }, include: { user: true, scopes: true } }),
      this.prisma.companyMembership.count({ where }),
    ])
    return paged(items.map((m) => this.view(m)), total, p)
  }

  @RequirePerm('user.manage') @Post() @Msg('Utilisateur créé.')
  async create(@Ctx() ctx: TenantContext, @Body(zod(userCreate)) body: z.infer<typeof userCreate>) {
    this.assertCanGrant(ctx, null, body)
    await this.limits.assertCanAdd(ctx.companyId, 'users')
    await this.checkScopes(ctx, body.warehouseIds)
    if (!body.password && !(await this.emails.configured())) {
      throw new BadRequestException("L'envoi des e-mails n'est pas configuré : saisissez un mot de passe initial.")
    }
    const hash = body.password ? await bcrypt.hash(body.password, 12) : await EmailsService.placeholderPassword()
    const userId = await this.prisma.atomic(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: body.email } })
      // Un compte existant ne peut pas être rattaché sans vérification de son propriétaire.
      if (existing) throw new ConflictException('Cette adresse e-mail est déjà utilisée.')
      const user = await tx.user.create({ data: { fullName: body.fullName, email: body.email, phone: body.phone, passwordHash: hash } })
      await tx.companyMembership.create({
        data: {
          companyId: ctx.companyId, userId: user.id, role: body.role, customPermissions: body.customPermissions ? JSON.stringify(body.customPermissions) : null,
          allWarehouses: !body.warehouseIds?.length, scopes: body.warehouseIds?.length ? { create: body.warehouseIds.map((warehouseId) => ({ warehouseId })) } : undefined,
        },
      })
      await this.audit.log(ctx, 'user.create', 'User', user.id, { role: body.role }, tx)
      return user.id
    })
    const inviter = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { fullName: true } })
    const invitation = await accountEmail(this.emails, userId, ctx.companyId, !body.password, inviter?.fullName ?? null)
    return { ...this.view(await this.membership(ctx, userId)), invitation }
  }

  /** Renvoie l'invitation d'un membre qui n'a pas encore choisi son mot de passe. */
  @RequirePerm('user.manage') @Post(':id/invite') @HttpCode(200) @Msg('Invitation envoyée.')
  async invite(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    const m = await this.membership(ctx, id)
    if (m.role === 'DRIVER') throw new ConflictException('Un chauffeur se gère depuis sa fiche.')
    this.assertCanGrant(ctx, m)
    if (m.user.lastLoginAt) throw new ConflictException('Ce compte est déjà activé : envoyez plutôt un lien de réinitialisation.')
    const inviter = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { fullName: true } })
    const r = await this.emails.invite(id, ctx.companyId, inviter?.fullName ?? null)
    if (!r.sent) throw new BadGatewayException(r.error ?? "L'invitation n'a pas pu partir.")
    await this.audit.log(ctx, 'user.invite', 'User', id)
    return { sentTo: m.user.email }
  }

  @RequirePerm('user.manage') @Get(':id')
  async get(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.view(await this.membership(ctx, id)) }

  @RequirePerm('user.manage') @Patch(':id')
  async update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(userPatch)) body: z.infer<typeof userPatch>) {
    this.assertCanGrant(ctx, await this.membership(ctx, id))
    await this.prisma.user.update({ where: { id }, data: body })
    return this.view(await this.membership(ctx, id))
  }

  @RequirePerm('user.manage') @Post(':id/assign-role') @HttpCode(200) @Msg('Rôle mis à jour.')
  async assign(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(roleSchema)) body: z.infer<typeof roleSchema>) {
    const m = await this.membership(ctx, id)
    if (m.role === 'DRIVER') throw new ConflictException("Un chauffeur se gère depuis sa fiche.")
    this.assertCanGrant(ctx, m, { role: body.role, customPermissions: body.customPermissions })
    await this.checkScopes(ctx, body.warehouseIds)
    await this.assertNotLastAdmin(ctx, m, body.role)
    await this.prisma.$transaction([
      this.prisma.userScope.deleteMany({ where: { membershipId: m.id } }),
      this.prisma.companyMembership.update({
        where: { id: m.id },
        data: {
          role: body.role, customPermissions: body.customPermissions ? JSON.stringify(body.customPermissions) : null, allWarehouses: !body.warehouseIds?.length,
          scopes: body.warehouseIds?.length ? { create: body.warehouseIds.map((warehouseId) => ({ warehouseId })) } : undefined,
        },
      }),
    ])
    await this.audit.log(ctx, 'user.assign_role', 'User', id, body)
    return this.view(await this.membership(ctx, id))
  }

  private async assertNotLastAdmin(ctx: TenantContext, m: { role: string; userId: string; isActive: boolean }, nextRole?: string) {
    if (m.role !== 'COMPANY_ADMIN' || nextRole === 'COMPANY_ADMIN') return
    const others = await this.prisma.companyMembership.count({ where: { companyId: ctx.companyId, role: 'COMPANY_ADMIN', isActive: true, userId: { not: m.userId } } })
    if (!others) throw new ConflictException("L'entreprise doit conserver au moins un administrateur principal.")
  }

  /** L'administrateur redonne l'accès à un membre qui a oublié son mot de passe. */
  /** L'administrateur redonne l'accès : soit il fixe un mot de passe, soit le membre reçoit un lien pour choisir le sien. */
  @RequirePerm('user.manage') @Post(':id/reset-password') @HttpCode(200) @Msg('Mot de passe réinitialisé.')
  async resetPassword(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(z.object({ password: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().min(8).max(200).optional()) }))) body: { password?: string }) {
    const m = await this.membership(ctx, id)
    if (m.role === 'DRIVER') throw new ConflictException('Un chauffeur se gère depuis sa fiche.')
    this.assertCanGrant(ctx, m)
    if (!body.password) {
      const r = await this.emails.resetLink(id, { byAdmin: true })
      if (!r.sent) throw new BadGatewayException(r.error ?? "Le lien n'a pas pu partir.")
      await this.audit.log(ctx, 'user.reset_link', 'User', id)
      return { mode: 'link', sentTo: m.user.email }
    }
    const passwordHash = await bcrypt.hash(body.password, 12)
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { passwordHash, failedLogins: 0, lockedUntil: null } }),
      this.prisma.userSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ])
    await this.audit.log(ctx, 'user.reset_password', 'User', id)
    this.emails.passwordChanged(id, 'admin')
    return { mode: 'password' }
  }

  @RequirePerm('user.manage') @Post(':id/deactivate') @HttpCode(200) @Msg('Utilisateur désactivé.')
  async deactivate(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    const m = await this.membership(ctx, id)
    this.assertCanGrant(ctx, m)
    await this.assertNotLastAdmin(ctx, m)
    await this.prisma.companyMembership.update({ where: { id: m.id }, data: { isActive: false } })
    await this.prisma.userSession.updateMany({ where: { userId: id, companyId: ctx.companyId, revokedAt: null }, data: { revokedAt: new Date() } })
    await this.audit.log(ctx, 'user.deactivate', 'User', id)
    return this.view(await this.membership(ctx, id))
  }

  @RequirePerm('user.manage') @Post(':id/activate') @HttpCode(200) @Msg('Utilisateur réactivé.')
  async activate(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    const m = await this.membership(ctx, id)
    this.assertCanGrant(ctx, m)
    await this.limits.assertCanAdd(ctx.companyId, 'users')
    await this.prisma.companyMembership.update({ where: { id: m.id }, data: { isActive: true } })
    await this.audit.log(ctx, 'user.activate', 'User', id)
    return this.view(await this.membership(ctx, id))
  }
}

// ---------- Notifications ----------
@AuthOnly()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Ctx() ctx: AuthContext, @Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.NotificationWhereInput = { userId: ctx.userId, companyId: ctx.companyId, ...(p.unread === 'true' ? { readAt: null } : {}) }
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' } }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId: ctx.userId, companyId: ctx.companyId, readAt: null } }),
    ])
    return { items, total, unread }
  }

  @Post(':id/read') @HttpCode(200)
  async read(@Ctx() ctx: AuthContext, @Param('id') id: string) {
    await this.prisma.notification.updateMany({ where: { id, userId: ctx.userId }, data: { readAt: new Date() } })
  }

  @Post('read-all') @HttpCode(200)
  async readAll(@Ctx() ctx: AuthContext) {
    await this.prisma.notification.updateMany({ where: { userId: ctx.userId, companyId: ctx.companyId, readAt: null }, data: { readAt: new Date() } })
  }
}

@Controller('notification-templates')
export class TemplatesController {
  constructor(private readonly prisma: PrismaService) {}

  @RequirePerm('company.manage') @Get()
  async list(@Ctx() ctx: TenantContext) {
    const custom = await this.prisma.notificationTemplate.findMany({ where: { companyId: ctx.companyId } })
    return Object.entries(NOTIFICATION_DEFAULTS).map(([type, tpl]) => {
      const c = custom.find((x) => x.type === type)
      return { type, title: c?.title ?? tpl.title, body: c?.body ?? tpl.body, isCustom: !!c }
    })
  }

  @RequirePerm('company.manage') @Put(':type')
  async save(@Ctx() ctx: TenantContext, @Param('type') type: string, @Body(zod(z.object({ title: z.string().trim().min(2).max(120), body: z.string().trim().min(2).max(500) }))) body: { title: string; body: string }) {
    if (!(type in NOTIFICATION_DEFAULTS)) throw new NotFoundException('Type de notification inconnu.')
    return this.prisma.notificationTemplate.upsert({ where: { companyId_type: { companyId: ctx.companyId, type } }, create: { ...body, type, companyId: ctx.companyId }, update: body })
  }
}

/** Compte SMTP. Mot de passe vide ou absent : celui déjà enregistré est conservé. */
const mailSettingsSchema = z.object({
  host: z.string().trim().min(3).max(190),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().min(3).max(190),
  password: z.string().max(200).optional(),
  from: z.string().trim().max(190).nullish(),
})

// ---------- Journal d'audit ----------
@Controller()
export class AuditController {
  constructor(private readonly prisma: PrismaService, private readonly outbound: OutboundService) {}

  private async page(where: Prisma.AuditLogWhereInput, q: Record<string, unknown>) {
    const p = parsePage(q)
    const filter: Prisma.AuditLogWhereInput = { ...where, ...(p.q ? { action: { contains: p.q } } : {}) }
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where: filter, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' }, include: { user: { select: { fullName: true } }, company: { select: { tradeName: true } } } }),
      this.prisma.auditLog.count({ where: filter }),
    ])
    return paged(items, total, p)
  }

  @RequirePerm('audit.view') @Get('audit-logs')
  company(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) { return this.page({ companyId: ctx.companyId }, q) }

  @SuperAdminOnly() @Get('admin/backups')
  async backups() { return { items: (await listBackups()).slice(0, 30), directory: backupRoot(), copyDirectory: process.env.BACKUP_COPY_DIR ?? null, keepDays: Number(process.env.BACKUP_KEEP_DAYS ?? 14) } }

  @SuperAdminOnly() @Post('admin/backups') @HttpCode(200) @Msg('Sauvegarde terminée.')
  async backupNow(@Ctx() ctx: AuthContext) {
    const info = await runBackup(this.prisma)
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, action: 'platform.backup', entity: 'Backup', entityId: info.name } })
    return info
  }

  @SuperAdminOnly() @Get('admin/mail')
  mailStatus() { return this.outbound.mailStatus() }

  /** Compte d'envoi des e-mails, saisi dans l'administration. Pris en compte sans redémarrage. */
  @SuperAdminOnly() @Put('admin/mail') @Msg("Réglages d'envoi enregistrés.")
  async saveMail(@Ctx() ctx: AuthContext, @Body(zod(mailSettingsSchema)) body: z.infer<typeof mailSettingsSchema>) {
    await this.outbound.saveMailSettings(body, ctx.userId)
    // Le mot de passe n'apparaît jamais dans le journal.
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, action: 'platform.mail_settings', entity: 'MailSettings', entityId: 'default', details: JSON.stringify({ host: body.host, port: body.port, secure: body.secure, user: body.user, from: body.from ?? null, passwordChanged: !!body.password }) } })
    return this.outbound.mailStatus()
  }

  /** Revient aux réglages MAIL_* du fichier .env. */
  @SuperAdminOnly() @Delete('admin/mail') @Msg("Réglages d'envoi supprimés.")
  async clearMail(@Ctx() ctx: AuthContext) {
    await this.outbound.clearMailSettings()
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, action: 'platform.mail_settings_cleared', entity: 'MailSettings', entityId: 'default' } })
    return this.outbound.mailStatus()
  }

  /** Envoie un e-mail de test au Super Administrateur, pour valider la configuration Gmail. */
  @SuperAdminOnly() @Post('admin/mail/test') @HttpCode(200) @Msg('E-mail de test envoyé.')
  async mailTest(@Ctx() ctx: AuthContext, @Body() body: { companyId?: string | null } = {}) {
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } })
    if (!me.email) throw new BadRequestException('Votre compte n\'a pas d\'adresse e-mail.')
    // Aperçu facultatif aux couleurs d'une entreprise, pour vérifier son logo et ses coordonnées.
    const companyId = typeof body?.companyId === 'string' && body.companyId ? body.companyId : null
    const company = companyId ? await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true, tradeName: true } }) : null
    if (companyId && !company) throw new NotFoundException('Entreprise introuvable.')
    await this.outbound.mail(me.email, {
      subject: company ? `Test d'envoi — ${company.tradeName}` : 'Test d\'envoi LogisticTrack',
      title: 'L\'envoi des e-mails fonctionne',
      paragraphs: [
        company ? `Voici l'apparence des e-mails envoyés pour ${company.tradeName} : son logo en tête, ses coordonnées en bas.` : 'Ce message de test confirme que LogisticTrack peut envoyer des e-mails, notamment pour réinitialiser un mot de passe.',
        'Aucune action n\'est nécessaire.',
      ],
    }, company?.id)
    return { sentTo: me.email, companyId: company?.id ?? null }
  }

  /** Derniers e-mails de la plateforme (toutes entreprises), pour repérer un échec d'envoi. Jamais leur contenu. */
  @SuperAdminOnly() @Get('admin/mail/log')
  async mailLog(@Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.EmailLogWhereInput = p.status ? { status: p.status } : {}
    const [items, total] = await Promise.all([this.prisma.emailLog.findMany({ where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' } }), this.prisma.emailLog.count({ where })])
    const names = new Map((await this.prisma.company.findMany({ where: { id: { in: [...new Set(items.map((i) => i.companyId).filter((x): x is string => !!x))] } }, select: { id: true, tradeName: true } })).map((c) => [c.id, c.tradeName]))
    return paged(items.map(({ dedupeKey: _k, ...i }) => ({ ...i, company: i.companyId ? names.get(i.companyId) ?? null : null })), total, p)
  }

  /** E-mails envoyés au nom de l'entreprise active (clients, factures, comptes). */
  @RequirePerm('company.manage') @AllowAnySubscription() @Get('emails/log')
  async companyMailLog(@Ctx() ctx: TenantContext, @Query() q: Record<string, unknown>) {
    const p = parsePage(q)
    const where: Prisma.EmailLogWhereInput = { companyId: ctx.companyId, ...(p.status ? { status: p.status } : {}) }
    const [items, total] = await Promise.all([this.prisma.emailLog.findMany({ where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' } }), this.prisma.emailLog.count({ where })])
    return paged(items.map(({ dedupeKey: _k, ...i }) => i), total, p)
  }

  @SuperAdminOnly() @Get('admin/audit-logs')
  platform(@Query() q: Record<string, unknown>) { return this.page({}, q) }
}

// ---------- Fichiers privés ----------
@Controller('files')
export class FilesController {
  constructor(private readonly files: FileService) {}

  @RequirePerm('product.manage', 'company.manage', 'driver.manage', 'package.manage') @Post() @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async upload(@Ctx() ctx: TenantContext, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Fichier manquant.')
    const saved = await this.files.save(ctx, file)
    return { id: saved.id, sha256: saved.sha256 }
  }

  @RequirePerm('delivery.view', 'product.view', 'driver.view') @Get(':id/url')
  url(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.files.signedUrl(ctx, id) }

  /** Accès par URL temporaire signée, sans en-tête d'authentification. */
  @Public() @Get(':id/content')
  async content(@Param('id') id: string, @Query('expires') expires: string, @Query('signature') signature: string, @Res({ passthrough: true }) res: Response) {
    const { file, stream } = await this.files.openSigned(id, Number(expires), signature)
    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Cache-Control', 'private, no-store')
    return new StreamableFile(stream)
  }
}

@Module({
  controllers: [BillingController, CompaniesController, UsersController, NotificationsController, TemplatesController, AuditController, FilesController],
  providers: [BillingService],
  exports: [BillingService],
})
export class SaasModule {}

