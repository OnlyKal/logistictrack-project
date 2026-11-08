import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { api, session } from './api.js'

let socket = null
/** Bus stable : les abonnements des pages survivent au remplacement de la connexion. */
const listeners = new Map()
const statusListeners = new Set()
const notifyStatus = (connected) => statusListeners.forEach((fn) => fn(connected))

/** Connexion WebSocket authentifiée, avec reconnexion automatique de Socket.IO. */
export function connectSocket() {
  socket?.disconnect()
  const current = io(import.meta.env.VITE_API_URL ?? '/', {
    // Évalué à chaque tentative : la reconnexion utilise le jeton le plus récent.
    auth: (cb) => cb({ token: session.token }),
    transports: ['websocket', 'polling'],
  })
  current.on('connect', () => notifyStatus(true))
  current.on('disconnect', () => notifyStatus(false))
  current.onAny((event, payload) => {
    listeners.get(event)?.forEach((fn) => fn(payload))
  })
  // Jeton expiré pendant une coupure : on le rafraîchit puis on se reconnecte.
  current.on('auth_error', () => {
    api.restore().then((ok) => { if (ok && socket === current) current.connect() }).catch(() => null)
  })
  socket = current
  return current
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
}

/** État de la connexion temps réel, pour l'afficher honnêtement à l'écran. */
export function useSocketStatus() {
  const [connected, setConnected] = useState(() => !!socket?.connected)
  useEffect(() => {
    statusListeners.add(setConnected)
    setConnected(!!socket?.connected)
    return () => { statusListeners.delete(setConnected) }
  }, [])
  return connected
}

/** Abonne un composant à un événement temps réel. */
export function useLive(event, handler) {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    const listener = (payload) => ref.current(payload)
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(listener)
    return () => listeners.get(event).delete(listener)
  }, [event])
}
