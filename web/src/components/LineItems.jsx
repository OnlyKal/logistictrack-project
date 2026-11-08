import { Plus, Trash2 } from 'lucide-react'
import { Button, Field, Input, Select } from './ui.jsx'

/**
 * Éditeur de lignes (produit + quantité + champs supplémentaires).
 * `extra` : colonnes additionnelles { name, label, type, width }.
 */
export function LineItems({ products, lines, setLines, extra = [], quantityLabel = 'Quantité' }) {
  const update = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const template = `minmax(0, 2fr) 110px ${extra.map((e) => e.width ?? '110px').join(' ')} 34px`
  return (
    <div>
      {lines.map((line, i) => (
        <div className="line-row" key={line.key} style={{ gridTemplateColumns: template }}>
          <Field label={i === 0 ? 'Marchandise' : undefined}>
            <Select required value={line.productId} onChange={(e) => update(i, { productId: e.target.value })} placeholder="Sélectionner" options={products} />
          </Field>
          <Field label={i === 0 ? quantityLabel : undefined}>
            <Input required type="number" step="any" min="0.001" value={line.quantity} onChange={(e) => update(i, { quantity: e.target.value })} />
          </Field>
          {extra.map((e) => (
            <Field key={e.name} label={i === 0 ? e.label : undefined}>
              <Input type={e.type ?? 'text'} step="any" min={e.type === 'number' ? 0 : undefined} value={line[e.name] ?? ''} onChange={(ev) => update(i, { [e.name]: ev.target.value })} />
            </Field>
          ))}
          <Button variant="ghost" icon={Trash2} disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Retirer la ligne" />
        </div>
      ))}
      <Button variant="ghost" icon={Plus} style={{ marginTop: 8 }} onClick={() => setLines([...lines, newLine()])}>Ajouter une ligne</Button>
    </div>
  )
}

export const newLine = () => ({ key: crypto.randomUUID(), productId: '', quantity: '' })
export const productOption = (p) => ({ value: p.id, label: `${p.name} (${p.reference}) — ${p.baseUnit}` })
export const namedOption = (r) => ({ value: r.id, label: r.name })
