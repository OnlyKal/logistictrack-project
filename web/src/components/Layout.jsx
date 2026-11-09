import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Bell, Boxes, Building2, CarFront, ChartNoAxesCombined, ClipboardCheck, ContactRound, CreditCard, Factory, FileClock, Layers, LayoutDashboard, LogOut, MapPin, Menu, Package, PackageCheck, Route, Search, Settings2, ShoppingCart, Tags, Truck, Users, UserCog, Warehouse, ArrowLeftRight,
} from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useFetch } from '../lib/hooks.js'
import { useLive } from '../lib/socket.js'
import { date, dateTime } from '../lib/format.js'
import { Alert, Button, Select, useToast } from './ui.jsx'
import { LogoMark } from './Logo.jsx'

const COMPANY_NAV = [
  { items: [{ to: '/', label: 'Tableau de bord', icon: LayoutDashboard, end: true }] },
  {
    group: 'Entrepôt',
    items: [
      { to: '/entrepots', label: 'Entrepôts', icon: Warehouse, perm: ['warehouse.view'] },
      { to: '/produits', label: 'Marchandises', icon: Package, perm: ['product.view'] },
      { to: '/stocks', label: 'Stocks', icon: Boxes, perm: ['stock.view'] },
      { to: '/transferts', label: 'Transferts', icon: ArrowLeftRight, perm: ['stock.view'] },
      { to: '/inventaires', label: 'Inventaires', icon: ClipboardCheck, perm: ['stock.view'] },
    ],
  },
  {
    group: 'Commercial',
    items: [
      { to: '/fournisseurs', label: 'Fournisseurs', icon: Factory, perm: ['supplier.manage'] },
      { to: '/bons-de-commande', label: 'Bons de commande', icon: Tags, perm: ['supplier.manage'] },
      { to: '/clients', label: 'Clients', icon: ContactRound, perm: ['customer.view'] },
      { to: '/commandes', label: 'Commandes', icon: ShoppingCart, perm: ['order.view'] },
    ],
  },
  {
    group: 'Distribution',
    items: [
      { to: '/colis', label: 'Colis', icon: PackageCheck, perm: ['package.manage', 'delivery.view'] },
      { to: '/livraisons', label: 'Livraisons', icon: Truck, perm: ['delivery.view'] },
      { to: '/tournees', label: 'Tournées', icon: Route, perm: ['route.manage'] },
      { to: '/suivi', label: 'Suivi en direct', icon: MapPin, perm: ['tracking.view'] },
      { to: '/chauffeurs', label: 'Chauffeurs', icon: Users, perm: ['driver.view'] },
      { to: '/vehicules', label: 'Véhicules', icon: CarFront, perm: ['vehicle.view'] },
    ],
  },
  {
    group: 'Pilotage',
    items: [
      { to: '/rapports', label: 'Rapports', icon: ChartNoAxesCombined, perm: ['reports.view'] },
      { to: '/utilisateurs', label: 'Utilisateurs', icon: UserCog, perm: ['user.manage'] },
      { to: '/agences', label: 'Agences', icon: Layers, perm: ['agency.manage'] },
      { to: '/abonnement', label: 'Abonnement', icon: CreditCard, perm: ['billing.manage'] },
      { to: '/journal', label: "Journal d'audit", icon: FileClock, perm: ['audit.view'] },
      { to: '/parametres', label: 'Paramètres', icon: Settings2, perm: ['company.manage'] },
    ],
  },
]
const ADMIN_NAV = [
  { items: [{ to: '/', label: 'Tableau de bord', icon: LayoutDashboard, end: true }] },
  {
    group: 'Plateforme',
    items: [
      { to: '/admin/entreprises', label: 'Entreprises', icon: Building2 },
      { to: '/admin/factures', label: 'Factures', icon: CreditCard },
      { to: '/admin/journal', label: "Journal d'audit", icon: FileClock },
      { to: '/mon-compte', label: 'Mon compte', icon: UserCog },
    ],
  },
]

/** Abonnement à échéance ou expiré : tous les membres de l'entreprise sont prévenus, sur toutes les pages. */
function SubscriptionBanner() {
  const { can } = useAuth()
  const location = useLocation()
  const { data } = useFetch('/subscriptions/status')
  if (!data || !['GRACE', 'EXPIRED'].includes(data.status) || location.pathname === '/abonnement') return null
  const next = can('billing.manage') ? <Link to="/abonnement">{data.status === 'EXPIRED' ? 'Se réabonner' : 'Renouveler'}</Link> : 'Contactez votre administrateur.'
  return (
    <div style={{ marginBottom: 16 }}>
      {data.status === 'EXPIRED'
        ? <Alert tone="error">Abonnement expiré : la plateforme est en lecture seule. Les missions déjà commencées peuvent se terminer. {next}</Alert>
        : <Alert tone="warn">Abonnement arrivé à échéance : période de grâce jusqu'au {date(data.graceEndsAt)}. {next}</Alert>}
    </div>
  )
}

function Notifications() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState({ items: [], unread: 0 })
  const toast = useToast()
  const load = () => api.get('/notifications?limit=20').then(setData).catch(() => null)
  useEffect(() => { load() }, [])
  useLive('notification', (n) => {
    toast(n.title)
    load()
  })
  const read = async (n) => {
    if (!n.readAt) await api.post(`/notifications/${n.id}/read`).catch(() => null)
    load()
  }
  return (
    <div className="relative">
      <Button variant="ghost" icon={Bell} onClick={() => setOpen(!open)} aria-label={`Notifications, ${data.unread} non lues`} />
      {data.unread > 0 && <span className="count-dot" aria-hidden>{data.unread > 99 ? '99+' : data.unread}</span>}
      {open && (
        <div className="popover">
          <div className="card-head"><span className="card-title">Notifications</span>{data.unread > 0 && <Button variant="ghost" onClick={async () => { await api.post('/notifications/read-all'); load() }}>Tout marquer lu</Button>}</div>
          {data.items.length === 0 && <div className="empty">Aucune notification</div>}
          {data.items.map((n) => {
            const to = n.refType === 'Delivery' ? `/livraisons/${n.refId}` : n.refType === 'Order' ? `/commandes/${n.refId}` : null
            const body = <><div className="strong">{n.title}</div><div className="muted small">{n.body}</div><div className="muted small">{dateTime(n.createdAt)}</div></>
            return to
              ? <Link key={n.id} to={to} className={`notif ${n.readAt ? '' : 'unread'}`} onClick={() => { read(n); setOpen(false) }}>{body}</Link>
              : <div key={n.id} className={`notif ${n.readAt ? '' : 'unread'}`} onClick={() => read(n)}>{body}</div>
          })}
        </div>
      )}
    </div>
  )
}

export function Layout() {
  const { user, can, logout, switchCompany, leaveCompany } = useAuth()
  const [menu, setMenu] = useState(false)
  const [search, setSearch] = useState('')
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => setMenu(false), [location.pathname])
  const isPlatform = user.isSuperAdmin && !user.company
  const nav = isPlatform ? ADMIN_NAV : COMPANY_NAV

  return (
    <div className="shell">
      <aside className={`sidebar ${menu ? 'open' : ''}`} aria-label="Navigation principale">
        <Link to="/" className="brand" style={{ textDecoration: 'none' }}><LogoMark />LogisticTrack</Link>
        {nav.map((section, i) => {
          const items = section.items.filter((item) => !item.perm || can(...item.perm))
          if (!items.length) return null
          return (
            <nav key={section.group ?? i} style={{ display: 'contents' }}>
              {section.group && <div className="nav-group">{section.group}</div>}
              {items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                  <item.icon size={18} strokeWidth={1.8} aria-hidden />{item.label}
                </NavLink>
              ))}
            </nav>
          )
        })}
      </aside>
      <div className="main">
        <header className="topbar">
          <Button className="menu-toggle" variant="ghost" icon={Menu} onClick={() => setMenu(!menu)} aria-label="Menu" />
          {!isPlatform && can('delivery.view') && (
            <form className="topbar-search hide-mobile" onSubmit={(e) => { e.preventDefault(); navigate(`/livraisons?q=${encodeURIComponent(search)}`) }}>
              <div className="input-icon"><Search size={15} aria-hidden /><input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher une livraison ou un client" aria-label="Rechercher une livraison ou un client" /></div>
            </form>
          )}
          <div className="spacer" />
          {user.companies?.length > 1 && (
            <Select aria-label="Entreprise active" style={{ width: 200 }} value={user.company?.id ?? ''} onChange={(e) => switchCompany(e.target.value).then(() => navigate('/'))} options={user.companies.map((c) => ({ value: c.id, label: c.name }))} />
          )}
          <Notifications />
          <div className="hide-mobile" style={{ textAlign: 'right', lineHeight: 1.25 }}>
            <div className="strong">{user.fullName}</div>
            <div className="muted small">{isPlatform ? 'Super Administrateur' : `${user.roleLabel ?? ''} · ${user.company?.tradeName ?? ''}`}</div>
          </div>
          <Button variant="ghost" icon={LogOut} onClick={logout} aria-label="Se déconnecter" title="Se déconnecter" />
        </header>
        {user.managing && (
          <div className="managing-bar">
            <span>Super Administrateur : vous gérez <strong>{user.company.tradeName}</strong>. Vos actions sont inscrites dans son journal.</span>
            <Button onClick={async () => { const id = user.company.id; await leaveCompany(); navigate(`/admin/entreprises/${id}`) }}>Quitter cette entreprise</Button>
          </div>
        )}
        <main className="content" key={location.pathname}>{!isPlatform && <SubscriptionBanner />}<Outlet /></main>
      </div>
    </div>
  )
}
