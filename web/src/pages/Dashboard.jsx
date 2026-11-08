import { Link } from 'react-router-dom'
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Boxes, Building2, CalendarClock, CheckCircle2, ClipboardList, CircleDollarSign, ContactRound, CarFront, PackageX, Percent, ShoppingCart, Truck, Users, Warehouse, XCircle,
} from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { useFetch } from '../lib/hooks.js'
import { useLive } from '../lib/socket.js'
import { DELIVERY_STATUS, MOVEMENT_REASONS, SUBSCRIPTION_STATUS, dateTime, money, num, qty } from '../lib/format.js'
import { Card, DataTable, Empty, ErrorBox, PageHead, Stat, Status } from '../components/ui.jsx'

function Platform() {
  const { data, loading, error } = useFetch('/admin/dashboard')
  if (error) return <ErrorBox error={error} />
  const d = data ?? {}
  return (
    <>
      <PageHead title="Vue de la plateforme" sub="Indicateurs globaux, sans accès aux opérations des entreprises." />
      <div className="stack">
        <div className="grid grid-stats">
          <Stat loading={loading} label="Entreprises" value={num(d.companies)} icon={Building2} />
          <Stat loading={loading} label="Entreprises actives" value={num(d.active)} icon={CheckCircle2} />
          <Stat loading={loading} label="Suspendues" value={num(d.suspended)} icon={XCircle} />
          <Stat loading={loading} label="Entrepôts" value={num(d.warehouses)} icon={Warehouse} />
          <Stat loading={loading} label="Utilisateurs" value={num(d.users)} icon={Users} />
          <Stat loading={loading} label="Chauffeurs" value={num(d.drivers)} icon={Truck} />
          <Stat loading={loading} label="Livraisons" value={num(d.deliveries)} icon={ClipboardList} />
          <Stat loading={loading} label="Taux de réussite" value={d.successRate === null || d.successRate === undefined ? '—' : `${num(d.successRate)} %`} icon={Percent} note="Livraisons terminées" />
        </div>
        <div className="grid grid-2">
          <Card title="Abonnements en cours">
            <DataTable loading={loading} rows={d.subscriptions ?? []} rowKey={(r) => r.status} columns={[
              { label: 'État', render: (r) => <Status map={SUBSCRIPTION_STATUS} value={r.status} /> },
              { label: 'Entreprises', num: true, render: (r) => num(r.count) },
            ]} empty={<Empty title="Aucun abonnement" />} />
          </Card>
          <Card title="Revenus encaissés">
            <DataTable loading={loading} rows={d.revenue ?? []} rowKey={(r) => r.currency} columns={[
              { label: 'Devise', key: 'currency' },
              { label: 'Montant', num: true, render: (r) => money(r.amount, r.currency) },
            ]} empty={<Empty icon={CircleDollarSign} title="Aucun paiement encaissé" />} />
          </Card>
        </div>
      </div>
    </>
  )
}

function CompanyDashboard() {
  const { user, can } = useAuth()
  const { data, loading, error, reload } = useFetch('/dashboard/overview')
  useLive('delivery.status', reload)
  useLive('stock.changed', reload)
  if (error) return <ErrorBox error={error} />
  const d = data ?? {}
  const logistics = can('delivery.view')
  return (
    <>
      <PageHead title={`Bonjour, ${user.fullName.split(' ')[0]}`} sub={`${user.company?.tradeName} · données à jour en temps réel`} />
      <div className="stack">
        <div className="grid grid-stats">
          {logistics && <Stat loading={loading} label="Prévues aujourd'hui" value={num(d.deliveriesToday)} icon={CalendarClock} />}
          {logistics && <Stat loading={loading} label="En cours" value={num(d.inProgress)} icon={Truck} />}
          {logistics && <Stat loading={loading} label="Livrées aujourd'hui" value={num(d.deliveredToday)} icon={CheckCircle2} />}
          {logistics && <Stat loading={loading} label="Échecs à traiter" value={num(d.failed)} icon={XCircle} />}
          {logistics && <Stat loading={loading} label="En retard" value={num(d.late)} icon={AlertTriangle} />}
          {can('order.view') && <Stat loading={loading} label="Commandes ouvertes" value={num(d.ordersOpen)} icon={ShoppingCart} />}
          {can('stock.view') && <Stat loading={loading} label="Stock disponible" value={num(d.totalAvailable)} note={`${num(d.reserved)} réservé · ${num(d.damaged)} endommagé`} icon={Boxes} />}
          {can('reports.view') && can('stock.view') && <Stat loading={loading} label="Valeur du stock" value={money(d.stockValue)} note="Au coût unitaire" icon={CircleDollarSign} />}
          {can('stock.view') && <Stat loading={loading} label="Entrées du jour" value={num(d.entriesToday)} icon={ArrowDownToLine} />}
          {can('stock.view') && <Stat loading={loading} label="Sorties du jour" value={num(d.exitsToday)} icon={ArrowUpFromLine} />}
          <Stat loading={loading} label="Entrepôts actifs" value={num(d.warehouses)} icon={Warehouse} note={`${num(d.pendingTransfers)} transfert(s) · ${num(d.openInventories)} inventaire(s) ouverts`} />
          {can('customer.view') && <Stat loading={loading} label="Clients" value={num(d.customers)} icon={ContactRound} />}
          {can('driver.view') && <Stat loading={loading} label="Chauffeurs" value={num(d.drivers)} note={`${num(d.activeDrivers)} en mission`} icon={Users} />}
          {can('vehicle.view') && <Stat loading={loading} label="Véhicules disponibles" value={num(d.vehiclesAvailable)} icon={CarFront} />}
        </div>
        <div className="grid grid-2">
          {logistics && (
            <Card title="Livraisons récentes" actions={<Link to="/livraisons" className="small">Tout voir</Link>}>
              <DataTable loading={loading} rows={d.recentDeliveries ?? []} columns={[
                { label: 'Numéro', render: (r) => <Link to={`/livraisons/${r.id}`} className="strong">{r.number}</Link> },
                { label: 'Client', render: (r) => r.customer.name },
                { label: 'État', render: (r) => <Status map={DELIVERY_STATUS} value={r.status} /> },
              ]} empty={<Empty icon={Truck} title="Aucune livraison" />} />
            </Card>
          )}
          {can('stock.view') && (
            <Card title="Mouvements récents" actions={<Link to="/stocks" className="small">Tout voir</Link>}>
              <DataTable loading={loading} rows={d.recentMovements ?? []} columns={[
                { label: 'Marchandise', render: (r) => r.product.name },
                { label: 'Motif', render: (r) => MOVEMENT_REASONS[r.reason] ?? r.reason },
                { label: 'Quantité', num: true, render: (r) => `${r.direction === 'IN' ? '+' : '−'}${qty(r.quantity, r.product.baseUnit)}` },
                { label: 'Date', render: (r) => <span className="muted">{dateTime(r.createdAt)}</span> },
              ]} empty={<Empty icon={Boxes} title="Aucun mouvement" />} />
            </Card>
          )}
          {can('stock.view') && (d.lowStock?.length ?? 0) > 0 && (
            <Card title="Stock faible">
              <DataTable rows={d.lowStock} rowKey={(r) => r.name} columns={[
                { label: 'Marchandise', render: (r) => <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}><PackageX size={15} aria-hidden />{r.name}</span> },
                { label: 'Disponible', num: true, render: (r) => qty(r.qty, r.unit) },
                { label: 'Seuil', num: true, render: (r) => qty(r.level, r.unit) },
              ]} />
            </Card>
          )}
        </div>
      </div>
    </>
  )
}

export function Dashboard() {
  const { user } = useAuth()
  if (user.isSuperAdmin && !user.company) return <Platform />
  if (user.role === 'DRIVER') return <Empty icon={Truck} title="Espace chauffeur">Vos missions se gèrent depuis l'application mobile LogisticTrack.</Empty>
  return <CompanyDashboard />
}
