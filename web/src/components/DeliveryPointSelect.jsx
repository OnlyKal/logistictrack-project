import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { FormModal } from './CrudPage.jsx'
import { Button, Field, Select, useToast } from './ui.jsx'

export const pointFields = [
  { name: 'name', label: 'Nom du site', required: true }, { name: 'contactName', label: 'Contact sur place' }, { name: 'address', label: 'Adresse', required: true, wide: true },
  { name: 'commune', label: 'Commune' }, { name: 'city', label: 'Ville' }, { name: 'phone', label: 'Téléphone' }, { name: 'openingHours', label: 'Horaires de réception' },
  { name: 'latitude', label: 'Latitude', type: 'number', min: -90 }, { name: 'longitude', label: 'Longitude', type: 'number', min: -180 },
  { name: 'instructions', label: 'Instructions', type: 'textarea', wide: true }, { name: 'restrictions', label: "Restrictions d'accès", type: 'textarea', wide: true },
]

/** Choix du point de livraison d'un client, avec création sur place : le client n'a pas à quitter son formulaire. */
export function DeliveryPointSelect({ customerId, value, onChange }) {
  const { can } = useAuth()
  const toast = useToast()
  const [points, setPoints] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    setPoints([])
    setLoaded(false)
    if (!customerId) return undefined
    let active = true
    api.get(`/customers/${customerId}/delivery-points`)
      .then((rows) => { if (active) { setPoints(rows); setLoaded(true) } })
      .catch(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [customerId])

  const create = async (values) => {
    const point = await api.post(`/customers/${customerId}/delivery-points`, values)
    setPoints((rows) => [...rows, point].sort((a, b) => a.name.localeCompare(b.name)))
    onChange(point.id)
    setAdding(false)
    toast('Point de livraison ajouté.')
  }

  const canAdd = can('customer.manage')
  const hint = !customerId
    ? "Choisissez d'abord le client."
    : loaded && !points.length
      ? (canAdd ? "Ce client n'a pas encore de point de livraison : ajoutez-en un." : "Ce client n'a pas encore de point de livraison. Demandez à un responsable de l'ajouter.")
      : undefined

  return (
    <Field label="Point de livraison *" hint={hint}>
      <div className="point-select">
        <Select required disabled={!customerId} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Sélectionner" options={points.map((p) => ({ value: p.id, label: p.name }))} />
        {canAdd && <Button icon={Plus} disabled={!customerId} onClick={() => setAdding(true)}>Ajouter</Button>}
      </div>
      {/* Hors du formulaire parent, dans le document comme dans la propagation des événements. */}
      {adding && createPortal(
        <div onSubmit={(e) => e.stopPropagation()}>
          <FormModal wide title="Nouveau point de livraison" fields={pointFields} onClose={() => setAdding(false)} onSubmit={create} />
        </div>,
        document.body,
      )}
    </Field>
  )
}
