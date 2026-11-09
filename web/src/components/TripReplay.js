import { useEffect, useMemo, useRef, useState } from 'react'
import { distanceKm } from '../lib/format.js'

/** Durée de la relecture à la vitesse ×1, quelle que soit la durée réelle du trajet. */
const REPLAY_MS = 30_000
/** Un arrêt prolongé (pause, embouteillage, coupure du signal) ne fige pas la relecture plus de 20 s réelles. */
const MAX_GAP_MS = 20_000
export const REPLAY_SPEEDS = [1, 2, 4, 8]

const bearing = ([lat1, lng1], [lat2, lng2]) => {
  const r = Math.PI / 180
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r)
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r)
  return ((Math.atan2(y, x) / r) + 360) % 360
}

/**
 * Relecture d'un trajet terminé : le véhicule rejoue ses positions dans l'ordre, au rythme réel compressé.
 * `trail` : positions { latitude, longitude, recordedAt }, déjà triées et filtrées.
 */
export function useReplay(trail) {
  const [progress, setProgress] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const frame = useRef(0)

  const timeline = useMemo(() => {
    const points = trail.map((p) => [p.latitude, p.longitude])
    const times = trail.map((p) => new Date(p.recordedAt).getTime())
    const virtual = [0]
    const covered = [0]
    for (let i = 1; i < trail.length; i++) {
      virtual.push(virtual[i - 1] + Math.min(MAX_GAP_MS, Math.max(1000, times[i] - times[i - 1])))
      covered.push(covered[i - 1] + distanceKm(points[i - 1], points[i]))
    }
    return { points, times, virtual, covered, total: virtual.at(-1) ?? 0 }
  }, [trail])

  useEffect(() => {
    if (!playing) return undefined
    let last = performance.now()
    const step = (now) => {
      const dt = now - last
      last = now
      setProgress((p) => {
        const next = Math.min(1, p + (dt * speed) / REPLAY_MS)
        if (next >= 1) setPlaying(false)
        return next
      })
      frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame.current)
  }, [playing, speed])

  // Un autre trajet (rechargement) repart de zéro.
  useEffect(() => {
    setPlaying(false)
    setProgress(0)
  }, [timeline])

  const { points, times, virtual, covered, total } = timeline
  const active = playing || progress > 0
  let current = null
  if (active && points.length > 1) {
    const target = progress * total
    let i = 0
    while (i < virtual.length - 2 && virtual[i + 1] <= target) i++
    const span = virtual[i + 1] - virtual[i]
    const f = span > 0 ? Math.min(1, Math.max(0, (target - virtual[i]) / span)) : 1
    const a = points[i]
    const b = points[i + 1]
    const at = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
    // Sur place, la flèche garde sa dernière direction connue.
    let k = i
    while (k > 0 && points[k][0] === points[k + 1][0] && points[k][1] === points[k + 1][1]) k--
    const moved = points[k][0] !== points[k + 1][0] || points[k][1] !== points[k + 1][1]
    current = {
      point: at,
      drawn: [...points.slice(0, i + 1), at],
      time: new Date(times[i] + (times[i + 1] - times[i]) * f),
      heading: moved ? bearing(points[k], points[k + 1]) : null,
      km: covered[i] + (covered[i + 1] - covered[i]) * f,
      speedMs: trail[i].speedMs ?? null,
    }
  }

  return {
    available: points.length > 1,
    active,
    playing,
    progress,
    speed,
    current,
    toggle: () => {
      if (playing) return setPlaying(false)
      if (progress >= 1) setProgress(0)
      setPlaying(true)
    },
    seek: (p) => setProgress(Math.min(1, Math.max(0, p))),
    stop: () => {
      setPlaying(false)
      setProgress(0)
    },
    nextSpeed: () => setSpeed((s) => REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(s) + 1) % REPLAY_SPEEDS.length]),
  }
}
