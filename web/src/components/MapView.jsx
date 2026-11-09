import { useEffect, useRef } from 'react'
import L from 'leaflet'

const TILES = import.meta.env.VITE_MAP_TILES ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const DEFAULT_CENTER = [-4.325, 15.322] // Kinshasa
const GLIDE_MS = 800

const iconHtml = (m) => m.html ?? `<div class="driver-dot" style="background:${m.color}"></div>`
const icon = (m) => {
  const size = m.size ?? 16
  return L.divIcon({ className: '', html: iconHtml(m), iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
}
/** Étiquette en texte pur, jamais interprétée comme du HTML. */
const labelNode = (text) => {
  const el = document.createElement('span')
  el.textContent = text
  return el
}

/**
 * Carte OpenStreetMap. `markers` : { id, lat, lng, color, popup, moving }, `path` : liste [lat, lng],
 * `lines` : { id, points, color, weight, opacity, dashed, flow }. Les lignes sont mises à jour sans clignoter.
 * Un marqueur peut aussi avoir `html`, `size`, `heading`, `label`, `onClick` et `z` (priorité d'affichage).
 * Sans `fitKey`, la vue suit les véhicules tant que l'utilisateur n'a pas déplacé la carte lui-même.
 * Avec `fitKey`, elle se recadre sur `fitPoints` quand la clé change, et `followPoint` garde le véhicule au centre.
 */
export function MapView({ markers = [], path, lines = [], tall, className = '', fitKey, fitPoints, fitPadding, followPoint, onUserMove }) {
  const el = useRef(null)
  const map = useRef(null)
  const layers = useRef(new Map())
  const line = useRef(null)
  const fitted = useRef('')
  const userMoved = useRef(false)
  const extraLines = useRef(new Map())
  const glides = useRef(new Map())
  const still = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const clicks = useRef(new Map())
  const lastFit = useRef(null)
  const moved = useRef(onUserMove)
  useEffect(() => { moved.current = onUserMove })

  useEffect(() => {
    map.current = L.map(el.current, { zoomControl: true }).setView(DEFAULT_CENTER, 12)
    map.current.on('dragstart', () => {
      userMoved.current = true
      moved.current?.()
    })
    L.tileLayer(TILES, { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map.current)
    const current = layers.current
    const currentLines = extraLines.current
    const currentGlides = glides.current
    return () => {
      currentGlides.forEach((frame) => cancelAnimationFrame(frame))
      currentGlides.clear()
      currentLines.clear()
      map.current.remove()
      map.current = null
      current.clear()
      line.current = null
      fitted.current = ''
    }
  }, [])

  /** Un véhicule glisse vers sa nouvelle position au lieu de sauter. */
  const moveMarker = (id, marker, m) => {
    const from = marker.getLatLng()
    if (from.lat === m.lat && from.lng === m.lng) return
    cancelAnimationFrame(glides.current.get(id))
    if (!m.moving || still.current) {
      marker.setLatLng([m.lat, m.lng])
      return
    }
    const start = performance.now()
    const step = (now) => {
      const t = Math.min(1, (now - start) / GLIDE_MS)
      marker.setLatLng([from.lat + (m.lat - from.lat) * t, from.lng + (m.lng - from.lng) * t])
      if (t < 1) glides.current.set(id, requestAnimationFrame(step))
      else glides.current.delete(id)
    }
    glides.current.set(id, requestAnimationFrame(step))
  }

  useEffect(() => {
    if (!map.current) return
    const seen = new Set()
    for (const m of markers) {
      seen.add(m.id)
      const existing = layers.current.get(m.id)
      if (existing) {
        moveMarker(m.id, existing, m)
        // Recréer l'icône à chaque position relancerait ses animations : seulement si elle change vraiment.
        if (existing.options.iconKey !== iconHtml(m)) {
          existing.options.iconKey = iconHtml(m)
          existing.setIcon(icon(m))
        }
        if (m.popup) existing.setPopupContent(m.popup)
      } else {
        const marker = L.marker([m.lat, m.lng], { icon: icon(m), title: m.title, iconKey: iconHtml(m), zIndexOffset: m.z ?? 0 }).addTo(map.current)
        // Contenu textuel construit par l'appelant à partir d'un élément DOM : aucune injection HTML.
        if (m.popup) marker.bindPopup(m.popup)
        marker.on('click', () => clicks.current.get(m.id)?.())
        layers.current.set(m.id, marker)
      }
      const marker = layers.current.get(m.id)
      if (m.onClick) clicks.current.set(m.id, m.onClick)
      if (marker.options.labelText !== (m.label ?? null)) {
        marker.options.labelText = m.label ?? null
        marker.unbindTooltip()
        if (m.label) marker.bindTooltip(labelNode(m.label), { permanent: true, direction: 'top', offset: [0, -(m.size ?? 16) / 2], className: 'map-label' })
      }
      // La flèche du véhicule pivote en douceur vers sa direction réelle.
      const arrow = marker.getElement()?.querySelector('.veh-arrow')
      if (arrow && m.heading != null) arrow.style.transform = `rotate(${m.heading - 45}deg)`
    }
    for (const [id, marker] of layers.current) {
      if (!seen.has(id)) {
        marker.remove()
        layers.current.delete(id)
        clicks.current.delete(id)
      }
    }
    const seenLines = new Set()
    for (const l of lines) {
      if (l.points.length < 2) continue
      seenLines.add(l.id)
      const style = { color: l.color ?? '#2563EB', weight: l.weight ?? 3, opacity: l.opacity ?? 0.9, dashArray: l.dashed ? '6 9' : null, lineCap: 'round', lineJoin: 'round', interactive: false }
      const existing = extraLines.current.get(l.id)
      if (existing) {
        existing.setLatLngs(l.points)
        existing.setStyle(style)
      } else {
        extraLines.current.set(l.id, L.polyline(l.points, { ...style, className: l.flow ? 'line-flow' : undefined }).addTo(map.current))
      }
    }
    for (const [id, polyline] of extraLines.current) {
      if (!seenLines.has(id)) {
        polyline.remove()
        extraLines.current.delete(id)
      }
    }
    if (line.current) line.current.remove()
    line.current = path?.length ? L.polyline(path, { color: '#2563EB', weight: 3, opacity: 0.85 }).addTo(map.current) : null

    const signature = `${[...seen].sort().join(',')}|${path?.length ? 'p' : ''}|${[...seenLines].sort().join(',')}`
    const points = [...markers.map((m) => [m.lat, m.lng]), ...(path ?? []), ...lines.flatMap((l) => l.points)]
    // Recadrage à l'apparition d'un élément, ou quand un véhicule sort de la vue si l'utilisateur n'a pas déplacé la carte.
    const outOfView = !userMoved.current && markers.some((m) => !map.current.getBounds().contains([m.lat, m.lng]))
    if (fitKey === undefined && points.length && (signature !== fitted.current || outOfView)) {
      if (signature !== fitted.current) userMoved.current = false
      fitted.current = signature
      map.current.fitBounds(points, { padding: [40, 40], maxZoom: 15 })
    }
  }, [markers, path, lines]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!map.current || fitKey === undefined || lastFit.current === fitKey || !fitPoints?.length) return
    lastFit.current = fitKey
    const narrow = el.current.clientWidth < 700
    map.current.fitBounds(fitPoints, {
      paddingTopLeft: narrow ? [24, 24] : fitPadding?.topLeft ?? [40, 40], paddingBottomRight: narrow ? [24, 24] : fitPadding?.bottomRight ?? [40, 40],
      maxZoom: 16, animate: !still.current, duration: 0.8,
    })
  }, [fitKey, fitPoints, fitPadding])

  const followLat = followPoint?.[0]
  const followLng = followPoint?.[1]
  useEffect(() => {
    if (!map.current || followLat === undefined) return
    map.current.panTo([followLat, followLng], { animate: !still.current, duration: 0.8 })
  }, [followLat, followLng])

  return <div ref={el} className={`map ${tall ? 'map-tall' : ''} ${className}`} />
}

/** Bulle d'information sûre : du texte, jamais de HTML brut. */
export function popupNode(lines) {
  const div = document.createElement('div')
  lines.filter(Boolean).forEach((text, i) => {
    const row = document.createElement('div')
    row.textContent = text
    if (i === 0) row.style.fontWeight = '600'
    div.appendChild(row)
  })
  return div
}
