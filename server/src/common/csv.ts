/** Lecture de fichiers CSV tels qu'Excel les enregistre : séparateur « ; » ou « , », guillemets, BOM, fins de ligne Windows. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, '')
  const firstLine = source.split(/\r?\n/, 1)[0] ?? ''
  const separator = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === separator) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

/** « Poids (kg) », « poids_kg » et « POIDS KG » désignent la même colonne. */
export const columnKey = (header: string) => header.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\*/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

/** Fichier modèle : séparateur « ; » et BOM, pour qu'Excel l'ouvre correctement en français. */
export function toCsv(rows: string[][]) {
  const esc = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n'
}
