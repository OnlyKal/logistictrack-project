/**
 * Expéditions (messagerie) : un expéditeur dépose un colis au guichet, l'entreprise l'achemine
 * d'entrepôt en entrepôt (escales possibles) jusqu'à la destination, où le destinataire le retire.
 * Indépendant des commandes, des livraisons et du stock.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, Ban, FileDown, HandHelping, Link2, MapPin, PackageCheck, Plus, Route, ScanLine, Send, Undo2, X } from 'lucide-react'
import { api, query } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useDebounced, useFetch, useList } from '../lib/hooks.js'
import { useLive } from '../lib/socket.js'
import { SHIPMENT_STATUS, dateTime, dayEnd, dayStart, num, options } from '../lib/format.js'
import { BackLink, PeriodFilter, useOptions } from '../components/CrudPage.jsx'
import { Alert, Button, Card, Checkbox, Confirm, DataTable, Empty, ErrorBox, Field, Input, Modal, PageHead, Pagination, SearchInput, Select, Status, Textarea, useAction, useToast } from '../components/ui.jsx'

const place = (w) => (w ? (w.agency ? `${w.name} (${w.agency.name})` : w.name) : '—')
const placeOption = (w) => ({ value: w.id, label: place(w) })
/** Où est le colis : dans un entrepôt, ou en route vers le prochain. */
const whereIs = (s) => (s.status === 'IN_TRANSIT' ? `En route vers ${s.nextWarehouse?.name ?? '—'}` : s.currentWarehouse ? place(s.currentWarehouse) : '—')
const AT_WAREHOUSE = ['REGISTERED', 'AT_WAREHOUSE', 'AVAILABLE']

/** Escales prévues, dans l'ordre : ajouter, déplacer, retirer. */
function StopsEditor({ value, onChange, places, exclude = [] }) {
  const [adding, setAdding] = useState('')
  const label = (id) => places.find((p) => p.value === id)?.label ?? '…'
  const move = (i, d) => { const next = [...value]; [next[i], next[i + d]] = [next[i + d], next[i]]; onChange(next) }
  const choices = places.filter((p) => !value.includes(p.value) && !exclude.includes(p.value))
  return (
    <div className="stack" style={{ gap: 6 }}>
      {value.length === 0 && <span className="muted small">Aucune escale : le colis va directement à destination.</span>}
      {value.map((id, i) => (
        <div key={id} className="toolbar" style={{ margin: 0 }}>
          <span className="strong">{i + 1}.</span><span style={{ flex: 1 }}>{label(id)}</span>
          <Button type="button" variant="ghost" icon={ArrowUp} aria-label="Monter" disabled={i === 0} onClick={() => move(i, -1)} />
          <Button type="button" variant="ghost" icon={ArrowDown} aria-label="Descendre" disabled={i === value.length - 1} onClick={() => move(i, 1)} />
          <Button type="button" variant="ghost" icon={X} aria-label="Retirer" onClick={() => onChange(value.filter((x) => x !== id))} />
        </div>
      ))}
      <div className="toolbar" style={{ margin: 0 }}>
        <Select style={{ flex: 1 }} aria-label="Ajouter une escale" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Ajouter une escale…" options={choices} />
        <Button type="button" icon={Plus} disabled={!adding} onClick={() => { onChange([...value, adding]); setAdding('') }}>Ajouter</Button>
      </div>
    </div>
  )
}

export function Shipments() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const manage = can('shipment.manage')
  const mine = useOptions('/warehouses?limit=200', placeOption)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [view, setView] = useState('all')
  const [warehouseId, setWarehouseId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState([])
  const [modal, setModal] = useState(null)
  const debounced = useDebounced(q)
  useEffect(() => { if (!warehouseId && mine.length === 1) setWarehouseId(mine[0].value) }, [mine, warehouseId])
  const filters = { q: debounced, status, from: dayStart(from), to: dayEnd(to), page, ...(view === 'here' && warehouseId ? { at: warehouseId } : {}), ...(view === 'incoming' && warehouseId ? { incoming: warehouseId } : {}) }
  const { items, meta, loading, error, reload } = useList(`/shipments${query(filters)}`)
  useLive('shipment.changed', reload)
  useEffect(() => setSelected([]), [view, warehouseId, page, status, debounced])
  const selectable = manage && ((view === 'here' && warehouseId) || (view === 'incoming' && warehouseId))
  const toggle = (id, on) => setSelected(on ? [...selected, id] : selected.filter((x) => x !== id))
  const done = () => { setModal(null); setSelected([]); reload() }
  const counter = (
    <div className="toolbar toolbar-wrap">
      <Select style={{ width: 230 }} aria-label="Guichet" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setPage(1) }} placeholder="Mon entrepôt (guichet)" options={mine} />
      <div className="actions">
        {[['all', 'Toutes'], ['here', 'Présents ici'], ['incoming', 'En route vers ici']].map(([key, label]) => (
          <Button key={key} variant={view === key ? 'primary' : undefined} disabled={key !== 'all' && !warehouseId} onClick={() => { setView(key); setPage(1) }}>{label}</Button>
        ))}
      </div>
      {selectable && view === 'here' && <Button variant="primary" icon={Send} disabled={!selected.length} onClick={() => setModal('dispatch')}>Faire partir ({selected.length})</Button>}
      {selectable && view === 'incoming' && <Button variant="primary" icon={PackageCheck} disabled={!selected.length} onClick={() => setModal('receive')}>Réceptionner ({selected.length})</Button>}
      {manage && warehouseId && <Button icon={ScanLine} onClick={() => setModal('scan')}>Réception par scan</Button>}
    </div>
  )
  return (
    <>
      <PageHead title="Expéditions" sub="Colis déposés au guichet, acheminés d'entrepôt en entrepôt jusqu'au retrait par le destinataire." actions={manage && <Button variant="primary" icon={Plus} onClick={() => setModal('deposit')}>Nouveau dépôt</Button>} />
      <Card>
        {counter}
        <div className="toolbar toolbar-wrap">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="N°, nom ou téléphone" />
          <Select style={{ width: 200 }} aria-label="État" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} placeholder="Tous les états" options={Object.entries(SHIPMENT_STATUS).map(([value, [label]]) => ({ value, label }))} />
          <PeriodFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); setPage(1) }} />
        </div>
        <DataTable loading={loading} error={error} rows={items} onRowClick={(s) => navigate(`/expeditions/${s.id}`)} columns={[
          ...(selectable ? [{ label: '', render: (s) => <input type="checkbox" aria-label={`Sélectionner ${s.number}`} checked={selected.includes(s.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => toggle(s.id, e.target.checked)} /> }] : []),
          { label: 'Suivi', render: (s) => <><span className="mono strong">{s.trackingNumber}</span><div className="muted small">{s.number}</div></> },
          { label: 'Expéditeur', render: (s) => <>{s.senderName}<div className="muted small">{s.senderPhone}</div></> },
          { label: 'Destinataire', render: (s) => <>{s.recipientName}<div className="muted small">{s.recipientPhone}</div></> },
          { label: 'Trajet', render: (s) => <>{s.originWarehouse.name} → {s.destinationWarehouse.name}</> },
          { label: 'Position', render: whereIs },
          { label: 'Colis', num: true, render: (s) => s.parcels },
          { label: 'Déposé', render: (s) => dateTime(s.createdAt) },
          { label: 'État', render: (s) => <Status map={SHIPMENT_STATUS} value={s.status} /> },
        ]} empty={<Empty icon={Send} title="Aucune expédition">{view === 'incoming' ? 'Aucun colis en route vers cet entrepôt.' : 'Les colis déposés au guichet apparaissent ici.'}</Empty>} />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
      {modal === 'deposit' && <DepositModal origins={mine} defaultOrigin={warehouseId} onClose={() => setModal(null)} onDone={(s) => navigate(`/expeditions/${s.id}`)} />}
      {modal === 'dispatch' && <DispatchModal ids={selected} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'receive' && <ReceiveModal ids={selected} warehouseId={warehouseId} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'scan' && <ScanModal warehouseId={warehouseId} warehouseLabel={mine.find((w) => w.value === warehouseId)?.label} onClose={() => { setModal(null); reload() }} />}
    </>
  )
}

function DepositModal({ origins, defaultOrigin, onClose, onDone }) {
  const destinations = useOptions('/shipments/destinations', placeOption)
  const [v, setV] = useState({
    senderName: '', senderPhone: '', senderEmail: '', recipientName: '', recipientPhone: '', recipientEmail: '', description: '', parcels: 1,
    weightKg: '', declaredValue: '', fee: '', paymentMode: 'SENDER', originWarehouseId: defaultOrigin || '', destinationWarehouseId: '', instructions: '',
  })
  const [stops, setStops] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [key] = useState(() => api.newKey())
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const numbers = Object.fromEntries(['weightKg', 'declaredValue', 'fee'].map((k) => [k, v[k] === '' ? undefined : Number(v[k])]))
    try {
      const s = await api.post('/shipments', { ...v, ...numbers, parcels: Number(v.parcels) || 1, stops: stops.filter((x) => x !== v.originWarehouseId && x !== v.destinationWarehouseId) }, key)
      await api.download(`/shipments/${s.id}/receipt`, `expedition-${s.number}.pdf`).catch(() => undefined)
      onDone(s)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal wide title="Nouveau dépôt de colis" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" loading={busy}>Enregistrer et imprimer le reçu</Button></>}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Entrepôt de dépôt *"><Select required value={v.originWarehouseId} onChange={set('originWarehouseId')} placeholder="Sélectionner" options={origins} /></Field>
          <Field label="Entrepôt de retrait *" hint="Où le destinataire viendra chercher le colis."><Select required value={v.destinationWarehouseId} onChange={set('destinationWarehouseId')} placeholder="Sélectionner" options={destinations} /></Field>
        </div>
        <Field label="Escales prévues" hint="Entrepôts par lesquels le colis passera, dans l'ordre. Le client les voit dès le dépôt ; un arrêt imprévu reste possible.">
          <StopsEditor value={stops} onChange={setStops} places={destinations} exclude={[v.originWarehouseId, v.destinationWarehouseId]} />
        </Field>
        <span className="field-label">Expéditeur</span>
        <div className="form-grid">
          <Field label="Nom *"><Input required minLength={2} value={v.senderName} onChange={set('senderName')} /></Field>
          <Field label="Téléphone *"><Input required type="tel" value={v.senderPhone} onChange={set('senderPhone')} /></Field>
          <Field label="E-mail" hint="Pour recevoir chaque étape du suivi."><Input type="email" value={v.senderEmail} onChange={set('senderEmail')} /></Field>
        </div>
        <span className="field-label">Destinataire</span>
        <div className="form-grid">
          <Field label="Nom *"><Input required minLength={2} value={v.recipientName} onChange={set('recipientName')} /></Field>
          <Field label="Téléphone *"><Input required type="tel" value={v.recipientPhone} onChange={set('recipientPhone')} /></Field>
          <Field label="E-mail" hint="Pour être prévenu de l'arrivée."><Input type="email" value={v.recipientEmail} onChange={set('recipientEmail')} /></Field>
        </div>
        <span className="field-label">Colis</span>
        <div className="form-grid">
          <Field label="Contenu *"><Input required minLength={2} value={v.description} onChange={set('description')} placeholder="Ex. : carton de vêtements" /></Field>
          <Field label="Nombre de colis"><Input type="number" min="1" value={v.parcels} onChange={set('parcels')} /></Field>
          <Field label="Poids (kg)"><Input type="number" step="any" min="0" value={v.weightKg} onChange={set('weightKg')} /></Field>
          <Field label="Valeur déclarée"><Input type="number" step="any" min="0" value={v.declaredValue} onChange={set('declaredValue')} /></Field>
          <Field label="Frais d'envoi"><Input type="number" step="any" min="0" value={v.fee} onChange={set('fee')} /></Field>
          <Field label="Paiement des frais"><Select value={v.paymentMode} onChange={set('paymentMode')} options={options({ SENDER: 'Payés au dépôt', RECIPIENT: 'À payer par le destinataire au retrait' })} /></Field>
        </div>
        <Field label="Instructions"><Textarea value={v.instructions} onChange={set('instructions')} /></Field>
      </Modal>
    </form>
  )
}

function DispatchModal({ ids, onClose, onDone }) {
  const destinations = useOptions('/shipments/destinations', placeOption)
  const [v, setV] = useState({ toWarehouseId: '', transportInfo: '', note: '' })
  const { run, busy } = useAction()
  const [key] = useState(() => api.newKey())
  const submit = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post('/shipments/dispatch', { shipmentIds: ids, toWarehouseId: v.toWarehouseId || undefined, transportInfo: v.transportInfo, note: v.note }, key), `${ids.length} colis en route.`)
    if (r.ok) onDone()
  }
  return (
    <form onSubmit={submit}>
      <Modal title={`Faire partir ${ids.length} colis`} onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" icon={Send} loading={busy}>Confirmer le départ</Button></>}>
        <div className="stack">
          <Field label="Vers" hint="Par défaut, chaque colis part vers sa prochaine escale prévue, ou sa destination. Choisissez un entrepôt pour un arrêt imprévu.">
            <Select value={v.toWarehouseId} onChange={(e) => setV({ ...v, toWarehouseId: e.target.value })} options={[{ value: '', label: 'Prochaine étape prévue de chaque colis' }, ...destinations]} />
          </Field>
          <Field label="Transport" hint="Camion, bateau, avion, transporteur… (interne, non visible par les clients)"><Input value={v.transportInfo} onChange={(e) => setV({ ...v, transportInfo: e.target.value })} /></Field>
          <Field label="Note"><Textarea value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
        </div>
      </Modal>
    </form>
  )
}

function ReceiveModal({ ids, warehouseId, onClose, onDone }) {
  const { run, busy } = useAction()
  const [key] = useState(() => api.newKey())
  return (
    <Confirm title={`Réceptionner ${ids.length} colis`} message="Les colis arrivés à leur destination deviennent disponibles au retrait, et leurs destinataires sont prévenus. Les autres sont enregistrés en escale." confirmLabel="Réceptionner" busy={busy} onClose={onClose}
      onConfirm={async () => { const r = await run(() => api.post('/shipments/receive', { warehouseId, shipmentIds: ids }, key), 'Arrivée enregistrée.'); if (r.ok) onDone() }} />
  )
}

/** Réception rapide : la douchette (ou la saisie) envoie un numéro de suivi, validé aussitôt. */
function ScanModal({ warehouseId, warehouseLabel, onClose }) {
  const [code, setCode] = useState('')
  const [log, setLog] = useState([])
  const [busy, setBusy] = useState(false)
  const input = useRef(null)
  const submit = async (e) => {
    e.preventDefault()
    const number = code.trim().toUpperCase()
    if (!number) return
    setBusy(true)
    try {
      await api.post('/shipments/receive', { warehouseId, trackingNumbers: [number] }, api.newKey())
      setLog((l) => [{ number, ok: true }, ...l])
    } catch (err) {
      setLog((l) => [{ number, ok: false, message: err.message }, ...l])
    } finally {
      setCode('')
      setBusy(false)
      input.current?.focus()
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal title={`Réception à ${warehouseLabel ?? 'cet entrepôt'}`} onClose={onClose} footer={<Button onClick={onClose}>Terminer</Button>}>
        <div className="stack">
          <Field label="Numéro de suivi" hint="Scannez le code du reçu ou saisissez le numéro, puis Entrée."><Input ref={input} autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="EX…" disabled={busy} /></Field>
          {log.map((l, i) => <Alert key={i} tone={l.ok ? 'info' : 'error'}>{l.number} : {l.ok ? 'réceptionné' : l.message}</Alert>)}
        </div>
      </Modal>
    </form>
  )
}

function HandoverModal({ shipment: s, toSender, onClose, onDone }) {
  const feeDue = !toSender && s.paymentMode === 'RECIPIENT' && Number(s.fee) > 0 && !s.feePaidAt
  const [v, setV] = useState({ name: toSender ? s.senderName : s.recipientName, phone: toSender ? s.senderPhone : s.recipientPhone, idDocument: '', note: '', feeCollected: false })
  const [file, setFile] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.upload(`/shipments/${s.id}/handover`, file, { ...v, feeCollected: String(v.feeCollected), toSender: String(!!toSender) })
      toast(toSender ? "Colis rendu à l'expéditeur." : 'Colis remis au destinataire.')
      onDone()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal title={toSender ? "Rendre le colis à l'expéditeur" : 'Remettre le colis au destinataire'} onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" loading={busy} disabled={feeDue && !v.feeCollected}>Confirmer la remise</Button></>}>
        <ErrorBox error={error} />
        <p className="muted small">Vérifiez le numéro de suivi et la pièce d'identité. Attendu : <strong>{toSender ? s.senderName : s.recipientName}</strong>. Si une autre personne retire le colis, indiquez son nom.</p>
        <div className="form-grid">
          <Field label="Nom de la personne *"><Input required minLength={2} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
          <Field label="Téléphone"><Input type="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></Field>
          <Field label="Pièce d'identité"><Input value={v.idDocument} onChange={(e) => setV({ ...v, idDocument: e.target.value })} placeholder="Type et numéro" /></Field>
          <Field label="Signature (photo ou scan)"><Input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        </div>
        {feeDue && <Checkbox checked={v.feeCollected} onChange={(e) => setV({ ...v, feeCollected: e.target.checked })} label={`Frais d'envoi encaissés : ${num(s.fee)}`} hint="Obligatoire avant la remise." />}
        <Field label="Note"><Textarea value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
      </Modal>
    </form>
  )
}

/** Escales restant à faire ; celles déjà faites restent dans l'historique. */
function StopsModal({ shipment: s, onClose, onDone }) {
  const places = useOptions('/shipments/destinations', placeOption)
  const travelling = s.status === 'IN_TRANSIT' ? s.nextWarehouse?.id : null
  const [stops, setStops] = useState(() => s.stops.filter((x) => !x.arrivedAt && !x.skipped && x.warehouseId !== travelling).map((x) => x.warehouseId))
  const [note, setNote] = useState('')
  const { run, busy } = useAction()
  const submit = async (e) => {
    e.preventDefault()
    const r = await run(() => api.put(`/shipments/${s.id}/stops`, { stops, note: note || undefined }), 'Itinéraire enregistré.')
    if (r.ok) onDone()
  }
  return (
    <form onSubmit={submit}>
      <Modal title="Modifier l'itinéraire" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" loading={busy}>Enregistrer</Button></>}>
        <div className="stack">
          <p className="muted small">Escales restant à faire avant {place(s.destinationWarehouse)}{travelling ? `, après ${s.nextWarehouse.name} vers laquelle le colis roule déjà` : ''}.</p>
          <StopsEditor value={stops} onChange={setStops} places={places} exclude={[s.destinationWarehouse.id, s.currentWarehouse?.id, travelling].filter(Boolean)} />
          <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
      </Modal>
    </form>
  )
}

function RedirectModal({ shipment: s, onClose, onDone }) {
  const destinations = useOptions('/shipments/destinations', placeOption)
  const [v, setV] = useState({ destinationWarehouseId: '', note: '' })
  const { run, busy } = useAction()
  const submit = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post(`/shipments/${s.id}/redirect`, v), 'Destination modifiée.')
    if (r.ok) onDone()
  }
  return (
    <form onSubmit={submit}>
      <Modal title="Changer l'entrepôt de retrait" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" loading={busy}>Enregistrer</Button></>}>
        <div className="stack">
          <p className="muted small">Le destinataire veut retirer son colis ailleurs. S'il n'y est pas déjà, faites-le partir vers ce nouvel entrepôt.</p>
          <Field label="Nouvel entrepôt de retrait *"><Select required value={v.destinationWarehouseId} onChange={(e) => setV({ ...v, destinationWarehouseId: e.target.value })} placeholder="Sélectionner" options={destinations.filter((w) => w.value !== s.destinationWarehouse.id)} /></Field>
          <Field label="Note"><Textarea value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
        </div>
      </Modal>
    </form>
  )
}

export function ShipmentDetail() {
  const { id } = useParams()
  const { can } = useAuth()
  const { data: s, error, reload } = useFetch(`/shipments/${id}`)
  const [modal, setModal] = useState(null)
  const { run, busy } = useAction()
  const toast = useToast()
  useLive('shipment.changed', (p) => { if (p.ids?.includes(id)) reload() })
  const visibleEvents = useMemo(() => s?.events ?? [], [s])
  if (error) return <ErrorBox error={error} />
  if (!s) return null
  const manage = can('shipment.manage')
  const st = s.status
  const done = () => { setModal(null); reload() }
  const copyLink = async () => {
    await navigator.clipboard.writeText(s.trackingUrl)
    toast('Lien de suivi copié : envoyez-le à l’expéditeur et au destinataire (SMS, WhatsApp).')
  }
  return (
    <>
      <PageHead back={<BackLink to="/expeditions" label="Expéditions" />} title={s.trackingNumber} sub={`${s.number} · ${s.originWarehouse.name} → ${s.destinationWarehouse.name}`} actions={<>
        <Status map={SHIPMENT_STATUS} value={st} />
        {manage && st === 'AVAILABLE' && <Button variant="primary" icon={HandHelping} onClick={() => setModal('handover')}>Remettre au destinataire</Button>}
        {manage && AT_WAREHOUSE.includes(st) && s.currentWarehouse?.id !== s.destinationWarehouse.id && <Button variant="primary" icon={Send} onClick={() => setModal('dispatch')}>Faire partir</Button>}
        {manage && st === 'IN_TRANSIT' && s.nextWarehouse && <Button variant="primary" icon={PackageCheck} loading={busy} onClick={async () => { await run(() => api.post('/shipments/receive', { warehouseId: s.nextWarehouse.id, shipmentIds: [s.id] }, api.newKey()), 'Arrivée enregistrée.'); reload() }}>Réceptionner à {s.nextWarehouse.name}</Button>}
        {manage && !['DELIVERED', 'RETURNED', 'CANCELLED'].includes(st) && <Button icon={MapPin} onClick={() => setModal('redirect')}>Changer la destination</Button>}
        {manage && AT_WAREHOUSE.includes(st) && st !== 'REGISTERED' && <Button icon={Undo2} onClick={() => setModal('return')}>Rendre à l'expéditeur</Button>}
        <Button icon={FileDown} onClick={() => run(() => api.download(`/shipments/${s.id}/receipt`, `expedition-${s.number}.pdf`))}>Reçu</Button>
        <Button icon={Link2} onClick={copyLink}>Lien de suivi</Button>
        {manage && st === 'REGISTERED' && s.currentWarehouse?.id === s.originWarehouse.id && <Button variant="danger" icon={Ban} onClick={() => setModal('cancel')}>Annuler</Button>}
      </>} />
      {st === 'AVAILABLE' && s.paymentMode === 'RECIPIENT' && Number(s.fee) > 0 && !s.feePaidAt && <div style={{ marginBottom: 16 }}><Alert tone="warn">Frais d'envoi à encaisser au retrait : {num(s.fee)}.</Alert></div>}
      <div className="grid grid-side">
        <div className="stack">
          <Card title="Itinéraire" pad actions={manage && !['DELIVERED', 'RETURNED', 'CANCELLED', 'AVAILABLE'].includes(st) && <Button variant="ghost" icon={Route} onClick={() => setModal('stops')}>Modifier</Button>}>
            <ol className="timeline">
              <li><div className="strong">{place(s.originWarehouse)}</div><div className="muted small">Dépôt · {dateTime(s.createdAt)}</div></li>
              {s.stops.map((x) => (
                <li key={x.id} style={x.skipped ? { opacity: 0.55 } : undefined}>
                  <div className="strong">{x.skipped ? <s>{place(x.warehouse)}</s> : place(x.warehouse)}</div>
                  <div className="muted small">{x.skipped ? 'Escale sautée' : x.departedAt ? `Escale faite · arrivé ${dateTime(x.arrivedAt)} · reparti ${dateTime(x.departedAt)}` : x.arrivedAt ? `Arrivé ${dateTime(x.arrivedAt)} · en escale` : st === 'IN_TRANSIT' && s.nextWarehouse?.id === x.warehouseId ? 'En route vers cette escale' : 'Escale prévue'}</div>
                </li>
              ))}
              <li><div className="strong">{place(s.destinationWarehouse)}</div><div className="muted small">Retrait{st === 'AVAILABLE' ? ' · le colis y est' : st === 'DELIVERED' ? ` · retiré ${dateTime(s.pickedUpAt)}` : ''}</div></li>
            </ol>
          </Card>
          <Card title="Parcours" pad>
            <ol className="timeline">{visibleEvents.map((ev) => (
              <li key={ev.id}>
                <div className="strong">{ev.label}</div>
                <div className="muted small">{dateTime(ev.occurredAt)}{ev.note ? ` · ${ev.note}` : ''}{!ev.isPublic ? ' · interne' : ''}</div>
              </li>
            ))}</ol>
          </Card>
        </div>
        <div className="stack">
          <Card title="Détails" pad>
            <dl className="kv">
              <dt>Position</dt><dd>{whereIs(s)}</dd>
              <dt>Expéditeur</dt><dd>{s.senderName}<div className="muted small">{[s.senderPhone, s.senderEmail].filter(Boolean).join(' · ')}</div></dd>
              <dt>Destinataire</dt><dd>{s.recipientName}<div className="muted small">{[s.recipientPhone, s.recipientEmail].filter(Boolean).join(' · ')}</div></dd>
              <dt>Dépôt</dt><dd>{place(s.originWarehouse)}</dd>
              <dt>Retrait</dt><dd>{place(s.destinationWarehouse)}{s.destinationWarehouse.address && <div className="muted small">{s.destinationWarehouse.address}</div>}</dd>
              <dt>Contenu</dt><dd>{s.description} · {s.parcels} colis{s.weightKg ? ` · ${num(s.weightKg)} kg` : ''}</dd>
              {s.declaredValue && <><dt>Valeur déclarée</dt><dd>{num(s.declaredValue)}</dd></>}
              <dt>Frais</dt><dd>{Number(s.fee) > 0 ? `${num(s.fee)} · ${s.feePaidAt ? `payés le ${dateTime(s.feePaidAt)}` : 'à payer au retrait'}` : '—'}</dd>
              {s.transportInfo && <><dt>Dernier transport</dt><dd>{s.transportInfo}</dd></>}
              {s.instructions && <><dt>Instructions</dt><dd>{s.instructions}</dd></>}
              {s.pickedUpAt && <><dt>{st === 'RETURNED' ? 'Rendu à' : 'Retiré par'}</dt><dd>{s.pickedUpBy}<div className="muted small">{[dateTime(s.pickedUpAt), s.pickedUpPhone, s.pickedUpIdDocument].filter(Boolean).join(' · ')}</div></dd></>}
              {s.signatureFileId && <><dt>Signature</dt><dd><Button variant="ghost" onClick={async () => { const r = await run(() => api.get(`/shipments/${s.id}/signature`)); if (r.ok) window.open(api.fileUrl(r.result.url), '_blank', 'noopener') }}>Ouvrir</Button></dd></>}
            </dl>
          </Card>
        </div>
      </div>
      {modal === 'handover' && <HandoverModal shipment={s} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'return' && <HandoverModal toSender shipment={s} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'dispatch' && <DispatchModal ids={[s.id]} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'stops' && <StopsModal shipment={s} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'redirect' && <RedirectModal shipment={s} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'cancel' && <Confirm danger title="Annuler l'expédition" message="Le colis n'est pas encore parti. Rendez-le à l'expéditeur au guichet." confirmLabel="Annuler l'expédition" busy={busy} onClose={() => setModal(null)} onConfirm={async () => { await run(() => api.post(`/shipments/${s.id}/cancel`, {}), 'Expédition annulée.'); done() }} />}
    </>
  )
}
