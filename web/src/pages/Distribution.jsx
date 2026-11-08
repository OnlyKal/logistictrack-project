import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Battery, Compass, ExternalLink, FileDown, Gauge, GripVertical, Link2, MapPin, Plus, QrCode, RotateCcw, Satellite, Truck, Undo2, UserCheck, ArrowDown, ArrowUp } from 'lucide-react'
import { api, query } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useDebounced, useFetch, useList } from '../lib/hooks.js'
import { useLive } from '../lib/socket.js'
import { DELIVERY_STATUS, DRIVER_STATUS, FAILURE_REASONS, PACKAGE_STATUS, PACKAGING, PRIORITY, PROOF_TYPES, ROUTE_STATUS, VEHICLE_STATUS, VEHICLE_TYPES, accuracyLabel, ago, date, dayEnd, dayStart, dateTime, num, options, qty } from '../lib/format.js'
import { BackLink, CrudPage, FormModal, PeriodFilter, ResetPasswordModal, useOptions } from '../components/CrudPage.jsx'
import { DeliveryPointSelect } from '../components/DeliveryPointSelect.jsx'
import { LineItems, namedOption, newLine, productOption } from '../components/LineItems.jsx'
import { RouteMap, TripMap } from '../components/TripMap.jsx'
import { Alert, Badge, Button, Card, Confirm, DataTable, Empty, ErrorBox, Field, Input, Modal, PageHead, Pagination, SearchInput, Select, Status, Textarea, useAction, useToast } from '../components/ui.jsx'

const driverOption = (d) => ({ value: d.id, label: `${d.fullName} (${d.code})` })
const vehicleOption = (v) => ({ value: v.id, label: `${v.registration} — ${VEHICLE_TYPES[v.type]}` })

function QrModal({ pack, onClose }) {
  const { data, error } = useQrData(pack.id)
  return (
    <Modal title={`Colis ${pack.trackingNumber}`} onClose={onClose}>
      <ErrorBox error={error} />
      {data && (
        <div className="stack" style={{ alignItems: 'center' }}>
          <img src={data.dataUrl} width="220" height="220" alt={`QR Code du colis ${pack.trackingNumber}`} />
          <div className="mono strong">{data.trackingNumber}</div>
          <p className="muted small" style={{ textAlign: 'center' }}>Le QR Code ne contient qu'un jeton opaque. Le numéro de suivi permet au destinataire de suivre son colis.</p>
          <Button onClick={() => window.print()}>Imprimer</Button>
        </div>
      )}
    </Modal>
  )
}
function useQrData(id) {
  const [state, setState] = useState({})
  useEffect(() => {
    api.post(`/packages/${id}/generate-qr`).then((data) => setState({ data })).catch((error) => setState({ error }))
  }, [id])
  return state
}

export function Packages() {
  const { can } = useAuth()
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [qr, setQr] = useState(null)
  const [create, setCreate] = useState(false)
  const debounced = useDebounced(q)
  const { items, meta, loading, error, reload } = useList(`/packages${query({ q: debounced, page })}`)
  return (
    <>
      <PageHead title="Colis" sub="Chaque unité logistique possède son identité de suivi." actions={can('package.manage') && <Button variant="primary" icon={Plus} onClick={() => setCreate(true)}>Colis sans commande</Button>} />
      <Card>
        <div className="toolbar"><SearchInput value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Numéro de suivi" /></div>
        <DataTable loading={loading} error={error} rows={items} columns={[
          { label: 'Suivi', render: (p) => <span className="mono strong">{p.trackingNumber}</span> }, { label: 'Unité', render: (p) => PACKAGING[p.unitType] },
          { label: 'Contenu', render: (p) => p.items.map((i) => `${i.product.name} : ${qty(i.quantity, i.product.baseUnit)}`).join(' · ') },
          { label: 'Commande', render: (p) => p.order?.number ?? '—' }, { label: 'Livraison', render: (p) => (p.delivery ? <Link to={`/livraisons/${p.delivery.id}`}>{p.delivery.number}</Link> : '—') },
          { label: 'État', render: (p) => <Status map={PACKAGE_STATUS} value={p.status} /> }, { label: '', render: (p) => <Button variant="ghost" icon={QrCode} aria-label="QR Code" title="QR Code" onClick={() => setQr(p)} /> },
        ]} empty={<Empty title="Aucun colis" />} />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
      {qr && <QrModal pack={qr} onClose={() => setQr(null)} />}
      {create && <FreePackageModal onClose={() => setCreate(false)} onDone={() => { setCreate(false); reload() }} />}
    </>
  )
}

function FreePackageModal({ onClose, onDone }) {
  const warehouses = useOptions('/warehouses?limit=200', namedOption)
  const products = useOptions('/products?limit=200', productOption)
  const [warehouseId, setWarehouseId] = useState('')
  const [unitType, setUnitType] = useState('CARTON')
  const [lines, setLines] = useState([newLine()])
  const [error, setError] = useState(null)
  const submit = async (e) => {
    e.preventDefault()
    try {
      await api.post('/packages', { warehouseId, unitType, items: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })) })
      onDone()
    } catch (err) { setError(err) }
  }
  return (
    <form onSubmit={submit}>
      <Modal wide title="Colis sans commande" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary">Créer</Button></>}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Entrepôt *"><Select required value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} placeholder="Sélectionner" options={warehouses} /></Field>
          <Field label="Unité logistique"><Select value={unitType} onChange={(e) => setUnitType(e.target.value)} options={options(PACKAGING)} /></Field>
        </div>
        <LineItems products={products} lines={lines} setLines={setLines} />
      </Modal>
    </form>
  )
}

const deliveryOrigin = (d) => <>{d.deliveryPoint.name}<div className="muted small">{[d.deliveryPoint.commune, d.deliveryPoint.city].filter(Boolean).join(', ')}</div></>

export function Deliveries() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const [status, setStatus] = useState('')
  const [driverId, setDriverId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [create, setCreate] = useState(false)
  const debounced = useDebounced(q)
  const seesDrivers = can('driver.view', 'delivery.assign')
  const drivers = useOptions(seesDrivers ? '/drivers?limit=200' : null, driverOption)
  const { items, meta, loading, error, reload } = useList(`/deliveries${query({ q: debounced, status, driverId, from: dayStart(from), to: dayEnd(to), page })}`)
  useLive('delivery.status', reload)
  const filtered = status || driverId || from || to
  const reset = () => { setStatus(''); setDriverId(''); setFrom(''); setTo(''); setPage(1) }
  return (
    <>
      <PageHead title="Livraisons" sub="De la préparation à la preuve de livraison." actions={can('delivery.create') && <Button variant="primary" icon={Plus} onClick={() => setCreate(true)}>Livraison sans commande</Button>} />
      <Card>
        <div className="toolbar toolbar-wrap">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Numéro ou client" />
          <Select style={{ width: 190 }} aria-label="État" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} placeholder="Tous les états" options={Object.entries(DELIVERY_STATUS).map(([value, [label]]) => ({ value, label }))} />
          {seesDrivers && <Select style={{ width: 220 }} aria-label="Chauffeur" value={driverId} onChange={(e) => { setDriverId(e.target.value); setPage(1) }} placeholder="Tous les chauffeurs" options={drivers} />}
          <PeriodFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); setPage(1) }} />
          {filtered && <Button variant="ghost" onClick={reset}>Effacer les filtres</Button>}
        </div>
        <DataTable loading={loading} error={error} rows={items} onRowClick={(d) => navigate(`/livraisons/${d.id}`)} columns={[
          { label: 'Numéro', render: (d) => <span className="strong">{d.number}</span> }, { label: 'Client', render: (d) => d.customer.name }, { label: 'Destination', render: deliveryOrigin },
          { label: 'Chauffeur', render: (d) => (d.driver ? (can('driver.view') ? <Link to={`/chauffeurs/${d.driverId}`} onClick={(e) => e.stopPropagation()}>{d.driver.fullName}</Link> : d.driver.fullName) : '—') }, { label: 'Véhicule', render: (d) => d.vehicle?.registration ?? '—' }, { label: 'Colis', num: true, render: (d) => d._count.packages },
          { label: 'Prévue', render: (d) => dateTime(d.scheduledAt) }, { label: 'État', render: (d) => <Status map={DELIVERY_STATUS} value={d.status} /> },
        ]} empty={<Empty icon={Truck} title="Aucune livraison">{filtered ? 'Aucune livraison ne correspond à ces filtres.' : 'Les livraisons se créent depuis une commande prête.'}</Empty>} />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
      {create && <FreeDeliveryModal onClose={() => setCreate(false)} onDone={(d) => navigate(`/livraisons/${d.id}`)} />}
    </>
  )
}

function FreeDeliveryModal({ onClose, onDone }) {
  const customers = useOptions('/customers?limit=200', namedOption)
  const packages = useOptions('/packages?limit=200&unassigned=true', (p) => ({ value: p.id, label: `${p.trackingNumber} — ${p.items.map((i) => i.product.name).join(', ')}`, orderId: p.orderId }))
  const [v, setV] = useState({ customerId: '', deliveryPointId: '', packageId: '', scheduledAt: '', justification: '' })
  const [error, setError] = useState(null)
  const [key] = useState(() => api.newKey())
  const submit = async (e) => {
    e.preventDefault()
    try {
      onDone(await api.post('/deliveries', { customerId: v.customerId, deliveryPointId: v.deliveryPointId, packageIds: [v.packageId], scheduledAt: v.scheduledAt ? new Date(v.scheduledAt).toISOString() : undefined, justification: v.justification }, key))
    } catch (err) { setError(err) }
  }
  return (
    <form onSubmit={submit}>
      <Modal title="Livraison sans commande" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary">Créer</Button></>}>
        <ErrorBox error={error} />
        <Field label="Colis *" hint={!packages.length ? "Créez d'abord un colis sans commande." : undefined}><Select required value={v.packageId} onChange={(e) => setV({ ...v, packageId: e.target.value })} placeholder="Sélectionner" options={packages.filter((p) => !p.orderId)} /></Field>
        <div className="form-grid">
          <Field label="Client *"><Select required value={v.customerId} onChange={(e) => setV({ ...v, customerId: e.target.value, deliveryPointId: '' })} placeholder="Sélectionner" options={customers} /></Field>
          <DeliveryPointSelect customerId={v.customerId} value={v.deliveryPointId} onChange={(deliveryPointId) => setV((current) => ({ ...current, deliveryPointId }))} />
        </div>
        <Field label="Date prévue"><Input type="datetime-local" value={v.scheduledAt} onChange={(e) => setV({ ...v, scheduledAt: e.target.value })} /></Field>
        <Field label="Justification *" hint="Obligatoire pour une livraison sans commande commerciale."><Textarea required value={v.justification} onChange={(e) => setV({ ...v, justification: e.target.value })} /></Field>
      </Modal>
    </form>
  )
}

function AssignModal({ delivery, onClose, onDone, reschedule }) {
  const toast = useToast()
  const drivers = useOptions('/drivers?limit=200', driverOption)
  const vehicles = useOptions('/vehicles?limit=200', vehicleOption)
  const [v, setV] = useState({ driverId: delivery.driver?.id ?? '', vehicleId: delivery.vehicle?.id ?? '', scheduledAt: '', note: '' })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [key] = useState(() => api.newKey())
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (reschedule) await api.post(`/deliveries/${delivery.id}/reschedule`, { driverId: v.driverId, vehicleId: v.vehicleId, scheduledAt: new Date(v.scheduledAt).toISOString(), note: v.note || undefined })
      else await api.post(`/deliveries/${delivery.id}/assign`, { driverId: v.driverId, vehicleId: v.vehicleId }, key)
      toast(reschedule ? 'Livraison reprogrammée.' : 'Affectation enregistrée.')
      onDone()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal title={reschedule ? 'Reprogrammer la livraison' : 'Affecter un chauffeur et un véhicule'} onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" loading={busy}>Confirmer</Button></>}>
        <ErrorBox error={error} />
        <p className="muted small">Le système contrôle le permis, la capacité en poids et en volume, la compatibilité du chargement et les documents du véhicule.</p>
        <Field label="Chauffeur *"><Select required value={v.driverId} onChange={(e) => setV({ ...v, driverId: e.target.value })} placeholder="Sélectionner" options={drivers} /></Field>
        <Field label="Véhicule *"><Select required value={v.vehicleId} onChange={(e) => setV({ ...v, vehicleId: e.target.value })} placeholder="Sélectionner" options={vehicles} /></Field>
        {reschedule && <Field label="Nouvelle date *"><Input required type="datetime-local" value={v.scheduledAt} onChange={(e) => setV({ ...v, scheduledAt: e.target.value })} /></Field>}
        {reschedule && <Field label="Note"><Textarea value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>}
      </Modal>
    </form>
  )
}

const CONFIRMABLE = ['ARRIVED']

/** Le bureau arrête une mission en cours : motif obligatoire, chauffeur prévenu, suivi arrêté. */
function RecallModal({ delivery: d, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const { run, busy } = useAction()
  const submit = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post(`/deliveries/${d.id}/recall`, { reason }), 'Chauffeur rappelé : il est prévenu sur son téléphone.')
    if (r.ok) onDone()
  }
  return (
    <form onSubmit={submit}>
      <Modal title={`Rappeler ${d.driver?.fullName ?? 'le chauffeur'}`} onClose={onClose} footer={<><Button onClick={onClose}>Garder la mission</Button><Button type="submit" variant="danger" loading={busy}>Rappeler le chauffeur</Button></>}>
        <div className="stack">
          <Alert tone="warn">La livraison {d.number} s'arrête. Le chauffeur est prévenu sur son téléphone et son suivi GPS s'arrête. Ensuite, enregistrez le retour de la marchandise ou reprogrammez la livraison. Pensez aussi à l'appeler{d.driver?.phone ? ` (${d.driver.phone})` : ''} : sans réseau, il ne verra l'information qu'à sa reconnexion.</Alert>
          <Field label="Motif *" hint="Visible par le chauffeur et dans l'historique."><Textarea required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. : le client annule la commande" /></Field>
        </div>
      </Modal>
    </form>
  )
}

export function DeliveryDetail() {
  const { id } = useParams()
  const { can } = useAuth()
  const { data: d, error, reload } = useFetch(`/deliveries/${id}`)
  const track = useFetch(can('tracking.view') ? `/tracking/deliveries/${id}` : null)
  const [modal, setModal] = useState(null)
  const [qr, setQr] = useState(null)
  const { run, busy } = useAction()
  useLive('delivery.status', (p) => { if (p.id === id) { reload(); track.reload() } })
  if (error) return <ErrorBox error={error} />
  if (!d) return null
  const s = d.status
  const act = async (action, message, body) => {
    await run(() => api.post(`/deliveries/${id}/${action}`, body), message)
    reload()
  }
  const download = (type) => run(() => api.download(`/deliveries/${id}/documents/${type}`, `${type}-${d.number}.pdf`))
  const openProof = async (proof) => {
    const r = await run(() => api.get(`/proofs/${proof.id}/download`))
    if (r.ok) window.open(api.fileUrl(r.result.url), '_blank', 'noopener')
  }
  const issueStock = can('delivery.resolve')
  return (
    <>
      <PageHead back={<BackLink to="/livraisons" label="Livraisons" />} title={d.number} sub={`${d.customer.name} · ${d.deliveryPoint.name}`} actions={<>
        <Status map={DELIVERY_STATUS} value={s} />
        {['DRAFT', 'PENDING'].includes(s) && can('delivery.validate') && <Button variant="primary" loading={busy} onClick={() => act('validate', 'Livraison validée.')}>Valider</Button>}
        {['VALIDATED', 'PREPARING', 'READY', 'ASSIGNED'].includes(s) && can('delivery.assign') && <Button variant={s === 'ASSIGNED' ? undefined : 'primary'} icon={UserCheck} onClick={() => setModal('assign')}>{s === 'ASSIGNED' ? 'Changer' : 'Affecter'}</Button>}
        {s === 'ASSIGNED' && can('delivery.load') && <Button variant="primary" loading={busy} onClick={() => act('load', 'Chargement confirmé, stock sorti.', {})}>Confirmer le chargement</Button>}
        {s === 'LOADED' && can('delivery.resolve') && <Button icon={Undo2} onClick={() => setModal('return')}>Retour</Button>}
        {s === 'FAILED' && issueStock && <><Button variant="primary" icon={RotateCcw} onClick={() => setModal('reschedule')}>Reprogrammer</Button><Button icon={Undo2} onClick={() => setModal('return')}>Enregistrer le retour</Button></>}
        {s === 'PARTIALLY_DELIVERED' && issueStock && !d.stockReturned && <Button variant="primary" icon={Undo2} onClick={() => setModal('return')}>Retour des quantités refusées</Button>}
        {['IN_TRANSIT', 'ARRIVED'].includes(s) && can('delivery.resolve') && <Button variant="danger" icon={Undo2} onClick={() => setModal('recall')}>Rappeler le chauffeur</Button>}
        {!['DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED', 'DRAFT'].includes(s) && <Button icon={Link2} disabled={busy} onClick={() => run(async () => {
          const { url } = await api.get(`/deliveries/${d.id}/tracking-link`)
          await navigator.clipboard.writeText(url)
        }, 'Lien de suivi copié : envoyez-le au client (SMS, WhatsApp). La carte en direct s’active au départ du chauffeur.')}>Lien de suivi client</Button>}
        {/* Marchandise sortie et pas encore revenue : l'annulation attend l'enregistrement du retour. */}
        {(['DRAFT', 'PENDING', 'VALIDATED', 'PREPARING', 'READY', 'ASSIGNED'].includes(s) || (s === 'FAILED' && !(d.stockIssued && !d.stockReturned))) && can('delivery.cancel') && <Button variant="danger" onClick={() => setModal('cancel')}>Annuler</Button>}
      </>} />
      {s === 'FAILED' && <div style={{ marginBottom: 16 }}><Alert>{d.failureReason === 'RECALLED' ? 'Chauffeur rappelé par l\'entreprise' : 'Échec de livraison'} : {FAILURE_REASONS[d.failureReason] ?? d.failureReason}{d.failureComment ? ` — ${d.failureComment}` : ''}. Tentative n° {d.attempts}.</Alert></div>}
      {d.driverResponse === 'REFUSED' && <div style={{ marginBottom: 16 }}><Alert tone="warn">Le chauffeur précédent a refusé cette mission : affectez-en un autre.</Alert></div>}
      <div className="grid grid-side">
        <div className="stack">
          <Card title="Marchandises">
            <DataTable rows={d.items} columns={[
              { label: 'Marchandise', render: (i) => i.product.name }, { label: 'Prévu', num: true, render: (i) => qty(i.quantity, i.product.baseUnit) }, { label: 'Remis', num: true, render: (i) => num(i.quantityDelivered) },
              { label: 'Refusé', num: true, render: (i) => num(i.quantityRefused) }, { label: 'Manquant', num: true, render: (i) => num(i.quantityMissing) }, { label: 'Retourné', num: true, render: (i) => num(i.quantityReturned) },
              { label: 'Motif', render: (i) => i.discrepancyReason ?? '—' },
            ]} />
          </Card>
          <Card title="Colis">
            <DataTable rows={d.packages} columns={[
              { label: 'Suivi', render: (p) => <span className="mono strong">{p.trackingNumber}</span> }, { label: 'Unité', render: (p) => PACKAGING[p.unitType] }, { label: 'Poids', num: true, render: (p) => (p.weightKg ? `${num(p.weightKg)} kg` : '—') },
              { label: 'Scan de chargement', render: (p) => (p.loadScannedAt ? dateTime(p.loadScannedAt) : '—') }, { label: 'État', render: (p) => <Status map={PACKAGE_STATUS} value={p.status} /> },
              { label: '', render: (p) => <Button variant="ghost" icon={QrCode} aria-label="QR Code" title="QR Code" onClick={() => setQr(p)} /> },
            ]} />
          </Card>
          <Card title="Itinéraire réel et destination" pad>
            <TripMap delivery={d} positions={track.data?.positions} onReload={track.reload} />
          </Card>
          <Card title="Preuves de livraison">
            <DataTable rows={d.proofs} columns={[
              { label: 'Type', render: (p) => PROOF_TYPES[p.type] ?? p.type }, { label: 'Valeur', render: (p) => p.value ?? (p.latitude != null ? `${p.latitude}, ${p.longitude}` : '—') },
              { label: 'Capturée', render: (p) => dateTime(p.capturedAt) }, { label: 'Reçue', render: (p) => dateTime(p.receivedAt) },
              { label: '', render: (p) => p.fileId && <Button variant="ghost" icon={ExternalLink} aria-label="Ouvrir" title="Ouvrir" onClick={() => openProof(p)} /> },
            ]} empty={<Empty title="Aucune preuve">{CONFIRMABLE.includes(s) ? 'Le chauffeur les collecte à la remise.' : 'Elles seront collectées à la remise.'}</Empty>} />
          </Card>
        </div>
        <div className="stack">
          <Card title="Détails" pad>
            <dl className="kv">
              <dt>Client</dt><dd><Link to={`/clients/${d.customer.id}`}>{d.customer.name}</Link></dd>
              <dt>Adresse</dt><dd>{[d.deliveryPoint.address, d.deliveryPoint.commune, d.deliveryPoint.city].filter(Boolean).join(', ')}</dd>
              <dt>Contact</dt><dd>{[d.deliveryPoint.contactName, d.deliveryPoint.phone].filter(Boolean).join(' / ') || '—'}</dd>
              <dt>Entrepôt</dt><dd>{d.warehouse.name}</dd>
              <dt>Commande</dt><dd>{d.order ? <Link to={`/commandes/${d.order.id}`}>{d.order.number}</Link> : <span title={d.justification}>Sans commande</span>}</dd>
              <dt>Chauffeur</dt><dd>{d.driver?.fullName ?? '—'}{d.driverResponse === 'ACCEPTED' && <span className="muted small"> · a accepté</span>}</dd>
              <dt>Véhicule</dt><dd>{d.vehicle?.registration ?? '—'}</dd>
              <dt>Prévue</dt><dd>{dateTime(d.scheduledAt)}</dd>
              <dt>Priorité</dt><dd>{PRIORITY[d.priority]}</dd>
              {d.recipientName && <><dt>Réceptionnaire</dt><dd>{d.recipientName}</dd></>}
              {d.deliveredAt && <><dt>Livrée le</dt><dd>{dateTime(d.deliveredAt)}</dd></>}
              {d.instructions && <><dt>Instructions</dt><dd>{d.instructions}</dd></>}
            </dl>
          </Card>
          <Card title="Documents" pad>
            <div className="stack" style={{ gap: 8 }}>
              <Button icon={FileDown} onClick={() => download('delivery-note')}>Bon de livraison</Button>
              {['DELIVERED', 'PARTIALLY_DELIVERED'].includes(s) && <Button icon={FileDown} onClick={() => download('receipt')}>Accusé de réception</Button>}
              {s === 'PARTIALLY_DELIVERED' && <Button icon={FileDown} onClick={() => download('partial')}>Rapport de livraison partielle</Button>}
              {d.history.some((h) => h.status === 'FAILED') && <Button icon={FileDown} onClick={() => download('failure')}>Rapport d'échec</Button>}
              {d.stockReturned && <Button icon={FileDown} onClick={() => download('return')}>Rapport de retour</Button>}
            </div>
          </Card>
          {d.incidents.length > 0 && (
            <Card title="Incidents" pad>
              <ol className="timeline">{d.incidents.map((i) => <li key={i.id}><div className="strong">{i.type}</div><div className="muted small">{dateTime(i.reportedAt)}{i.description ? ` · ${i.description}` : ''}</div></li>)}</ol>
            </Card>
          )}
          <Card title="Historique" pad>
            <ol className="timeline">{d.events.map((ev) => (
              <li key={ev.id}>
                <div className="strong">{ev.label}</div>
                <div className="muted small">{dateTime(ev.occurredAt)}{ev.note ? ` · ${ev.note}` : ''}</div>
              </li>
            ))}</ol>
          </Card>
        </div>
      </div>
      {qr && <QrModal pack={qr} onClose={() => setQr(null)} />}
      {modal === 'assign' && <AssignModal delivery={d} onClose={() => setModal(null)} onDone={() => { setModal(null); reload() }} />}
      {modal === 'reschedule' && <AssignModal reschedule delivery={d} onClose={() => setModal(null)} onDone={() => { setModal(null); reload() }} />}
      {modal === 'return' && <FormModal title="Retour de marchandise" submitLabel="Enregistrer le retour" onClose={() => setModal(null)} fields={[
        { name: 'condition', label: 'État constaté', type: 'select', required: true, default: 'GOOD', options: options({ GOOD: 'Bon : réintégré au stock disponible', DAMAGED: 'Endommagé : stock non disponible', QUARANTINE: 'À contrôler : stock bloqué' }) },
        { name: 'note', label: 'Note', type: 'textarea', wide: true },
      ]} onSubmit={async (v) => { await api.post(`/deliveries/${id}/return`, v); setModal(null); reload() }} />}
      {modal === 'recall' && <RecallModal delivery={d} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); track.reload() }} />}
      {modal === 'cancel' && <Confirm danger title="Annuler la livraison" message="Les colis redeviendront disponibles pour une autre livraison." confirmLabel="Annuler la livraison" busy={busy} onClose={() => setModal(null)} onConfirm={async () => { await act('cancel', 'Livraison annulée.', {}); setModal(null) }} />}
    </>
  )
}

export function RoutesPage() {
  const navigate = useNavigate()
  const { items, loading, error, reload } = useList('/routes?limit=100')
  const [create, setCreate] = useState(false)
  return (
    <>
      <PageHead title="Tournées" sub="Plusieurs livraisons, un chauffeur, un véhicule, un ordre de passage." actions={<Button variant="primary" icon={Plus} onClick={() => setCreate(true)}>Nouvelle tournée</Button>} />
      <Card>
        <DataTable loading={loading} error={error} rows={items} onRowClick={(r) => navigate(`/tournees/${r.id}`)} columns={[
          { label: 'Numéro', render: (r) => <span className="strong">{r.number}</span> }, { label: 'Date', render: (r) => dateTime(r.plannedAt) }, { label: 'Chauffeur', render: (r) => r.driver?.fullName ?? '—' }, { label: 'Véhicule', render: (r) => r.vehicle?.registration ?? '—' },
          { label: 'Arrêts', num: true, render: (r) => r.stops.length }, { label: 'État', render: (r) => <Status map={ROUTE_STATUS} value={r.status} /> },
        ]} empty={<Empty icon={Truck} title="Aucune tournée" />} />
      </Card>
      {create && <RouteModal onClose={() => setCreate(false)} onDone={() => { setCreate(false); reload() }} />}
    </>
  )
}

function RouteModal({ onClose, onDone }) {
  const warehouses = useOptions('/warehouses?limit=200', namedOption)
  const drivers = useOptions('/drivers?limit=200', driverOption)
  const vehicles = useOptions('/vehicles?limit=200', vehicleOption)
  const deliveries = useOptions('/deliveries?limit=200&status=VALIDATED,READY,PREPARING', (d) => ({ value: d.id, label: `${d.number} — ${d.customer.name} (${d.deliveryPoint.commune ?? d.deliveryPoint.name})` }))
  const [v, setV] = useState({ plannedAt: '', warehouseId: '', driverId: '', vehicleId: '' })
  const [selected, setSelected] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/routes', { ...v, plannedAt: new Date(v.plannedAt).toISOString(), deliveryIds: selected })
      onDone()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal wide title="Nouvelle tournée" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" loading={busy} disabled={!selected.length}>Créer</Button></>}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Date *"><Input required type="datetime-local" value={v.plannedAt} onChange={(e) => setV({ ...v, plannedAt: e.target.value })} /></Field>
          <Field label="Entrepôt de départ *"><Select required value={v.warehouseId} onChange={(e) => setV({ ...v, warehouseId: e.target.value })} placeholder="Sélectionner" options={warehouses} /></Field>
          <Field label="Chauffeur *"><Select required value={v.driverId} onChange={(e) => setV({ ...v, driverId: e.target.value })} placeholder="Sélectionner" options={drivers} /></Field>
          <Field label="Véhicule *"><Select required value={v.vehicleId} onChange={(e) => setV({ ...v, vehicleId: e.target.value })} placeholder="Sélectionner" options={vehicles} /></Field>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="field-label">Livraisons, dans l'ordre de passage</span>
          {deliveries.length === 0 && <span className="muted small">Aucune livraison validée n'attend d'affectation.</span>}
          {deliveries.map((o) => (
            <label key={o.value} className="checkbox">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={(e) => setSelected(e.target.checked ? [...selected, o.value] : selected.filter((x) => x !== o.value))} />
              <span>{selected.includes(o.value) && <strong>{selected.indexOf(o.value) + 1}. </strong>}{o.label}</span>
            </label>
          ))}
        </div>
      </Modal>
    </form>
  )
}

export function RouteDetail() {
  const { id } = useParams()
  const { data: r, error, reload } = useFetch(`/routes/${id}`)
  const track = useFetch(`/tracking/routes/${id}`)
  const { run, busy } = useAction()
  useLive('delivery.status', reload)
  if (error) return <ErrorBox error={error} />
  if (!r) return null
  const move = async (index, delta) => {
    const ids = r.stops.map((s) => s.deliveryId)
    const [x] = ids.splice(index, 1)
    ids.splice(index + delta, 0, x)
    await run(() => api.put(`/routes/${id}/stops`, { deliveryIds: ids }))
    reload()
  }
  const act = async (a, m) => {
    await run(() => api.post(`/routes/${id}/${a}`), m)
    reload()
  }
  const editable = ['PLANNED', 'IN_PROGRESS'].includes(r.status)
  return (
    <>
      <PageHead back={<BackLink to="/tournees" label="Tournées" />} title={r.number} sub={`${r.driver?.fullName ?? ''} · ${r.vehicle?.registration ?? ''} · départ ${r.warehouse.name}`} actions={<>
        <Status map={ROUTE_STATUS} value={r.status} />
        {r.status === 'PLANNED' && <Button variant="primary" loading={busy} onClick={() => act('start', 'Tournée démarrée.')}>Démarrer</Button>}
        {r.status === 'IN_PROGRESS' && <Button variant="primary" loading={busy} onClick={() => act('finish', 'Tournée clôturée.')}>Clôturer</Button>}
      </>} />
      <div className="grid grid-2">
        <Card title="Ordre de passage">
          <DataTable rows={r.stops} columns={[
            { label: '', render: (s) => <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><GripVertical size={14} aria-hidden />{s.position}</span> },
            { label: 'Livraison', render: (s) => <Link to={`/livraisons/${s.delivery.id}`}>{s.delivery.number}</Link> }, { label: 'Client', render: (s) => s.delivery.customer.name }, { label: 'Lieu', render: (s) => s.delivery.deliveryPoint.commune ?? s.delivery.deliveryPoint.name },
            { label: 'État', render: (s) => <Status map={DELIVERY_STATUS} value={s.delivery.status} /> },
            { label: '', render: (s) => { const i = r.stops.indexOf(s); return editable && <div className="actions"><Button variant="ghost" icon={ArrowUp} disabled={i === 0 || busy} onClick={() => move(i, -1)} aria-label="Monter" /><Button variant="ghost" icon={ArrowDown} disabled={i === r.stops.length - 1 || busy} onClick={() => move(i, 1)} aria-label="Descendre" /></div> } },
          ]} />
        </Card>
        <Card title="Carte de la tournée" pad><RouteMap route={r} positions={track.data?.positions} onReload={track.reload} /></Card>
      </div>
    </>
  )
}

/** Suivi en direct : uniquement ce que le téléphone du chauffeur transmet. */
const TRAIL_MAX_ACCURACY_M = 100
const hasCoords = (place) => place?.latitude != null && place?.longitude != null

const driverFields = [
  { name: 'fullName', label: 'Nom complet', required: true }, { name: 'phone', label: 'Téléphone', required: true, hint: 'Identifiant de connexion mobile.', type: 'tel' },
  { name: 'email', label: 'E-mail', type: 'email', createOnly: true }, { name: 'password', label: 'Mot de passe initial', type: 'password', required: true, createOnly: true, minLength: 8 },
  { name: 'address', label: 'Adresse' }, { name: 'idDocument', label: "Pièce d'identité" }, { name: 'licenseNumber', label: 'Numéro de permis' }, { name: 'licenseClasses', label: 'Catégories de permis' },
  { name: 'licenseExpiry', label: 'Expiration du permis', type: 'date', hint: "Obligatoire pour recevoir une mission." },
  { name: 'warehouseId', label: 'Entrepôt de rattachement', type: 'select', optionsFrom: '/warehouses?limit=200', toOption: namedOption, placeholder: 'Aucun' },
  { name: 'status', label: 'Statut', type: 'select', options: options({ available: 'Disponible', on_mission: 'En mission', off_duty: 'Hors service', inactive: 'Inactif', suspended: 'Suspendu' }), default: 'available', hint: "Inactif ou suspendu : le chauffeur ne peut plus se connecter." },
]

export const Drivers = () => (
  <CrudPage title="Chauffeurs" sub="Chaque chauffeur dispose d'un compte mobile dédié." endpoint="/drivers" singular="chauffeur" fields={driverFields} createPerm="driver.manage" editPerm="driver.manage"
    statusOptions={Object.entries(DRIVER_STATUS).map(([value, [label]]) => ({ value, label }))} rowLink={(r) => `/chauffeurs/${r.id}`}
    columns={[
      { label: 'Code', render: (r) => <span className="mono">{r.code}</span> }, { label: 'Nom', render: (r) => <span className="strong">{r.fullName}</span> }, { label: 'Téléphone', key: 'phone' },
      { label: 'Permis', render: (r) => <LicenseInfo driver={r} /> },
      { label: 'Rattachement', render: (r) => r.warehouse?.name ?? '—' }, { label: 'Statut', render: (r) => <Status map={DRIVER_STATUS} value={r.status} /> },
    ]} />
)

function LicenseInfo({ driver: r }) {
  const expired = r.licenseExpiry && new Date(r.licenseExpiry) < new Date()
  return <>{r.licenseNumber ?? '—'}{r.licenseExpiry && <div className={`small ${expired ? '' : 'muted'}`} style={expired ? { color: 'var(--red-text)' } : undefined}>Expire le {date(r.licenseExpiry)}</div>}</>
}

/** Toutes les missions d'un chauffeur : chaque ligne ouvre la livraison, ses preuves et son trajet. */
function DriverHistory({ driverId }) {
  const navigate = useNavigate()
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const { items, meta, loading, error, reload } = useList(`/deliveries${query({ driverId, status, from: dayStart(from), to: dayEnd(to), page })}`)
  useLive('delivery.status', (p) => { if (p.driverId === driverId) reload() })
  const filtered = status || from || to
  return (
    <Card title={`Historique des missions${meta.total !== undefined ? ` (${num(meta.total)})` : ''}`}>
      <div className="toolbar toolbar-wrap">
        <Select style={{ width: 190 }} aria-label="État" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} placeholder="Tous les états" options={Object.entries(DELIVERY_STATUS).map(([value, [label]]) => ({ value, label }))} />
        <PeriodFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); setPage(1) }} />
        {filtered && <Button variant="ghost" onClick={() => { setStatus(''); setFrom(''); setTo(''); setPage(1) }}>Effacer les filtres</Button>}
      </div>
      <DataTable loading={loading} error={error} rows={items} onRowClick={(d) => navigate(`/livraisons/${d.id}`)} columns={[
        { label: 'Numéro', render: (d) => <span className="strong">{d.number}</span> }, { label: 'Client', render: (d) => d.customer.name }, { label: 'Destination', render: deliveryOrigin },
        { label: 'Véhicule', render: (d) => d.vehicle?.registration ?? '—' }, { label: 'Prévue', render: (d) => dateTime(d.scheduledAt) }, { label: 'État', render: (d) => <Status map={DELIVERY_STATUS} value={d.status} /> },
      ]} empty={<Empty icon={Truck} title="Aucune mission">{filtered ? 'Aucune mission ne correspond à ces filtres.' : "Ce chauffeur n'a pas encore reçu de mission."}</Empty>} />
      <Pagination meta={meta} onPage={setPage} />
    </Card>
  )
}

export function DriverDetail() {
  const { id } = useParams()
  const { can } = useAuth()
  const toast = useToast()
  const { data: d, error, reload } = useFetch(`/drivers/${id}`)
  const [modal, setModal] = useState(null)
  if (error) return <ErrorBox error={error} />
  if (!d) return null
  const save = async (values) => {
    await api.patch(`/drivers/${id}`, values)
    toast('Modifications enregistrées.')
    setModal(null)
    reload()
  }
  return (
    <>
      <PageHead back={<BackLink to="/chauffeurs" label="Chauffeurs" />} title={d.fullName} sub={`${d.code} · ${d.phone}`} actions={<>
        <Status map={DRIVER_STATUS} value={d.status} />
        {can('driver.manage') && <Button onClick={() => setModal('password')}>Mot de passe</Button>}
        {can('driver.manage') && <Button variant="primary" onClick={() => setModal('edit')}>Modifier</Button>}
      </>} />
      <div className="stack">
        <Card title="Fiche" pad>
          <dl className="kv">
            <dt>Permis</dt><dd><LicenseInfo driver={d} />{d.licenseClasses && <div className="muted small">Catégories : {d.licenseClasses}</div>}</dd>
            <dt>Rattachement</dt><dd>{d.warehouse?.name ?? '—'}</dd>
            <dt>Adresse</dt><dd>{d.address ?? '—'}</dd>
            <dt>Pièce d'identité</dt><dd>{d.idDocument ?? '—'}</dd>
          </dl>
        </Card>
        {can('delivery.view') && <DriverHistory driverId={id} />}
      </div>
      {modal === 'edit' && <FormModal title="Modifier : chauffeur" fields={driverFields} row={d} onSubmit={save} onClose={() => setModal(null)} wide />}
      {modal === 'password' && <ResetPasswordModal endpoint={`/drivers/${id}/reset-password`} name={d.fullName} onClose={() => setModal(null)} />}
    </>
  )
}

const vehicleFields = [
  { name: 'registration', label: 'Immatriculation', required: true }, { name: 'type', label: 'Type', type: 'select', required: true, options: options(VEHICLE_TYPES) }, { name: 'brand', label: 'Marque' }, { name: 'model', label: 'Modèle' },
  { name: 'weightCapacityKg', label: 'Capacité en poids (kg)', type: 'number' }, { name: 'volumeCapacityM3', label: 'Capacité en volume (m³)', type: 'number' }, { name: 'insuranceExpiry', label: 'Assurance valable jusqu\'au', type: 'date' }, { name: 'inspectionExpiry', label: 'Contrôle technique valable jusqu\'au', type: 'date' },
  { name: 'status', label: 'Statut', type: 'select', default: 'available', options: options({ available: 'Disponible', in_use: 'En service', maintenance: 'En maintenance', inactive: 'Inactif' }) },
]

export const Vehicles = () => (
  <CrudPage title="Véhicules" sub="Capacités et documents contrôlés à chaque affectation." endpoint="/vehicles" singular="véhicule" fields={vehicleFields} createPerm="vehicle.manage" editPerm="vehicle.manage"
    statusOptions={Object.entries(VEHICLE_STATUS).map(([value, [label]]) => ({ value, label }))}
    columns={[
      { label: 'Immatriculation', render: (r) => <span className="mono strong">{r.registration}</span> }, { label: 'Type', render: (r) => VEHICLE_TYPES[r.type] }, { label: 'Modèle', render: (r) => [r.brand, r.model].filter(Boolean).join(' ') || '—' },
      { label: 'Poids', num: true, render: (r) => (r.weightCapacityKg ? `${num(r.weightCapacityKg)} kg` : '—') }, { label: 'Volume', num: true, render: (r) => (r.volumeCapacityM3 ? `${num(r.volumeCapacityM3)} m³` : '—') },
      { label: 'Assurance', render: (r) => date(r.insuranceExpiry) }, { label: 'Contrôle', render: (r) => date(r.inspectionExpiry) }, { label: 'Statut', render: (r) => <Status map={VEHICLE_STATUS} value={r.status} /> },
    ]} />
)
