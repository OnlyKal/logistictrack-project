import { useState } from 'react'
import { query } from '../lib/api.js'
import { useList } from '../lib/hooks.js'
import { dateTime } from '../lib/format.js'
import { DataTable, Empty, Pagination, Select, Status } from './ui.jsx'

/** Libellés des e-mails, du plus courant au plus rare. */
export const EMAIL_KINDS = {
  'customer.en_route': 'Client : en route', 'customer.delivered': 'Client : livrée', 'customer.partial': 'Client : livrée en partie', 'customer.failed': 'Client : non effectuée',
  'account.invite': 'Invitation', 'account.welcome': 'Bienvenue', 'account.reset': 'Lien de mot de passe',
  'security.password_changed': 'Alerte : mot de passe modifié', 'security.locked': 'Alerte : compte bloqué',
  'billing.invoice': 'Facture', 'billing.receipt': 'Reçu de paiement', 'billing.expiring': "Rappel d'échéance", 'billing.trial_ending': "Fin d'essai",
  'billing.grace': 'Période de grâce', 'billing.expired': 'Lecture seule', 'platform.invoice': 'Facture à encaisser',
}

/** Journal des e-mails : destinataire, objet, réussite ou cause de l'échec. Jamais le contenu. */
export function EmailLog({ endpoint, showCompany }) {
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const { items, meta, loading, error } = useList(`${endpoint}${query({ status, page, limit: 10 })}`)
  return (
    <>
      <div className="toolbar">
        <Select style={{ width: 200 }} aria-label="Résultat" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} placeholder="Tous les envois" options={[{ value: 'SENT', label: 'Envoyés' }, { value: 'FAILED', label: 'Échecs' }]} />
      </div>
      <DataTable loading={loading} error={error} rows={items} columns={[
        { label: 'Date', render: (l) => dateTime(l.createdAt) },
        ...(showCompany ? [{ label: 'Entreprise', render: (l) => l.company ?? 'Plateforme' }] : []),
        { label: 'Type', render: (l) => EMAIL_KINDS[l.kind] ?? l.kind }, { label: 'Destinataire', key: 'recipient' }, { label: 'Objet', key: 'subject' },
        { label: 'Résultat', render: (l) => <><Status map={{ SENT: ['Envoyé', 'green'], FAILED: ['Échec', 'red'] }} value={l.status} />{l.error && <div className="muted small">{l.error}</div>}</> },
      ]} empty={<Empty title="Aucun e-mail envoyé">Les e-mails apparaissent ici dès qu'ils partent.</Empty>} />
      <Pagination meta={meta} onPage={setPage} />
    </>
  )
}
