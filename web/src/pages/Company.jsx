import { useEffect, useState } from 'react'
import { FileSpreadsheet, FileText, FileType2 } from 'lucide-react'
import { api, query } from '../lib/api.js'
import { useFetch, useList } from '../lib/hooks.js'
import { date, dateTime, DELIVERY_STATUS, durationLabel, INVOICE_STATUS, money, num, SUBSCRIPTION_STATUS } from '../lib/format.js'
import { FormFields, ResetPasswordModal, serialize, useOptions } from '../components/CrudPage.jsx'
import { namedOption } from '../components/LineItems.jsx'
import { Alert, Button, Card, Checkbox, DataTable, Empty, ErrorBox, Field, Input, Modal, PageHead, Pagination, SearchInput, Select, Status, Textarea, useAction, useToast } from '../components/ui.jsx'
import { useAuth } from '../lib/auth.jsx'
import { invitationMessage } from './admin/Admin.jsx'
import { EmailLog } from '../components/EmailLog.jsx'

const REPORTS = { deliveries: 'Livraisons', stocks: 'Stocks', drivers: 'Chauffeurs', warehouses: 'Entrepôts' }

export function Reports() {
  const [type, setType] = useState('deliveries')
  const [f, setF] = useState({ from: '', to: '', status: '', warehouseId: '', driverId: '', customerId: '', commune: '' })
  const warehouses = useOptions('/warehouses?limit=200', namedOption)
  const q = query(type === 'deliveries' ? f : type === 'stocks' ? { warehouseId: f.warehouseId } : { from: f.from, to: f.to })
  const { data, loading, error } = useFetch(`/reports/${type}${q}`)
  const { run, busy } = useAction()
  const exportAs = (format) => run(() => api.download(`/reports/${type}${q}${q ? '&' : '?'}format=${format}`, `${type}.${format}`))
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const rows = data?.rows ?? []
  return (
    <>
      <PageHead title="Rapports" sub="Calculés depuis les opérations enregistrées." actions={<>
        <Button icon={FileText} disabled={busy} onClick={() => exportAs('pdf')}>PDF</Button><Button icon={FileSpreadsheet} disabled={busy} onClick={() => exportAs('xlsx')}>Excel</Button><Button icon={FileType2} disabled={busy} onClick={() => exportAs('csv')}>CSV</Button>
      </>} />
      <Card>
        <div className="toolbar">
          <Select style={{ width: 170 }} aria-label="Rapport" value={type} onChange={(e) => setType(e.target.value)} options={Object.entries(REPORTS).map(([value, label]) => ({ value, label }))} />
          {type !== 'stocks' && <><Input style={{ width: 150 }} type="date" aria-label="Du" value={f.from} onChange={set('from')} /><Input style={{ width: 150 }} type="date" aria-label="Au" value={f.to} onChange={set('to')} /></>}
          {['deliveries', 'stocks'].includes(type) && <Select style={{ width: 190 }} aria-label="Entrepôt" value={f.warehouseId} onChange={set('warehouseId')} placeholder="Tous les entrepôts" options={warehouses} />}
          {type === 'deliveries' && <Select style={{ width: 180 }} aria-label="État" value={f.status} onChange={set('status')} placeholder="Tous les états" options={Object.entries(DELIVERY_STATUS).map(([value, [label]]) => ({ value, label }))} />}
          {type === 'deliveries' && <Input style={{ width: 150 }} aria-label="Commune" placeholder="Commune" value={f.commune} onChange={set('commune')} />}
        </div>
        <DataTable loading={loading} error={error} rows={rows} rowKey={(r) => JSON.stringify(r)} columns={(data?.columns ?? [{ key: 'x', label: 'Chargement' }]).map((c) => ({
          label: c.label, num: rows.length > 0 && typeof rows[0][c.key] === 'number',
          render: (r) => { const v = r[c.key]; if (typeof v === 'number') return num(v); if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return dateTime(v); return v || '—' },
        }))} empty={<Empty title="Aucune donnée sur cette période" />} />
      </Card>
    </>
  )
}

function UserModal({ row, roles, onClose, onDone }) {
  const toast = useToast()
  const warehouses = useOptions('/warehouses?limit=200', namedOption)
  const [v, setV] = useState({ fullName: row?.fullName ?? '', email: row?.email ?? '', phone: row?.phone ?? '', password: '', role: row?.role ?? 'WAREHOUSE_MANAGER' })
  const [perms, setPerms] = useState(row?.customPermissions ?? [])
  const [scope, setScope] = useState(row?.warehouseIds ?? [])
  const [restricted, setRestricted] = useState(row ? !row.allWarehouses : false)
  const [error, setError] = useState(null)
  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    try {
      const rights = { role: v.role, customPermissions: v.role === 'SECONDARY_ADMIN' ? perms : undefined, warehouseIds: restricted ? scope : undefined }
      if (row) {
        await api.patch(`/users/${row.id}`, { fullName: v.fullName, phone: v.phone || null })
        await api.post(`/users/${row.id}/assign-role`, rights)
      } else {
        const created = await api.post('/users', { fullName: v.fullName, email: v.email, phone: v.phone || undefined, password: v.password || undefined, ...rights })
        const [message, tone] = invitationMessage('Utilisateur créé')(created)
        toast(message, tone)
        onDone()
        return
      }
      toast('Utilisateur enregistré.')
      onDone()
    } catch (err) { setError(err) }
  }
  return (
    <form onSubmit={submit}>
      <Modal wide title={row ? `Modifier : ${row.fullName}` : 'Nouvel utilisateur'} onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary">Enregistrer</Button></>}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Nom complet *"><Input required value={v.fullName} onChange={(e) => setV({ ...v, fullName: e.target.value })} /></Field>
          <Field label="Téléphone"><Input value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></Field>
          {!row && <Field label="E-mail *"><Input required type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>}
          {!row && <Field label="Mot de passe initial" hint="Laissez vide (recommandé) : la personne reçoit un e-mail pour choisir le sien."><Input type="password" minLength={8} autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} /></Field>}
          <Field label="Rôle *" className="span-2"><Select value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })} options={roles.roles.map((r) => ({ value: r.code, label: r.label }))} /></Field>
        </div>
        {v.role === 'SECONDARY_ADMIN' && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="field-label">Permissions attribuées</span>
            <div className="form-grid" style={{ gap: 6 }}>
              {roles.permissions.map((p) => <Checkbox key={p} label={<span className="mono">{p}</span>} checked={perms.includes(p)} onChange={(e) => setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))} />)}
            </div>
          </div>
        )}
        <Checkbox label="Limiter à certains entrepôts" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />
        {restricted && (
          <div className="form-grid" style={{ gap: 6 }}>
            {warehouses.map((w) => <Checkbox key={w.value} label={w.label} checked={scope.includes(w.value)} onChange={(e) => setScope(e.target.checked ? [...scope, w.value] : scope.filter((x) => x !== w.value))} />)}
          </div>
        )}
      </Modal>
    </form>
  )
}

export function Users() {
  const [q, setQ] = useState('')
  const { items, meta, loading, error, reload } = useList(`/users${query({ q, limit: 100 })}`)
  const roles = useFetch('/users/roles')
  const [modal, setModal] = useState(null)
  const [passwordFor, setPasswordFor] = useState(null)
  const { run } = useAction()
  const toggle = async (u) => {
    await run(() => api.post(`/users/${u.id}/${u.isActive ? 'deactivate' : 'activate'}`), u.isActive ? 'Utilisateur désactivé.' : 'Utilisateur réactivé.')
    reload()
  }
  const reinvite = (u) => run(() => api.post(`/users/${u.id}/invite`), `Invitation renvoyée à ${u.email}.`)
  return (
    <>
      <PageHead title="Utilisateurs" sub="Rôles et périmètre par entrepôt. Les chauffeurs se gèrent depuis leur fiche." actions={<Button variant="primary" onClick={() => setModal('new')} disabled={!roles.data}>Ajouter</Button>} />
      <Card>
        <div className="toolbar"><SearchInput value={q} onChange={setQ} /></div>
        <DataTable loading={loading} error={error} rows={items} columns={[
          { label: 'Nom', render: (u) => <span className="strong">{u.fullName}</span> }, { label: 'E-mail', key: 'email' }, { label: 'Rôle', key: 'roleLabel' },
          { label: 'Périmètre', render: (u) => (u.allWarehouses ? 'Toute l\'entreprise' : `${u.warehouseIds.length} entrepôt(s)`) }, { label: 'Dernière connexion', render: (u) => (u.lastLoginAt ? dateTime(u.lastLoginAt) : <Status map={{ pending: ['Jamais connecté', 'orange'] }} value="pending" />) },
          { label: 'État', render: (u) => <Status map={{ true: ['Actif', 'green'], false: ['Désactivé', 'neutral'] }} value={String(u.isActive)} /> },
          { label: '', render: (u) => <div className="actions"><Button onClick={() => setModal(u)} disabled={!roles.data}>Modifier</Button>{!u.lastLoginAt && u.isActive && <Button onClick={() => reinvite(u)}>Renvoyer l'invitation</Button>}<Button onClick={() => setPasswordFor(u)}>Mot de passe</Button><Button variant={u.isActive ? 'danger' : undefined} onClick={() => toggle(u)}>{u.isActive ? 'Désactiver' : 'Réactiver'}</Button></div> },
        ]} />
        <Pagination meta={meta} onPage={() => {}} />
      </Card>
      {modal && <UserModal row={modal === 'new' ? null : modal} roles={roles.data} onClose={() => setModal(null)} onDone={() => { setModal(null); reload() }} />}
      {passwordFor && <ResetPasswordModal endpoint={`/users/${passwordFor.id}/reset-password`} name={passwordFor.fullName} email={passwordFor.email} allowLink onClose={() => setPasswordFor(null)} />}
    </>
  )
}

export function Subscription() {
  const current = useFetch('/subscriptions/current')
  const invoices = useFetch('/subscriptions/invoices')
  const { run, busy } = useAction()
  const reload = () => { current.reload(); invoices.reload() }
  const sub = current.data?.subscription
  const usage = current.data?.usage ?? {}
  const pending = invoices.data?.find((i) => i.status === 'UNPAID')
  const ended = sub?.status === 'EXPIRED'
  const trial = sub?.status === 'TRIAL'
  const limit = (label, used, max) => (
    <div key={label}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}><span>{label}</span><span className="muted">{num(used)} / {max === null || max === undefined ? 'illimité' : num(max)}</span></div>
      {max ? <div className="bar"><span style={{ width: `${Math.min(100, (used / max) * 100)}%` }} /></div> : null}
    </div>
  )
  return (
    <>
      <PageHead title="Abonnement" sub="Montant, consommation et factures." />
      <ErrorBox error={current.error} />
      {sub && ['GRACE', 'EXPIRED'].includes(sub.status) && <div style={{ marginBottom: 16 }}><Alert tone={sub.status === 'EXPIRED' ? 'error' : 'warn'}>{sub.status === 'EXPIRED' ? "Abonnement expiré : la plateforme est en lecture seule jusqu'au paiement." : `Période de grâce jusqu'au ${date(sub.graceEndsAt)}. Renouvelez pour éviter la suspension.`}</Alert></div>}
      <div className="stack">
        <div className="grid grid-2">
          <Card title="Mon abonnement" pad>
            {sub ? (
              <dl className="kv">
                <dt>Montant mensuel</dt><dd className="strong">{money(sub.monthlyAmount, sub.currency)}</dd><dt>État</dt><dd><Status map={SUBSCRIPTION_STATUS} value={sub.status} /></dd>
                <dt>Échéance</dt><dd>{date(sub.endsAt)}</dd><dt>Durée</dt><dd>{trial ? 'Essai gratuit' : `${sub.durationMonths} mois`}</dd><dt>Suivi GPS</dt><dd>{sub.gpsEnabled ? 'Inclus' : 'Non inclus'}</dd>
              </dl>
            ) : <Empty title="Aucun abonnement" />}
          </Card>
          <Card title="Consommation" pad>
            {sub && <div className="stack" style={{ gap: 12 }}>
              {limit('Entrepôts', usage.warehouses, sub.maxWarehouses)}{limit('Utilisateurs', usage.users, sub.maxUsers)}{limit('Chauffeurs', usage.drivers, sub.maxDrivers)}{limit('Véhicules', usage.vehicles, sub.maxVehicles)}{limit('Livraisons ce mois-ci', usage.deliveries, sub.maxDeliveriesMonth)}
            </div>}
          </Card>
        </div>
        {pending && <Alert tone="warn">Facture {pending.number} de {money(pending.amount, pending.currency)} pour {durationLabel(pending.durationMonths, pending.discountPercent)} en attente. Le paiement en ligne arrivera plus tard : votre abonnement sera mis à jour dès que LogisticTrack aura enregistré votre règlement.</Alert>}
        <Card title={trial ? "S'abonner" : ended ? 'Se réabonner' : 'Changer de durée ou prolonger'}>
          {sub && <div className="toolbar muted small">{ended ? "Le nouvel abonnement démarrera dès l'enregistrement du règlement." : trial ? `Essai gratuit jusqu'au ${date(sub.endsAt)}. Votre abonnement prendra le relais à cette date.` : `La durée choisie s'applique après l'échéance du ${date(sub.endsAt)}. Le montant mensuel reste celui de votre abonnement.`}</div>}
          <DataTable rows={current.data?.durations ?? []} rowKey={(d) => d.durationMonths} columns={[
            { label: 'Durée', render: (d) => <span className="strong">{d.durationMonths} mois</span> }, { label: 'Sans remise', num: true, render: (d) => money(d.gross, sub.currency) }, { label: 'Remise', num: true, render: (d) => (d.discountPercent ? `${d.discountPercent} %` : '—') },
            { label: 'À payer', num: true, render: (d) => <span className="strong">{money(d.total, sub.currency)}</span> },
            { label: '', render: (d) => (pending?.durationMonths === d.durationMonths
              ? <span className="muted small">Facture en attente</span>
              : <Button disabled={busy} onClick={async () => { await run(() => api.post('/subscriptions/renew', { durationMonths: d.durationMonths }), pending ? 'Durée changée : la facture en attente est remplacée.' : 'Facture émise.'); reload() }}>{trial ? "S'abonner" : ended ? 'Se réabonner' : 'Choisir'}</Button>) },
          ]} />
        </Card>
        <Card title="Factures">
          <DataTable loading={invoices.loading} rows={invoices.data ?? []} columns={[
            { label: 'Numéro', render: (i) => <span className="mono">{i.number}</span> }, { label: 'Période', render: (i) => `${date(i.periodStart)} — ${date(i.periodEnd)}` }, { label: 'Durée', render: (i) => durationLabel(i.durationMonths, i.discountPercent) }, { label: 'Montant', num: true, render: (i) => money(i.amount, i.currency) }, { label: 'État', render: (i) => <Status map={INVOICE_STATUS} value={i.status} /> },
          ]} empty={<Empty title="Aucune facture" />} />
        </Card>
      </div>
    </>
  )
}

export function AuditPage({ endpoint = '/audit-logs', showCompany }) {
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const { items, meta, loading, error } = useList(`${endpoint}${query({ q, page })}`)
  return (
    <>
      <PageHead title="Journal d'audit" sub="Actions sensibles : auteur, date et détail." />
      <Card>
        <div className="toolbar"><SearchInput value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Action, par exemple delivery.confirm" style={{ width: 320 }} /></div>
        <DataTable loading={loading} error={error} rows={items} columns={[
          { label: 'Date', render: (l) => dateTime(l.createdAt) }, ...(showCompany ? [{ label: 'Entreprise', render: (l) => l.company?.tradeName ?? 'Plateforme' }] : []),
          { label: 'Auteur', render: (l) => l.user?.fullName ?? 'Système' }, { label: 'Action', render: (l) => <span className="mono">{l.action}</span> }, { label: 'Élément', render: (l) => l.entity ?? '—' }, { label: 'Adresse IP', render: (l) => l.ip ?? '—' },
        ]} empty={<Empty title="Aucune entrée" />} />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
    </>
  )
}

const companyFields = [
  { name: 'tradeName', label: 'Nom commercial', required: true }, { name: 'legalName', label: 'Raison sociale' }, { name: 'taxId', label: 'NIF' }, { name: 'rccm', label: 'RCCM' },
  { name: 'email', label: 'E-mail', type: 'email', required: true }, { name: 'phone', label: 'Téléphone' }, { name: 'address', label: 'Adresse du siège', wide: true }, { name: 'country', label: 'Pays' }, { name: 'province', label: 'Province' }, { name: 'city', label: 'Ville' }, { name: 'sector', label: "Secteur d'activité" },
  { name: 'description', label: 'Description', type: 'textarea', wide: true },
]

export function Settings() {
  const { data, error, reload } = useFetch('/companies/current')
  const { run, busy } = useAction()
  const [profile, setProfile] = useState(null)
  const [settings, setSettings] = useState(null)
  const [template, setTemplate] = useState(null)
  const templates = useFetch('/notification-templates')
  const { user } = useAuth()
  const [pwd, setPwd] = useState({ current: '', next: '' })
  useEffect(() => {
    if (!data) return
    setProfile(Object.fromEntries(companyFields.map((f) => [f.name, data[f.name] ?? ''])))
    setSettings(data.settings)
  }, [data])
  if (error) return <ErrorBox error={error} />
  if (!profile || !settings) return null
  const toggle = (k) => ({ checked: !!settings[k], onChange: (e) => setSettings({ ...settings, [k]: e.target.checked }) })
  const saveSettings = () => {
    const { companyId: _c, ...body } = settings
    return run(() => api.put('/companies/current/settings', { ...body, gpsRetentionDays: Number(body.gpsRetentionDays) }), 'Paramètres enregistrés.')
  }
  return (
    <>
      <PageHead title="Paramètres" sub={user.company?.tradeName} />
      <div className="grid grid-2">
        <Card title="Profil de l'entreprise" pad>
          <div className="stack">
            <FormFields fields={companyFields} values={profile} setValues={setProfile} isEdit />
            <Field label="Logo" hint="PNG ou JPEG, affiché sur les documents PDF."><input type="file" accept="image/png,image/jpeg" onChange={(e) => e.target.files[0] && run(() => api.upload('/companies/current/logo', e.target.files[0]), 'Logo enregistré.')} /></Field>
            <div><Button variant="primary" loading={busy} onClick={async () => { await run(() => api.patch('/companies/current', serialize(companyFields, profile, true)), 'Profil enregistré.'); reload() }}>Enregistrer</Button></div>
          </div>
        </Card>
        <div className="stack">
          <Card title="Preuves de livraison exigées" pad>
            <div className="stack" style={{ gap: 10 }}>
              <Checkbox label="Signature du réceptionnaire" {...toggle('requireSignature')} />
              <Checkbox label="Nom du réceptionnaire" {...toggle('requireRecipientName')} />
              <Checkbox label="Photo de la marchandise ou du lieu" {...toggle('requirePhoto')} />
              <Checkbox label="Position GPS à la confirmation" hint="Une livraison ne pourra pas être confirmée sans signal GPS." {...toggle('requireGpsOnProof')} />
              <Checkbox label="Scan QR de tous les colis au chargement" {...toggle('requireQrOnLoad')} />
            </div>
          </Card>
          <Card title="Opérations" pad>
            <div className="stack">
              <Field label="Stratégie de sortie de stock"><Select value={settings.stockStrategy} onChange={(e) => setSettings({ ...settings, stockStrategy: e.target.value })} options={[{ value: 'FIFO', label: 'FIFO : premier entré, premier sorti' }, { value: 'FEFO', label: 'FEFO : première expiration, première sortie' }]} /></Field>
              <Checkbox label="Emplacement obligatoire à la réception" {...toggle('useLocations')} />
              <Checkbox label="Les chauffeurs peuvent refuser une mission" {...toggle('driversCanRefuse')} />
              <Field label="Conservation de l'historique GPS (jours)"><Input type="number" min="1" max="3650" value={settings.gpsRetentionDays} onChange={(e) => setSettings({ ...settings, gpsRetentionDays: e.target.value })} /></Field>
              <div className="form-grid">
                <Field label="Devise"><Input maxLength={3} value={settings.currency} onChange={(e) => setSettings({ ...settings, currency: e.target.value.toUpperCase() })} /></Field>
                <Field label="Fuseau horaire"><Input value={settings.timezone} onChange={(e) => setSettings({ ...settings, timezone: e.target.value })} /></Field>
              </div>
              <div><Button variant="primary" loading={busy} onClick={saveSettings}>Enregistrer</Button></div>
            </div>
          </Card>
          <Card title="E-mails aux clients" pad>
            <div className="stack" style={{ gap: 10 }}>
              <p className="muted small" style={{ margin: 0 }}>Envoyés à l'adresse e-mail du client, à vos couleurs (logo, nom, coordonnées). Ses réponses vous parviennent. Un client peut les refuser depuis sa fiche.</p>
              <Checkbox label="Livraison en route" hint="Avec le nom du chauffeur, le véhicule et un lien de suivi." {...toggle('customerEmailEnRoute')} />
              <Checkbox label="Livraison effectuée" hint="Avec l'accusé de réception en PDF : signature, nom du réceptionnaire, écarts éventuels." {...toggle('customerEmailDelivered')} />
              <Checkbox label="Livraison non effectuée" hint="Avec le motif. Un rappel du chauffeur par vos soins reste interne." {...toggle('customerEmailFailed')} />
              <div><Button variant="primary" loading={busy} onClick={saveSettings}>Enregistrer</Button></div>
            </div>
          </Card>
          <Card title="Mon mot de passe" pad>
            <form className="stack" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api.post('/auth/password/change', pwd), 'Mot de passe modifié.'); if (r.ok) setPwd({ current: '', next: '' }) }}>
              <Field label="Mot de passe actuel"><Input required type="password" autoComplete="current-password" value={pwd.current} onChange={(e) => setPwd({ ...pwd, current: e.target.value })} /></Field>
              <Field label="Nouveau mot de passe"><Input required type="password" minLength={8} autoComplete="new-password" value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} /></Field>
              <div><Button type="submit">Modifier</Button></div>
            </form>
          </Card>
        </div>
        <Card title="E-mails envoyés" style={{ gridColumn: '1 / -1' }}>
          <EmailLog endpoint="/emails/log" />
        </Card>
        <Card title="Modèles de notifications" style={{ gridColumn: '1 / -1' }}>
          <DataTable loading={templates.loading} rows={templates.data ?? []} rowKey={(t) => t.type} onRowClick={setTemplate} columns={[
            { label: 'Événement', render: (t) => <span className="mono">{t.type}</span> }, { label: 'Titre', key: 'title' }, { label: 'Message', key: 'body' }, { label: '', render: (t) => (t.isCustom ? 'Personnalisé' : 'Par défaut') },
          ]} />
        </Card>
      </div>
      {template && (
        <Modal title={`Modèle : ${template.type}`} onClose={() => setTemplate(null)} footer={<><Button onClick={() => setTemplate(null)}>Annuler</Button><Button variant="primary" onClick={async () => { await run(() => api.put(`/notification-templates/${template.type}`, { title: template.title, body: template.body }), 'Modèle enregistré.'); setTemplate(null); templates.reload() }}>Enregistrer</Button></>}>
          <Field label="Titre"><Input value={template.title} onChange={(e) => setTemplate({ ...template, title: e.target.value })} /></Field>
          <Field label="Message" hint="Les variables entre doubles accolades sont remplacées automatiquement."><Textarea value={template.body} onChange={(e) => setTemplate({ ...template, body: e.target.value })} /></Field>
        </Modal>
      )}
    </>
  )
}

