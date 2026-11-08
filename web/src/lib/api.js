/** Client de l'API : jeton d'accès, rafraîchissement automatique, enveloppe de réponse. */
const BASE = `${import.meta.env.VITE_API_URL ?? ''}/api/v1`
const REFRESH_KEY = 'lt.refresh'

let accessToken = null
let refreshing = null
let onSessionLost = () => {}

export class ApiError extends Error {
  constructor(message, status, code, errors) {
    super(message)
    this.status = status
    this.code = code
    this.errors = errors
  }
}

export const session = {
  set(tokens) {
    if (tokens.accessToken) accessToken = tokens.accessToken
    if (tokens.refreshToken) localStorage.setItem(REFRESH_KEY, tokens.refreshToken)
  },
  clear() {
    accessToken = null
    localStorage.removeItem(REFRESH_KEY)
  },
  get token() { return accessToken },
  get hasRefresh() { return !!localStorage.getItem(REFRESH_KEY) },
  onLost(fn) { onSessionLost = fn },
}

/** Un seul onglet renouvelle la session à la fois ; les autres reprennent le jeton qu'il a enregistré. */
const exclusive = (fn) => (navigator.locks?.request ? navigator.locks.request('lt-session-refresh', fn) : fn())

async function refresh() {
  refreshing ??= exclusive(async () => {
    const refreshToken = localStorage.getItem(REFRESH_KEY)
    if (!refreshToken) return false
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }),
    }).catch(() => null)
    if (!res) throw new ApiError('Serveur injoignable. Vérifiez votre connexion.', 0)
    // Seul un refus explicite du serveur ferme la session ; une panne ou un redémarrage ne déconnecte jamais.
    if (res.status === 401) {
      session.clear()
      return false
    }
    if (!res.ok) throw new ApiError('Serveur momentanément indisponible. Nouvelle tentative en cours.', res.status)
    const body = await res.json()
    session.set(body.data)
    return true
  }).finally(() => { refreshing = null })
  return refreshing
}

async function raw(path, options = {}, retry = true) {
  const headers = { ...(options.headers ?? {}) }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  const isForm = options.body instanceof FormData
  if (options.body && !isForm) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetch(`${BASE}${path}`, { ...options, headers, body: options.body && !isForm ? JSON.stringify(options.body) : options.body })
  } catch {
    throw new ApiError('Serveur injoignable. Vérifiez votre connexion.', 0)
  }
  if (res.status === 401 && retry && session.hasRefresh && !path.startsWith('/auth/login')) {
    if (await refresh()) return raw(path, options, false)
    onSessionLost()
  }
  return res
}

async function parse(res) {
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.success === false) {
    throw new ApiError(body?.message ?? `Erreur ${res.status}`, res.status, body?.code, body?.errors)
  }
  return body
}

const uuid = () => crypto.randomUUID()

export const api = {
  /** Renvoie seulement `data`. */
  async get(path) { return (await parse(await raw(path))).data },
  /** Renvoie { data, meta } pour les listes paginées. */
  async list(path) {
    const body = await parse(await raw(path))
    return { items: body.data, meta: body.meta }
  },
  /** Opérations d'écriture : chaque tentative porte une clé d'idempotence distincte par action utilisateur. */
  async post(path, data, idempotencyKey) {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined
    return (await parse(await raw(path, { method: 'POST', body: data ?? {}, headers }))).data
  },
  async patch(path, data) { return (await parse(await raw(path, { method: 'PATCH', body: data }))).data },
  async put(path, data) { return (await parse(await raw(path, { method: 'PUT', body: data }))).data },
  async del(path) { return (await parse(await raw(path, { method: 'DELETE' }))).data },
  async upload(path, file, fields = {}) {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    if (file) form.append('file', file)
    return (await parse(await raw(path, { method: 'POST', body: form }))).data
  },
  /** Téléchargement authentifié d'un document (PDF, Excel, CSV). */
  async download(path, fallbackName) {
    const res = await raw(path)
    if (!res.ok) await parse(res)
    const disposition = res.headers.get('content-disposition') ?? ''
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  },
  newKey: uuid,
  async restore() { return session.hasRefresh ? refresh() : false },
  fileUrl: (signedPath) => `${import.meta.env.VITE_API_URL ?? ''}${signedPath}`,
}

export function query(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v)
  const s = q.toString()
  return s ? `?${s}` : ''
}
