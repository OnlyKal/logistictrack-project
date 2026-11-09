import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft, LocateFixed, Plus } from 'lucide-react'
import { api, query } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useDebounced, useList } from '../lib/hooks.js'
import { inputDate } from '../lib/format.js'
import { Alert, Button, Card, Checkbox, DataTable, Empty, ErrorBox, Field, Input, Modal, PageHead, Pagination, SearchInput, Select, Textarea, useToast } from './ui.jsx'

/** Charge les options d'une liste liée (entrepôts, clients, etc.). */
export function useOptions(path, toOption) {
  const [options, setOptions] = useState([])
  useEffect(() => {
    if (!path) {
      setOptions([])
      return undefined
    }
    let active = true
    api.get(path).then((rows) => { if (active) setOptions(rows.map(toOption)) }).catch(() => setOptions([]))
    return () => { active = false }
    // toOption est stable par construction dans les pages (fonction de module).
  }, [path]) // eslint-disable-line
  return options
}

/** Ramène les valeurs d'un formulaire au format de l'API. */
export function serialize(fields, values, isEdit) {
  const out = {}
  for (const f of fields) {
    if (f.readOnlyOnEdit && isEdit) continue
    const v = values[f.name]
    if (f.type === 'checkbox') out[f.name] = !!v
    else if (v === '' || v === undefined || v === null) {
      // Un champ à valeur par défaut n'accepte pas null : on le laisse simplement inchangé.
      if (isEdit && f.default === undefined) out[f.name] = null
      else if (f.required) out[f.name] = ''
    } else if (f.type === 'number') out[f.name] = Number(v)
    else if (f.type === 'date') out[f.name] = new Date(v).toISOString()
    else out[f.name] = v
  }
  return out
}

function initialValues(fields, row) {
  const values = {}
  for (const f of fields) {
    const v = row?.[f.name] ?? f.default ?? (f.type === 'checkbox' ? false : '')
    values[f.name] = f.type === 'date' ? inputDate(v) : v
  }
  return values
}

function FieldControl({ field, value, onChange }) {
  const dynamic = useOptions(field.optionsFrom, field.toOption)
  const common = { value: value ?? '', onChange: (e) => onChange(e.target.value), required: field.required, placeholder: field.placeholder }
  if (field.type === 'select') return <Select {...common} placeholder={field.required && field.default ? undefined : field.placeholder ?? 'Sélectionner'} options={field.options ?? dynamic} />
  if (field.type === 'textarea') return <Textarea {...common} />
  if (field.type === 'number') return <Input {...common} type="number" step="any" min={field.min ?? 0} />
  return <Input {...common} type={field.type ?? 'text'} minLength={field.minLength} />
}

const LOCATION_ERRORS = {
  1: "Localisation refusée : autorisez-la dans votre navigateur, ou saisissez les coordonnées.",
  2: 'Position indisponible sur cet appareil : saisissez les coordonnées.',
  3: 'La localisation a pris trop de temps : réessayez, ou saisissez les coordonnées.',
}

/** Remplit la latitude et la longitude avec la position réelle de l'appareil, jamais avec une valeur inventée. */
function LocateButton({ onLocated }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const locate = () => {
    if (!navigator.geolocation) {
      setMessage({ error: true, text: LOCATION_ERRORS[2] })
      return
    }
    setBusy(true)
    setMessage(null)
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        onLocated(Number(coords.latitude.toFixed(6)), Number(coords.longitude.toFixed(6)))
        setMessage({ text: `Position de cet appareil, précision d'environ ${Math.round(coords.accuracy)} m. Vérifiez qu'elle correspond bien au lieu.` })
        setBusy(false)
      },
      (error) => {
        setMessage({ error: true, text: LOCATION_ERRORS[error.code] ?? LOCATION_ERRORS[2] })
        setBusy(false)
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    )
  }
  return (
    <div className="span-2 locate-row">
      <Button variant="primary" icon={LocateFixed} loading={busy} onClick={locate}>Localisation</Button>
      {message && <span className="small" role={message.error ? 'alert' : 'status'} style={message.error ? { color: 'var(--red-text)' } : undefined}>{message.text}</span>}
    </div>
  )
}

export function FormFields({ fields, values, setValues, isEdit }) {
  return (
    <div className="form-grid">
      {fields.filter((f) => !(f.createOnly && isEdit) && !(f.readOnlyOnEdit && isEdit && f.hideOnEdit)).map((f) => (
        f.type === 'checkbox'
          ? <div key={f.name} className={f.wide ? 'span-2' : undefined}><Checkbox label={f.label} hint={f.hint} checked={!!values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} /></div>
          : (
            <Field key={f.name} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.hint} className={f.wide ? 'span-2' : undefined}>
              <FieldControl field={f} value={values[f.name]} onChange={(v) => setValues({ ...values, [f.name]: v })} />
            </Field>
          )
      ))}
      {fields.some((f) => f.locate) && <LocateButton onLocated={(latitude, longitude) => setValues((current) => ({ ...current, latitude, longitude }))} />}
    </div>
  )
}

/** Fenêtre de création ou de modification générée depuis la déclaration des champs. */
export function FormModal({ title, fields, row, onSubmit, onClose, submitLabel = 'Enregistrer', wide, children }) {
  const isEdit = !!row
  const [values, setValues] = useState(() => initialValues(fields, row))
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit(serialize(fields.filter((f) => !(f.createOnly && isEdit)), values, isEdit))
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal title={title} onClose={onClose} wide={wide} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" loading={busy}>{submitLabel}</Button></>}>
        <ErrorBox error={error} />
        {children}
        <FormFields fields={fields} values={values} setValues={setValues} isEdit={isEdit} />
      </Modal>
    </form>
  )
}

const NEW_PASSWORD_FIELD = [{ name: 'password', label: 'Nouveau mot de passe', type: 'password', required: true, minLength: 8, wide: true, hint: '8 caractères minimum. Communiquez-le à la personne : ses sessions ouvertes seront fermées et son compte débloqué.' }]

/**
 * L'administrateur redonne l'accès à un membre qui a oublié son mot de passe. Avec allowLink, il peut
 * plutôt lui envoyer un lien par e-mail : personne d'autre que le membre ne connaît alors le mot de passe.
 */
export function ResetPasswordModal({ endpoint, name, email, allowLink, preferLink = true, onClose, onDone }) {
  const toast = useToast()
  const [mode, setMode] = useState(allowLink && email && preferLink ? 'link' : 'password')
  const [notice, setNotice] = useState(null)
  const submit = async (values) => {
    if (mode === 'link') {
      try {
        await api.post(endpoint, {})
      } catch (err) {
        // E-mail impossible (envoi non configuré, adresse refusée) : on bascule sur la saisie directe, avec la raison.
        setNotice(/Saisissez/.test(err.message) ? err.message : `${err.message} Saisissez le nouveau mot de passe ci-dessous.`)
        setMode('password')
        return
      }
      toast(`Lien envoyé à ${email}. Il est valable 24 heures.`)
    } else {
      await api.post(endpoint, values)
      toast('Mot de passe modifié. Communiquez-le à la personne : ses autres sessions sont fermées.')
    }
    onDone?.()
    onClose()
  }
  return (
    <FormModal key={mode} title={`Mot de passe : ${name}`} fields={mode === 'link' ? [] : NEW_PASSWORD_FIELD} onSubmit={submit} onClose={onClose} submitLabel={mode === 'link' ? 'Envoyer le lien' : 'Réinitialiser'}>
      {notice && <Alert tone="warn">{notice}</Alert>}
      {allowLink && email && (
        <Field label="Méthode">
          <Select value={mode} onChange={(e) => setMode(e.target.value)} options={[{ value: 'link', label: `Envoyer un lien par e-mail à ${email} (recommandé)` }, { value: 'password', label: 'Fixer moi-même un nouveau mot de passe' }]} />
        </Field>
      )}
      {mode === 'link' && <p className="muted small" style={{ margin: 0 }}>La personne choisit elle-même son nouveau mot de passe. L'actuel reste valable jusque-là.</p>}
    </FormModal>
  )
}

/** Période d'une liste : deux jours inclus, dans le fuseau de l'utilisateur. */
export function PeriodFilter({ from, to, onChange }) {
  return (
    <>
      <label className="period"><span className="muted small">Du</span><Input type="date" aria-label="Du" max={to || undefined} value={from} onChange={(e) => onChange(e.target.value, to)} /></label>
      <label className="period"><span className="muted small">Au</span><Input type="date" aria-label="Au" min={from || undefined} value={to} onChange={(e) => onChange(from, e.target.value)} /></label>
    </>
  )
}

export const BackLink = ({ to, label }) => <Link className="back" to={to}><ChevronLeft size={15} aria-hidden />{label}</Link>

/**
 * Page de liste standard : recherche, filtre d'état, pagination, création et modification.
 * Toutes les pages de référentiel partagent ce comportement.
 */
export function CrudPage({ title, sub, endpoint, columns, fields, createPerm, editPerm, singular = 'élément', editable = true, statusOptions, rowLink, searchable = true, transformCreate, headerActions, filters, unpaged, emptyText, createdMessage }) {
  const { can } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [modal, setModal] = useState(null)
  const debounced = useDebounced(q)
  useEffect(() => setPage(1), [debounced, status])
  const path = useMemo(() => `${endpoint}${query({ q: debounced, status, page, limit: 25, ...(filters ?? {}) })}`, [endpoint, debounced, status, page, filters])
  const { items, meta, loading, error, reload } = useList(path)
  const canCreate = fields && (!createPerm || can(createPerm))
  const canEdit = editable && fields && (!editPerm || can(editPerm))

  const save = async (values) => {
    const result = modal === 'new' ? await api.post(endpoint, transformCreate ? transformCreate(values) : values) : await api.patch(`${endpoint}/${modal.id}`, values)
    const custom = modal === 'new' && createdMessage ? createdMessage(result) : null
    toast(custom?.[0] ?? (modal === 'new' ? `${singular} créé(e).` : 'Modifications enregistrées.'), custom?.[1])
    setModal(null)
    reload()
  }

  return (
    <>
      <PageHead title={title} sub={sub} actions={<>{headerActions}{canCreate && <Button variant="primary" icon={Plus} onClick={() => setModal('new')}>Ajouter</Button>}</>} />
      <Card>
        {(searchable || statusOptions) && (
          <div className="toolbar">
            {searchable && <SearchInput value={q} onChange={setQ} />}
            {statusOptions && <Select style={{ width: 200 }} value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Tous les états" options={statusOptions} />}
          </div>
        )}
        <DataTable
          columns={columns} rows={items} loading={loading} error={error}
          onRowClick={rowLink ? (r) => navigate(rowLink(r)) : canEdit ? (r) => setModal(r) : undefined}
          empty={<Empty title={`Aucun ${singular}`}>{emptyText ?? (canCreate ? 'Ajoutez le premier avec le bouton « Ajouter ».' : null)}</Empty>}
        />
        {!unpaged && <Pagination meta={meta} onPage={setPage} />}
      </Card>
      {modal && (
        <FormModal
          title={modal === 'new' ? `Nouveau : ${singular}` : `Modifier : ${singular}`}
          fields={fields} row={modal === 'new' ? null : modal} onSubmit={save} onClose={() => setModal(null)}
          wide={fields.length > 8}
        />
      )}
    </>
  )
}
