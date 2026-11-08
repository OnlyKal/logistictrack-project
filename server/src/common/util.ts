import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { Prisma } from '@prisma/client'

export const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0)
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
/** Type réel d'un fichier d'après ses premiers octets, jamais d'après ce que déclare le navigateur. */
export function detectFileType(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf' | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer.length >= 5 && buffer.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf'
  return null
}

export const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex')

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Jeton opaque non prévisible (QR Code, suivi public). */
export const opaqueToken = (bytes = 24) => randomBytes(bytes).toString('base64url')

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
/** Code lisible sans caractères ambigus. */
export function readableCode(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

export function secret(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`)
  return value
}

/** Clé propre à un usage, dérivée de JWT_SECRET : un secret stocké en base reste illisible sans le .env. */
const settingsKey = (purpose: string) => Buffer.from(hkdfSync('sha256', secret('JWT_SECRET'), 'logistictrack-settings', purpose, 32))

/** Chiffre un secret à stocker en base (AES-256-GCM, authentifié). Format : v1.iv.tag.données, en base64url. */
export function encryptSecret(plain: string, purpose: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', settingsKey(purpose), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
}

/** Renvoie null si le secret est illisible (JWT_SECRET changé, donnée altérée). */
export function decryptSecret(stored: string, purpose: string): string | null {
  try {
    const [version, iv, tag, data] = stored.split('.')
    if (version !== 'v1' || !iv || !tag || data === undefined) return null
    const decipher = createDecipheriv('aes-256-gcm', settingsKey(purpose), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function escapeCsv(value: unknown): string {
  const s = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value)
  // Neutralise l'injection de formules dans les tableurs.
  const safe = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
