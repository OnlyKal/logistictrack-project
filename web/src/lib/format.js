/** Libellés et formats français partagés. */
// Une couleur garde le même sens partout, et deux états d'une même liste n'ont jamais la même couleur.
export const DELIVERY_STATUS = {
  DRAFT: ['Brouillon', 'neutral'], PENDING: ['En attente', 'amber'], VALIDATED: ['Validée', 'indigo'], PREPARING: ['En préparation', 'violet'], READY: ['Prête', 'cyan'],
  ASSIGNED: ['Affectée', 'blue'], LOADED: ['Chargée', 'teal'], IN_TRANSIT: ['En route', 'transit'], ARRIVED: ['Arrivée', 'lime'], AWAITING_PICKUP: ['Disponible au retrait', 'sky'], PARTIALLY_DELIVERED: ['Livrée partiellement', 'orange'],
  DELIVERED: ['Livrée', 'green'], FAILED: ['Échec', 'red'], RETURNED: ['Retournée', 'rose'], CANCELLED: ['Annulée', 'slate'],
}
/** Mode de remise : livraison à l'adresse du client, ou retrait par le client dans un entrepôt de l'entreprise. */
export const DELIVERY_MODE = { HOME: 'Livraison à domicile', PICKUP: 'Retrait en entrepôt' }
export const SHIPMENT_STATUS = {
  REGISTERED: ['Déposé', 'indigo'], IN_TRANSIT: ['En transit', 'transit'], AT_WAREHOUSE: ['En escale', 'violet'], AVAILABLE: ['Disponible au retrait', 'sky'],
  DELIVERED: ['Retiré', 'green'], RETURNED: ["Rendu à l'expéditeur", 'rose'], CANCELLED: ['Annulé', 'slate'],
}
export const ORDER_STATUS = {
  DRAFT: ['Brouillon', 'neutral'], SUBMITTED: ['Soumise', 'amber'], VALIDATING: ['En validation', 'sky'], VALIDATED: ['Validée', 'indigo'], PREPARING: ['En préparation', 'violet'],
  PARTIALLY_PREPARED: ['Partiellement préparée', 'orange'], READY: ['Prête', 'cyan'], PARTIALLY_SHIPPED: ['Partiellement expédiée', 'teal'], SHIPPED: ['Expédiée', 'transit'], CLOSED: ['Clôturée', 'green'], CANCELLED: ['Annulée', 'slate'],
}
export const TRANSFER_STATUS = { DRAFT: ['Brouillon', 'neutral'], PENDING: ['En attente', 'amber'], VALIDATED: ['Validé', 'indigo'], SHIPPED: ['En transit', 'transit'], CLOSED: ['Clôturé', 'green'], CANCELLED: ['Annulé', 'slate'] }
export const PACKAGE_STATUS = { CREATED: ['Créé', 'neutral'], LOADED: ['Chargé', 'teal'], IN_TRANSIT: ['En route', 'transit'], AVAILABLE: ['Au point de retrait', 'sky'], DELIVERED: ['Livré', 'green'], FAILED: ['Échec', 'red'], RETURNED: ['Retourné', 'rose'] }
export const ROUTE_STATUS = { PLANNED: ['Planifiée', 'indigo'], IN_PROGRESS: ['En cours', 'transit'], DONE: ['Clôturée', 'green'], CANCELLED: ['Annulée', 'slate'] }
export const COMPANY_STATUS = { active: ['Active', 'green'], suspended: ['Suspendue', 'red'], expired: ['Expirée', 'orange'], closed: ['Fermée', 'slate'] }
export const SUBSCRIPTION_STATUS = { TRIAL: ['Essai', 'sky'], ACTIVE: ['Actif', 'green'], GRACE: ['Période de grâce', 'orange'], EXPIRED: ['Expiré', 'red'], SUSPENDED: ['Suspendu', 'rose'] }
export const INVOICE_STATUS = { UNPAID: ['Impayée', 'orange'], PAID: ['Payée', 'green'], REFUNDED: ['Remboursée', 'violet'], CANCELLED: ['Annulée', 'slate'] }
/** Libellé d'une durée d'abonnement. Le serveur calcule seul les montants et les remises. */
export const durationLabel = (months, discount) => `${months} mois${discount ? ` (-${discount} %)` : ''}`

export const DRIVER_STATUS = { available: ['Disponible', 'green'], on_mission: ['En mission', 'transit'], off_duty: ['Hors service', 'neutral'], inactive: ['Inactif', 'slate'], suspended: ['Suspendu', 'red'] }
export const VEHICLE_STATUS = { available: ['Disponible', 'green'], in_use: ['En service', 'transit'], maintenance: ['En maintenance', 'orange'], inactive: ['Inactif', 'slate'] }
export const INVENTORY_STATUS = { OPEN: ['Ouvert', 'blue'], CLOSED: ['Clôturé', 'green'] }
export const ACTIVE_STATUS = { active: ['Actif', 'green'], inactive: ['Inactif', 'neutral'], closed: ['Fermé', 'slate'] }
export const PO_STATUS = { DRAFT: ['Brouillon', 'neutral'], VALIDATED: ['Validé', 'indigo'], PARTIALLY_RECEIVED: ['Reçu partiellement', 'orange'], RECEIVED: ['Reçu', 'green'] }

const toOptions = (map) => Object.entries(map).map(([value, label]) => ({ value, label }))
export const WAREHOUSE_TYPES = { GENERAL: 'Général', FOOD: 'Alimentaire', COLD: 'Frigorifique', LIQUID: 'Liquides', INDUSTRIAL: 'Industriel', MATERIALS: 'Matériaux', SENSITIVE: 'Produits sensibles', CUSTOM: 'Personnalisé' }
export const NATURES = { SOLID: 'Solide', LIQUID: 'Liquide', POWDER: 'Poudre', GRANULE: 'Granulé', GAS: 'Gaz', MIXED: 'Mixte', OTHER: 'Autre' }
export const PACKAGING = { CARTON: 'Carton', BAG: 'Sac', PALLET: 'Palette', DRUM: 'Fût', JERRYCAN: 'Bidon', BOTTLE: 'Bouteille', CRATE: 'Caisse', CONTAINER: 'Conteneur', TANK: 'Citerne ou réservoir', COMPARTMENT: 'Compartiment', BATCH: 'Lot', CUSTOM: 'Emballage personnalisé', NONE: 'Sans emballage' }
export const VEHICLE_TYPES = { MOTORBIKE: 'Moto', TRICYCLE: 'Tricycle', CAR: 'Voiture', VAN: 'Camionnette', TRUCK: 'Camion', TANKER: 'Camion-citerne', REEFER: 'Camion frigorifique', SEMI: 'Semi-remorque' }
export const FRAGILITY = { NONE: 'Aucune', LOW: 'Faible', MEDIUM: 'Moyenne', HIGH: 'Élevée' }
export const PRIORITY = { LOW: 'Basse', NORMAL: 'Normale', HIGH: 'Haute', URGENT: 'Urgente' }
export const FAILURE_REASONS = { CUSTOMER_ABSENT: 'Client absent', WRONG_ADDRESS: 'Adresse incorrecte', NO_ACCESS: 'Accès impossible', CUSTOMER_REFUSED: 'Refus du client', DAMAGED: 'Colis endommagé', BREAKDOWN: 'Panne', INCIDENT: 'Incident', OTHER: 'Autre', RECALLED: "Rappelé par l'entreprise" }
export const MOVEMENT_REASONS = { SUPPLIER: 'Réception fournisseur', CUSTOMER_RETURN: 'Retour client', TRANSFER_IN: 'Transfert entrant', PRODUCTION: 'Production', ADJUSTMENT: 'Ajustement', DELIVERY: 'Livraison', TRANSFER_OUT: 'Transfert sortant', LOSS: 'Perte', DAMAGED: 'Produit endommagé', INTERNAL_USE: 'Consommation interne' }
export const PROOF_TYPES = { SIGNATURE: 'Signature', PHOTO_GOODS: 'Photo de la marchandise', PHOTO_PLACE: 'Photo du lieu', RECIPIENT: 'Réceptionnaire', QR: 'QR Code', GPS: 'Position GPS' }
export const options = toOptions

const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const numberFmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 })

export const date = (v) => (v ? dateFmt.format(new Date(v)) : '—')
const pastYearFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
/** L'année n'apparaît que si elle diffère de l'année en cours : un historique reste sans ambiguïté. */
export const dateTime = (v) => {
  if (!v) return '—'
  const at = new Date(v)
  return (at.getFullYear() === new Date().getFullYear() ? dateTimeFmt : pastYearFmt).format(at)
}
export const num = (v) => (v === null || v === undefined || v === '' ? '—' : numberFmt.format(Number(v)))
export const money = (v, currency = 'USD') => (v === null || v === undefined ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(v)))
export const qty = (v, unit) => `${num(v)}${unit ? ` ${unit}` : ''}`
/** Valeur pour un champ <input type="date">. */
/** Début et fin d'une journée choisie, dans le fuseau de l'utilisateur. */
export const dayStart = (day) => (day ? new Date(`${day}T00:00:00`).toISOString() : undefined)
export const dayEnd = (day) => (day ? new Date(`${day}T23:59:59.999`).toISOString() : undefined)
export const inputDate = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '')

export function ago(v) {
  if (!v) return '—'
  const s = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 1000))
  if (s < 60) return `il y a ${s} s`
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`
  return `il y a ${Math.round(s / 86400)} j`
}
/** Distance à vol d'oiseau entre deux points, en kilomètres. */
export function distanceKm([lat1, lng1], [lat2, lng2]) {
  const rad = Math.PI / 180
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)))
}
export const km = (v) => `${v < 10 ? v.toFixed(1).replace('.', ',') : Math.round(v)} km`
export function accuracyLabel(m) {
  if (m === null || m === undefined) return 'Précision indisponible'
  if (m <= 10) return `Très bonne (${Math.round(m)} m)`
  if (m <= 30) return `Bonne (${Math.round(m)} m)`
  if (m <= 50) return `Moyenne (${Math.round(m)} m)`
  return `Faible (${Math.round(m)} m)`
}
