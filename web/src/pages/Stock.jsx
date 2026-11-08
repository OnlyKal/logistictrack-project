import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowDownToLine, ArrowUpFromLine, Plus, SlidersHorizontal } from 'lucide-react'
import { api, query } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useDebounced, useFetch, useList } from '../lib/hooks.js'
import { useLive } from '../lib/socket.js'
import { INVENTORY_STATUS, MOVEMENT_REASONS, TRANSFER_STATUS, date, dateTime, dayEnd, dayStart, num, qty } from '../lib/format.js'
import { BackLink, PeriodFilter, useOptions } from '../components/CrudPage.jsx'
import { ImportButton } from '../components/ImportButton.jsx'
import { LineItems, namedOption, newLine, productOption } from '../components/LineItems.jsx'
import { Badge, Button, Card, DataTable, Empty, ErrorBox, Field, Input, Modal, PageHead, Pagination, SearchInput, Select, Status, Textarea, useAction, useToast } from '../components/ui.jsx'

export function Stocks() {
  const { can } = useAuth()
  const [tab, setTab] = useState('balances')
  const [warehouseId, setWarehouseId] = useState('')
  const [q, setQ] = useState('')
  const [asOf, setAsOf] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [modal, setModal] = useState(null)
  const debounced = useDebounced(q)
  const history = useFetch(tab === 'balances' && asOf ? `/stocks/as-of${query({ date: asOf, warehouseId, q: debounced })}` : null)
  useEffect(() => setPage(1), [debounced, warehouseId, tab, from, to])
  const warehouses = useOptions('/warehouses?limit=200', namedOption)
  const path = `${tab === 'balances' ? '/stocks' : '/stocks/movements'}${query({ warehouseId, q: debounced, from: dayStart(from), to: dayEnd(to), page })}`
  const { items, meta, loading, error, reload } = useList(path)
  useLive('stock.changed', reload)
  const done = () => { setModal(null); reload() }
  return (
    <>
      <PageHead title="Stocks" sub="Tout changement de solde passe par un mouvement traçable." actions={<>
        {can('stock.receive') && <ImportButton kind="stock" onDone={reload} />}
        {can('stock.issue') && <Button icon={ArrowUpFromLine} onClick={() => setModal('issue')}>Sortie</Button>}
        {can('stock.receive') && <Button variant="primary" icon={ArrowDownToLine} onClick={() => setModal('receipt')}>Réception</Button>}
      </>} />
      <Card>
        <div className="toolbar toolbar-wrap">
          <div className="actions">
            <Button variant={tab === 'balances' ? 'primary' : undefined} onClick={() => setTab('balances')}>Soldes</Button>
            <Button variant={tab === 'movements' ? 'primary' : undefined} onClick={() => setTab('movements')}>Mouvements</Button>
          </div>
          <SearchInput value={q} onChange={setQ} placeholder="Rechercher une marchandise" />
          <Select style={{ width: 220 }} aria-label="Entrepôt" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} placeholder="Tous les entrepôts" options={warehouses} />
          {tab === 'balances' && <label className="period"><span className="muted small">Stock au</span><Input type="date" aria-label="Stock au" max={new Date().toISOString().slice(0, 10)} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>}
          {!(tab === 'balances' && asOf) && <PeriodFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />}
          {(from || to || asOf) && <Button variant="ghost" onClick={() => { setFrom(''); setTo(''); setAsOf('') }}>Effacer les dates</Button>}
        </div>
        {tab === 'balances' && asOf ? (
          <>
            <div className="toolbar muted small">Stock physique à la fin du {date(`${asOf}T12:00:00`)}, d'après les mouvements enregistrés. Les réservations de ce jour-là ne sont pas reconstituées.</div>
            <DataTable loading={history.loading} error={history.error} rows={history.data?.items ?? []} rowKey={(r) => r.key} columns={[
              { label: 'Marchandise', render: (b) => <><div className="strong">{b.product.name}</div><div className="muted small">{b.product.reference}</div></> },
              { label: 'Entrepôt', render: (b) => b.warehouse.name }, { label: 'Lot', render: (b) => b.batch?.batchNumber ?? '—' }, { label: 'Emplacement', render: (b) => b.location?.code ?? '—' },
              { label: 'Quantité', num: true, render: (b) => <span className="strong">{qty(b.quantity, b.product.baseUnit)}</span> }, { label: 'Dernier mouvement', render: (b) => dateTime(b.lastMovementAt) },
            ]} empty={<Empty title="Aucun stock à cette date" />} />
          </>
        ) : tab === 'balances' ? (
          <DataTable loading={loading} error={error} rows={items} columns={[
            { label: 'Marchandise', render: (b) => <><div className="strong">{b.product.name}</div><div className="muted small">{b.product.reference}</div></> },
            { label: 'Entrepôt', render: (b) => b.warehouse.name },
            { label: 'Lot', render: (b) => (b.batch ? <>{b.batch.batchNumber}{b.batch.expiresAt && <div className="muted small">Exp. {date(b.batch.expiresAt)}</div>}</> : '—') },
            { label: 'Emplacement', render: (b) => b.location?.code ?? '—' },
            { label: 'Physique', num: true, render: (b) => qty(b.onHand, b.product.baseUnit) }, { label: 'Réservé', num: true, render: (b) => num(b.reserved) },
            { label: 'Endommagé', num: true, render: (b) => num(b.damaged) },
            { label: 'Disponible', num: true, render: (b) => <span className="strong">{num(b.available)}</span> },
            { label: 'Mis à jour le', render: (b) => dateTime(b.updatedAt) },
            { label: '', render: (b) => can('stock.adjust') && <Button variant="ghost" icon={SlidersHorizontal} aria-label="Ajuster" title="Ajuster" onClick={() => setModal(b)} /> },
          ]} empty={<Empty title="Aucun stock">{from || to ? 'Aucun solde mis à jour sur cette période.' : 'Enregistrez une réception pour créer le premier solde.'}</Empty>} />
        ) : (
          <DataTable loading={loading} error={error} rows={items} columns={[
            { label: 'Date', render: (m) => dateTime(m.createdAt) }, { label: 'Marchandise', render: (m) => m.product.name }, { label: 'Entrepôt', render: (m) => m.warehouse.name },
            { label: 'Sens', render: (m) => <Badge tone={m.direction === 'IN' ? 'green' : 'blue'}>{m.direction === 'IN' ? 'Entrée' : 'Sortie'}</Badge> },
            { label: 'Motif', render: (m) => MOVEMENT_REASONS[m.reason] ?? m.reason }, { label: 'Quantité', num: true, render: (m) => qty(m.quantity, m.product.baseUnit) },
            { label: 'Avant → après', num: true, render: (m) => <span className="muted">{num(m.quantityBefore)} → {num(m.quantityAfter)}</span> },
            { label: 'Auteur', render: (m) => m.createdBy?.fullName ?? 'Système' }, { label: 'Note', render: (m) => m.note ?? '—' },
          ]} empty={<Empty title="Aucun mouvement">{from || to ? 'Aucun mouvement sur cette période.' : null}</Empty>} />
        )}
        <Pagination meta={meta} onPage={setPage} />
      </Card>
      {modal === 'receipt' && <ReceiptModal warehouses={warehouses} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'issue' && <IssueModal warehouses={warehouses} onClose={() => setModal(null)} onDone={done} />}
      {modal?.id && <AdjustModal balance={modal} onClose={() => setModal(null)} onDone={done} />}
    </>
  )
}

function ReceiptModal({ warehouses, onClose, onDone }) {
  const toast = useToast()
  const products = useOptions('/products?limit=200', productOption)
  const suppliers = useOptions('/suppliers?limit=200', namedOption)
  const [v, setV] = useState({ warehouseId: '', supplierId: '', purchaseOrderId: '', reason: 'SUPPLIER', note: '' })
  const openOrders = useOptions('/purchase-orders?limit=100', (o) => ({ value: o.id, label: `${o.number} — ${o.supplier.name} (${o.status})` }))
  const locations = useOptions(v.warehouseId ? `/warehouses/${v.warehouseId}/locations` : null, (l) => ({ value: l.id, label: l.code }))
  const [lines, setLines] = useState([newLine()])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [key] = useState(() => api.newKey())
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const receipt = await api.post('/stocks/receipts', {
        warehouseId: v.warehouseId, supplierId: v.supplierId || undefined, purchaseOrderId: v.purchaseOrderId || undefined, reason: v.reason, note: v.note || undefined,
        items: lines.map((l) => ({
          productId: l.productId, quantity: Number(l.quantity), batchNumber: l.batchNumber || undefined, expiresAt: l.expiresAt ? new Date(l.expiresAt).toISOString() : undefined,
          unitCost: l.unitCost ? Number(l.unitCost) : undefined, locationId: l.locationId || undefined,
        })),
      }, key)
      toast(`Réception ${receipt.number} enregistrée.`)
      onDone()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  const updateLine = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  return (
    <form onSubmit={submit}>
      <Modal wide title="Réception de marchandises" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" loading={busy}>Valider la réception</Button></>}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Entrepôt *"><Select required value={v.warehouseId} onChange={(e) => setV({ ...v, warehouseId: e.target.value })} placeholder="Sélectionner" options={warehouses} /></Field>
          <Field label="Motif *"><Select value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} options={['SUPPLIER', 'CUSTOMER_RETURN', 'PRODUCTION'].map((r) => ({ value: r, label: MOVEMENT_REASONS[r] }))} /></Field>
          <Field label="Fournisseur"><Select value={v.supplierId} onChange={(e) => setV({ ...v, supplierId: e.target.value })} placeholder="Aucun" options={suppliers} /></Field>
          <Field label="Bon de commande"><Select value={v.purchaseOrderId} onChange={(e) => setV({ ...v, purchaseOrderId: e.target.value })} placeholder="Aucun" options={openOrders} /></Field>
        </div>
        <LineItems products={products} lines={lines} setLines={setLines} extra={[
          { name: 'batchNumber', label: 'Lot' }, { name: 'expiresAt', label: 'Expiration', type: 'date', width: '140px' },
        ]} />
        {locations.length > 0 && lines.map((l, i) => (
          <Field key={l.key} label={`Emplacement, ligne ${i + 1}`}><Select value={l.locationId ?? ''} onChange={(e) => updateLine(i, { locationId: e.target.value })} placeholder="Non précisé" options={locations} /></Field>
        ))}
        <Field label="Note"><Textarea value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
      </Modal>
    </form>
  )
}

function IssueModal({ warehouses, onClose, onDone }) {
  const toast = useToast()
  const products = useOptions('/products?limit=200', productOption)
  const [v, setV] = useState({ warehouseId: '', productId: '', quantity: '', reason: 'DAMAGED', note: '' })
  const [error, setError] = useState(null)
  const [key] = useState(() => api.newKey())
  const submit = async (e) => {
    e.preventDefault()
    try {
      await api.post('/stocks/issues', { ...v, quantity: Number(v.quantity), note: v.note || undefined }, key)
      toast('Sortie enregistrée.')
      onDone()
    } catch (err) { setError(err) }
  }
  return (
    <form onSubmit={submit}>
      <Modal title="Sortie de stock" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary">Enregistrer</Button></>}>
        <ErrorBox error={error} />
        <Field label="Entrepôt *"><Select required value={v.warehouseId} onChange={(e) => setV({ ...v, warehouseId: e.target.value })} placeholder="Sélectionner" options={warehouses} /></Field>
        <Field label="Marchandise *"><Select required value={v.productId} onChange={(e) => setV({ ...v, productId: e.target.value })} placeholder="Sélectionner" options={products} /></Field>
        <div className="form-grid">
          <Field label="Quantité *"><Input required type="number" step="any" min="0.001" value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} /></Field>
          <Field label="Motif *"><Select value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} options={['DAMAGED', 'LOSS', 'INTERNAL_USE'].map((r) => ({ value: r, label: MOVEMENT_REASONS[r] }))} /></Field>
        </div>
        <Field label="Note"><Textarea value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
      </Modal>
    </form>
  )
}

function AdjustModal({ balance, onClose, onDone }) {
  const toast = useToast()
  const [countedQuantity, setCounted] = useState(String(balance.onHand))
  const [reason, setReason] = useState('')
  const [error, setError] = useState(null)
  const [key] = useState(() => api.newKey())
  const submit = async (e) => {
    e.preventDefault()
    try {
      await api.post('/stocks/adjustments', { balanceId: balance.id, countedQuantity: Number(countedQuantity), reason }, key)
      toast('Ajustement enregistré.')
      onDone()
    } catch (err) { setError(err) }
  }
  return (
    <form onSubmit={submit}>
      <Modal title={`Ajuster : ${balance.product.name}`} onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary">Enregistrer</Button></>}>
        <ErrorBox error={error} />
        <p className="muted">Solde physique actuel : {qty(balance.onHand, balance.product.baseUnit)}. L'auteur, le motif et les quantités seront conservés.</p>
        <Field label="Quantité comptée *"><Input required type="number" step="any" min="0" value={countedQuantity} onChange={(e) => setCounted(e.target.value)} /></Field>
        <Field label="Motif *"><Textarea required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </form>
  )
}

export function Transfers() {
  const { can } = useAuth()
  const { items, loading, error, reload } = useList('/stocks/transfers?limit=100')
  const [create, setCreate] = useState(false)
  const [receive, setReceive] = useState(null)
  const { run, busy } = useAction()
  const step = async (t, action, label) => {
    await run(() => api.post(`/stocks/transfers/${t.id}/${action}`), label)
    reload()
  }
  const manage = can('stock.transfer')
  return (
    <>
      <PageHead title="Transferts" sub="Le stock en transit n'est disponible à destination qu'après réception." actions={manage && <Button variant="primary" icon={Plus} onClick={() => setCreate(true)}>Nouveau transfert</Button>} />
      <Card>
        <DataTable loading={loading} error={error} rows={items} columns={[
          { label: 'Numéro', render: (t) => <span className="strong">{t.number}</span> }, { label: 'Origine', render: (t) => t.fromWarehouse.name }, { label: 'Destination', render: (t) => t.toWarehouse.name },
          { label: 'Contenu', render: (t) => t.items.map((i) => `${i.product.name} : ${qty(i.quantity, i.product.baseUnit)}`).join(' · ') },
          { label: 'État', render: (t) => <Status map={TRANSFER_STATUS} value={t.status} /> }, { label: 'Créé le', render: (t) => date(t.createdAt) },
          { label: '', render: (t) => manage && (
            <div className="actions" style={{ justifyContent: 'flex-end' }}>
              {t.status === 'PENDING' && <Button disabled={busy} onClick={() => step(t, 'validate', 'Transfert validé, stock réservé.')}>Valider</Button>}
              {t.status === 'VALIDATED' && <Button disabled={busy} onClick={() => step(t, 'dispatch', 'Transfert expédié.')}>Expédier</Button>}
              {t.status === 'SHIPPED' && <Button variant="primary" onClick={() => setReceive(t)}>Réceptionner</Button>}
              {['PENDING', 'VALIDATED'].includes(t.status) && <Button variant="danger" disabled={busy} onClick={() => step(t, 'cancel', 'Transfert annulé.')}>Annuler</Button>}
            </div>
          ) },
        ]} empty={<Empty title="Aucun transfert" />} />
      </Card>
      {create && <TransferModal onClose={() => setCreate(false)} onDone={() => { setCreate(false); reload() }} />}
      {receive && <ReceiveTransferModal transfer={receive} onClose={() => setReceive(null)} onDone={() => { setReceive(null); reload() }} />}
    </>
  )
}

function TransferModal({ onClose, onDone }) {
  const warehouses = useOptions('/warehouses?limit=200', namedOption)
  const products = useOptions('/products?limit=200', productOption)
  const [v, setV] = useState({ fromWarehouseId: '', toWarehouseId: '', note: '' })
  const [lines, setLines] = useState([newLine()])
  const [error, setError] = useState(null)
  const submit = async (e) => {
    e.preventDefault()
    try {
      await api.post('/stocks/transfers', { ...v, note: v.note || undefined, items: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })) })
      onDone()
    } catch (err) { setError(err) }
  }
  return (
    <form onSubmit={submit}>
      <Modal wide title="Nouvelle demande de transfert" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary">Créer</Button></>}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Entrepôt d'origine *"><Select required value={v.fromWarehouseId} onChange={(e) => setV({ ...v, fromWarehouseId: e.target.value })} placeholder="Sélectionner" options={warehouses} /></Field>
          <Field label="Entrepôt de destination *"><Select required value={v.toWarehouseId} onChange={(e) => setV({ ...v, toWarehouseId: e.target.value })} placeholder="Sélectionner" options={warehouses.filter((w) => w.value !== v.fromWarehouseId)} /></Field>
        </div>
        <LineItems products={products} lines={lines} setLines={setLines} />
      </Modal>
    </form>
  )
}

function ReceiveTransferModal({ transfer, onClose, onDone }) {
  const toast = useToast()
  const [received, setReceived] = useState(() => Object.fromEntries(transfer.items.map((i) => [i.id, String(i.quantity)])))
  const [error, setError] = useState(null)
  const submit = async (e) => {
    e.preventDefault()
    try {
      await api.post(`/stocks/transfers/${transfer.id}/receive`, { items: Object.entries(received).map(([itemId, q]) => ({ itemId, quantityReceived: Number(q) })) })
      toast('Transfert réceptionné.')
      onDone()
    } catch (err) { setError(err) }
  }
  return (
    <form onSubmit={submit}>
      <Modal title={`Réception : ${transfer.number}`} onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary">Confirmer la réception</Button></>}>
        <ErrorBox error={error} />
        {transfer.items.map((i) => (
          <Field key={i.id} label={`${i.product.name} (expédié : ${qty(i.quantity, i.product.baseUnit)})`}>
            <Input type="number" step="any" min="0" max={i.quantity} required value={received[i.id]} onChange={(e) => setReceived({ ...received, [i.id]: e.target.value })} />
          </Field>
        ))}
      </Modal>
    </form>
  )
}

export function Inventories() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const { items, loading, error } = useList('/stocks/inventories?limit=100')
  const warehouses = useOptions('/warehouses?limit=200', namedOption)
  const [create, setCreate] = useState(false)
  const [warehouseId, setWarehouseId] = useState('')
  const [kind, setKind] = useState('FULL')
  const [err, setErr] = useState(null)
  const open = async (e) => {
    e.preventDefault()
    try {
      const s = await api.post('/stocks/inventories', { warehouseId, kind })
      navigate(`/inventaires/${s.id}`)
    } catch (x) { setErr(x) }
  }
  return (
    <>
      <PageHead title="Inventaires" sub="Comparaison du stock théorique et du stock physique." actions={can('inventory.manage') && <Button variant="primary" icon={Plus} onClick={() => setCreate(true)}>Ouvrir un inventaire</Button>} />
      <Card>
        <DataTable loading={loading} error={error} rows={items} onRowClick={(s) => navigate(`/inventaires/${s.id}`)} columns={[
          { label: 'Numéro', render: (s) => <span className="strong">{s.number}</span> }, { label: 'Entrepôt', render: (s) => s.warehouse.name }, { label: 'Lignes', num: true, render: (s) => s._count.items },
          { label: 'État', render: (s) => <Status map={INVENTORY_STATUS} value={s.status} /> }, { label: 'Ouvert le', render: (s) => date(s.createdAt) }, { label: 'Clôturé le', render: (s) => date(s.closedAt) },
        ]} empty={<Empty title="Aucun inventaire" />} />
      </Card>
      {create && (
        <form onSubmit={open}>
          <Modal title="Ouvrir un inventaire" onClose={() => setCreate(false)} footer={<><Button onClick={() => setCreate(false)}>Annuler</Button><Button type="submit" variant="primary">Ouvrir</Button></>}>
            <ErrorBox error={err} />
            <Field label="Entrepôt *"><Select required value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} placeholder="Sélectionner" options={warehouses} /></Field>
            <Field label="Portée"><Select value={kind} onChange={(e) => setKind(e.target.value)} options={[{ value: 'FULL', label: 'Inventaire complet' }, { value: 'PARTIAL', label: 'Inventaire partiel' }]} /></Field>
          </Modal>
        </form>
      )}
    </>
  )
}

export function InventoryDetail() {
  const { id } = useParams()
  const { can } = useAuth()
  const { data: s, error, reload } = useFetch(`/stocks/inventories/${id}`)
  const [draft, setDraft] = useState({})
  const { run, busy } = useAction()
  const lines = useMemo(() => s?.items ?? [], [s])
  if (error) return <ErrorBox error={error} />
  if (!s) return null
  const editable = s.status === 'OPEN' && can('inventory.manage')
  const value = (i, k) => draft[i.id]?.[k] ?? (i[k] ?? '')
  const set = (i, k, v) => setDraft({ ...draft, [i.id]: { ...draft[i.id], [k]: v } })
  const save = async () => {
    const items = lines.filter((i) => value(i, 'counted') !== '').map((i) => ({ itemId: i.id, counted: Number(value(i, 'counted')), justification: value(i, 'justification') || undefined }))
    if (!items.length) return true
    const r = await run(() => api.post(`/stocks/inventories/${id}/count`, { items }), 'Comptage enregistré.')
    if (r.ok) { setDraft({}); reload() }
    return r.ok
  }
  const close = async () => {
    if (!(await save())) return
    const r = await run(() => api.post(`/stocks/inventories/${id}/close`), 'Inventaire clôturé, stock ajusté.')
    if (r.ok) reload()
  }
  return (
    <>
      <PageHead back={<BackLink to="/inventaires" label="Inventaires" />} title={s.number} sub={s.warehouse.name} actions={editable ? <><Button loading={busy} onClick={save}>Enregistrer le comptage</Button><Button variant="primary" loading={busy} onClick={close}>Clôturer</Button></> : <Status map={INVENTORY_STATUS} value={s.status} />} />
      <Card>
        <DataTable rows={lines} columns={[
          { label: 'Marchandise', render: (i) => <><div className="strong">{i.balance.product.name}</div><div className="muted small">{[i.balance.location?.code, i.balance.batch?.batchNumber].filter(Boolean).join(' · ') || i.balance.product.reference}</div></> },
          { label: 'Théorique', num: true, render: (i) => qty(i.theoretical, i.balance.product.baseUnit) },
          { label: 'Compté', render: (i) => (editable ? <Input style={{ width: 110 }} aria-label="Quantité comptée" type="number" step="any" min="0" value={value(i, 'counted')} onChange={(e) => set(i, 'counted', e.target.value)} /> : num(i.counted)) },
          { label: 'Écart', num: true, render: (i) => { const c = value(i, 'counted'); return c === '' ? '—' : num(Number(c) - i.theoretical) } },
          { label: 'Justification', render: (i) => (editable ? <Input aria-label="Justification" value={value(i, 'justification')} onChange={(e) => set(i, 'justification', e.target.value)} placeholder="Obligatoire en cas d'écart" /> : i.justification ?? '—') },
        ]} empty={<Empty title="Aucune ligne">Cet entrepôt ne contient aucun stock.</Empty>} />
      </Card>
    </>
  )
}
