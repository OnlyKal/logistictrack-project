import { useEffect, useState } from 'react'
import { MapPin, Warehouse } from 'lucide-react'

/** Scène décorative de la connexion : un entrepôt, ses tournées et les arrivées chez les destinataires. */
const HUB = { x: 400, y: 340 }
const ROUTES = [
  { to: [130, 130], d: 'M400 340 L400 250 Q400 225 375 225 L155 225 Q130 225 130 200 L130 130', dur: 11, begin: -2 },
  { to: [670, 110], d: 'M400 340 L500 340 Q525 340 525 315 L525 165 Q525 140 550 140 L645 140 Q670 140 670 115 L670 110', dur: 13, begin: -8 },
  { to: [700, 470], d: 'M400 340 L560 340 Q585 340 585 365 L585 445 Q585 470 610 470 L700 470', dur: 10, begin: -5 },
  { to: [110, 450], d: 'M400 340 L320 340 Q295 340 295 365 L295 425 Q295 450 270 450 L110 450', dur: 12, begin: -10 },
  { to: [430, 60], d: 'M400 340 L400 250 Q400 225 425 225 L430 225 Q445 225 445 200 L445 85 Q445 60 430 60', dur: 14, begin: -4 },
]
const LIFECYCLE = ['Préparation', 'Chargement', 'En route', 'Arrivée', 'Livraison']

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

function Route({ route, index, still }) {
  const timing = { dur: `${route.dur}s`, begin: `${route.begin}s`, repeatCount: 'indefinite' }
  const [x, y] = route.to
  return (
    <g>
      <path className="scene-road" d={route.d} pathLength="1" style={{ animationDelay: `${index * 0.12}s` }} />
      <path className="scene-flow" d={route.d} pathLength="100" />
      {!still && (
        <circle cx={x} cy={y} fill="none" stroke="#2563eb" strokeWidth="2" opacity="0">
          <animate attributeName="r" values="10;10;44" keyTimes="0;0.86;1" {...timing} />
          <animate attributeName="opacity" values="0;0;0.9;0" keyTimes="0;0.86;0.88;1" {...timing} />
        </circle>
      )}
      <circle cx={x} cy={y} r="17" className="scene-node" />
      <MapPin x={x - 8} y={y - 8} size={16} color="#ffffff" strokeWidth={1.8} aria-hidden />
      {!still && (
        <g opacity="0">
          <circle r="13" fill="#2563eb" opacity="0.35" />
          <circle r="5.5" fill="#ffffff" stroke="#2563eb" strokeWidth="2.5" />
          <animateMotion path={route.d} keyPoints="0;1;1" keyTimes="0;0.86;1" calcMode="linear" {...timing} />
          <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.03;0.85;0.87;1" {...timing} />
        </g>
      )}
    </g>
  )
}

export function LoginScene() {
  const still = useReducedMotion()
  return (
    <>
      <svg className="scene-map" viewBox="0 0 800 560" preserveAspectRatio="xMidYMid meet" aria-hidden focusable="false">
        <defs>
          <pattern id="scene-grid" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="1.5" cy="1.5" r="1.1" fill="#ffffff" opacity="0.1" />
          </pattern>
        </defs>
        <rect x="-1000" y="-1000" width="2800" height="2600" fill="url(#scene-grid)" />
        {[90, 170, 260].map((r) => <circle key={r} cx={HUB.x} cy={HUB.y} r={r} fill="none" stroke="#ffffff" strokeOpacity="0.07" />)}
        {!still && (
          <g>
            <path d={`M${HUB.x} ${HUB.y} L${HUB.x + 260} ${HUB.y} A260 260 0 0 0 ${HUB.x + 225} ${HUB.y - 130} Z`} fill="#2563eb" opacity="0.13" />
            <line x1={HUB.x} y1={HUB.y} x2={HUB.x + 260} y2={HUB.y} stroke="#2563eb" strokeOpacity="0.7" />
            <animateTransform attributeName="transform" type="rotate" from={`0 ${HUB.x} ${HUB.y}`} to={`-360 ${HUB.x} ${HUB.y}`} dur="16s" repeatCount="indefinite" />
          </g>
        )}
        {ROUTES.map((route, i) => <Route key={route.d} route={route} index={i} still={still} />)}
        {!still && (
          <circle cx={HUB.x} cy={HUB.y} fill="none" stroke="#ffffff" strokeWidth="1.5">
            <animate attributeName="r" values="28;62" dur="3.2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.5;0" dur="3.2s" repeatCount="indefinite" />
          </circle>
        )}
        <circle cx={HUB.x} cy={HUB.y} r="28" fill="#2563eb" />
        <Warehouse x={HUB.x - 13} y={HUB.y - 13} size={26} color="#ffffff" strokeWidth={1.7} aria-hidden />
      </svg>
      <ol className="scene-steps" aria-hidden>
        {LIFECYCLE.map((step, i) => <li key={step} style={{ animationDelay: `${i * 2}s` }}><span />{step}</li>)}
      </ol>
    </>
  )
}
