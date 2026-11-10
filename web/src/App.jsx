import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth.jsx'
import { Layout } from './components/Layout.jsx'
import { Empty, ToastProvider } from './components/ui.jsx'
import { ForgotPassword, Login } from './pages/public.jsx'
import { PublicTracking, ShipmentTracking } from './pages/PublicTracking.jsx'
import { ShipmentDetail, Shipments } from './pages/Shipments.jsx'
import { Dashboard } from './pages/Dashboard.jsx'
import { Agencies, CustomerDetail, Customers, ProductDetail, Products, PurchaseOrders, Suppliers, WarehouseDetail, Warehouses } from './pages/Catalog.jsx'
import { Inventories, InventoryDetail, Stocks, Transfers } from './pages/Stock.jsx'
import { OrderDetail, Orders } from './pages/Orders.jsx'
import { Deliveries, DeliveryDetail, DriverDetail, Drivers, Packages, RouteDetail, RoutesPage, Vehicles } from './pages/Distribution.jsx'
import { AuditPage, Reports, Settings, Subscription, Users } from './pages/Company.jsx'
import { LiveTracking } from './pages/LiveTracking.jsx'
import { Companies, CompanyDetail, Invoices, MyAccount } from './pages/admin/Admin.jsx'

function Protected() {
  const { user, ready, offline } = useAuth()
  if (!ready) return offline ? <div className="reconnecting" role="status">Connexion au serveur… Votre session est conservée.</div> : null
  if (!user) return <Navigate to="/connexion" replace />
  return <Layout />
}

function AppRoutes() {
  const { user, ready } = useAuth()
  const guest = (page) => (ready && user ? <Navigate to="/" replace /> : page)
  return (
    <Routes>
      <Route path="/connexion" element={guest(<Login />)} />
      <Route path="/mot-de-passe-oublie" element={guest(<ForgotPassword />)} />
      <Route path="/suivi-colis" element={<PublicTracking />} />
      <Route path="/suivi-colis/:token" element={<PublicTracking />} />
      <Route path="/suivi-expedition/:token" element={<ShipmentTracking />} />
      <Route element={<Protected />}>
        <Route index element={<Dashboard />} />
        <Route path="entrepots" element={<Warehouses />} />
        <Route path="entrepots/:id" element={<WarehouseDetail />} />
        <Route path="produits" element={<Products />} />
        <Route path="produits/:id" element={<ProductDetail />} />
        <Route path="stocks" element={<Stocks />} />
        <Route path="transferts" element={<Transfers />} />
        <Route path="inventaires" element={<Inventories />} />
        <Route path="inventaires/:id" element={<InventoryDetail />} />
        <Route path="fournisseurs" element={<Suppliers />} />
        <Route path="bons-de-commande" element={<PurchaseOrders />} />
        <Route path="clients" element={<Customers />} />
        <Route path="clients/:id" element={<CustomerDetail />} />
        <Route path="commandes" element={<Orders />} />
        <Route path="commandes/:id" element={<OrderDetail />} />
        <Route path="colis" element={<Packages />} />
        <Route path="livraisons" element={<Deliveries />} />
        <Route path="livraisons/:id" element={<DeliveryDetail />} />
        <Route path="expeditions" element={<Shipments />} />
        <Route path="expeditions/:id" element={<ShipmentDetail />} />
        <Route path="tournees" element={<RoutesPage />} />
        <Route path="tournees/:id" element={<RouteDetail />} />
        <Route path="suivi" element={<LiveTracking />} />
        <Route path="chauffeurs" element={<Drivers />} />
        <Route path="chauffeurs/:id" element={<DriverDetail />} />
        <Route path="vehicules" element={<Vehicles />} />
        <Route path="rapports" element={<Reports />} />
        <Route path="utilisateurs" element={<Users />} />
        <Route path="agences" element={<Agencies />} />
        <Route path="abonnement" element={<Subscription />} />
        <Route path="journal" element={<AuditPage />} />
        <Route path="parametres" element={<Settings />} />
        <Route path="admin/entreprises" element={<Companies />} />
        <Route path="admin/entreprises/:id" element={<CompanyDetail />} />
        <Route path="admin/factures" element={<Invoices />} />
        <Route path="mon-compte" element={<MyAccount />} />
        <Route path="admin/journal" element={<AuditPage endpoint="/admin/audit-logs" showCompany />} />
        <Route path="*" element={<Empty title="Page introuvable" />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
