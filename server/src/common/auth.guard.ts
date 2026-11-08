import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { AuditService } from './core.services.js'
import { PrismaService } from './prisma.service.js'
import { FINISHABLE_DELIVERY, ROLES, SUBSCRIPTION_USABLE, subscriptionStatus } from './constants.js'
import {
  ALLOW_DRIVER_KEY, ANY_SUBSCRIPTION_KEY, AUTH_ONLY_KEY, DRIVER_KEY, FINISH_MISSION_KEY, PERMS_KEY, PUBLIC_KEY, SUPER_ADMIN_KEY, type FinishKind, type TenantContext, type AuthContext,
} from './context.js'

export interface JwtPayload {
  sub: string
  sid: string
  cid: string | null
}

export function permissionsFor(role: string, customPermissions: string | null): Set<string> {
  const base = ROLES[role]?.permissions ?? []
  let extra: string[] = []
  if (customPermissions) {
    try {
      extra = JSON.parse(customPermissions)
    } catch {
      extra = []
    }
  }
  return new Set<string>([...base, ...extra])
}

@Injectable()
export class AuthResolver {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  /** Reconstruit le contexte à chaque requête : une révocation prend effet immédiatement. */
  async fromToken(token: string): Promise<AuthContext> {
    let payload: JwtPayload
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token)
    } catch {
      throw new UnauthorizedException('Session expirée ou invalide.')
    }
    const session = await this.prisma.userSession.findUnique({ where: { id: payload.sid }, include: { user: true } })
    if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user.isActive) {
      throw new UnauthorizedException('Session expirée ou révoquée.')
    }
    const ctx: AuthContext = {
      userId: session.userId,
      sessionId: session.id,
      isSuperAdmin: session.user.isSuperAdmin,
      companyId: null,
      role: null,
      permissions: new Set(),
      warehouseIds: null,
      driverId: null,
    }
    if (session.companyId && session.user.isSuperAdmin) {
      // Le Super Administrateur entré dans une entreprise y agit comme son administrateur principal, sans en devenir membre.
      const company = await this.prisma.company.findFirst({ where: { id: session.companyId, deletedAt: null }, select: { id: true } })
      if (company) {
        ctx.companyId = company.id
        ctx.role = 'COMPANY_ADMIN'
        ctx.permissions = permissionsFor('COMPANY_ADMIN', null)
      }
    } else if (session.companyId) {
      const membership = await this.prisma.companyMembership.findUnique({
        where: { companyId_userId: { companyId: session.companyId, userId: session.userId } },
        include: { scopes: true },
      })
      if (!membership || !membership.isActive) throw new UnauthorizedException("Vous n'avez plus accès à cette entreprise.")
      ctx.companyId = membership.companyId
      ctx.role = membership.role
      ctx.permissions = permissionsFor(membership.role, membership.customPermissions)
      ctx.warehouseIds = membership.allWarehouses ? null : membership.scopes.map((s) => s.warehouseId)
      if (membership.role === 'DRIVER') {
        const driver = await this.prisma.driver.findFirst({ where: { userId: session.userId, companyId: membership.companyId, deletedAt: null } })
        ctx.driverId = driver?.id ?? null
      }
    }
    return ctx
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly resolver: AuthResolver, private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private meta<T>(key: string, context: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()])
  }

  /** La lecture seule ne doit pas laisser une marchandise bloquée sur la route : seule une mission déjà commencée continue. */
  private async finishesMission(context: ExecutionContext, request: { params: Record<string, string>; body?: Record<string, unknown> }, ctx: AuthContext) {
    const kind = this.meta<FinishKind>(FINISH_MISSION_KEY, context)
    if (!kind || !ctx.companyId) return false
    const body = request.body ?? {}
    const started = async (id: unknown, statuses: string[]) => typeof id === 'string' && (await this.prisma.delivery.count({ where: { id, companyId: ctx.companyId!, status: { in: statuses } } })) === 1
    if (kind === 'delivery') return started(request.params.id, FINISHABLE_DELIVERY)
    if (kind === 'session') return started(body.deliveryId, FINISHABLE_DELIVERY)
    // Le service n'accepte que les positions d'une session de ce chauffeur, et jamais après son arrivée.
    if (kind === 'tracking') return !!ctx.driverId
    if (kind === 'route') return (await this.prisma.route.count({ where: { id: request.params.id, companyId: ctx.companyId, status: 'IN_PROGRESS' } })) === 1
    if ((body.action ?? 'VIEW') === 'VIEW') return true
    if (body.action !== 'DELIVER' || typeof body.token !== 'string') return false
    return (await this.prisma.package.count({ where: { qrToken: body.token, companyId: ctx.companyId, delivery: { status: { in: FINISHABLE_DELIVERY } } } })) === 1
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.meta<boolean>(PUBLIC_KEY, context)) return true
    const request = context.switchToHttp().getRequest()
    const header: string | undefined = request.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Authentification requise.')
    const ctx = await this.resolver.fromToken(header.slice(7))
    ctx.ip = request.ip
    request.auth = ctx

    if (this.meta<boolean>(SUPER_ADMIN_KEY, context)) {
      if (!ctx.isSuperAdmin) throw new ForbiddenException('Réservé au Super Administrateur.')
      return true
    }
    if (this.meta<boolean>(AUTH_ONLY_KEY, context)) return true

    if (!ctx.companyId) throw new ForbiddenException('Aucune entreprise active pour cette session.')

    const company = await this.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { status: true } })
    if (company?.status !== 'active' && !ctx.isSuperAdmin) {
      throw new ForbiddenException({ message: "Le compte de l'entreprise n'est pas actif.", code: 'COMPANY_INACTIVE' })
    }

    const driverOnly = this.meta<boolean>(DRIVER_KEY, context)
    if (driverOnly && !ctx.driverId) throw new ForbiddenException('Réservé aux chauffeurs.')

    const perms = this.meta<string[]>(PERMS_KEY, context)
    if (perms?.length) {
      const allowed = perms.some((p) => ctx.permissions.has(p)) || (this.meta<boolean>(ALLOW_DRIVER_KEY, context) && ctx.driverId)
      if (!allowed) throw new ForbiddenException('Permission insuffisante.')
    }

    // Toute écriture du Super Administrateur dans une entreprise est tracée dans le journal de cette entreprise.
    if (ctx.isSuperAdmin && request.method !== 'GET') {
      await this.audit.log(ctx as TenantContext, 'admin.action', 'Request', undefined, { method: request.method, path: String(request.originalUrl ?? '').split('?')[0] })
      return true
    }

    // Abonnement inactif : consultation seule, l'entreprise garde l'accès à ses données et à sa facturation.
    if (request.method !== 'GET' && !this.meta<boolean>(ANY_SUBSCRIPTION_KEY, context)) {
      const subscription = await this.prisma.subscription.findFirst({ where: { companyId: ctx.companyId, isCurrent: true }, select: { status: true, endsAt: true } })
      if (!subscription || !SUBSCRIPTION_USABLE.includes(subscriptionStatus(subscription))) {
        if (await this.finishesMission(context, request, ctx)) return true
        const message = ctx.role === 'DRIVER' ? 'Abonnement de votre entreprise expiré, contactez votre responsable.' : "L'abonnement n'est pas actif : la plateforme est en lecture seule."
        throw new ForbiddenException({ message, code: 'SUBSCRIPTION_INACTIVE' })
      }
    }
    return true
  }
}
