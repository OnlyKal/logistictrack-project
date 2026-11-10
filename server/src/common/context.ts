import { ForbiddenException, SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { Permission } from './constants.js'

export interface AuthContext {
  userId: string
  sessionId: string
  isSuperAdmin: boolean
  /** Entreprise active, déterminée côté serveur à partir de la session. Jamais depuis le client. */
  companyId: string | null
  role: string | null
  permissions: Set<string>
  /** null = toute l'entreprise ; sinon liste des entrepôts autorisés. */
  warehouseIds: string[] | null
  driverId: string | null
  ip?: string
}

/** Contexte d'une requête rattachée à une entreprise. */
export type TenantContext = AuthContext & { companyId: string }

export const PUBLIC_KEY = 'lt:public'
export const SUPER_ADMIN_KEY = 'lt:super'
export const PERMS_KEY = 'lt:perms'
export const DRIVER_KEY = 'lt:driver'
export const AUTH_ONLY_KEY = 'lt:authonly'
export const ANY_SUBSCRIPTION_KEY = 'lt:anysub'

/** Route accessible sans authentification. */
export const Public = () => SetMetadata(PUBLIC_KEY, true)
/** Réservée au Super Administrateur. */
export const SuperAdminOnly = () => SetMetadata(SUPER_ADMIN_KEY, true)
/** Exige au moins l'une des permissions indiquées dans l'entreprise active. */
export const RequirePerm = (...perms: Permission[]) => SetMetadata(PERMS_KEY, perms)
/** Réservée au compte chauffeur. */
export const DriverOnly = () => SetMetadata(DRIVER_KEY, true)
/** Exige seulement un utilisateur connecté (pas d'entreprise obligatoire). */
export const AuthOnly = () => SetMetadata(AUTH_ONLY_KEY, true)
/** Reste accessible en écriture quel que soit l'état de l'abonnement. */
export const AllowAnySubscription = () => SetMetadata(ANY_SUBSCRIPTION_KEY, true)
export const FINISH_MISSION_KEY = 'lt:finishmission'
export type FinishKind = 'delivery' | 'session' | 'tracking' | 'route' | 'scan'
/** Abonnement inactif : cette action reste permise uniquement pour terminer une mission déjà commencée. */
export const FinishesMission = (kind: FinishKind) => SetMetadata(FINISH_MISSION_KEY, kind)

export const Ctx = createParamDecorator((_: unknown, host: ExecutionContext) => host.switchToHttp().getRequest().auth)

export function assertWarehouse(ctx: TenantContext, warehouseId: string): void {
  if (ctx.warehouseIds && !ctx.warehouseIds.includes(warehouseId)) {
    throw new ForbiddenException('Cet entrepôt ne fait pas partie de votre périmètre.')
  }
}

/** Filtre Prisma limitant une requête au périmètre d'entrepôts de l'utilisateur. */
export function warehouseScope(ctx: TenantContext, field = 'warehouseId'): Record<string, unknown> {
  return ctx.warehouseIds ? { [field]: { in: ctx.warehouseIds } } : {}
}

/**
 * Périmètre d'une livraison : son entrepôt de départ, et pour un retrait, l'entrepôt de retrait
 * et celui qui garde la marchandise. Une livraison à domicile n'a que son entrepôt de départ.
 */
export function deliveryWarehouseScope(ctx: TenantContext): Record<string, unknown> {
  if (!ctx.warehouseIds) return {}
  const ids = { in: ctx.warehouseIds }
  return { OR: [{ warehouseId: ids }, { pickupWarehouseId: ids }, { heldAtWarehouseId: ids }] }
}

export const ALLOW_DRIVER_KEY = 'lt:allowdriver'
/** La route est aussi ouverte au chauffeur : le service vérifie que la mission lui appartient. */
export const AllowDriver = () => SetMetadata(ALLOW_DRIVER_KEY, true)
