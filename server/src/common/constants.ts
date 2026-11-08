/** Catalogue central : permissions (RBAC), rôles et machines à états métier. */

export const PERMISSIONS = [
  'company.manage', 'user.manage', 'agency.manage', 'audit.view', 'billing.manage',
  'warehouse.view', 'warehouse.manage',
  'product.view', 'product.manage',
  'stock.view', 'stock.receive', 'stock.issue', 'stock.adjust', 'stock.transfer', 'inventory.manage',
  'supplier.manage',
  'customer.view', 'customer.manage',
  'order.view', 'order.create', 'order.validate', 'order.prepare',
  'package.manage',
  'delivery.view', 'delivery.create', 'delivery.create_without_order', 'delivery.validate', 'delivery.assign',
  'delivery.load', 'delivery.cancel', 'delivery.resolve',
  'driver.view', 'driver.manage', 'vehicle.view', 'vehicle.manage',
  'route.manage', 'tracking.view', 'reports.view',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const WAREHOUSE_OPS: Permission[] = [
  'warehouse.view', 'product.view', 'stock.view', 'stock.receive', 'stock.issue', 'stock.transfer',
  'inventory.manage', 'order.view', 'order.prepare', 'package.manage', 'delivery.view', 'delivery.load', 'reports.view',
]

export const ROLES: Record<string, { label: string; permissions: readonly Permission[] }> = {
  COMPANY_ADMIN: { label: 'Administrateur principal', permissions: PERMISSIONS },
  SECONDARY_ADMIN: { label: 'Administrateur secondaire', permissions: [] },
  LOGISTICS_MANAGER: {
    label: 'Responsable logistique',
    permissions: [
      'warehouse.view', 'product.view', 'stock.view', 'customer.view', 'order.view', 'order.validate',
      'package.manage', 'delivery.view', 'delivery.create', 'delivery.validate', 'delivery.assign', 'delivery.cancel',
      'delivery.resolve', 'driver.view', 'vehicle.view', 'route.manage', 'tracking.view', 'reports.view',
    ],
  },
  WAREHOUSE_MANAGER: { label: "Responsable d'entrepôt", permissions: [...WAREHOUSE_OPS, 'stock.adjust'] },
  WAREHOUSE_AGENT: {
    label: "Agent d'entrepôt",
    permissions: ['warehouse.view', 'product.view', 'stock.view', 'order.view', 'order.prepare', 'package.manage', 'delivery.view'],
  },
  SALES_MANAGER: {
    label: 'Gestionnaire commercial',
    permissions: ['product.view', 'stock.view', 'warehouse.view', 'customer.view', 'customer.manage', 'order.view', 'order.create', 'delivery.view'],
  },
  FLEET_MANAGER: {
    label: 'Gestionnaire de flotte',
    permissions: ['warehouse.view', 'driver.view', 'driver.manage', 'vehicle.view', 'vehicle.manage', 'delivery.view', 'delivery.assign', 'route.manage', 'tracking.view', 'reports.view'],
  },
  DRIVER: { label: 'Chauffeur', permissions: [] },
}

export const COMPANY_STATUS = ['active', 'suspended', 'expired', 'closed'] as const
export const WAREHOUSE_TYPES = ['GENERAL', 'FOOD', 'COLD', 'LIQUID', 'INDUSTRIAL', 'MATERIALS', 'SENSITIVE', 'CUSTOM'] as const
export const PHYSICAL_NATURES = ['SOLID', 'LIQUID', 'POWDER', 'GRANULE', 'GAS', 'MIXED', 'OTHER'] as const
export const PACKAGING_TYPES = ['CARTON', 'BAG', 'PALLET', 'DRUM', 'JERRYCAN', 'BOTTLE', 'CRATE', 'CONTAINER', 'TANK', 'COMPARTMENT', 'BATCH', 'CUSTOM', 'NONE'] as const
export const VEHICLE_TYPES = ['MOTORBIKE', 'TRICYCLE', 'CAR', 'VAN', 'TRUCK', 'TANKER', 'REEFER', 'SEMI'] as const

export const STOCK_IN_REASONS = ['SUPPLIER', 'CUSTOMER_RETURN', 'TRANSFER_IN', 'PRODUCTION', 'ADJUSTMENT'] as const
export const STOCK_OUT_REASONS = ['DELIVERY', 'TRANSFER_OUT', 'LOSS', 'DAMAGED', 'INTERNAL_USE', 'ADJUSTMENT'] as const

export const FAILURE_REASONS = ['CUSTOMER_ABSENT', 'WRONG_ADDRESS', 'NO_ACCESS', 'CUSTOMER_REFUSED', 'DAMAGED', 'BREAKDOWN', 'INCIDENT', 'OTHER'] as const
/** Motif réservé au bureau : mission interrompue par l'entreprise. */
export const RECALLED = 'RECALLED'
export const PROOF_TYPES = ['SIGNATURE', 'PHOTO_GOODS', 'PHOTO_PLACE', 'RECIPIENT', 'QR', 'GPS'] as const

export type DeliveryStatus =
  | 'DRAFT' | 'PENDING' | 'VALIDATED' | 'PREPARING' | 'READY' | 'ASSIGNED' | 'LOADED' | 'IN_TRANSIT'
  | 'ARRIVED' | 'PARTIALLY_DELIVERED' | 'DELIVERED' | 'FAILED' | 'RETURNED' | 'CANCELLED'

export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  DRAFT: ['PENDING', 'VALIDATED', 'CANCELLED'],
  PENDING: ['VALIDATED', 'CANCELLED'],
  VALIDATED: ['PREPARING', 'READY', 'ASSIGNED', 'CANCELLED'],
  PREPARING: ['READY', 'ASSIGNED', 'CANCELLED'],
  READY: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['LOADED', 'READY', 'CANCELLED'],
  LOADED: ['IN_TRANSIT', 'ASSIGNED', 'RETURNED'],
  IN_TRANSIT: ['ARRIVED', 'FAILED'],
  ARRIVED: ['DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED'],
  PARTIALLY_DELIVERED: ['RETURNED'],
  DELIVERED: [],
  FAILED: ['ASSIGNED', 'RETURNED', 'CANCELLED'],
  RETURNED: [],
  CANCELLED: [],
}

/** Libellés publics du portail de suivi : aucune donnée interne. */
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  DRAFT: 'Brouillon', PENDING: 'En attente', VALIDATED: 'Validée', PREPARING: 'En préparation', READY: 'Prête',
  ASSIGNED: 'Affectée', LOADED: 'Chargée', IN_TRANSIT: 'En route', ARRIVED: 'Arrivée',
  PARTIALLY_DELIVERED: 'Livrée partiellement', DELIVERED: 'Livrée', FAILED: 'Échec', RETURNED: 'Retournée', CANCELLED: 'Annulée',
}

export const ORDER_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['VALIDATING', 'VALIDATED', 'CANCELLED'],
  VALIDATING: ['VALIDATED', 'CANCELLED'],
  VALIDATED: ['PREPARING', 'PARTIALLY_PREPARED', 'READY', 'CANCELLED'],
  PREPARING: ['PARTIALLY_PREPARED', 'READY', 'CANCELLED'],
  PARTIALLY_PREPARED: ['PARTIALLY_PREPARED', 'READY', 'PARTIALLY_SHIPPED', 'CANCELLED'],
  READY: ['PARTIALLY_SHIPPED', 'SHIPPED', 'CANCELLED'],
  PARTIALLY_SHIPPED: ['PARTIALLY_SHIPPED', 'SHIPPED', 'PARTIALLY_PREPARED', 'READY'],
  SHIPPED: ['PARTIALLY_SHIPPED', 'CLOSED'],
  CLOSED: [],
  CANCELLED: [],
}

export const SUBSCRIPTION_USABLE = ['TRIAL', 'ACTIVE', 'GRACE']
/** État réel : un essai terminé compte comme expiré tout de suite, sans attendre la tâche périodique. */
export const subscriptionStatus = (s: { status: string; endsAt: Date }, now = new Date()) => (s.status === 'TRIAL' && s.endsAt < now ? 'EXPIRED' : s.status)
/** Une mission dans l'un de ces états peut aller jusqu'au bout, même si l'abonnement expire entre-temps. Les transitions restent contrôlées par le service. */
export const FINISHABLE_DELIVERY = ['LOADED', 'IN_TRANSIT', 'ARRIVED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'FAILED']
/** Durées d'abonnement proposées (en mois) et remise fixe associée (en pourcentage). */
export const SUBSCRIPTION_DISCOUNTS: Record<number, number> = { 1: 0, 3: 5, 6: 9, 12: 12, 24: 25 }
/** Essai gratuit d'une nouvelle entreprise. Ensuite, elle s'abonne elle-même. */
export const TRIAL_DAYS = 3
/** Au-delà de cette durée sans signal, une position n'est jamais présentée comme « en direct ». */
export const GPS_LIVE_SECONDS = 120
