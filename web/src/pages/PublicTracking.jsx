/**
 * Suivi public d'un colis, sans compte : état, étapes, et carte en direct pendant le trajet.
 * La carte n'apparaît qu'avec le lien reçu par e-mail (clé signée) ; la recherche par numéro
 * de suivi ne donne que l'état. Mise à jour par WebSocket, sans recharger la page.
 * Aucune donnée sur le chauffeur ni sur l'organisation interne de l'entreprise.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { io } from 'socket.io-client'
import {
  Ban, Check, CircleAlert, Clock, Crosshair, Flag, LocateFixed, Mail, MapPin, Maximize, Navigation, Package, PackageCheck, PackageSearch,
  Phone, Radio, Route, ShieldCheck, Truck, Undo2, WifiOff, X,
} from 'lucide-react'
import { api } from '../lib/api.js'
import { date, dateTime, distanceKm, km } from '../lib/format.js'
import { MapView } from '../components/MapView.jsx'
import { PIN_END, leftLine, trailLines, vehicleHtml } from '../components/TripMap.jsx'
import { Button, ErrorBox, Input } from '../components/ui.jsx'

const STATUS_LOOK = {
  DRAFT: [Package, 'neutral'], PENDING: [Package, 'neutral'], VALIDATED: [Package, 'neutral'], PREPARING: [Package, 'blue'], READY: [Package, 'blue'],
  ASSIGNED: [Package, 'blue'], LOADED: [Truck, 'blue'], IN_TRANSIT: [Truck, 'blue'], ARRIVED: [MapPin, 'blue'], DELIVERED: [PackageCheck, 'green'],
  PARTIALLY_DELIVERED: [PackageCheck, 'orange'], FAILED: [CircleAlert, 'red'], RETURNED: [Undo2, 'orange'], CANCELLED: [Ban, 'red'],
}
const STEP_ICON = { REGISTERED: Package, PREPARED: PackageCheck, IN_TRANSIT: Truck, ARRIVED: MapPin, DELIVERED: Check }

/** Message de la carte quand la position n'est pas affichée : toujours la vraie raison. */
const MAP_NOTICE = {
  NOT_STARTED: [Clock, 'La carte s’activera au départ du livreur', 'Vous verrez alors sa position en direct, jusqu’à son arrivée chez vous.'],
  WAITING: [Radio, 'Le livreur est parti', 'En attente de sa première position. La carte se met à jour toute seule.'],
  OTHER_STOP: [Route, 'Une autre livraison est en cours avant la vôtre', 'La position du livreur réapparaîtra dès qu’il reprendra la route vers vous.'],
  ARRIVED: [MapPin, 'Le livreur est arrivé', 'Il est à votre adresse de livraison.'],
  ENDED: [ShieldCheck, 'Le suivi en direct est terminé', 'La position du livreur n’est visible que pendant le trajet.'],
}

const clock = (v) => new Date(v).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
function since(seconds) {
  if (seconds < 10) return 'à l’instant'
  if (seconds < 60) return `il y a ${seconds} s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `il y a ${m} min` : `il y a ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

/** Connexion temps réel propre à cette page : jeton du colis et clé du lien, jamais de compte. */
function usePublicSocket(token, key, enabled, onPosition, onRefresh) {
  const [connected, setConnected] = useState(false)
  const handlers = useRef({ onPosition, onRefresh })
  useEffect(() => { handlers.current = { onPosition, onRefresh } })
  useEffect(() => {
    if (!enabled) return undefined
    const socket = io(import.meta.env.VITE_API_URL ?? '/', { auth: { trackingToken: token, key }, transports: ['websocket', 'polling'] })
    socket.on('connect', () => { setConnected(true); handlers.current.onRefresh() })
    socket.on('disconnect', () => setConnected(false))
    socket.on('public.position', (p) => handlers.current.onPosition(p))
    socket.on('public.refresh', () => handlers.current.onRefresh())
    return () => { socket.close(); setConnected(false) }
  }, [token, key, enabled])
  return connected
}

function SearchForm({ compact }) {
  const navigate = useNavigate()
  const [number, setNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const search = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.post('/public/tracking/search', { trackingNumber: number.trim() })
      navigate(`/suivi-colis/${res.token}`)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="stack" onSubmit={search}>
      {!compact && <div><h1 className="page-title">Suivre un colis</h1><p className="page-sub">Saisissez le numéro de suivi communiqué par l’expéditeur.</p></div>}
      <div className="tk-search">
        <Input required aria-label="Numéro de suivi" placeholder="LT…" value={number} onChange={(e) => setNumber(e.target.value)} />
        <Button type="submit" variant="primary" icon={PackageSearch} loading={busy}>Suivre</Button>
      </div>
      <ErrorBox error={error} />
    </form>
  )
}

function CompanyMark({ company }) {
  const [broken, setBroken] = useState(false)
  if (company.logoUrl && !broken) return <img className="tk-logo" src={company.logoUrl} alt={company.name} onError={() => setBroken(true)} />
  return <span className="tk-initial" aria-hidden>{company.name.trim().charAt(0).toUpperCase()}</span>
}

function Steps({ steps }) {
  return (
    <ol className="tk-steps">
      {steps.map((s) => {
        const Icon = s.state === 'failed' ? X : s.state === 'done' ? Check : STEP_ICON[s.key] ?? Package
        return (
          <li key={s.key} className={`tk-step is-${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
            <span className="tk-step-dot"><Icon size={14} strokeWidth={2.4} aria-hidden /></span>
            <div>
              <div className="tk-step-label">{s.label}</div>
              <div className="tk-step-at">{s.at ? dateTime(s.at) : s.state === 'current' ? 'En cours' : s.state === 'todo' ? 'À venir' : ''}</div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function LiveMap({ data, trail, fix, now, connected }) {
  const [follow, setFollow] = useState(false)
  const [nonce, setNonce] = useState(0)
  const t = data.tracking
  const dest = data.destination?.latitude != null ? [data.destination.latitude, data.destination.longitude] : null
  const showVehicle = t.state === 'LIVE' && fix
  const here = showVehicle ? [fix.latitude, fix.longitude] : null
  const age = fix ? Math.max(0, Math.round((now - new Date(fix.recordedAt).getTime()) / 1000)) : null
  const isLive = age !== null && age <= data.liveSeconds
  const remaining = here && dest ? distanceKm(here, dest) : null

  const markers = [
    ...(dest ? [{ id: 'dest', lat: dest[0], lng: dest[1], html: PIN_END, size: 30, label: 'Votre adresse' }] : []),
    ...(here ? [{ id: 'vehicle', lat: here[0], lng: here[1], html: vehicleHtml({ isLive, heading: fix.headingDeg, selected: true }), size: 44, moving: true, heading: fix.headingDeg, label: isLive ? 'Votre livreur' : 'Dernière position connue' }] : []),
  ]
  const lines = showVehicle ? [...trailLines({ id: 'trail', points: trail, live: isLive }), ...(dest ? [leftLine({ id: 'left', from: here, to: dest })] : [])] : []
  const fitPoints = useMemo(() => [...(dest ? [dest] : []), ...(showVehicle ? trail : [])], [nonce, showVehicle, trail.length > 0, dest?.[0]]) // eslint-disable-line react-hooks/exhaustive-deps
  const notice = t.state !== 'LIVE' ? MAP_NOTICE[t.state] : null

  return (
    <section className="tk-card tk-map-card" aria-label="Carte du trajet">
      <div className="tk-map">
        {fitPoints.length ? (
          <MapView markers={markers} lines={lines} fitKey={`${nonce}:${showVehicle}:${trail.length > 0}`} fitPoints={fitPoints} fitPadding={{ topLeft: [60, 60], bottomRight: [60, 60] }} followPoint={follow ? here : null} onUserMove={() => setFollow(false)} />
        ) : <div className="tk-map-empty"><MapPin size={22} aria-hidden /><span>L’emplacement de livraison n’est pas renseigné.</span></div>}
        {notice && (
          <div className="tk-map-notice" role="status">
            <span className="tk-notice-icon">{(() => { const Icon = notice[0]; return <Icon size={18} aria-hidden /> })()}</span>
            <div><div className="strong">{notice[1]}</div><div className="muted small">{notice[2]}</div></div>
          </div>
        )}
        {showVehicle && (
          <div className="tk-map-tools">
            <button type="button" className={`tk-tool ${follow ? 'is-on' : ''}`} aria-pressed={follow} onClick={() => setFollow(!follow)}><LocateFixed size={15} aria-hidden />{follow ? 'Suivi activé' : 'Suivre'}</button>
            <button type="button" className="tk-tool" onClick={() => { setFollow(false); setNonce((n) => n + 1) }}><Maximize size={15} aria-hidden />Recadrer</button>
          </div>
        )}
      </div>
      <div className="tk-map-foot">
        {showVehicle ? (
          <>
            <span className={`tk-live ${isLive ? 'is-live' : 'is-stale'}`}><i aria-hidden />{isLive ? 'En direct' : 'Signal interrompu'}</span>
            <span className="tk-foot-item"><Clock size={14} aria-hidden />Position de {clock(fix.recordedAt)} · {since(age)}</span>
            {remaining !== null && <span className="tk-foot-item"><Navigation size={14} aria-hidden />À environ {km(remaining)} à vol d’oiseau</span>}
          </>
        ) : <span className="tk-foot-item"><ShieldCheck size={14} aria-hidden />Position du livreur visible uniquement pendant le trajet vers vous</span>}
        {!connected && <span className="tk-foot-item tk-warn"><WifiOff size={14} aria-hidden />Reconnexion…</span>}
      </div>
      {showVehicle && !isLive && <p className="tk-stale-note">Le téléphone du livreur n’a pas transmis de position depuis {since(age).replace('il y a ', '')}, souvent faute de réseau. La carte reprendra dès son retour.</p>}
    </section>
  )
}

export function PublicTracking() {
  const { token } = useParams()
  const [params] = useSearchParams()
  const key = params.get('k') ?? ''
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [trail, setTrail] = useState([])
  const [fix, setFix] = useState(null)
  const [now, setNow] = useState(Date.now())
  const timer = useRef(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const next = await api.get(`/public/tracking/${encodeURIComponent(token)}${key ? `?k=${encodeURIComponent(key)}` : ''}`)
      setData(next)
      setError(null)
      setTrail(next.tracking?.trail ?? [])
      setFix(next.tracking?.position ?? null)
    } catch (err) {
      setError(err)
    }
  }, [token, key])

  // Plusieurs événements rapprochés : un seul rechargement.
  const refresh = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(load, 400)
  }, [load])

  useEffect(() => {
    setData(null)
    load()
    return () => clearTimeout(timer.current)
  }, [load])

  const live = !!data?.live
  const connected = usePublicSocket(token, key, live && !['DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED'].includes(data?.status), (p) => {
    if (data?.tracking?.state !== 'LIVE') return refresh()
    setFix(p)
    setTrail((all) => (all.length && all.at(-1)[0] === p.latitude && all.at(-1)[1] === p.longitude ? all : [...all, [p.latitude, p.longitude]]))
  }, refresh)

  // Horloge de « il y a X s », et filet de sécurité si le WebSocket est coupé.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!data || ['DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED'].includes(data.status)) return undefined
    const t = setInterval(() => { if (!document.hidden) load() }, connected ? 60_000 : 15_000)
    const onShow = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onShow)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow) }
  }, [data, connected, load])

  useEffect(() => {
    document.title = data ? `${data.statusLabel} · Suivi ${data.trackingNumber}` : 'Suivi de colis'
  }, [data])

  if (!token) {
    return (
      <div className="tk-page tk-page-search">
        <header className="tk-top"><Link to="/suivi-colis" className="tk-brand"><span className="brand-mark"><Truck size={15} strokeWidth={2.2} aria-hidden /></span>LogisticTrack</Link></header>
        <div className="tk-card tk-search-card"><SearchForm /></div>
        <Link className="small" to="/connexion">Espace professionnel</Link>
      </div>
    )
  }
  if (error && !data) {
    return (
      <div className="tk-page tk-page-search">
        <header className="tk-top"><Link to="/suivi-colis" className="tk-brand"><span className="brand-mark"><Truck size={15} strokeWidth={2.2} aria-hidden /></span>LogisticTrack</Link></header>
        <div className="tk-card tk-search-card"><div className="stack"><h1 className="page-title">Lien de suivi invalide</h1><p className="muted">Ce lien n’existe pas ou n’est plus valable. Vérifiez le lien reçu, ou recherchez votre colis par son numéro de suivi.</p><SearchForm compact /></div></div>
      </div>
    )
  }
  if (!data) return <div className="tk-page"><div className="tk-loading" role="status"><span className="tk-spinner" aria-hidden />Chargement du suivi…</div></div>

  const [StatusIcon, tone] = STATUS_LOOK[data.status] ?? [Package, 'neutral']
  const t = data.tracking
  return (
    <div className="tk-page">
      <header className="tk-top">
        <div className="tk-company"><CompanyMark company={data.company} /><div><div className="tk-company-name">{data.company.name}</div><div className="muted small">Suivi de livraison</div></div></div>
        <div className="tk-number"><span className="muted small">N° de suivi</span><span className="mono strong">{data.trackingNumber}</span></div>
      </header>

      <main className="tk-grid">
        <section className={`tk-card tk-status tone-${tone}`} aria-live="polite">
          <span className="tk-status-icon"><StatusIcon size={22} aria-hidden /></span>
          <div className="tk-status-body">
            <h1 className="tk-status-label">{data.statusLabel}</h1>
            <p className="tk-status-hint">{data.statusHint}</p>
            {t?.stopsBefore > 0 && <p className="tk-chip"><Route size={14} aria-hidden />{t.stopsBefore === 1 ? '1 livraison avant la vôtre' : `${t.stopsBefore} livraisons avant la vôtre`}</p>}
          </div>
        </section>

        {live ? <LiveMap data={data} trail={trail} fix={fix} now={now} connected={connected} /> : (
          <section className="tk-card tk-nomap">
            <Crosshair size={20} aria-hidden />
            <div><div className="strong">Carte en direct</div><p className="muted small">Pendant le trajet, la position du livreur est visible avec le lien reçu par e-mail au départ de votre livraison.</p></div>
          </section>
        )}

        <section className="tk-card tk-pad tk-steps-card">
          <h2 className="tk-h2">Étapes de la livraison</h2>
          <Steps steps={data.steps} />
        </section>

        <section className="tk-card tk-pad tk-details">
          <h2 className="tk-h2">Informations</h2>
          <dl className="tk-kv">
            {data.destination?.label && <><dt><MapPin size={14} aria-hidden />Destination</dt><dd>{data.destination.label}</dd></>}
            {data.scheduledAt && <><dt><Clock size={14} aria-hidden />Date prévue</dt><dd>{date(data.scheduledAt)}</dd></>}
            {data.deliveredAt && <><dt><PackageCheck size={14} aria-hidden />Livré le</dt><dd>{dateTime(data.deliveredAt)}</dd></>}
            <dt><Package size={14} aria-hidden />Colis</dt><dd>{data.packages > 1 ? `${data.packages} colis` : '1 colis'}</dd>
            <dt><Flag size={14} aria-hidden />Expéditeur</dt><dd>{data.company.name}</dd>
          </dl>
          {(data.company.phone || data.company.email) && (
            <div className="tk-contact">
              <div className="muted small">Une question sur votre livraison ? Contactez {data.company.name}.</div>
              <div className="tk-contact-actions">
                {data.company.phone && <a className="tk-tool" href={`tel:${data.company.phone.replace(/\s/g, '')}`}><Phone size={15} aria-hidden />{data.company.phone}</a>}
                {data.company.email && <a className="tk-tool" href={`mailto:${data.company.email}`}><Mail size={15} aria-hidden />Écrire</a>}
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="tk-foot">
        <span><ShieldCheck size={14} aria-hidden />Lien personnel : ne le partagez qu’avec les personnes qui réceptionnent le colis.</span>
        <span>Suivi fourni par <strong>LogisticTrack</strong></span>
      </footer>
    </div>
  )
}
