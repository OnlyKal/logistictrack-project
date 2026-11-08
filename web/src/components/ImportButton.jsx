import { useState } from 'react'
import { FileDown, Upload } from 'lucide-react'
import { api } from '../lib/api.js'
import { Alert, Button, DataTable, ErrorBox, Field, Modal, useToast } from './ui.jsx'

const LABELS = { products: 'marchandises', customers: 'clients', stock: 'stock initial' }
const HELP = {
  products: "Une ligne par marchandise. Une référence déjà connue met à jour la marchandise : seules les colonnes remplies sont modifiées. Les catégories absentes sont créées.",
  customers: 'Une ligne par client, avec un point de livraison facultatif. Un code client déjà connu met à jour ce client.',
  stock: "Une ligne par marchandise et par entrepôt (code ou nom). Les quantités s'ajoutent au stock, avec un mouvement tracé « Stock initial importé ». Importez d'abord les marchandises.",
}

/**
 * Import CSV en deux temps : le fichier est d'abord vérifié en entier, sans rien enregistrer,
 * puis importé seulement s'il ne contient aucune erreur.
 */
export function ImportButton({ kind, onDone }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button icon={Upload} onClick={() => setOpen(true)}>Importer</Button>
      {open && <ImportModal kind={kind} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone?.() }} />}
    </>
  )
}

function ImportModal({ kind, onClose, onDone }) {
  const toast = useToast()
  const [file, setFile] = useState(null)
  const [check, setCheck] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const verify = async (chosen) => {
    setFile(chosen)
    setCheck(null)
    setError(null)
    if (!chosen) return
    setBusy(true)
    try {
      setCheck(await api.upload(`/imports/${kind}?dryRun=true`, chosen))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const done = await api.upload(`/imports/${kind}`, file)
      if (done.errors.length) {
        setCheck(done)
        return
      }
      toast(`Import terminé : ${done.created} ajout(s), ${done.updated} mise(s) à jour.`)
      onDone()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  const ready = check && !check.errors.length
  return (
    <Modal wide title={`Importer : ${LABELS[kind]}`} onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button variant="primary" disabled={!ready} loading={busy && !!check} onClick={confirm}>{ready ? `Importer ${check.total} ligne(s)` : 'Importer'}</Button></>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>{HELP[kind]}</p>
        <div><Button icon={FileDown} onClick={() => api.download(`/imports/${kind}/template`, `modele-${kind}.csv`)}>Télécharger le modèle</Button></div>
        <Field label="Fichier CSV" hint="Enregistré depuis Excel au format « CSV (séparateur : point-virgule) ». 5 000 lignes au plus.">
          <input type="file" accept=".csv,text/csv" onChange={(e) => verify(e.target.files?.[0] ?? null)} />
        </Field>
        <ErrorBox error={error} />
        {busy && !check && <p className="muted">Vérification du fichier…</p>}
        {check && (check.errors.length
          ? (
            <>
              <Alert tone="error">{check.errors.length} erreur(s) sur {check.total} ligne(s) : rien n'a été enregistré. Corrigez le fichier, puis choisissez-le de nouveau.</Alert>
              <DataTable rows={check.errors.map((e, i) => ({ ...e, id: i }))} columns={[{ label: 'Ligne', num: true, render: (e) => e.line }, { label: 'Problème', render: (e) => e.message }]} />
            </>
          )
          : <Alert tone="info">Fichier vérifié : {check.total} ligne(s), {check.created} ajout(s){check.updated ? `, ${check.updated} mise(s) à jour` : ''}. Rien n'est encore enregistré.</Alert>)}
      </div>
    </Modal>
  )
}
