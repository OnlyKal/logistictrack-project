import { EmailsService } from '../../common/emails.service.js'
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Post, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Throttle } from '@nestjs/throttler'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { AuditService, OutboundService } from '../../common/core.services.js'
import { PrismaService } from '../../common/prisma.service.js'
import { AllowAnySubscription, AuthOnly, Ctx, Public, SuperAdminOnly, type AuthContext } from '../../common/context.js'
import { Msg, zod } from '../../common/http.js'
import { hmac, opaqueToken, safeEqual, secret, sha256 } from '../../common/util.js'
import { permissionsFor } from '../../common/auth.guard.js'
import { ROLES } from '../../common/constants.js'

const password = z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères.').max(200)
const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(190),
  password: z.string().min(1).max(200),
  companyId: z.string().uuid().optional(),
})
/** Blocage d'un compte après trop de mots de passe faux, quel que soit l'appareil. */
export const MAX_LOGIN_ATTEMPTS = 6
const LOCK_MINUTES = 15

/** Échéance glissante, repoussée à chaque usage : en pratique, seule une déconnexion arrête la session. */
const SESSION_DAYS = 36500

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly outbound: OutboundService,
    private readonly emails: EmailsService,
  ) {}

  /**
   * Une session ne s'arrête que sur déconnexion volontaire, ou sur décision d'un administrateur
   * (compte désactivé, mot de passe réinitialisé ou changé). Son échéance glisse à chaque usage.
   */
  private expiry() {
    return new Date(Date.now() + SESSION_DAYS * 86400_000)
  }

  /** Jeton de rafraîchissement d'une génération donnée, recalculable par le serveur seul. */
  private derive(sessionId: string, generation: number, salt: string) {
    return hmac(secret('JWT_SECRET'), `refresh:${sessionId}:${generation}:${salt}`)
  }

  private async tokens(session: { id: string; userId: string; companyId: string | null; generation: number; refreshSalt: string | null }) {
    return {
      accessToken: await this.jwt.signAsync({ sub: session.userId, sid: session.id, cid: session.companyId }),
      refreshToken: `${session.id}.${session.generation}.${this.derive(session.id, session.generation, session.refreshSalt!)}`,
    }
  }

  private async issue(userId: string, companyId: string | null, userAgent?: string) {
    const salt = opaqueToken(16)
    const session = await this.prisma.userSession.create({
      data: { userId, companyId, userAgent: userAgent?.slice(0, 180), refreshSalt: salt, generation: 1, refreshTokenHash: sha256(opaqueToken(32)), expiresAt: this.expiry() },
    })
    return this.tokens(session)
  }

  async login(body: z.infer<typeof loginSchema>, userAgent?: string, ip?: string) {
    const identifier = body.identifier.includes('@') ? body.identifier.toLowerCase() : body.identifier
    const user = await this.prisma.user.findFirst({ where: { OR: [{ email: identifier }, { phone: identifier }] } })
    // Comparaison effectuée même sans compte : le temps de réponse ne révèle pas son existence.
    const hash = user?.passwordHash ?? '$2b$12$C6UzMDM.H6dfI/f/IKcEeOaxjZ1VtSsmcTCJ6hP0n0F5WvC3oQW.y'
    const ok = await bcrypt.compare(body.password, hash)
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000)
      throw new ForbiddenException({ message: `Compte bloqué après ${MAX_LOGIN_ATTEMPTS} mots de passe incorrects. Réessayez dans ${minutes} min, ou demandez à votre administrateur de réinitialiser votre mot de passe.`, code: 'ACCOUNT_LOCKED' })
    }
    if (!user || !ok || !user.isActive) {
      if (user && !ok) {
        // Le compte se bloque, quel que soit l'appareil utilisé.
        const failed = user.failedLogins + 1
        const locked = failed >= MAX_LOGIN_ATTEMPTS
        await this.prisma.user.update({ where: { id: user.id }, data: locked ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } : { failedLogins: failed } })
        if (locked) {
          await this.audit.log({ companyId: null, userId: user.id, ip }, 'auth.locked', 'User', user.id)
          this.emails.accountLocked(user.id, LOCK_MINUTES)
        }
      }
      await this.audit.log(user ? { companyId: null, userId: user.id, ip } : null, 'auth.login_failed', 'User', user?.id)
      throw new UnauthorizedException('Identifiants incorrects.')
    }
    const memberships = await this.prisma.companyMembership.findMany({
      where: { userId: user.id, isActive: true, company: { status: { not: 'closed' } } },
      orderBy: { createdAt: 'asc' },
    })
    let companyId: string | null = null
    if (body.companyId) {
      if (!memberships.some((m) => m.companyId === body.companyId)) throw new ForbiddenException("Vous n'avez pas accès à cette entreprise.")
      companyId = body.companyId
    } else if (memberships.length) {
      companyId = memberships[0].companyId
    }
    if (!companyId && !user.isSuperAdmin) throw new ForbiddenException('Aucune entreprise active pour ce compte.')
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null } })
    await this.audit.log({ companyId, userId: user.id, ip }, 'auth.login', 'User', user.id)
    return { ...(await this.issue(user.id, companyId, userAgent)), user: await this.profile(user.id, companyId) }
  }

  /**
   * Rotation à chaque usage, sans jamais déconnecter par accident :
   * - le jeton courant donne le suivant ;
   * - le jeton précédent (réponse perdue, deux onglets, téléphone coupé au mauvais moment) redonne le jeton courant ;
   * - un jeton plus ancien est le signe d'un vol : la session est fermée.
   */
  async refresh(token: string, userAgent?: string) {
    const parts = token.split('.')
    const session = parts[0] ? await this.prisma.userSession.findUnique({ where: { id: parts[0] }, include: { user: true } }) : null
    if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user.isActive) throw new UnauthorizedException('Session expirée.')
    const revoke = async () => {
      await this.prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } })
      await this.audit.log({ companyId: session.companyId, userId: session.userId }, 'auth.refresh_reuse', 'UserSession', session.id)
      throw new UnauthorizedException('Session révoquée.')
    }
    const keep = { expiresAt: this.expiry(), userAgent: userAgent?.slice(0, 180) }

    // Ancien format, d'avant cette version : converti une fois, sans déconnexion.
    if (parts.length === 2) {
      if (session.refreshTokenHash !== sha256(parts[1])) return revoke()
      if (session.refreshSalt) return session.generation <= 1 ? this.tokens(session) : revoke()
      const converted = await this.prisma.userSession.update({ where: { id: session.id }, data: { ...keep, refreshSalt: opaqueToken(16), generation: 1 } })
      return this.tokens(converted)
    }
    const generation = Number(parts[1])
    if (parts.length !== 3 || !session.refreshSalt || !Number.isInteger(generation) || !safeEqual(parts[2], this.derive(session.id, generation, session.refreshSalt))) {
      throw new UnauthorizedException('Session invalide.')
    }
    if (generation === session.generation - 1) {
      await this.prisma.userSession.update({ where: { id: session.id }, data: keep })
      return this.tokens(session)
    }
    if (generation !== session.generation) return revoke()
    // Deux demandes simultanées obtiennent le même jeton suivant.
    await this.prisma.userSession.updateMany({ where: { id: session.id, generation }, data: { ...keep, generation: generation + 1 } })
    return this.tokens(await this.prisma.userSession.findUniqueOrThrow({ where: { id: session.id } }))
  }

  async logout(ctx: AuthContext) {
    await this.prisma.userSession.update({ where: { id: ctx.sessionId }, data: { revokedAt: new Date() } })
  }

  async profile(userId: string, companyId: string | null) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } })
    if (user.isSuperAdmin) {
      const company = companyId ? await this.prisma.company.findFirst({ where: { id: companyId, deletedAt: null }, select: { id: true, tradeName: true, status: true } }) : null
      return {
        id: user.id, fullName: user.fullName, email: user.email, phone: user.phone, isSuperAdmin: true, company, managing: !!company, role: company ? 'COMPANY_ADMIN' : null, roleLabel: company ? 'Super Administrateur' : null,
        driverId: null, allWarehouses: true, warehouseIds: null, permissions: company ? [...permissionsFor('COMPANY_ADMIN', null)] : [], companies: [],
      }
    }
    const memberships = await this.prisma.companyMembership.findMany({
      where: { userId, isActive: true },
      include: { company: { select: { id: true, tradeName: true, status: true } }, scopes: true },
    })
    const active = memberships.find((m) => m.companyId === companyId)
    const driver = companyId ? await this.prisma.driver.findFirst({ where: { userId, companyId, deletedAt: null } }) : null
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      isSuperAdmin: user.isSuperAdmin,
      company: active?.company ?? null,
      role: active?.role ?? null,
      roleLabel: active ? ROLES[active.role]?.label : null,
      driverId: driver?.id ?? null,
      allWarehouses: active?.allWarehouses ?? true,
      warehouseIds: active?.allWarehouses === false ? active.scopes.map((s) => s.warehouseId) : null,
      permissions: active ? [...permissionsFor(active.role, active.customPermissions)] : [],
      companies: memberships.map((m) => ({ id: m.company.id, name: m.company.tradeName, role: m.role })),
    }
  }

  async switchCompany(ctx: AuthContext, companyId: string) {
    const membership = await this.prisma.companyMembership.findUnique({ where: { companyId_userId: { companyId, userId: ctx.userId } } })
    if (!membership?.isActive) throw new ForbiddenException("Vous n'avez pas accès à cette entreprise.")
    await this.prisma.userSession.update({ where: { id: ctx.sessionId }, data: { companyId } })
    return {
      accessToken: await this.jwt.signAsync({ sub: ctx.userId, sid: ctx.sessionId, cid: companyId }),
      user: await this.profile(ctx.userId, companyId),
    }
  }

  /** Le Super Administrateur entre dans une entreprise, même suspendue. Entrée et sortie sont tracées dans son journal. */
  async enterCompany(ctx: AuthContext, companyId: string) {
    if (!(await this.prisma.company.findFirst({ where: { id: companyId, deletedAt: null }, select: { id: true } }))) throw new NotFoundException('Entreprise introuvable.')
    if (ctx.companyId && ctx.companyId !== companyId) await this.audit.log(ctx, 'admin.leave_company', 'Company', ctx.companyId)
    await this.prisma.userSession.update({ where: { id: ctx.sessionId }, data: { companyId } })
    await this.audit.log({ companyId, userId: ctx.userId, ip: ctx.ip }, 'admin.enter_company', 'Company', companyId)
    return { accessToken: await this.jwt.signAsync({ sub: ctx.userId, sid: ctx.sessionId, cid: companyId }), user: await this.profile(ctx.userId, companyId) }
  }

  async leaveCompany(ctx: AuthContext) {
    if (ctx.companyId) await this.audit.log(ctx, 'admin.leave_company', 'Company', ctx.companyId)
    await this.prisma.userSession.update({ where: { id: ctx.sessionId }, data: { companyId: null } })
    return { accessToken: await this.jwt.signAsync({ sub: ctx.userId, sid: ctx.sessionId, cid: null }), user: await this.profile(ctx.userId, null) }
  }

  async changePassword(ctx: AuthContext, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } })
    if (!(await bcrypt.compare(current, user.passwordHash))) throw new BadRequestException('Mot de passe actuel incorrect.')
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(next, 12) } })
    // Toutes les autres sessions sont fermées.
    await this.prisma.userSession.updateMany({ where: { userId: user.id, revokedAt: null, id: { not: ctx.sessionId } }, data: { revokedAt: new Date() } })
    await this.audit.log(ctx, 'auth.password_changed', 'User', user.id)
    this.emails.passwordChanged(user.id, 'self')
  }

  async requestReset(identifier: string) {
    const value = identifier.includes('@') ? identifier.toLowerCase() : identifier
    const user = await this.prisma.user.findFirst({ where: { OR: [{ email: value }, { phone: value }] } })
    if (!user || !user.isActive) return // Réponse identique : on ne révèle pas l'existence du compte.
    // En arrière-plan : le temps de réponse ne révèle ni l'existence du compte ni la lenteur du serveur d'envoi.
    if (user.email && (await this.emails.configured())) {
      this.emails.later(() => this.emails.resetLink(user.id))
      return
    }
    const token = opaqueToken(32)
    await this.prisma.passwordReset.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) } })
    await this.outbound.send(user.email ?? user.phone ?? '', user.email ? 'email' : 'sms', 'Réinitialisation du mot de passe', token)
  }

  async confirmReset(token: string, next: string) {
    const row = await this.prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) } })
    if (!row || row.usedAt || row.expiresAt < new Date()) throw new BadRequestException('Lien invalide ou expiré.')
    // Première connexion d'un invité : il choisit son mot de passe, ce n'est pas un changement à signaler.
    const invited = !(await this.prisma.user.findUniqueOrThrow({ where: { id: row.userId }, select: { lastLoginAt: true } })).lastLoginAt
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await bcrypt.hash(next, 12), failedLogins: 0, lockedUntil: null } }),
      this.prisma.passwordReset.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      this.prisma.userSession.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ])
    await this.audit.log({ companyId: null, userId: row.userId }, 'auth.password_reset', 'User', row.userId)
    if (!invited) this.emails.passwordChanged(row.userId, 'link')
  }

}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body(zod(loginSchema)) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body)
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(zod(z.object({ refreshToken: z.string().min(10).max(300) }))) body: { refreshToken: string }) {
    return this.auth.refresh(body.refreshToken)
  }

  @AuthOnly()
  @Post('logout')
  @HttpCode(200)
  logout(@Ctx() ctx: AuthContext) {
    return this.auth.logout(ctx)
  }

  @AuthOnly()
  @Get('me')
  me(@Ctx() ctx: AuthContext) {
    return this.auth.profile(ctx.userId, ctx.companyId)
  }

  @AuthOnly()
  @Get('me/permissions')
  permissions(@Ctx() ctx: AuthContext) {
    return { role: ctx.role, permissions: [...ctx.permissions], warehouseIds: ctx.warehouseIds }
  }

  @AuthOnly()
  @AllowAnySubscription()
  @Post('switch-company')
  @HttpCode(200)
  switchCompany(@Ctx() ctx: AuthContext, @Body(zod(z.object({ companyId: z.string().uuid() }))) body: { companyId: string }) {
    return this.auth.switchCompany(ctx, body.companyId)
  }

  @SuperAdminOnly()
  @Post('enter-company')
  @HttpCode(200)
  enterCompany(@Ctx() ctx: AuthContext, @Body(zod(z.object({ companyId: z.string().uuid() }))) body: { companyId: string }) {
    return this.auth.enterCompany(ctx, body.companyId)
  }

  @SuperAdminOnly()
  @Post('leave-company')
  @HttpCode(200)
  leaveCompany(@Ctx() ctx: AuthContext) {
    return this.auth.leaveCompany(ctx)
  }

  @AuthOnly()
  @Post('password/change')
  @HttpCode(200)
  @Msg('Mot de passe modifié.')
  change(@Ctx() ctx: AuthContext, @Body(zod(z.object({ current: z.string().max(200), next: password }))) body: { current: string; next: string }) {
    return this.auth.changePassword(ctx, body.current, body.next)
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/reset')
  @HttpCode(200)
  @Msg('Si ce compte existe, un message de réinitialisation a été envoyé.')
  reset(@Body(zod(z.object({ identifier: z.string().trim().min(3).max(190) }))) body: { identifier: string }) {
    return this.auth.requestReset(body.identifier)
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('password/reset/confirm')
  @HttpCode(200)
  @Msg('Mot de passe réinitialisé.')
  confirm(@Body(zod(z.object({ token: z.string().min(10).max(200), password }))) body: { token: string; password: string }) {
    return this.auth.confirmReset(body.token, body.password)
  }
}

@Module({ controllers: [AuthController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
