import { z } from 'zod'
import { DELIVERY_MODES, FAILURE_REASONS, PACKAGING_TYPES, PROOF_TYPES } from '../../common/constants.js'
import { lat, lng, optDate, qty, qtyOrZero, uuid } from '../../common/http.js'

/** Champs communs des opérations terrain, y compris synchronisées après coup. */
const opFields = {
  clientOpId: z.string().min(8).max(64).optional(),
  occurredAt: z.coerce.date().optional().nullable(),
  latitude: lat.optional(),
  longitude: lng.optional(),
  note: z.string().max(1000).optional(),
}
export const opSchema = z.object(opFields)

export const packageSchema = z.object({
  warehouseId: uuid, orderId: uuid.optional(), unitType: z.enum(PACKAGING_TYPES).default('CARTON'),
  weightKg: qtyOrZero.optional(), volumeM3: qtyOrZero.optional(), dimensions: z.string().max(60).optional(), transportNote: z.string().max(300).optional(),
  items: z.array(z.object({ productId: uuid, orderItemId: uuid.optional(), quantity: qty })).min(1).max(200),
})
export const scanSchema = z.object({
  token: z.string().min(8).max(100), action: z.enum(['VIEW', 'LOAD', 'DELIVER']).default('VIEW'), deliveryId: uuid.optional(), ...opFields,
})
export const deliverySchema = z.object({
  orderId: uuid.optional(), customerId: uuid.optional(), deliveryPointId: uuid.optional(), packageIds: z.array(uuid).min(1).max(500),
  scheduledAt: optDate, priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  instructions: z.string().max(2000).optional(), justification: z.string().max(1000).optional(),
  // Par défaut, livraison à domicile : sans ces champs, rien ne change.
  mode: z.enum(DELIVERY_MODES).default('HOME'), pickupWarehouseId: uuid.optional(),
})
/** Mode de remise ou entrepôt de retrait : modifiable avant le chargement, ou pour envoyer la marchandise vers un autre entrepôt. */
export const pickupSchema = z.object({ mode: z.enum(DELIVERY_MODES).default('PICKUP'), pickupWarehouseId: uuid.optional(), note: z.string().max(500).optional() })
export const deliveryPatch = z.object({
  scheduledAt: optDate, priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(), instructions: z.string().max(2000).nullish(),
})
export const assignSchema = z.object({ driverId: uuid, vehicleId: uuid })
export const respondSchema = z.object({ accept: z.boolean(), note: z.string().max(500).optional() })
export const proofSchema = z.object({
  type: z.enum(PROOF_TYPES), value: z.string().max(500).optional(), capturedAt: z.coerce.date().optional(),
  latitude: lat.optional(), longitude: lng.optional(), clientOpId: z.string().min(8).max(64).optional(),
})
const recipient = {
  recipientName: z.string().trim().min(2).max(120).optional(), recipientPhone: z.string().trim().max(40).optional(),
}
export const confirmSchema = z.object({ ...opFields, ...recipient })
export const partialSchema = z.object({
  ...opFields, ...recipient,
  items: z.array(z.object({
    deliveryItemId: uuid, delivered: qtyOrZero, refused: qtyOrZero.default(0), missing: qtyOrZero.default(0), reason: z.string().trim().max(300).optional(),
  })).min(1).max(500),
})
export const failSchema = z.object({ ...opFields, reason: z.enum(FAILURE_REASONS), comment: z.string().max(1000).optional() })
export const rescheduleSchema = z.object({ scheduledAt: z.coerce.date(), driverId: uuid.optional(), vehicleId: uuid.optional(), note: z.string().max(500).optional() })
export const returnSchema = z.object({ condition: z.enum(['GOOD', 'DAMAGED', 'QUARANTINE']).default('GOOD'), note: z.string().max(1000).optional() })
export const cancelSchema = z.object({ note: z.string().max(500).optional() })
export const recallSchema = z.object({ reason: z.string().trim().min(3, 'Indiquez le motif du rappel.').max(500) })
export const incidentSchema = z.object({ ...opFields, type: z.string().trim().min(2).max(60), description: z.string().max(1000).optional() })
