import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useFetch, useList } from '../lib/hooks.js'
import { ACTIVE_STATUS, DELIVERY_STATUS, FRAGILITY, NATURES, ORDER_STATUS, PACKAGING, PO_STATUS, VEHICLE_TYPES, WAREHOUSE_TYPES, date, money, num, options, qty } from '../lib/format.js'
import { BackLink, CrudPage, FormModal, useOptions } from '../components/CrudPage.jsx'
import { pointFields } from '../components/DeliveryPointSelect.jsx'
import { ImportButton } from '../components/ImportButton.jsx'
import { LineItems, namedOption, newLine, productOption } from '../components/LineItems.jsx'
import { Button, Card, DataTable, Empty, ErrorBox, Field, Modal, PageHead, Select, Status, useAction, useToast } from '../components/ui.jsx'
import { Link } from 'react-router-dom'

const statusField = { name: 'status', label: 'Statut', type: 'select', options: options({ active: 'Actif', inactive: 'Inactif' }), default: 'active' }

const warehouseFields = [
  { name: 'name', label: 'Nom', required: true }, 
  { name: 'type', label: 'Type', type: 'select', required: true, default: 'GENERAL', options: options(WAREHOUSE_TYPES) },
  { name: 'agencyId', label: 'Agence', type: 'select', optionsFrom: '/agencies', toOption: namedOption, placeholder: 'Aucune (siège)' },
  { name: 'address', label: 'Adresse', wide: true }, { name: 'manager', label: 'Responsable' }, { name: 'phone', label: 'Téléphone' },
  { name: 'latitude', locate: true, label: 'Latitude', type: 'number', min: -90 }, { name: 'longitude', label: 'Longitude', type: 'number', min: -180 },
  { name: 'maxCapacity', label: 'Capacité maximale', type: 'number', hint: "En unités de stock. Vide : pas de contrôle." }, { name: 'surface', label: 'Surface (m²)', type: 'number' },
]

export const Warehouses = () => (
  <CrudPage
    title="Entrepôts" sub="Unités de stockage de l'entreprise." endpoint="/warehouses" singular="entrepôt" fields={warehouseFields} createPerm="warehouse.manage"
    rowLink={(r) => `/entrepots/${r.id}`}
    columns={[
      { label: 'Nom', render: (r) => <span className="strong">{r.name}</span> }, { label: 'Code', render: (r) => <span className="mono">{r.code}</span> },
      { label: 'Type', render: (r) => WAREHOUSE_TYPES[r.type] ?? r.type }, { label: 'Agence', render: (r) => r.agency?.name ?? 'Siège' }, { label: 'Responsable', key: 'manager' },
      { label: 'Statut', render: (r) => <Status map={ACTIVE_STATUS} value={r.status} /> },
    ]}
  />
)

export function WarehouseDetail() {
  const { id } = useParams()
  const { can } = useAuth()
  const toast = useToast()
  const { data: wh, error, reload } = useFetch(`/warehouses/${id}`)
  const locations = useFetch(`/warehouses/${id}/locations`)
  const [modal, setModal] = useState(null)
  if (error) return <ErrorBox error={error} />
  if (!wh) return null
  const manage = can('warehouse.manage')
  const refresh = () => { setModal(null); reload(); locations.reload() }
  const zoneOptions = wh.zones.map((z) => ({ value: z.id, label: z.name }))
  const aisleOptions = wh.zones.flatMap((z) => z.aisles.map((a) => ({ value: a.id, label: `${z.name} / ${a.name}` })))
  return (
    <>
      <PageHead back={<BackLink to="/entrepots" label="Entrepôts" />} title={wh.name} sub={`${wh.code} · ${WAREHOUSE_TYPES[wh.type]}`} actions={manage && (
        <>
          <Button onClick={() => setModal('edit')}>Modifier</Button>
          <Button icon={Plus} onClick={() => setModal('zone')}>Zone</Button>
          <Button icon={Plus} disabled={!zoneOptions.length} onClick={() => setModal('aisle')}>Rayon</Button>
          <Button variant="primary" icon={Plus} onClick={() => setModal('location')}>Emplacement</Button>
        </>
      )} />
      <div className="grid grid-2">
        <Card title="Zones et rayons">
          <DataTable rows={wh.zones} columns={[
            { label: 'Zone', render: (z) => <span className="strong">{z.name}</span> }, { label: 'Code', key: 'code' },
            { label: 'Type', render: (z) => ({ STORAGE: 'Stockage', RECEIVING: 'Réception', SHIPPING: 'Expédition', QUARANTINE: 'Quarantaine' }[z.kind]) },
            { label: 'Rayons', render: (z) => z.aisles.map((a) => a.name).join(', ') || '—' },
          ]} empty={<Empty title="Aucune zone">Organisez l'entrepôt en zones, rayons et emplacements.</Empty>} />
        </Card>
        <Card title="Emplacements">
          <DataTable loading={locations.loading} rows={locations.data ?? []} columns={[
            { label: 'Code', render: (l) => <span className="mono">{l.code}</span> },
            { label: 'Rayon', render: (l) => (l.aisle ? `${l.aisle.zone.name} / ${l.aisle.name}` : '—') },
            { label: 'Étagère', key: 'shelf' }, { label: 'Compartiment', key: 'compartment' },
          ]} empty={<Empty title="Aucun emplacement" />} />
        </Card>
      </div>
      {modal === 'edit' && <FormModal title="Modifier l'entrepôt" fields={[...warehouseFields, { ...statusField, options: options({ active: 'Actif', inactive: 'Inactif', closed: 'Fermé' }) }]} row={wh} wide onClose={() => setModal(null)} onSubmit={async (v) => { await api.patch(`/warehouses/${id}`, v); toast('Entrepôt modifié.'); refresh() }} />}
      {modal === 'zone' && <FormModal title="Nouvelle zone" onClose={() => setModal(null)} fields={[
        { name: 'name', label: 'Nom', required: true }, { name: 'code', label: 'Code', required: true },
        { name: 'kind', label: 'Type', type: 'select', default: 'STORAGE', required: true, options: options({ STORAGE: 'Stockage', RECEIVING: 'Réception', SHIPPING: 'Expédition', QUARANTINE: 'Quarantaine' }) },
      ]} onSubmit={async (v) => { await api.post(`/warehouses/${id}/zones`, v); refresh() }} />}
      {modal === 'aisle' && <AisleModal id={id} zones={zoneOptions} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'location' && <FormModal title="Nouvel emplacement" onClose={() => setModal(null)} fields={[
        { name: 'code', label: 'Code unique', required: true }, { name: 'aisleId', label: 'Rayon', type: 'select', options: aisleOptions, placeholder: 'Aucun' },
        { name: 'shelf', label: 'Étagère' }, { name: 'compartment', label: 'Compartiment' },
      ]} onSubmit={async (v) => { await api.post(`/warehouses/${id}/locations`, v); refresh() }} />}
    </>
  )
}

function AisleModal({ id, zones, onClose, onDone }) {
  return <FormModal title="Nouveau rayon" onClose={onClose} fields={[
    { name: 'zoneId', label: 'Zone', type: 'select', required: true, options: zones }, { name: 'name', label: 'Nom', required: true }, { name: 'code', label: 'Code', required: true },
  ]} onSubmit={async ({ zoneId, ...v }) => { await api.post(`/warehouses/${id}/zones/${zoneId}/aisles`, v); onDone() }} />
}

const productFields = [
  { name: 'name', label: 'Nom', required: true }, { name: 'reference', label: 'Référence interne', required: true },
  { name: 'categoryId', label: 'Catégorie', type: 'select', optionsFrom: '/products/categories', toOption: namedOption, placeholder: 'Aucune' }, { name: 'brand', label: 'Marque' },
  { name: 'physicalNature', label: 'Nature physique', type: 'select', required: true, default: 'SOLID', options: options(NATURES) },
  { name: 'baseUnit', label: 'Unité de base', required: true, default: 'unité', hint: 'litre, sac, carton, kg…' },
  { name: 'unitWeightKg', label: 'Poids unitaire (kg)', type: 'number' }, { name: 'unitVolumeM3', label: 'Volume unitaire (m³)', type: 'number' },
  { name: 'barcode', label: 'Code-barres' }, { name: 'dimensions', label: 'Dimensions' },
  { name: 'storageCondition', label: 'Conditions de conservation' }, { name: 'fragility', label: 'Fragilité', type: 'select', default: 'NONE', required: true, options: options(FRAGILITY) },
  { name: 'hazardClass', label: 'Classe de danger' }, { name: 'requiredVehicle', label: 'Véhicule obligatoire', type: 'select', options: options(VEHICLE_TYPES), placeholder: 'Aucun', hint: "Contrôlé à l'affectation." },
  { name: 'unitCost', label: 'Coût unitaire', type: 'number' }, { name: 'salePrice', label: 'Prix de vente', type: 'number' },
  { name: 'lowStockLevel', label: 'Seuil de stock faible', type: 'number' },
  { name: 'trackBatches', label: 'Suivi par lots', type: 'checkbox', hint: 'Numéro de lot obligatoire à la réception.' },
  { name: 'description', label: 'Description', type: 'textarea', wide: true },
]

export function Products() {
  const { can } = useAuth()
  const [category, setCategory] = useState(false)
  const [version, setVersion] = useState(0)
  return (
    <>
      <CrudPage
        key={version} title="Marchandises" sub="Solides, liquides, poudres, en vrac ou conditionnées." endpoint="/products" singular="marchandise" fields={productFields} createPerm="product.manage" rowLink={(r) => `/produits/${r.id}`}
        headerActions={can('product.manage') && <><ImportButton kind="products" onDone={() => setVersion((v) => v + 1)} /><Button onClick={() => setCategory(true)}>Nouvelle catégorie</Button></>}
        columns={[
          { label: 'Nom', render: (r) => <span className="strong">{r.name}</span> }, { label: 'Référence', render: (r) => <span className="mono">{r.reference}</span> },
          { label: 'Catégorie', render: (r) => r.category?.name ?? '—' }, { label: 'Nature', render: (r) => NATURES[r.physicalNature] }, { label: 'Unité', key: 'baseUnit' },
          { label: 'Conditionnements', num: true, render: (r) => r.packagings.length },
        ]}
      />
      {category && <FormModal title="Nouvelle catégorie" fields={[{ name: 'name', label: 'Nom', required: true }]} onClose={() => setCategory(false)} onSubmit={async (v) => { await api.post('/products/categories', v); setCategory(false); setVersion(version + 1) }} />}
    </>
  )
}

export function ProductDetail() {
  const { id } = useParams()
  const { can } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const { data: p, error, reload } = useFetch(`/products/${id}`)
  const stock = useFetch(can('stock.view') ? `/products/${id}/stock` : null)
  const [modal, setModal] = useState(null)
  const { run, busy } = useAction()
  if (error) return <ErrorBox error={error} />
  if (!p) return null
  const manage = can('product.manage')
  const close = () => { setModal(null); reload() }
  return (
    <>
      <PageHead back={<BackLink to="/produits" label="Marchandises" />} title={p.name} sub={`${p.reference} · ${NATURES[p.physicalNature]} · unité : ${p.baseUnit}`} actions={manage && (
        <>
          <Button variant="danger" loading={busy} onClick={async () => { const r = await run(() => api.del(`/products/${id}`), 'Marchandise archivée.'); if (r.ok) navigate('/produits') }}>Archiver</Button>
          <Button onClick={() => setModal('edit')}>Modifier</Button>
          <Button icon={Plus} onClick={() => setModal('batch')}>Lot</Button>
          <Button variant="primary" icon={Plus} onClick={() => setModal('packaging')}>Conditionnement</Button>
        </>
      )} />
      <div className="grid grid-2">
        <Card title="Fiche" pad>
          <dl className="kv">
            <dt>Catégorie</dt><dd>{p.category?.name ?? '—'}</dd><dt>Marque</dt><dd>{p.brand ?? '—'}</dd><dt>Code-barres</dt><dd>{p.barcode ?? '—'}</dd>
            <dt>Poids unitaire</dt><dd>{p.unitWeightKg ? `${num(p.unitWeightKg)} kg` : '—'}</dd><dt>Volume unitaire</dt><dd>{p.unitVolumeM3 ? `${num(p.unitVolumeM3)} m³` : '—'}</dd>
            <dt>Conservation</dt><dd>{p.storageCondition ?? '—'}</dd><dt>Fragilité</dt><dd>{FRAGILITY[p.fragility]}</dd><dt>Danger</dt><dd>{p.hazardClass ?? '—'}</dd>
            <dt>Véhicule obligatoire</dt><dd>{VEHICLE_TYPES[p.requiredVehicle] ?? '—'}</dd><dt>Coût / prix</dt><dd>{money(p.unitCost)} / {money(p.salePrice)}</dd>
          </dl>
        </Card>
        <Card title="Stock par entrepôt">
          <DataTable loading={stock.loading} rows={stock.data ?? []} columns={[
            { label: 'Entrepôt', render: (b) => b.warehouse.name }, { label: 'Lot', render: (b) => b.batch?.batchNumber ?? '—' },
            { label: 'Physique', num: true, render: (b) => qty(b.onHand, p.baseUnit) }, { label: 'Réservé', num: true, render: (b) => num(b.reserved) },
          ]} empty={<Empty title="Aucun stock" />} />
        </Card>
        <Card title="Conditionnements">
          <DataTable rows={p.packagings} columns={[
            { label: 'Nom', key: 'name' }, { label: 'Type', render: (x) => PACKAGING[x.type] }, { label: 'Contenance', num: true, render: (x) => qty(x.quantityPerUnit, p.baseUnit) },
          ]} empty={<Empty title="Aucun conditionnement">Exemple : bidon de 20 litres, fût de 200 litres.</Empty>} />
        </Card>
        <Card title="Lots">
          <DataTable rows={p.batches} columns={[
            { label: 'Lot', render: (b) => <span className="mono">{b.batchNumber}</span> }, { label: 'Reçu le', render: (b) => date(b.receivedAt) }, { label: 'Expire le', render: (b) => date(b.expiresAt) },
            { label: 'Quantité reçue', num: true, render: (b) => num(b.quantityReceived) },
          ]} empty={<Empty title="Aucun lot" />} />
        </Card>
      </div>
      {modal === 'edit' && <FormModal title="Modifier la marchandise" wide fields={productFields} row={p} onClose={() => setModal(null)} onSubmit={async (v) => { await api.patch(`/products/${id}`, v); toast('Marchandise modifiée.'); close() }} />}
      {modal === 'packaging' && <FormModal title="Nouveau conditionnement" onClose={() => setModal(null)} fields={[
        { name: 'name', label: 'Nom', required: true, placeholder: 'Bidon 20 L' }, { name: 'type', label: 'Type', type: 'select', required: true, options: options(PACKAGING) },
        { name: 'quantityPerUnit', label: `Contenance (${p.baseUnit})`, type: 'number', required: true },
      ]} onSubmit={async (v) => { await api.post(`/products/${id}/packagings`, v); close() }} />}
      {modal === 'batch' && <FormModal title="Nouveau lot" onClose={() => setModal(null)} fields={[
        { name: 'batchNumber', label: 'Numéro de lot', required: true }, { name: 'manufacturedAt', label: 'Fabrication', type: 'date' }, { name: 'expiresAt', label: 'Expiration', type: 'date' },
      ]} onSubmit={async (v) => { await api.post(`/products/${id}/batches`, v); close() }} />}
    </>
  )
}

export const Agencies = () => (
  <CrudPage title="Agences" sub="Établissements de l'entreprise." endpoint="/agencies" singular="agence" createPerm="agency.manage" editPerm="agency.manage" searchable={false} unpaged
    fields={[{ name: 'name', label: 'Nom', required: true }, { name: 'address', label: 'Adresse', wide: true }, { name: 'phone', label: 'Téléphone' }, { name: 'manager', label: 'Responsable' }, { name: 'latitude', locate: true, label: 'Latitude', type: 'number', min: -90 }, { name: 'longitude', label: 'Longitude', type: 'number', min: -180 }]}
    columns={[{ label: 'Nom', render: (r) => <span className="strong">{r.name}</span> }, { label: 'Code', key: 'code' }, { label: 'Adresse', key: 'address' }, { label: 'Responsable', key: 'manager' }, { label: 'Téléphone', key: 'phone' }]} />
)

export const Suppliers = () => (
  <CrudPage title="Fournisseurs" sub="Origine des marchandises." endpoint="/suppliers" singular="fournisseur" createPerm="supplier.manage" editPerm="supplier.manage"
    fields={[{ name: 'name', label: 'Nom', required: true }, { name: 'contact', label: 'Personne à contacter' }, { name: 'phone', label: 'Téléphone' }, { name: 'email', label: 'E-mail', type: 'email' }, { name: 'address', label: 'Adresse', wide: true }]}
    columns={[{ label: 'Nom', render: (r) => <span className="strong">{r.name}</span> }, { label: 'Personne à contacter', key: 'contact' }, { label: 'Téléphone', key: 'phone' }, { label: 'E-mail', key: 'email' }]} />
)

export function PurchaseOrders() {
  const { items, loading, error, reload } = useList('/purchase-orders?limit=100')
  const [create, setCreate] = useState(false)
  const { run } = useAction()
  return (
    <>
      <PageHead title="Bons de commande" sub="Commandes fournisseurs, distinctes des commandes clients." actions={<Button variant="primary" icon={Plus} onClick={() => setCreate(true)}>Nouveau bon</Button>} />
      <Card>
        <DataTable loading={loading} error={error} rows={items} columns={[
          { label: 'Numéro', render: (r) => <span className="strong">{r.number}</span> }, { label: 'Fournisseur', render: (r) => r.supplier.name }, { label: 'Entrepôt', render: (r) => r.warehouse.name },
          { label: 'Reçu', render: (r) => r.items.map((i) => `${i.product.name} : ${num(i.quantityReceived)}/${num(i.quantity)} ${i.product.baseUnit}`).join(' · ') },
          { label: 'État', render: (r) => <Status map={PO_STATUS} value={r.status} /> },
          { label: '', render: (r) => r.status === 'DRAFT' && <Button onClick={async () => { await run(() => api.post(`/purchase-orders/${r.id}/validate`), 'Bon validé.'); reload() }}>Valider</Button> },
        ]} empty={<Empty title="Aucun bon de commande" />} />
      </Card>
      {create && <PurchaseModal onClose={() => setCreate(false)} onDone={() => { setCreate(false); reload() }} />}
    </>
  )
}

function PurchaseModal({ onClose, onDone }) {
  const suppliers = useOptions('/suppliers?limit=200', namedOption)
  const warehouses = useOptions('/warehouses?limit=200', namedOption)
  const products = useOptions('/products?limit=200', productOption)
  const [v, setV] = useState({ supplierId: '', warehouseId: '' })
  const [lines, setLines] = useState([newLine()])
  const [error, setError] = useState(null)
  const submit = async (e) => {
    e.preventDefault()
    try {
      await api.post('/purchase-orders', { ...v, items: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitCost: l.unitCost ? Number(l.unitCost) : undefined })) })
      onDone()
    } catch (err) { setError(err) }
  }
  return (
    <form onSubmit={submit}>
      <Modal wide title="Nouveau bon de commande" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary">Créer</Button></>}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Fournisseur *"><Select required value={v.supplierId} onChange={(e) => setV({ ...v, supplierId: e.target.value })} placeholder="Sélectionner" options={suppliers} /></Field>
          <Field label="Entrepôt *"><Select required value={v.warehouseId} onChange={(e) => setV({ ...v, warehouseId: e.target.value })} placeholder="Sélectionner" options={warehouses} /></Field>
        </div>
        <LineItems products={products} lines={lines} setLines={setLines} extra={[{ name: 'unitCost', label: 'Coût unitaire', type: 'number' }]} />
      </Modal>
    </form>
  )
}

const customerFields = [
  { name: 'name', label: 'Nom', required: true }, { name: 'type', label: 'Type', type: 'select', required: true, default: 'COMPANY', options: options({ COMPANY: 'Entreprise', INDIVIDUAL: 'Particulier' }) },
  { name: 'phone', label: 'Téléphone' }, { name: 'email', label: 'E-mail', type: 'email' }, { name: 'address', label: 'Adresse principale', wide: true }, { name: 'notes', label: 'Notes', type: 'textarea', wide: true },
  { name: 'emailNotifications', label: 'Recevoir les e-mails de livraison', type: 'checkbox', default: true, wide: true, hint: "En route, livrée, non effectuée : selon ce que l'entreprise a activé dans ses Paramètres." },
]

export function Customers() {
  const { can } = useAuth()
  const [version, setVersion] = useState(0)
  return (
  <CrudPage key={version} headerActions={can('customer.manage') && <ImportButton kind="customers" onDone={() => setVersion((v) => v + 1)} />} title="Clients" sub="Un client peut posséder plusieurs points de livraison." endpoint="/customers" singular="client" fields={customerFields} createPerm="customer.manage" rowLink={(r) => `/clients/${r.id}`}
    columns={[
      { label: 'Code', render: (r) => <span className="mono">{r.code}</span> }, { label: 'Nom', render: (r) => <span className="strong">{r.name}</span> },
      { label: 'Type', render: (r) => (r.type === 'COMPANY' ? 'Entreprise' : 'Particulier') }, { label: 'Téléphone', key: 'phone' }, { label: 'Points de livraison', num: true, render: (r) => r._count.deliveryPoints },
    ]} />
  )
}

export function CustomerDetail() {
  const { id } = useParams()
  const { can } = useAuth()
  const { data: c, error, reload } = useFetch(`/customers/${id}`)
  const [modal, setModal] = useState(null)
  if (error) return <ErrorBox error={error} />
  if (!c) return null
  const manage = can('customer.manage')
  const close = () => { setModal(null); reload() }
  return (
    <>
      <PageHead back={<BackLink to="/clients" label="Clients" />} title={c.name} sub={`${c.code} · ${c.phone ?? 'sans téléphone'}`} actions={manage && (
        <><Button onClick={() => setModal('edit')}>Modifier</Button><Button variant="primary" icon={Plus} onClick={() => setModal('point')}>Point de livraison</Button></>
      )} />
      <div className="stack">
        <Card title="Points de livraison">
          <DataTable rows={c.deliveryPoints} onRowClick={manage ? (p) => setModal(p) : undefined} columns={[
            { label: 'Site', render: (p) => <span className="strong">{p.name}</span> }, { label: 'Adresse', key: 'address' }, { label: 'Commune', key: 'commune' }, { label: 'Contact', key: 'contactName' }, { label: 'Téléphone', key: 'phone' }, { label: 'Horaires', key: 'openingHours' },
          ]} empty={<Empty title="Aucun point de livraison">Le siège et les sites de réception peuvent être différents.</Empty>} />
        </Card>
        <div className="grid grid-2">
          <Card title="Dernières commandes">
            <DataTable rows={c.orders} columns={[
              { label: 'Numéro', render: (o) => <Link to={`/commandes/${o.id}`}>{o.number}</Link> }, { label: 'Date', render: (o) => date(o.createdAt) }, { label: 'État', render: (o) => <Status map={ORDER_STATUS} value={o.status} /> },
            ]} empty={<Empty title="Aucune commande" />} />
          </Card>
          <Card title="Dernières livraisons">
            <DataTable rows={c.deliveries} columns={[
              { label: 'Numéro', render: (d) => <Link to={`/livraisons/${d.id}`}>{d.number}</Link> }, { label: 'Prévue', render: (d) => date(d.scheduledAt) }, { label: 'État', render: (d) => <Status map={DELIVERY_STATUS} value={d.status} /> },
            ]} empty={<Empty title="Aucune livraison" />} />
          </Card>
        </div>
      </div>
      {modal === 'edit' && <FormModal title="Modifier le client" fields={customerFields} row={c} onClose={() => setModal(null)} onSubmit={async (v) => { await api.patch(`/customers/${id}`, v); close() }} />}
      {modal === 'point' && <FormModal wide title="Nouveau point de livraison" fields={pointFields} onClose={() => setModal(null)} onSubmit={async (v) => { await api.post(`/customers/${id}/delivery-points`, v); close() }} />}
      {modal?.id && <FormModal wide title="Modifier le point de livraison" fields={pointFields} row={modal} onClose={() => setModal(null)} onSubmit={async (v) => { await api.patch(`/customers/${id}/delivery-points/${modal.id}`, v); close() }} />}
    </>
  )
}
