import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { useAuth } from '../../lib/auth.jsx'
import { useFetch, useList } from '../../lib/hooks.js'
import { COMPANY_STATUS, INVOICE_STATUS, SUBSCRIPTION_STATUS, date, dateTime, durationLabel, money, num } from '../../lib/format.js'
import { BackLink, CrudPage, FormModal, ResetPasswordModal } from '../../components/CrudPage.jsx'
import { KeyRound } from 'lucide-react'
import { EmailLog } from '../../components/EmailLog.jsx'
import { Alert, Button, Card, Checkbox, Confirm, DataTable, Empty, ErrorBox, Field, Input, PageHead, Select, Status, useAction } from '../../components/ui.jsx'

/** Prix et limites de chaque entreprise. Une limite vide signifie illimité. La durée est choisie par l'entreprise. */
const termFields = [
  { name: 'monthlyAmount', label: 'Montant mensuel', type: 'number', required: true, hint: "Propre à cette entreprise. Elle s'abonne elle-même après l'essai gratuit de 3 jours." }, { name: 'currency', label: 'Devise', default: 'USD', required: true },
  { name: 'graceDays', label: 'Période de grâce (jours)', type: 'number', default: 7 },
  { name: 'maxWarehouses', label: 'Entrepôts max.', type: 'number', hint: 'Vide : illimité' }, { name: 'maxUsers', label: 'Utilisateurs max.', type: 'number', hint: 'Vide : illimité' },
  { name: 'maxDrivers', label: 'Chauffeurs max.', type: 'number', hint: 'Vide : illimité' }, { name: 'maxVehicles', label: 'Véhicules max.', type: 'number', hint: 'Vide : illimité' },
  { name: 'maxDeliveriesMonth', label: 'Livraisons par mois max.', type: 'number', hint: 'Vide : illimité' }, { name: 'gpsEnabled', label: 'Suivi GPS inclus', type: 'checkbox', default: true },
]
/** Valeurs proposées à la création seulement. La modification affiche toujours les valeurs réelles de l'entreprise. */
const CREATE_DEFAULTS = { monthlyAmount: 200, graceDays: 7, maxWarehouses: 5, maxUsers: 7, maxDrivers: 10, maxVehicles: 7 }
const createTermFields = termFields.map((f) => ({ ...f, default: CREATE_DEFAULTS[f.name] ?? f.default }))
const limitText = (v) => (v === null || v === undefined ? 'illimité' : num(v))

/** Résultat de l'e-mail envoyé à la création d'un compte. */
export const invitationMessage = (what) => (r) => {
  const i = r?.invitation
  if (!i) return [`${what}.`]
  if (i.mode === 'password') return [`${what}. Un e-mail de bienvenue est envoyé, sans le mot de passe : communiquez-le vous-même.`]
  if (i.sent) return [`${what}. Une invitation pour choisir son mot de passe est envoyée par e-mail.`]
  return [`${what}, mais l'invitation n'est pas partie : ${i.error ?? 'erreur d\'envoi'}. Renvoyez-la depuis Utilisateurs.`, 'error']
}

export function Companies() {
  const [version, setVersion] = useState(0)
  return (
    <CrudPage
      key={version} title="Entreprises" sub="Création, statuts et abonnements." endpoint="/companies" singular="entreprise" editable={false} rowLink={(r) => `/admin/entreprises/${r.id}`}
      statusOptions={Object.entries(COMPANY_STATUS).map(([value, [label]]) => ({ value, label }))}
      fields={[
        { name: 'tradeName', label: 'Nom commercial', required: true }, { name: 'email', label: "E-mail de l'entreprise", type: 'email', required: true },
        { name: 'adminName', label: "Nom de l'administrateur", required: true }, { name: 'adminEmail', label: "E-mail de l'administrateur", type: 'email', required: true },
        { name: 'adminPassword', label: 'Mot de passe initial', type: 'password', minLength: 8, wide: true, hint: "Laissez vide (recommandé) : l'administrateur reçoit un e-mail pour choisir lui-même son mot de passe." },
        ...createTermFields,
      ]}
      columns={[
        { label: 'Entreprise', render: (r) => <><div className="strong">{r.tradeName}</div><div className="muted small">{r.email}</div></> }, { label: 'Statut', render: (r) => <Status map={COMPANY_STATUS} value={r.status} /> },
        { label: 'Mensuel', num: true, render: (r) => (r.subscriptions[0] ? money(r.subscriptions[0].monthlyAmount, r.subscriptions[0].currency) : '—') }, { label: 'Abonnement', render: (r) => (r.subscriptions[0] ? <Status map={SUBSCRIPTION_STATUS} value={r.subscriptions[0].status} /> : '—') },
        { label: 'Entrepôts', num: true, render: (r) => r._count.warehouses }, { label: 'Chauffeurs', num: true, render: (r) => r._count.drivers }, { label: 'Livraisons', num: true, render: (r) => r._count.deliveries }, { label: 'Créée le', render: (r) => date(r.createdAt) },
      ]}
      headerActions={<Button onClick={() => setVersion(version + 1)}>Actualiser</Button>}
      createdMessage={invitationMessage('Entreprise créée')}
    />
  )
}

export function CompanyDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: c, error, reload } = useFetch(`/companies/${id}`)
  const { enterCompany } = useAuth()
  const { run, busy } = useAction()
  const [modal, setModal] = useState(null)
  const [passwordFor, setPasswordFor] = useState(null)
  const accounts = useFetch(`/companies/${id}/accounts`)
  if (error) return <ErrorBox error={error} />
  if (!c) return null
  const sub = c.subscriptions[0]
  const act = async (fn, msg) => {
    await run(fn, msg)
    reload()
  }
  return (
    <>
      <PageHead back={<BackLink to="/admin/entreprises" label="Entreprises" />} title={c.tradeName} sub={c.email} actions={<>
        <Status map={COMPANY_STATUS} value={c.status} />
        {c.status !== 'closed' && <Button variant="primary" onClick={async () => { await enterCompany(id); navigate('/') }}>Gérer cette entreprise</Button>}
        {['suspended', 'expired'].includes(c.status) && <Button variant="primary" loading={busy} onClick={() => act(() => api.post(`/companies/${id}/activate`, {}), 'Entreprise activée.')}>Réactiver</Button>}
        {c.status === 'active' && <Button variant="danger" loading={busy} onClick={() => act(() => api.post(`/companies/${id}/suspend`, {}), 'Entreprise suspendue.')}>Suspendre</Button>}
        {c.status !== 'closed' && <Button variant="danger" loading={busy} onClick={async () => { const r = await run(() => api.del(`/companies/${id}`), 'Entreprise fermée.'); if (r.ok) navigate('/admin/entreprises') }}>Fermer</Button>}
      </>} />
      <div className="stack">
        <div className="grid grid-2">
          <Card title="Fiche" pad>
            <dl className="kv">
              <dt>Raison sociale</dt><dd>{c.legalName ?? '—'}</dd><dt>NIF</dt><dd>{c.taxId ?? '—'}</dd><dt>RCCM</dt><dd>{c.rccm ?? '—'}</dd><dt>Téléphone</dt><dd>{c.phone ?? '—'}</dd>
              <dt>Ville</dt><dd>{[c.city, c.country].filter(Boolean).join(', ') || '—'}</dd><dt>Secteur</dt><dd>{c.sector ?? '—'}</dd><dt>Créée le</dt><dd>{date(c.createdAt)}</dd>
              <dt>Utilisation</dt><dd>{num(c._count.warehouses)} entrepôts · {num(c._count.drivers)} chauffeurs · {num(c._count.deliveries)} livraisons · {num(c._count.companyMemberships)} comptes</dd>
            </dl>
          </Card>
          <Card title="Abonnement" pad actions={sub && <Button variant="primary" onClick={() => setModal('terms')}>Modifier</Button>}>
            {sub ? (
              <dl className="kv">
                <dt>Montant mensuel</dt><dd className="strong">{money(sub.monthlyAmount, sub.currency)}</dd>
                <dt>Durée</dt><dd>{sub.status === 'TRIAL' ? 'Essai gratuit' : `${sub.durationMonths} mois`}</dd>
                <dt>État</dt><dd><Status map={SUBSCRIPTION_STATUS} value={sub.status} /></dd>
                <dt>Échéance</dt><dd>{date(sub.endsAt)}</dd>
                <dt>Limites</dt><dd>Entrepôts : {limitText(sub.maxWarehouses)} · Utilisateurs : {limitText(sub.maxUsers)} · Chauffeurs : {limitText(sub.maxDrivers)} · Véhicules : {limitText(sub.maxVehicles)} · Livraisons par mois : {limitText(sub.maxDeliveriesMonth)}</dd>
                <dt>Suivi GPS</dt><dd>{sub.gpsEnabled ? 'Inclus' : 'Non inclus'}</dd>
                <dt>Période de grâce</dt><dd>{sub.graceDays} jour(s)</dd>
              </dl>
            ) : <Empty title="Aucun abonnement" />}
          </Card>
        </div>
        <Card title="Comptes de l'entreprise">
          <DataTable loading={accounts.loading} error={accounts.error} rows={accounts.data ?? []} columns={[
            { label: 'Nom', render: (a) => <span className="strong">{a.fullName}</span> }, { label: 'E-mail ou téléphone', render: (a) => a.email ?? a.phone ?? '—' }, { label: 'Rôle', key: 'roleLabel' },
            { label: 'Dernière connexion', render: (a) => (a.lastLoginAt ? dateTime(a.lastLoginAt) : 'Jamais') },
            { label: 'État', render: (a) => (a.lockedUntil ? <Status map={{ locked: [`Bloqué jusqu'à ${new Date(a.lockedUntil).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`, 'red'] }} value="locked" /> : <Status map={{ true: ['Actif', 'green'], false: ['Désactivé', 'neutral'] }} value={String(a.isActive)} />) },
            { label: '', render: (a) => <div className="actions"><Button icon={KeyRound} onClick={() => setPasswordFor(a)}>Mot de passe</Button></div> },
          ]} empty={<Empty title="Aucun compte" />} />
        </Card>
        <Card title="Factures">
          <InvoiceTable rows={c.subscriptionInvoices} />
        </Card>
      </div>
      {passwordFor && (
        <ResetPasswordModal
          endpoint={`/companies/${id}/accounts/${passwordFor.id}/password`} name={`${passwordFor.fullName} (${passwordFor.roleLabel})`}
          email={passwordFor.email} allowLink preferLink={false} onDone={accounts.reload} onClose={() => setPasswordFor(null)}
        />
      )}
      {modal === 'terms' && <FormModal wide title="Modifier l'abonnement" fields={termFields} row={sub} onClose={() => setModal(null)} onSubmit={async (v) => { await api.patch(`/companies/${id}/subscription`, v); setModal(null); reload() }}>
        <Alert tone="info">Une facture en attente est remplacée au nouveau montant. Les factures déjà payées ne changent pas.</Alert>
      </FormModal>}
    </>
  )
}

/** Facture : la durée et sa remise restent visibles, même si le montant mensuel change ensuite. */
function InvoiceTable({ rows, company, action, loading, error }) {
  return (
    <DataTable loading={loading} error={error} rows={rows} columns={[
      { label: 'Numéro', render: (i) => <span className="mono">{i.number}</span> }, ...(company ? [{ label: 'Entreprise', render: (i) => i.company.tradeName }] : []), { label: 'Période', render: (i) => `${date(i.periodStart)} — ${date(i.periodEnd)}` },
      { label: 'Mensuel', num: true, render: (i) => money(i.monthlyAmount, i.currency) }, { label: 'Durée', render: (i) => durationLabel(i.durationMonths, i.discountPercent) }, { label: 'Montant', num: true, render: (i) => <span className="strong">{money(i.amount, i.currency)}</span> },
      { label: 'État', render: (i) => <Status map={INVOICE_STATUS} value={i.status} /> }, ...(action ? [{ label: '', render: action }] : []),
    ]} empty={<Empty title="Aucune facture" />} />
  )
}

export function Invoices() {
  const { items, loading, error, reload } = useList('/admin/invoices?limit=100')
  const [pay, setPay] = useState(null)
  return (
    <>
      <PageHead title="Factures" sub="Enregistrement manuel d'un paiement reçu." />
      <Card>
        <InvoiceTable company loading={loading} error={error} rows={items} action={(i) => i.status === 'UNPAID' && <Button variant="primary" onClick={() => setPay(i)}>Enregistrer le paiement</Button>} />
      </Card>
      {pay && <FormModal title={`Paiement : ${pay.number}`} submitLabel="Confirmer" onClose={() => setPay(null)} fields={[
        { name: 'externalRef', label: 'Référence du paiement', required: true, hint: 'Numéro de transaction ou de virement.' }, { name: 'provider', label: 'Moyen de paiement', default: 'manual', required: true },
      ]} onSubmit={async (v) => { await api.post('/admin/payments', { ...v, invoiceId: pay.id, amount: pay.amount, currency: pay.currency }); setPay(null); reload() }} />}
    </>
  )
}

/** Ports usuels : 465 en SSL/TLS direct, 587 en STARTTLS. */
const SMTP_PRESETS = { 465: true, 587: false }

/**
 * Compte d'envoi des e-mails (réinitialisation des mots de passe, notifications).
 * Saisi ici, il remplace les variables MAIL_* du .env, sans redémarrage. Le mot de passe n'est jamais réaffiché.
 */
function MailSettings({ status: m, onSaved, testTo }) {
  const { run, busy } = useAction()
  const fromAdmin = m.source === 'admin'
  const [form, setForm] = useState({
    host: m.host ?? 'smtp.gmail.com', port: m.port ?? 465, secure: m.secure ?? true,
    user: fromAdmin ? m.user ?? '' : '', password: '', from: fromAdmin ? m.from ?? '' : '',
  })
  const [confirmClear, setConfirmClear] = useState(false)
  const [previewCompany, setPreviewCompany] = useState('')
  const companies = useFetch('/companies?limit=200')
  const companyList = Array.isArray(companies.data) ? companies.data : companies.data?.items ?? []
  const companyName = companyList.find((c) => c.id === previewCompany)?.tradeName
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const needsPassword = !fromAdmin || m.passwordUnreadable
  const save = async (e) => {
    e.preventDefault()
    const r = await run(() => api.put('/admin/mail', { ...form, port: Number(form.port), from: form.from.trim() || null }), "Réglages d'envoi enregistrés.")
    if (r.ok) {
      set({ password: '' })
      onSaved()
    }
  }
  const clear = async () => {
    const r = await run(() => api.del('/admin/mail'), 'Réglages supprimés : le serveur utilise de nouveau le fichier .env.')
    setConfirmClear(false)
    if (r.ok) onSaved()
  }
  return (
    <div className="stack">
      <dl className="kv">
        <dt>État</dt><dd><Status map={{ true: ['Configuré', 'green'], false: ['Non configuré', 'orange'] }} value={String(m.configured)} /></dd>
        <dt>Source</dt><dd>{fromAdmin ? 'Réglages ci-dessous' : m.source === 'env' ? 'Fichier server/.env' : 'Aucune'}</dd>
        {m.source === 'env' && <><dt>Compte du .env</dt><dd>{m.user}</dd></>}
      </dl>
      {m.passwordUnreadable && <Alert tone="warn">Le mot de passe enregistré est illisible, probablement parce que JWT_SECRET a changé. Ressaisissez-le.</Alert>}
      <form className="stack" onSubmit={save}>
        <div className="grid grid-2">
          <Field label="Serveur SMTP"><Input required value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.gmail.com" /></Field>
          <Field label="Port" hint="465 (SSL) ou 587 (STARTTLS)">
            <Input required type="number" min={1} max={65535} value={form.port} onChange={(e) => set({ port: e.target.value, ...(e.target.value in SMTP_PRESETS ? { secure: SMTP_PRESETS[e.target.value] } : {}) })} />
          </Field>
        </div>
        <Checkbox label="Connexion chiffrée dès l'ouverture (SSL/TLS)" hint="Cochée pour le port 465, décochée pour le port 587." checked={form.secure} onChange={(e) => set({ secure: e.target.checked })} />
        <Field label="Adresse e-mail du compte d'envoi"><Input required type="email" autoComplete="off" value={form.user} onChange={(e) => set({ user: e.target.value })} placeholder="notifications@exemple.com" /></Field>
        <Field label="Mot de passe" hint={needsPassword ? "Pour Gmail : un mot de passe d'application, sans espaces, pas celui du compte." : 'Laissez vide pour conserver le mot de passe enregistré.'}>
          <Input type="password" required={needsPassword} autoComplete="new-password" value={form.password} onChange={(e) => set({ password: e.target.value })} placeholder={needsPassword ? '' : '••••••••  (inchangé)'} />
        </Field>
        <Field label="Expéditeur affiché" hint="Facultatif. Par défaut : l'adresse du compte d'envoi."><Input value={form.from} onChange={(e) => set({ from: e.target.value })} placeholder="LogisticTrack <notifications@exemple.com>" /></Field>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button type="submit" variant="primary" loading={busy}>Enregistrer</Button>
          <Button type="button" loading={busy} disabled={!m.configured} onClick={() => run(() => api.post('/admin/mail/test', { companyId: previewCompany || null }), `E-mail de test${companyName ? ` aux couleurs de ${companyName}` : ''} envoyé à ${testTo}.`)}>Envoyer un e-mail de test</Button>
          {fromAdmin && <Button type="button" onClick={() => setConfirmClear(true)}>Revenir au fichier .env</Button>}
        </div>
        <Field label="Aperçu de l'e-mail de test" hint="Chaque e-mail porte le logo, le nom et les coordonnées de l'entreprise concernée, dans le même design que ses PDF.">
          <Select value={previewCompany} onChange={(e) => setPreviewCompany(e.target.value)} placeholder="LogisticTrack (plateforme)" options={companyList.map((c) => ({ value: c.id, label: c.tradeName }))} />
        </Field>
      </form>
      {confirmClear && (
        <Confirm
          title="Supprimer ces réglages ?"
          message={m.envAvailable ? 'Le serveur utilisera de nouveau le compte du fichier server/.env.' : "Le fichier server/.env n'a pas de compte d'envoi : plus aucun e-mail ne partira."}
          confirmLabel="Supprimer" danger busy={busy} onConfirm={clear} onClose={() => setConfirmClear(false)}
        />
      )}
    </div>
  )
}

/** Compte du Super Administrateur : mot de passe, et vérification de l'envoi des e-mails. */
export function MyAccount() {
  const { user } = useAuth()
  const mail = useFetch('/admin/mail')
  const backups = useFetch('/admin/backups')
  const { run, busy } = useAction()
  const [pwd, setPwd] = useState({ current: '', next: '', confirm: '' })
  const [mismatch, setMismatch] = useState(false)
  const change = async (e) => {
    e.preventDefault()
    if (pwd.next !== pwd.confirm) return setMismatch(true)
    setMismatch(false)
    const r = await run(() => api.post('/auth/password/change', { current: pwd.current, next: pwd.next }), 'Mot de passe modifié. Les autres appareils sont déconnectés.')
    if (r.ok) setPwd({ current: '', next: '', confirm: '' })
  }
  const m = mail.data
  return (
    <>
      <PageHead title="Mon compte" sub={user.email} />
      <div className="grid grid-2">
        <Card title="Mot de passe" pad>
          <form className="stack" onSubmit={change}>
            <Field label="Mot de passe actuel"><Input required type="password" autoComplete="current-password" value={pwd.current} onChange={(e) => setPwd({ ...pwd, current: e.target.value })} /></Field>
            <Field label="Nouveau mot de passe" hint="8 caractères minimum."><Input required type="password" minLength={8} autoComplete="new-password" value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} /></Field>
            <Field label="Confirmer le nouveau mot de passe" error={mismatch ? 'Les deux mots de passe ne correspondent pas.' : undefined}><Input required type="password" minLength={8} autoComplete="new-password" value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })} /></Field>
            <div><Button type="submit" variant="primary" loading={busy}>Modifier le mot de passe</Button></div>
          </form>
        </Card>
        <Card title="Sauvegardes" pad actions={<Button loading={busy} onClick={async () => { const r = await run(() => api.post('/admin/backups'), 'Sauvegarde terminée.'); if (r.ok) backups.reload() }}>Sauvegarder maintenant</Button>}>
          {!backups.data ? <ErrorBox error={backups.error} /> : (
            <div className="stack">
              <p className="muted" style={{ margin: 0 }}>Une sauvegarde automatique par jour : base de données et fichiers (preuves, photos, signatures, logos), conservée {backups.data.keepDays} jours.</p>
              {!backups.data.copyDirectory && <Alert tone="warn">Aucune seconde copie : renseignez BACKUP_COPY_DIR dans server/.env (disque externe ou dossier synchronisé) pour survivre à une panne de ce disque.</Alert>}
              <DataTable rows={backups.data.items.slice(0, 7)} rowKey={(b) => b.name} columns={[
                { label: 'Date', render: (b) => dateTime(b.createdAt) }, { label: 'Base', num: true, render: (b) => `${Math.max(1, Math.round(b.databaseBytes / 1024))} Ko` },
                { label: 'Fichiers', num: true, render: (b) => num(b.files) }, { label: 'Seconde copie', render: (b) => (b.copiedTo ? 'Oui' : 'Non') },
              ]} empty={<Empty title="Aucune sauvegarde pour l'instant" />} />
              <p className="muted small" style={{ margin: 0 }}>Dossier : <span className="mono">{backups.data.directory}</span>. Restauration : <span className="mono">npm run restore -- &lt;dossier&gt;</span>, serveur arrêté.</p>
            </div>
          )}
        </Card>
        <Card title="Envoi des e-mails" pad>
          {!m ? <ErrorBox error={mail.error} /> : <MailSettings key={`${m.source}:${m.user}:${m.host}:${m.port}:${m.passwordUnreadable}`} status={m} onSaved={mail.reload} testTo={user.email} />}
        </Card>
        <Card title="Journal des e-mails" style={{ gridColumn: '1 / -1' }}>
          <EmailLog endpoint="/admin/mail/log" showCompany />
        </Card>
      </div>
    </>
  )
}
