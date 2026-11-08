/**
 * Lien public de suivi en direct. Le jeton du colis (192 bits aléatoires) identifie la livraison ;
 * la clé, signée par le serveur, ouvre la carte en direct. La recherche par numéro de suivi, imprimé
 * sur l'étiquette, ne donne que le jeton : l'état du colis, jamais la position du chauffeur.
 */
import { webUrl } from './emails.service.js'
import { hmac, safeEqual, secret } from './util.js'

export const liveKey = (trackingToken: string) => hmac(secret('FILE_URL_SECRET'), `live-tracking:${trackingToken}`).slice(0, 40)

export const isLiveKey = (trackingToken: string, key: unknown) => typeof key === 'string' && key.length === 40 && safeEqual(liveKey(trackingToken), key)

export const publicTrackingUrl = (trackingToken: string) => webUrl(`/suivi-colis/${trackingToken}?k=${liveKey(trackingToken)}`)
