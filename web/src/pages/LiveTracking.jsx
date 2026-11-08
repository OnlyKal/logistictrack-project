import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity, AlertTriangle, ArrowRight, BatteryLow, BatteryMedium, CircleCheck, Clock, Crosshair, Flag, Gauge, LocateFixed, Maximize, MapPin, MapPinOff, Navigation, Phone, Radio, Route, Satellite, Search, Truck, Warehouse, WifiOff, X,
} from 'lucide-react'
import { useFetch } from '../lib/hooks.js'
import { useLive, useSocketStatus } from '../lib/socket.js'
import { accuracyLabel, ago, dateTime, distanceKm, km } from '../lib/format.js'
import { MapView } from '../components/MapView.jsx'
import { PIN_END, PIN_START, TRAIL_MAX_ACCURACY_M, duration, hasCoords, leftLine, trailLines, vehicleHtml } from '../components/TripMap.jsx'

const LOW_BATTERY = 15
const place = (p) => [p?.address, p?.commune, p?.city].filter(Boolean).join(', ')

/** Toutes les valeurs viennent des positions reçues : ce qui n'est pas mesuré n'est jamais estimé sans le dire. */
function analyse(row, extra, liveFix) {
  const fresh = liveFix?.sessionId === row.sessionId ? liveFix : null
  const pos = fresh && (!row.position || new Date(fresh.recordedAt) >= new Date(row.position.recordedAt)) ? fresh : row.position
  const age = pos ? Math.round((Date.now() - new Date(pos.recordedAt).getTime()) / 1000) : null
  const lastKnown = row.trail.at(-1)?.[2] ?? 0
  const stamped = [...row.trail, ...(extra ?? []).filter((p) => p[2] > lastKnown)]
  const trail = stamped.map(([lat, lng]) => [lat, lng])
  const delivery = row.deliveries.find((d) => d.status === 'IN_TRANSIT') ?? row.deliveries[0]
  const point = delivery?.deliveryPoint
  const destination = hasCoords(point) ? [point.latitude, point.longitude] : null
  const start = hasCoords(delivery?.warehouse) ? [delivery.warehouse.latitude, delivery.warehouse.longitude] : null
  // Une mesure trop imprécise ne déplace ni le véhicule ni la ligne.
  const reliable = pos && (pos.accuracyM == null || pos.accuracyM <= TRAIL_MAX_ACCURACY_M)
  const here = reliable ? [pos.latitude, pos.longitude] : trail.at(-1) ?? (pos ? [pos.latitude, pos.longitude] : null)
  const done = trail.reduce((sum, p, i) => (i ? sum + distanceKm(trail[i - 1], p) : 0), 0)
  const left = here && destination ? distanceKm(here, destination) : null
  const percent = left === null ? null : Math.min(100, Math.round((done / Math.max(done + left, 0.001)) * 100))
  const seconds = stamped.length > 1 ? (stamped.at(-1)[2] - stamped[0][2]) / 1000 : 0
  const averageKmh = seconds >= 60 ? (done / seconds) * 3600 : null
  const isLive = age !== null && age <= 120
  const alerts = []
  if (!pos) alerts.push({ icon: Satellite, tone: 'warn', text: "Aucune position reçue : GPS du téléphone à vérifier." })
  else if (!isLive) alerts.push({ icon: WifiOff, tone: 'warn', text: `Signal perdu ${ago(pos.recordedAt)}. Hors réseau, le téléphone garde ses positions et les enverra au retour de la connexion.` })
  if (pos?.batteryLevel != null && pos.batteryLevel <= LOW_BATTERY) alerts.push({ icon: BatteryLow, tone: 'danger', text: `Batterie faible : ${pos.batteryLevel} %.` })
  if (pos && !reliable) alerts.push({ icon: Crosshair, tone: 'warn', text: `Position imprécise écartée (${Math.round(pos.accuracyM)} m).` })
  if (!destination) alerts.push({ icon: MapPinOff, tone: 'info', text: 'Destination non localisée : renseignez ses coordonnées sur le point de livraison.' })
  return { ...row, pos, age, isLive, trail, delivery, point, destination, start, here, done, left, percent, averageKmh, alerts, serious: alerts.some((a) => a.tone !== 'info') }
}

function Kpi({ icon: Icon, label, value, tone }) {
  return <div className={`ops-kpi ${tone ? `ops-kpi-${tone}` : ''}`}><Icon size={15} strokeWidth={2} aria-hidden /><strong>{value}</strong><span>{label}</span></div>
}

function Progress({ percent, label }) {
  return <div className="ops-bar" role="progressbar" aria-valuenow={percent ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label={label}><span style={{ width: `${percent ?? 0}%` }} /></div>
}

function DriverCard({ row, selected, onSelect }) {
  const d = row.delivery
  return (
    <button type="button" className={`ops-card ${selected ? 'is-selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
      <div className="ops-card-head">
        <span className={`ops-dot ${row.isLive ? 'is-live' : 'is-lost'}`} aria-hidden />
        <strong>{row.driver.fullName}</strong>
        <span className="ops-signal">{!row.pos ? 'Aucun signal' : row.isLive ? 'En direct' : ago(row.pos.recordedAt)}</span>
      </div>
      <div className="ops-route"><span>{d?.warehouse?.name ?? '—'}</span><ArrowRight size={12} aria-hidden /><span>{row.point?.name ?? '—'}</span></div>
      {row.percent !== null && <Progress percent={row.percent} label={`Progression de ${row.driver.fullName}`} />}
      <div className="ops-card-foot">
        <span>{d?.vehicle?.registration ?? '—'}</span>
        <span>{!row.isLive || row.pos?.speedMs == null ? '—' : `${Math.round(row.pos.speedMs * 3.6)} km/h`}</span>
        <span>{row.left === null ? km(row.done) : `reste ${km(row.left)}`}</span>
        {row.serious && <AlertTriangle size={13} className="ops-warn" aria-label="Alerte" />}
      </div>
    </button>
  )
}

function Stat({ icon: Icon, label, value }) {
  return <div className="ops-stat"><span><Icon size={13} aria-hidden />{label}</span><strong>{value}</strong></div>
}

function TripDetail({ row, follow, onFollow, onCenter, onClose }) {
  const { pos, delivery: d, point } = row
  return (
    <aside className="ops-panel ops-detail" aria-label={`Suivi de ${row.driver.fullName}`}>
      <header className="ops-detail-head">
        <div><h2>{row.driver.fullName}</h2><p>{[d?.vehicle?.registration, d?.number].filter(Boolean).join(' · ')}</p></div>
        <button type="button" className="ops-icon" onClick={onClose} aria-label="Fermer"><X size={16} aria-hidden /></button>
      </header>
      {row.alerts.length > 0 && <div className="ops-alerts">{row.alerts.map((a) => <div key={a.text} className={`ops-alert ops-alert-${a.tone}`}><a.icon size={14} aria-hidden /><span>{a.text}</span></div>)}</div>}

      <ol className="ops-timeline">
        <li className="is-start">
          <span className="ops-node"><Warehouse size={13} aria-hidden /></span>
          <div><small>Départ · {dateTime(row.startedAt)}</small><strong>{d?.warehouse?.name ?? '—'}</strong>{d?.warehouse?.address && <p>{d.warehouse.address}</p>}{!row.start && <em>Non localisé sur la carte</em>}</div>
        </li>
        <li className="is-now">
          <span className="ops-node"><Navigation size={13} aria-hidden /></span>
          <div><small>{row.isLive ? 'Position en direct' : 'Dernière position'}{pos ? ` · ${ago(pos.recordedAt)}` : ''}</small><strong>{pos ? `${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}` : 'Aucune position'}</strong>{row.left !== null && <p>{km(row.done)} parcourus · reste {km(row.left)} à vol d'oiseau</p>}</div>
        </li>
        <li className="is-end">
          <span className="ops-node"><Flag size={13} aria-hidden /></span>
          <div><small>Destination · {d?.customer?.name}</small><strong>{point?.name ?? '—'}</strong>{place(point) && <p>{place(point)}</p>}{point?.contactName && <p>{point.contactName}{point.phone ? ` · ${point.phone}` : ''}</p>}{!row.destination && <em>Non localisée sur la carte</em>}</div>
        </li>
      </ol>

      {row.percent !== null && (
        <div className="ops-progress">
          <div><span>Progression estimée</span><strong>{row.percent} %</strong></div>
          <Progress percent={row.percent} label="Progression estimée" />
        </div>
      )}

      <div className="ops-stats">
        <Stat icon={Gauge} label="Vitesse" value={!row.isLive || pos?.speedMs == null ? '—' : `${Math.round(pos.speedMs * 3.6)} km/h`} />
        <Stat icon={Activity} label="Moyenne" value={row.averageKmh === null ? '—' : `${Math.round(row.averageKmh)} km/h`} />
        <Stat icon={Clock} label="En route" value={duration(row.startedAt)} />
        <Stat icon={Route} label="Parcouru" value={km(row.done)} />
        <Stat icon={BatteryMedium} label="Batterie" value={pos?.batteryLevel == null ? '—' : `${pos.batteryLevel} %`} />
        <Stat icon={Crosshair} label="Précision" value={pos ? accuracyLabel(pos.accuracyM).replace('Précision indisponible', '—') : '—'} />
      </div>

      <div className="ops-actions">
        <button type="button" className={`ops-action ${follow ? 'is-on' : ''}`} onClick={onFollow} aria-pressed={follow} disabled={!row.here}><LocateFixed size={15} aria-hidden />{follow ? 'Suivi activé' : 'Suivre'}</button>
        <button type="button" className="ops-action" onClick={onCenter}><Maximize size={15} aria-hidden />Recadrer</button>
        {row.driver.phone && <a className="ops-action" href={`tel:${row.driver.phone.replace(/[^+\d]/g, '')}`}><Phone size={15} aria-hidden />Appeler</a>}
      </div>
      <div className="ops-links">
        {row.deliveries.map((x) => <Link key={x.id} to={`/livraisons/${x.id}`}>{x.number}</Link>)}
        <Link to={`/chauffeurs/${row.driver.id}`}>Fiche du chauffeur</Link>
      </div>
    </aside>
  )
}

export function LiveTracking() {
  const { data, error, loading, reload } = useFetch('/tracking/drivers/live')
  const onSite = useFetch('/tracking/on-site')
  const connected = useSocketStatus()
  const [fixes, setFixes] = useState({})
  const [extra, setExtra] = useState({})
  const [selected, setSelected] = useState(null)
  const [closed, setClosed] = useState(false)
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [follow, setFollow] = useState(false)
  const [fitNonce, setFitNonce] = useState(0)
  const [, tick] = useState(0)
  const reloadAll = () => { reload(); onSite.reload() }

  useLive('position.update', (p) => {
    setFixes((all) => ({ ...all, [p.driverId]: p }))
    // Retour du réseau : plusieurs positions d'un coup, le tracé complet vient du serveur.
    if (p.batch > 1) reload()
    else if (p.accuracyM == null || p.accuracyM <= TRAIL_MAX_ACCURACY_M) {
      setExtra((all) => ({ ...all, [p.sessionId]: [...(all[p.sessionId] ?? []), [p.latitude, p.longitude, new Date(p.recordedAt).getTime()]] }))
    }
  })
  useLive('delivery.status', reloadAll)
  // La fraîcheur est recalculée en continu : une position ancienne ne reste jamais « en direct ».
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000)
    const r = setInterval(reloadAll, 60000)
    return () => { clearInterval(t); clearInterval(r) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = (data ?? []).map((row) => analyse(row, extra[row.sessionId], fixes[row.driver.id]))
  const current = closed ? null : rows.find((r) => r.driver.id === selected) ?? (rows.length === 1 ? rows[0] : null)
  const id = current?.sessionId ?? null
  const live = rows.filter((r) => r.isLive).length
  const lost = rows.length - live
  const arrived = onSite.data ?? []
  const shown = rows
    .filter((r) => (filter === 'live' ? r.isLive : filter === 'lost' ? !r.isLive : true))
    .filter((r) => {
      const term = q.trim().toLowerCase()
      if (!term) return true
      return [r.driver.fullName, r.delivery?.number, r.delivery?.vehicle?.registration, r.point?.name, r.delivery?.customer?.name, r.delivery?.warehouse?.name].some((v) => v?.toLowerCase().includes(term))
    })
  const focusOn = (driverId) => { setSelected(driverId); setClosed(false); setFollow(false) }
  useEffect(() => { if (!id) setFollow(false) }, [id])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { setClosed(true); setFollow(false) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const markers = rows.flatMap((r) => {
    const focus = r.sessionId === id
    return [
      ...(r.start ? [{ id: `wh-${r.sessionId}`, lat: r.start[0], lng: r.start[1], html: PIN_START, size: 30, label: focus ? `Départ : ${r.delivery.warehouse.name}` : null, onClick: () => focusOn(r.driver.id) }] : []),
      ...(r.destination ? [{ id: `dest-${r.sessionId}`, lat: r.destination[0], lng: r.destination[1], html: PIN_END, size: 30, label: focus ? `Destination : ${r.point.name}` : null, onClick: () => focusOn(r.driver.id) }] : []),
      ...(r.here ? [{ id: r.driver.id, lat: r.here[0], lng: r.here[1], html: vehicleHtml({ isLive: r.isLive, heading: r.pos?.headingDeg, selected: focus }), size: 44, moving: true, heading: r.pos?.headingDeg, title: r.driver.fullName, label: r.driver.fullName, onClick: () => focusOn(r.driver.id) }] : []),
    ]
  })
  const lines = rows.flatMap((r) => {
    const focus = !id || r.sessionId === id
    const points = r.trail.length && r.here ? [...r.trail, r.here] : r.trail
    return [
      ...trailLines({ id: r.sessionId, points, live: r.isLive, focus }),
      ...(r.here && r.destination ? [leftLine({ id: r.sessionId, from: r.here, to: r.destination, focus })] : []),
    ]
  })
  const tripPoints = (r) => [r.start, r.here, r.destination, ...r.trail].filter(Boolean)
  const fitPoints = useMemo(() => (current ? tripPoints(current) : rows.flatMap(tripPoints)), [id, fitNonce, rows.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="ops" aria-label="Suivi en direct">
      <MapView
        markers={markers} lines={lines} fitKey={`${id ?? 'all'}:${fitNonce}:${rows.length > 0}`} fitPoints={fitPoints}
        fitPadding={{ topLeft: [376, 96], bottomRight: [current ? 396 : 40, 40] }} followPoint={follow ? current?.here : null} onUserMove={() => setFollow(false)}
      />

      <header className="ops-top">
        <div className="ops-title">
          <h1>Suivi en direct</h1>
          <span className={`ops-link ${connected ? 'is-on' : ''}`} role="status"><Radio size={12} aria-hidden />{connected ? 'Temps réel' : 'Reconnexion…'}</span>
        </div>
        <div className="ops-kpis">
          <Kpi icon={Truck} label="En route" value={rows.length} />
          <Kpi icon={Satellite} label="En direct" value={live} tone={live ? 'ok' : undefined} />
          <Kpi icon={WifiOff} label="Sans signal" value={lost} tone={lost ? 'warn' : undefined} />
          <Kpi icon={CircleCheck} label="Sur place" value={arrived.length} />
        </div>
      </header>

      <aside className="ops-panel ops-list" aria-label="Chauffeurs">
        <label className="ops-search"><Search size={14} aria-hidden /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chauffeur, véhicule, destination" aria-label="Rechercher" /></label>
        <div className="ops-chips" role="group" aria-label="Filtrer">
          {[['all', 'Tous', rows.length], ['live', 'En direct', live], ['lost', 'Sans signal', lost]].map(([value, label, count]) => (
            <button key={value} type="button" className={filter === value ? 'is-on' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<b>{count}</b></button>
          ))}
        </div>
        {error && <div className="ops-alert ops-alert-danger"><AlertTriangle size={14} aria-hidden /><span>{error.message}</span></div>}
        <div className="ops-scroll">
          {loading && !data && <div className="ops-empty">Chargement…</div>}
          {data && !shown.length && (
            <div className="ops-empty">
              <Satellite size={24} strokeWidth={1.5} aria-hidden />
              <strong>{rows.length ? 'Aucun résultat' : 'Aucun chauffeur en route'}</strong>
              <span>{rows.length ? 'Modifiez la recherche ou le filtre.' : "Le suivi démarre quand un chauffeur appuie sur « Démarrer le transport »."}</span>
            </div>
          )}
          {shown.map((r) => <DriverCard key={r.sessionId} row={r} selected={r.sessionId === id} onSelect={() => focusOn(r.driver.id)} />)}
          {arrived.length > 0 && (
            <div className="ops-onsite">
              <h3><MapPin size={13} aria-hidden />Arrivés sur place</h3>
              {arrived.map((a) => (
                <Link key={a.id} to={`/livraisons/${a.id}`} className="ops-onsite-row">
                  <strong>{a.driver?.fullName ?? '—'}</strong>
                  <span>{a.deliveryPoint.name} · {a.arrivedAt ? ago(a.arrivedAt) : '—'}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </aside>

      {current && <TripDetail row={current} follow={follow} onFollow={() => setFollow(!follow)} onCenter={() => { setFollow(false); setFitNonce((n) => n + 1) }} onClose={() => { setClosed(true); setFollow(false) }} />}

      <div className={`ops-legend ${current ? 'with-detail' : ''}`}>
        <span><i className="lg-line" />Trajet réel</span>
        <span><i className="lg-dash" />Reste à vol d'oiseau</span>
        <button type="button" onClick={() => { setClosed(true); setFollow(false); setFitNonce((n) => n + 1) }}><Maximize size={13} aria-hidden />Tout voir</button>
      </div>
    </section>
  )
}
