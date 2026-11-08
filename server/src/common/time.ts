/** Dates dans le fuseau horaire de l'entreprise, quel que soit celui du serveur. */
import type { PrismaService } from './prisma.service.js'

export const DEFAULT_TIMEZONE = 'Africa/Kinshasa'

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const zone = (tz?: string | null) => (isTimeZone(tz) ? tz : DEFAULT_TIMEZONE)

function wall(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') }
}

/** Décalage du fuseau à un instant donné, en millisecondes (heure d'été comprise). */
function offset(tz: string, at: Date) {
  const w = wall(tz, at)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(at.getTime() / 1000) * 1000
}

/** Minuit, heure locale de l'entreprise, pour le jour civil donné. */
export function zonedMidnight(y: number, m: number, d: number, tz?: string | null) {
  const z = zone(tz)
  const guess = Date.UTC(y, m - 1, d)
  const first = guess - offset(z, new Date(guess))
  return new Date(guess - offset(z, new Date(first)))
}

/** Début du jour en cours dans le fuseau de l'entreprise. */
export function startOfDay(at: Date, tz?: string | null) {
  const w = wall(zone(tz), at)
  return zonedMidnight(w.y, w.m, w.d, tz)
}

/** Borne d'une période saisie à l'écran : « 2026-03-01 » devient minuit (ou la fin de journée) dans le fuseau de l'entreprise. */
export function dayBound(value: string, tz: string | null | undefined, end: boolean) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return new Date(value)
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  return end ? new Date(zonedMidnight(y, m, d + 1, tz).getTime() - 1) : zonedMidnight(y, m, d, tz)
}

/** Jour civil (AAAA-MM-JJ) d'un instant, dans le fuseau de l'entreprise. */
export function dayIn(at: Date, tz?: string | null) {
  const w = wall(zone(tz), at)
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`
}

/**
 * Une date limite saisie comme un jour (expiration d'un lot) vaut pour toute cette journée :
 * le lot n'est périmé qu'à partir du lendemain, dans le fuseau de l'entreprise.
 * Le jour est lu en UTC, car le navigateur et l'import l'enregistrent à minuit UTC.
 */
export function isPastDay(limit: Date, tz?: string | null, at = new Date()) {
  return limit.toISOString().slice(0, 10) < dayIn(at, tz)
}

export const formatDateTime = (at: Date | null | undefined, tz?: string | null) => (at ? at.toLocaleString('fr-FR', { timeZone: zone(tz), dateStyle: 'short', timeStyle: 'short' }) : '')
export const formatDate = (at: Date | null | undefined, tz?: string | null) => (at ? at.toLocaleDateString('fr-FR', { timeZone: zone(tz) }) : '')

export async function companyTimeZone(prisma: PrismaService, companyId: string) {
  const settings = await prisma.companySettings.findUnique({ where: { companyId }, select: { timezone: true } })
  return zone(settings?.timezone)
}
