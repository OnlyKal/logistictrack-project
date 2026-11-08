import { createContext, useCallback, useContext, useEffect, useMemo, useState, useRef } from 'react'
import { AlertCircle, AlertTriangle, Ban, BadgeCheck, CheckCircle2, ChevronLeft, ChevronRight, Circle, ClipboardList, Hourglass, Info, Inbox, Loader2, MapPinCheck, Package, PackageCheck, Search, SearchCheck, Truck, Undo2, UserCheck, X, XCircle } from 'lucide-react'
import { ApiError } from '../lib/api.js'

/** Chaque couleur d'état a aussi son icône : l'état reste lisible sans distinguer les couleurs. */
const TONE_ICON = {
  neutral: Circle, blue: UserCheck, green: CheckCircle2, orange: AlertTriangle, red: XCircle, amber: Hourglass, sky: SearchCheck, indigo: BadgeCheck, violet: ClipboardList,
  cyan: PackageCheck, teal: Package, transit: Truck, lime: MapPinCheck, rose: Undo2, slate: Ban, info: Info,
}

export function Badge({ tone = 'neutral', children }) {
  const Icon = TONE_ICON[tone] ?? Circle
  return <span className={`badge badge-${tone}`}><Icon size={13} strokeWidth={2} aria-hidden />{children}</span>
}

/** État métier : icône + libellé, jamais la couleur seule. */
export function Status({ map, value }) {
  const [label, tone] = map[value] ?? [value ?? '—', 'neutral']
  return <Badge tone={tone}>{label}</Badge>
}

export function Button({ variant, icon: Icon, loading, children, className = '', size, ...props }) {
  const classes = ['btn', variant && `btn-${variant}`, size && `btn-${size}`, !children && 'btn-icon', className].filter(Boolean).join(' ')
  return (
    <button type="button" className={classes} disabled={loading || props.disabled} {...props}>
      {loading ? <Loader2 size={16} className="spin" aria-hidden /> : Icon && <Icon size={16} strokeWidth={1.9} aria-hidden />}
      {children}
    </button>
  )
}

export function Field({ label, hint, error, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  )
}
export const Input = (props) => <input className="input" {...props} />
export const Textarea = (props) => <textarea className="textarea" {...props} />
export function Select({ options = [], placeholder, ...props }) {
  return (
    <select className="select" {...props}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
export function SearchInput({ value, onChange, placeholder = 'Rechercher', style }) {
  return (
    <div className="input-icon" style={style ?? { width: 260 }}>
      <Search size={15} aria-hidden />
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </div>
  )
}
export function Checkbox({ label, hint, ...props }) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...props} />
      <span>{label}{hint && <span className="field-hint" style={{ display: 'block' }}>{hint}</span>}</span>
    </label>
  )
}

export function Alert({ tone = 'error', children }) {
  const Icon = tone === 'error' ? AlertCircle : tone === 'warn' ? AlertTriangle : Info
  return <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : undefined}><Icon size={16} aria-hidden /><div>{children}</div></div>
}

/** Affiche une erreur d'API et, s'il y en a, ses détails de validation. */
export function ErrorBox({ error }) {
  if (!error) return null
  const details = error instanceof ApiError && Array.isArray(error.errors) ? error.errors.filter((e) => e.message && e.message !== error.message) : []
  return (
    <Alert>
      {error.message}
      {details.length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>{details.map((e, i) => <li key={i}>{e.path ? `${e.path} : ` : ''}{e.message}</li>)}</ul>}
    </Alert>
  )
}

export function Card({ title, actions, children, pad, style }) {
  return (
    <section className="card" style={style}>
      {(title || actions) && <header className="card-head"><h2 className="card-title">{title}</h2>{actions && <div className="actions">{actions}</div>}</header>}
      <div className={pad ? 'card-pad' : undefined}>{children}</div>
    </section>
  )
}

export function Stat({ label, value, note, icon: Icon, loading }) {
  return (
    <div className="card stat">
      <div className="stat-top"><span>{label}</span>{Icon && <Icon size={17} strokeWidth={1.8} aria-hidden />}</div>
      {loading ? <div className="skeleton" style={{ height: 28, marginTop: 8, width: '55%' }} /> : <div className="stat-value">{value}</div>}
      {note && <div className="stat-note">{note}</div>}
    </div>
  )
}

export function PageHead({ title, sub, actions, back }) {
  return (
    <div>
      {back}
      <div className="page-head">
        <div><h1 className="page-title">{title}</h1>{sub && <p className="page-sub">{sub}</p>}</div>
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  )
}

export function Modal({ title, onClose, children, footer, wide }) {
  const back = useRef(null)
  useEffect(() => {
    // Échap ne ferme que la fenêtre du dessus, jamais celle qui se trouve en dessous.
    const onKey = (e) => {
      const all = document.querySelectorAll('.modal-back')
      if (e.key === 'Escape' && all[all.length - 1] === back.current) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div ref={back} className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head"><h2 className="card-title">{title}</h2><Button variant="ghost" icon={X} onClick={onClose} aria-label="Fermer" /></header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function Empty({ icon: Icon = Inbox, title = 'Aucun élément', children }) {
  return <div className="empty"><Icon size={26} strokeWidth={1.5} aria-hidden /><div className="strong" style={{ color: 'var(--text)' }}>{title}</div>{children && <div>{children}</div>}</div>
}

export function SkeletonRows({ columns, rows = 5 }) {
  return Array.from({ length: rows }, (_, i) => (
    <tr key={i}>{Array.from({ length: columns }, (__, j) => <td key={j}><div className="skeleton" /></td>)}</tr>
  ))
}

/** Tableau de données : colonnes déclaratives, chargement, vide et clic sur ligne. */
export function DataTable({ columns, rows, loading, error, onRowClick, empty, rowKey = (r) => r.id }) {
  if (error) return <div className="card-pad"><ErrorBox error={error} /></div>
  if (!loading && rows.length === 0) return empty ?? <Empty />
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{columns.map((c, i) => <th key={i} className={c.num ? 'num' : undefined}>{c.label}</th>)}</tr></thead>
        <tbody>
          {loading && rows.length === 0 ? <SkeletonRows columns={columns.length} /> : rows.map((row) => (
            <tr key={rowKey(row)} className={onRowClick ? 'clickable' : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((c, i) => <td key={i} className={c.num ? 'num' : undefined}>{c.render ? c.render(row) : row[c.key] ?? '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Pagination({ meta, onPage }) {
  if (!meta?.pages || meta.pages <= 1) return meta?.total ? <div className="pagination"><span>{meta.total} élément{meta.total > 1 ? 's' : ''}</span></div> : null
  return (
    <div className="pagination">
      <span>{meta.total} éléments</span>
      <div className="actions">
        <Button icon={ChevronLeft} disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)} aria-label="Page précédente" />
        <span>Page {meta.page} sur {meta.pages}</span>
        <Button icon={ChevronRight} disabled={meta.page >= meta.pages} onClick={() => onPage(meta.page + 1)} aria-label="Page suivante" />
      </div>
    </div>
  )
}

const ToastContext = createContext(() => {})
export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const push = useCallback((message, tone = 'ok') => {
    const id = crypto.randomUUID()
    setToasts((t) => [...t, { id, message, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])
  const value = useMemo(() => push, [push])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'error' ? 'toast-error' : ''}`}>
            {t.tone === 'error' ? <AlertCircle size={15} aria-hidden /> : <CheckCircle2 size={15} aria-hidden />}{t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/** Exécute une action serveur avec message de confirmation et gestion d'erreur. */
export function useAction() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const run = useCallback(async (fn, success) => {
    setBusy(true)
    try {
      const result = await fn()
      if (success) toast(success)
      return { ok: true, result }
    } catch (error) {
      toast(error.message, 'error')
      return { ok: false, error }
    } finally {
      setBusy(false)
    }
  }, [toast])
  return { busy, run }
}

export function Confirm({ title, message, confirmLabel = 'Confirmer', danger, onConfirm, onClose, busy }) {
  return (
    <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <p>{message}</p>
    </Modal>
  )
}
