import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PackagePlus, Plus, Truck } from 'lucide-react'
import { api, query } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useDebounced, useFetch, useList } from '../lib/hooks.js'
import { DELIVERY_STATUS, ORDER_STATUS, PACKAGE_STATUS, PACKAGING, PRIORITY, dateTime, date, money, num, options, qty } from '../lib/format.js'
import { BackLink, useOptions } from '../components/CrudPage.jsx'
import { DeliveryPointSelect } from '../components/DeliveryPointSelect.jsx'
import { LineItems, namedOption, newLine, productOption } from '../components/LineItems.jsx'
import { Button, Card, Confirm, DataTable, Empty, ErrorBox, Field, Input, Modal, PageHead, Pagination, SearchInput, Select, Status, Textarea, useAction, useToast } from '../components/ui.jsx'

export function Orders() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [create, setCreate] = useState(false)
  const debounced = useDebounced(q)
  const { items, meta, loading, error, reload } = useList(`/orders${query({ q: debounced, status, page })}`)
  return (
    <>
      <PageHead title="Commandes" sub="Commande, validation, préparation, expédition." actions={can('order.create') && <Button variant="primary" icon={Plus} onClick={() => setCreate(true)}>Nouvelle commande</Button>} />
      <Card>
        <div className="toolbar">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Numéro ou client" />
          <Select style={{ width: 220 }} aria-label="État" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} placeholder="Tous les états" options={Object.entries(ORDER_STATUS).map(([value, [label]]) => ({ value, label }))} />
        </div>
        <DataTable loading={loading} error={error} rows={items} onRowClick={(o) => navigate(`/commandes/${o.id}`)} columns={[
          { label: 'Numéro', render: (o) => <span className="strong">{o.number}</span> }, { label: 'Client', render: (o) => o.customer.name }, { label: 'Point de livraison', render: (o) => o.deliveryPoint.name },
          { label: 'Entrepôt', render: (o) => o.warehouse.name }, { label: 'Lignes', num: true, render: (o) => o.items.length }, { label: 'Total', num: true, render: (o) => money(o.total) },
          { label: 'État', render: (o) => <Status map={ORDER_STATUS} value={o.status} /> }, { label: 'Date', render: (o) => date(o.createdAt) },
        ]} empty={<Empty title="Aucune commande" />} />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
      {create && <OrderModal onClose={() => setCreate(false)} onDone={(o) => { setCreate(false); reload(); navigate(`/commandes/${o.id}`) }} />}
    </>
  )
}

function OrderModal({ onClose, onDone }) {
  const customers = useOptions('/customers?limit=200', namedOption)
  const warehouses = useOptions('/warehouses?limit=200', namedOption)
  const products = useOptions('/products?limit=200', productOption)
  const [v, setV] = useState({ customerId: '', deliveryPointId: '', warehouseId: '', requestedDate: '', instructions: '' })
  const [lines, setLines] = useState([newLine()])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [key] = useState(() => api.newKey())
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const order = await api.post('/orders', {
        customerId: v.customerId, deliveryPointId: v.deliveryPointId, warehouseId: v.warehouseId, requestedDate: v.requestedDate ? new Date(v.requestedDate).toISOString() : undefined, instructions: v.instructions || undefined,
        items: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice || 0), discount: Number(l.discount || 0), taxRate: Number(l.taxRate || 0) })),
      }, key)
      onDone(order)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal wide title="Nouvelle commande" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" loading={busy}>Créer le brouillon</Button></>}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Client *"><Select required value={v.customerId} onChange={(e) => setV({ ...v, customerId: e.target.value, deliveryPointId: '' })} placeholder="Sélectionner" options={customers} /></Field>
          <DeliveryPointSelect customerId={v.customerId} value={v.deliveryPointId} onChange={(deliveryPointId) => setV((current) => ({ ...current, deliveryPointId }))} />
          <Field label="Entrepôt de préparation *"><Select required value={v.warehouseId} onChange={(e) => setV({ ...v, warehouseId: e.target.value })} placeholder="Sélectionner" options={warehouses} /></Field>
          <Field label="Date souhaitée"><Input type="date" value={v.requestedDate} onChange={(e) => setV({ ...v, requestedDate: e.target.value })} /></Field>
        </div>
        <LineItems products={products} lines={lines} setLines={setLines} extra={[
          { name: 'unitPrice', label: 'Prix unitaire', type: 'number', width: '100px' }, { name: 'discount', label: 'Remise', type: 'number', width: '80px' }, { name: 'taxRate', label: 'Taxe %', type: 'number', width: '70px' },
        ]} />
        <Field label="Instructions"><Textarea value={v.instructions} onChange={(e) => setV({ ...v, instructions: e.target.value })} /></Field>
      </Modal>
    </form>
  )
}

export function OrderDetail() {
  const { id } = useParams()
  const { can } = useAuth()
  const navigate = useNavigate()
  const { data: o, error, reload } = useFetch(`/orders/${id}`)
  const [modal, setModal] = useState(null)
  const { run, busy } = useAction()
  if (error) return <ErrorBox error={error} />
  if (!o) return null
  const act = async (path, msg, body) => {
    await run(() => api.post(`/orders/${id}/${path}`, body), msg)
    reload()
  }
  const preparable = ['VALIDATED', 'PREPARING', 'PARTIALLY_PREPARED'].includes(o.status) && can('order.prepare')
  const free = o.packages.filter((p) => !p.deliveryId)
  const packagable = o.items.some((i) => i.quantityPrepared > i.quantityPackaged) && can('package.manage')
  return (
    <>
      <PageHead back={<BackLink to="/commandes" label="Commandes" />} title={o.number} sub={`${o.customer.name} · ${o.deliveryPoint.name}`} actions={<>
        <Status map={ORDER_STATUS} value={o.status} />
        {o.status === 'DRAFT' && can('order.create') && <Button variant="primary" loading={busy} onClick={() => act('submit', 'Commande soumise.')}>Soumettre</Button>}
        {['SUBMITTED', 'VALIDATING'].includes(o.status) && can('order.validate') && <Button variant="primary" loading={busy} onClick={() => act('validate', 'Commande validée, stock réservé.')}>Valider et réserver</Button>}
        {preparable && <Button variant="primary" onClick={() => setModal('prepare')}>Enregistrer la préparation</Button>}
        {packagable && <Button icon={PackagePlus} onClick={() => setModal('package')}>Créer un colis</Button>}
        {free.length > 0 && can('delivery.create') && <Button variant="primary" icon={Truck} onClick={() => setModal('delivery')}>Créer la livraison</Button>}
        {!['CLOSED', 'CANCELLED', 'SHIPPED', 'PARTIALLY_SHIPPED'].includes(o.status) && can('order.validate') && <Button variant="danger" onClick={() => setModal('cancel')}>Annuler</Button>}
      </>} />
      <div className="grid grid-side">
        <div className="stack">
          <Card title="Lignes">
            <DataTable rows={o.items} columns={[
              { label: 'Marchandise', render: (i) => i.product.name }, { label: 'Commandé', num: true, render: (i) => qty(i.quantity, i.product.baseUnit) }, { label: 'Préparé', num: true, render: (i) => num(i.quantityPrepared) },
              { label: 'En colis', num: true, render: (i) => num(i.quantityPackaged) }, { label: 'Expédié', num: true, render: (i) => num(i.quantityShipped) }, { label: 'Livré', num: true, render: (i) => num(i.quantityDelivered) },
              { label: 'Prix', num: true, render: (i) => money(i.unitPrice) },
            ]} />
          </Card>
          <Card title="Colis">
            <DataTable rows={o.packages} columns={[
              { label: 'Suivi', render: (p) => <span className="mono">{p.trackingNumber}</span> }, { label: 'Unité', render: (p) => PACKAGING[p.unitType] }, { label: 'Poids', num: true, render: (p) => (p.weightKg ? `${num(p.weightKg)} kg` : '—') },
              { label: 'État', render: (p) => <Status map={PACKAGE_STATUS} value={p.status} /> },
            ]} empty={<Empty title="Aucun colis">Préparez la commande puis créez ses colis.</Empty>} />
          </Card>
          <Card title="Livraisons">
            <DataTable rows={o.deliveries} columns={[
              { label: 'Numéro', render: (d) => <Link to={`/livraisons/${d.id}`}>{d.number}</Link> }, { label: 'Prévue', render: (d) => date(d.scheduledAt) }, { label: 'État', render: (d) => <Status map={DELIVERY_STATUS} value={d.status} /> },
            ]} empty={<Empty title="Aucune livraison" />} />
          </Card>
        </div>
        <div className="stack">
          <Card title="Récapitulatif" pad>
            <dl className="kv">
              <dt>Entrepôt</dt><dd>{o.warehouse.name}</dd><dt>Date souhaitée</dt><dd>{date(o.requestedDate)}</dd><dt>Remises</dt><dd>{money(o.discountTotal)}</dd><dt>Taxes</dt><dd>{money(o.taxTotal)}</dd>
              <dt>Total</dt><dd className="strong">{money(o.total)}</dd>{o.instructions && <><dt>Instructions</dt><dd>{o.instructions}</dd></>}
            </dl>
          </Card>
          <Card title="Historique" pad>
            <ol className="timeline">{o.history.map((h) => <li key={h.id}><div className="strong">{ORDER_STATUS[h.status]?.[0] ?? h.status}</div><div className="muted small">{dateTime(h.createdAt)}{h.note ? ` · ${h.note}` : ''}</div></li>)}</ol>
          </Card>
        </div>
      </div>
      {modal === 'prepare' && <PrepareModal order={o} onClose={() => setModal(null)} onDone={() => { setModal(null); reload() }} />}
      {modal === 'package' && <PackageModal order={o} onClose={() => setModal(null)} onDone={() => { setModal(null); reload() }} />}
      {modal === 'delivery' && <DeliveryFromOrder order={o} packages={free} onClose={() => setModal(null)} onDone={(d) => navigate(`/livraisons/${d.id}`)} />}
      {modal === 'cancel' && <Confirm danger title="Annuler la commande" message="Les quantités réservées seront libérées." confirmLabel="Annuler la commande" busy={busy} onClose={() => setModal(null)} onConfirm={async () => { await act('cancel', 'Commande annulée.', {}); setModal(null) }} />}
    </>
  )
}

function PrepareModal({ order, onClose, onDone }) {
  const toast = useToast()
  const open = order.items.filter((i) => i.quantity > i.quantityPrepared)
  const [values, setValues] = useState(() => Object.fromEntries(open.map((i) => [i.id, String(i.quantity - i.quantityPrepared)])))
  const [error, setError] = useState(null)
  const submit = async (e) => {
    e.preventDefault()
    try {
      const items = Object.entries(values).filter(([, q]) => Number(q) > 0).map(([orderItemId, q]) => ({ orderItemId, quantity: Number(q) }))
      await api.post(`/orders/${order.id}/prepare`, { items })
      toast('Préparation enregistrée.')
      onDone()
    } catch (err) { setError(err) }
  }
  return (
    <form onSubmit={submit}>
      <Modal title="Quantités préparées" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary">Enregistrer</Button></>}>
        <ErrorBox error={error} />
        <p className="muted">Une commande peut être préparée en plusieurs fois.</p>
        {open.map((i) => (
          <Field key={i.id} label={`${i.product.name} (reste ${qty(i.quantity - i.quantityPrepared, i.product.baseUnit)})`}>
            <Input type="number" step="any" min="0" max={i.quantity - i.quantityPrepared} value={values[i.id]} onChange={(e) => setValues({ ...values, [i.id]: e.target.value })} />
          </Field>
        ))}
      </Modal>
    </form>
  )
}

function PackageModal({ order, onClose, onDone }) {
  const toast = useToast()
  const open = order.items.filter((i) => i.quantityPrepared > i.quantityPackaged)
  const [values, setValues] = useState(() => Object.fromEntries(open.map((i) => [i.id, String(i.quantityPrepared - i.quantityPackaged)])))
  const [unitType, setUnitType] = useState('CARTON')
  const [error, setError] = useState(null)
  const submit = async (e) => {
    e.preventDefault()
    try {
      const items = open.filter((i) => Number(values[i.id]) > 0).map((i) => ({ productId: i.productId, orderItemId: i.id, quantity: Number(values[i.id]) }))
      await api.post('/packages', { warehouseId: order.warehouse.id, orderId: order.id, unitType, items })
      toast('Colis créé, QR Code et numéro de suivi générés.')
      onDone()
    } catch (err) { setError(err) }
  }
  return (
    <form onSubmit={submit}>
      <Modal title="Nouveau colis" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary">Créer le colis</Button></>}>
        <ErrorBox error={error} />
        <Field label="Unité logistique"><Select value={unitType} onChange={(e) => setUnitType(e.target.value)} options={options(PACKAGING)} /></Field>
        {open.map((i) => (
          <Field key={i.id} label={`${i.product.name} (disponible : ${qty(i.quantityPrepared - i.quantityPackaged, i.product.baseUnit)})`}>
            <Input type="number" step="any" min="0" max={i.quantityPrepared - i.quantityPackaged} value={values[i.id]} onChange={(e) => setValues({ ...values, [i.id]: e.target.value })} />
          </Field>
        ))}
      </Modal>
    </form>
  )
}

function DeliveryFromOrder({ order, packages, onClose, onDone }) {
  const [v, setV] = useState({ scheduledAt: '', priority: 'NORMAL', instructions: order.instructions ?? '' })
  const [selected, setSelected] = useState(() => packages.map((p) => p.id))
  const [error, setError] = useState(null)
  const [key] = useState(() => api.newKey())
  const submit = async (e) => {
    e.preventDefault()
    try {
      const d = await api.post('/deliveries', { orderId: order.id, packageIds: selected, scheduledAt: v.scheduledAt ? new Date(v.scheduledAt).toISOString() : undefined, priority: v.priority, instructions: v.instructions || undefined }, key)
      onDone(d)
    } catch (err) { setError(err) }
  }
  return (
    <form onSubmit={submit}>
      <Modal title="Créer la livraison" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" disabled={!selected.length}>Créer</Button></>}>
        <ErrorBox error={error} />
        <div className="stack" style={{ gap: 6 }}>
          <span className="field-label">Colis à livrer</span>
          {packages.map((p) => (
            <label key={p.id} className="checkbox"><input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))} /><span className="mono">{p.trackingNumber}</span></label>
          ))}
        </div>
        <div className="form-grid">
          <Field label="Date prévue"><Input type="datetime-local" value={v.scheduledAt} onChange={(e) => setV({ ...v, scheduledAt: e.target.value })} /></Field>
          <Field label="Priorité"><Select value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })} options={options(PRIORITY)} /></Field>
        </div>
        <Field label="Instructions"><Textarea value={v.instructions} onChange={(e) => setV({ ...v, instructions: e.target.value })} /></Field>
      </Modal>
    </form>
  )
}
