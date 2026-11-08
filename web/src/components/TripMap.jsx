import { useEffect, useMemo, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Activity, BatteryMedium, Clock, Flag, Gauge, LocateFixed, MapPin, Maximize, Navigation, Route, Satellite, Truck, Warehouse } from 'lucide-react'
import { useLive } from '../lib/socket.js'
import { ago, distanceKm, km } from '../lib/format.js'
import { MapView } from './MapView.jsx'
import { Empty } from './ui.jsx'

/** Éléments visuels communs au suivi en direct et à la fiche d'une livraison. */
export const TRAIL_MAX_ACCURACY_M = 100
export const LINE_LIVE = '#2563EB'
export const LINE_STALE = '#94A3B8'
const LINE_LEFT = '#14213D'
const svg = (element) => renderToStaticMarkup(element)
export const PIN_START = `<div class="pin pin-start">${svg(<Warehouse size={15} strokeWidth={2} aria-hidden />)}</div>`
export const PIN_END = `<div class="pin pin-end">${svg(<Flag size={15} strokeWidth={2} aria-hidden />)}</div>`
const ARROW = svg(<Navigation size={15} strokeWidth={2.4} aria-hidden />)
const TRUCK = svg(<Truck size={15} strokeWidth={2.2} aria-hidden />)
export const vehicleHtml = ({ isLive, heading, selected }) => `<div class="veh ${isLive ? 'veh-live' : 'veh-lost'} ${selected ? 'veh-on' : ''}"><span class="veh-pulse"></span><span class="veh-core"><span class="veh-arrow">${heading == null ? TRUCK : ARROW}</span></span></div>`
export const hasCoords = (place) => place?.latitude != null && place?.longitude != null
export const reliable = (p) => p.accuracyM == null || p.accuracyM <= TRAIL_MAX_ACCURACY_M
export const duration = (from, to = Date.now()) => {
  const minutes = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}
export const trailLines = ({ id, points, live, focus = true }) => {
  const color = live ? LINE_LIVE : LINE_STALE
  return [
    { id: `halo-${id}`, points, color, weight: focus ? 12 : 6, opacity: focus ? 0.18 : 0.06 },
    { id: `done-${id}`, points, color, weight: focus ? 4.5 : 2.5, opacity: focus ? 1 : 0.4 },
  ]
}
export const leftLine = ({ id, from, to, focus = true }) => ({ id: `left-${id}`, points: [from, to], color: LINE_LEFT, weight: 2.5, opacity: focus ? 0.8 : 0.25, dashed: true, flow: focus })

function Stat({ icon: Icon, label, value }) {
  return <div className="ops-stat"><span><Icon size={13} aria-hidden />{label}</span><strong>{value}</strong></div>
}

/**
 * Carte d'une livraison, au même design que le suivi en direct.
 * `positions` vient du serveur ; en route, les nouvelles positions s'ajoutent sans recharger.
 */
export function TripMap({ delivery: d, positions, onReload }) {
  const [extra, setExtra] = useState([])
  const [fix, setFix] = useState(null)
  const [follow, setFollow] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [, tick] = useState(0)
  const onRoad = d.status === 'IN_TRANSIT'

  useLive('position.update', (p) => {
    if (!onRoad || p.driverId !== d.driverId) return
    setFix(p)
    if (p.batch > 1) onReload?.()
    else if (reliable(p)) setExtra((all) => [...all, p])
  })
  useEffect(() => {
    if (!onRoad) return undefined
    const t = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [onRoad])
  useEffect(() => { if (!onRoad) setFollow(false) }, [onRoad])

  const trail = useMemo(() => {
    const measured = (positions ?? []).filter(reliable)
    const last = measured.at(-1)?.recordedAt
    const added = onRoad ? extra.filter((p) => !last || new Date(p.recordedAt) > new Date(last)) : []
    return [...measured, ...added]
  }, [positions, extra, onRoad])
  const points = useMemo(() => trail.map((p) => [p.latitude, p.longitude]), [trail])

  const start = hasCoords(d.warehouse) ? [d.warehouse.latitude, d.warehouse.longitude] : null
  const destination = hasCoords(d.deliveryPoint) ? [d.deliveryPoint.latitude, d.deliveryPoint.longitude] : null
  const latest = fix && (!trail.at(-1) || new Date(fix.recordedAt) >= new Date(trail.at(-1).recordedAt)) ? fix : trail.at(-1) ?? null
  const here = points.at(-1) ?? null
  const isLive = !!latest && onRoad && (Date.now() - new Date(latest.recordedAt).getTime()) / 1000 <= 120
  const done = points.reduce((sum, p, i) => (i ? sum + distanceKm(points[i - 1], p) : 0), 0)
  const left = onRoad && here && destination ? distanceKm(here, destination) : null
  const percent = left === null ? null : Math.min(100, Math.round((done / Math.max(done + left, 0.001)) * 100))
  const seconds = trail.length > 1 ? (new Date(trail.at(-1).recordedAt) - new Date(trail[0].recordedAt)) / 1000 : 0
  const average = seconds >= 60 ? (done / seconds) * 3600 : null

  const markers = [
    ...(start ? [{ id: 'start', lat: start[0], lng: start[1], html: PIN_START, size: 30, label: `Départ : ${d.warehouse.name}` }] : []),
    ...(destination ? [{ id: 'end', lat: destination[0], lng: destination[1], html: PIN_END, size: 30, label: `Destination : ${d.deliveryPoint.name}` }] : []),
    ...(here ? [{ id: 'vehicle', lat: here[0], lng: here[1], html: vehicleHtml({ isLive, heading: latest?.headingDeg, selected: true }), size: 44, moving: true, heading: latest?.headingDeg, label: onRoad ? d.driver?.fullName ?? null : 'Dernière position' }] : []),
  ]
  const lines = [
    ...trailLines({ id: 'trip', points, live: onRoad ? isLive : true }),
    ...(left !== null ? [leftLine({ id: 'trip', from: here, to: destination })] : []),
    // Avant le départ, le trajet prévu relie simplement les deux lieux.
    ...(!points.length && start && destination ? [leftLine({ id: 'plan', from: start, to: destination })] : []),
  ]
  const fitPoints = useMemo(() => [start, destination, ...points].filter(Boolean), [nonce, points.length > 0, start?.[0], destination?.[0]]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!fitPoints.length) return <Empty icon={MapPin} title="Aucune coordonnée">Renseignez la position de l'entrepôt et du point de livraison pour les voir ici.</Empty>
  return (
    <div className="trip-map">
      <MapView markers={markers} lines={lines} fitKey={`${d.id}:${nonce}:${points.length > 0}`} fitPoints={fitPoints} fitPadding={{ topLeft: [50, 50], bottomRight: [50, 40] }} followPoint={follow ? here : null} onUserMove={() => setFollow(false)} />
      <div className="trip-bar">
        <div className="ops-legend-items">
          <span><i className="lg-line" />Trajet réel</span>
          <span><i className="lg-dash" />{points.length ? 'Reste à vol d\'oiseau' : 'Trajet prévu, à vol d\'oiseau'}</span>
        </div>
        <div className="trip-tools">
          {onRoad && here && <button type="button" className={`ops-action ${follow ? 'is-on' : ''}`} aria-pressed={follow} onClick={() => setFollow(!follow)}><LocateFixed size={15} aria-hidden />{follow ? 'Suivi activé' : 'Suivre'}</button>}
          <button type="button" className="ops-action" onClick={() => { setFollow(false); setNonce((n) => n + 1) }}><Maximize size={15} aria-hidden />Recadrer</button>
        </div>
      </div>
      {percent !== null && (
        <div className="ops-progress">
          <div><span>Progression estimée · reste {km(left)} à vol d'oiseau</span><strong>{percent} %</strong></div>
          <div className="ops-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Progression estimée"><span style={{ width: `${percent}%` }} /></div>
        </div>
      )}
      {points.length > 0 && (
        <div className="ops-stats">
          <Stat icon={Route} label="Parcouru" value={km(done)} />
          <Stat icon={Clock} label="Durée" value={duration(trail[0].recordedAt, onRoad ? Date.now() : trail.at(-1).recordedAt)} />
          <Stat icon={Activity} label="Moyenne" value={average === null ? '—' : `${Math.round(average)} km/h`} />
          {onRoad && <Stat icon={Gauge} label="Vitesse" value={!isLive || latest?.speedMs == null ? '—' : `${Math.round(latest.speedMs * 3.6)} km/h`} />}
          {onRoad && <Stat icon={BatteryMedium} label="Batterie" value={latest?.batteryLevel == null ? '—' : `${latest.batteryLevel} %`} />}
          <Stat icon={Satellite} label={onRoad ? 'Dernier signal' : 'Fin du trajet'} value={ago(latest?.recordedAt)} />
        </div>
      )}
    </div>
  )
}

const STOP_TONE = { DELIVERED: 'done', PARTIALLY_DELIVERED: 'done', FAILED: 'failed', RETURNED: 'failed', CANCELLED: 'failed', IN_TRANSIT: 'now', ARRIVED: 'now' }
const stopHtml = (n, status) => `<div class="pin pin-stop pin-stop-${STOP_TONE[status] ?? 'todo'}">${n}</div>`
const TERMINAL = ['DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED']

/**
 * Carte d'une tournée, au même design que le suivi en direct : départ, arrêts numérotés dans l'ordre
 * de passage et colorés selon leur état, ordre prévu en pointillés, trajet réel du chauffeur en bleu.
 */
export function RouteMap({ route: r, positions, onReload }) {
  const [extra, setExtra] = useState([])
  const [fix, setFix] = useState(null)
  const [follow, setFollow] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [, tick] = useState(0)
  const running = r.status === 'IN_PROGRESS'

  useLive('position.update', (p) => {
    if (!running || p.driverId !== r.driver?.id) return
    setFix(p)
    if (p.batch > 1) onReload?.()
    else if (reliable(p)) setExtra((all) => [...all, p])
  })
  useEffect(() => {
    if (!running) return undefined
    const t = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [running])

  const trail = useMemo(() => {
    const measured = (positions ?? []).filter(reliable)
    const last = measured.at(-1)?.recordedAt
    return [...measured, ...(running ? extra.filter((p) => !last || new Date(p.recordedAt) > new Date(last)) : [])]
  }, [positions, extra, running])
  const points = useMemo(() => trail.map((p) => [p.latitude, p.longitude]), [trail])
  const start = hasCoords(r.warehouse) ? [r.warehouse.latitude, r.warehouse.longitude] : null
  const stops = r.stops.filter((s) => hasCoords(s.delivery.deliveryPoint))
  const latest = fix && (!trail.at(-1) || new Date(fix.recordedAt) >= new Date(trail.at(-1).recordedAt)) ? fix : trail.at(-1) ?? null
  const here = points.at(-1) ?? null
  const isLive = !!latest && running && (Date.now() - new Date(latest.recordedAt).getTime()) / 1000 <= 120
  const done = points.reduce((sum, p, i) => (i ? sum + distanceKm(points[i - 1], p) : 0), 0)
  const finished = r.stops.filter((s) => TERMINAL.includes(s.delivery.status)).length
  const next = r.stops.find((s) => !TERMINAL.includes(s.delivery.status))

  const markers = [
    ...(start ? [{ id: 'start', lat: start[0], lng: start[1], html: PIN_START, size: 30, label: `Départ : ${r.warehouse.name}` }] : []),
    ...stops.map((s) => ({
      id: `stop-${s.id}`, lat: s.delivery.deliveryPoint.latitude, lng: s.delivery.deliveryPoint.longitude, html: stopHtml(s.position, s.delivery.status), size: 30,
      label: TERMINAL.includes(s.delivery.status) ? null : `${s.position}. ${s.delivery.deliveryPoint.name}`,
    })),
    ...(here && running ? [{ id: 'vehicle', lat: here[0], lng: here[1], html: vehicleHtml({ isLive, heading: latest?.headingDeg, selected: true }), size: 44, moving: true, heading: latest?.headingDeg, label: r.driver?.fullName ?? null }] : []),
  ]
  // Ordre de passage prévu : du départ à chaque arrêt, dans l'ordre fixé par le gestionnaire.
  const planned = [start, ...stops.map((s) => [s.delivery.deliveryPoint.latitude, s.delivery.deliveryPoint.longitude])].filter(Boolean)
  const lines = [
    ...(planned.length > 1 ? [{ id: 'plan', points: planned, color: '#14213D', weight: 2.5, opacity: 0.55, dashed: true, flow: running }] : []),
    ...trailLines({ id: 'route', points, live: running ? isLive : true }),
  ]
  const fitPoints = useMemo(() => [...planned, ...points], [nonce, points.length > 0, planned.length]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!fitPoints.length) return <Empty icon={MapPin} title="Aucune coordonnée">Renseignez la position de l'entrepôt et des points de livraison pour voir la tournée.</Empty>
  return (
    <div className="trip-map">
      <MapView markers={markers} lines={lines} fitKey={`${r.id}:${nonce}:${points.length > 0}`} fitPoints={fitPoints} fitPadding={{ topLeft: [50, 50], bottomRight: [50, 40] }} followPoint={follow ? here : null} onUserMove={() => setFollow(false)} />
      <div className="trip-bar">
        <div className="ops-legend-items">
          <span><i className="lg-line" />Trajet réel</span><span><i className="lg-dash" />Ordre de passage prévu</span>
          <span><i className="lg-stop lg-stop-done" />Livré</span><span><i className="lg-stop lg-stop-now" />En cours</span><span><i className="lg-stop lg-stop-todo" />À faire</span><span><i className="lg-stop lg-stop-failed" />Échec</span>
        </div>
        <div className="trip-tools">
          {running && here && <button type="button" className={`ops-action ${follow ? 'is-on' : ''}`} aria-pressed={follow} onClick={() => setFollow(!follow)}><LocateFixed size={15} aria-hidden />{follow ? 'Suivi activé' : 'Suivre'}</button>}
          <button type="button" className="ops-action" onClick={() => { setFollow(false); setNonce((n) => n + 1) }}><Maximize size={15} aria-hidden />Recadrer</button>
        </div>
      </div>
      <div className="ops-progress">
        <div><span>{next ? `Prochain arrêt : ${next.position}. ${next.delivery.deliveryPoint.name}` : 'Tous les arrêts sont traités'}</span><strong>{finished} / {r.stops.length}</strong></div>
        <div className="ops-bar" role="progressbar" aria-valuenow={finished} aria-valuemin={0} aria-valuemax={r.stops.length} aria-label="Arrêts traités"><span style={{ width: `${r.stops.length ? (finished / r.stops.length) * 100 : 0}%` }} /></div>
      </div>
      {points.length > 0 && (
        <div className="ops-stats">
          <Stat icon={Route} label="Parcouru" value={km(done)} />
          <Stat icon={Clock} label="Durée" value={duration(trail[0].recordedAt, running ? Date.now() : trail.at(-1).recordedAt)} />
          {running && <Stat icon={Gauge} label="Vitesse" value={!isLive || latest?.speedMs == null ? '—' : `${Math.round(latest.speedMs * 3.6)} km/h`} />}
          {running && <Stat icon={BatteryMedium} label="Batterie" value={latest?.batteryLevel == null ? '—' : `${latest.batteryLevel} %`} />}
          <Stat icon={Satellite} label={running ? 'Dernier signal' : 'Fin du trajet'} value={ago(latest?.recordedAt)} />
        </div>
      )}
      {stops.length < r.stops.length && <p className="muted small" style={{ margin: 0 }}>{r.stops.length - stops.length} arrêt(s) sans coordonnées n'apparaissent pas sur la carte.</p>}
    </div>
  )
}
