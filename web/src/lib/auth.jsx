import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, session } from './api.js'
import { connectSocket, disconnectSocket } from './socket.js'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [ready, setReady] = useState(false)
  const [offline, setOffline] = useState(false)

  const loadProfile = useCallback(async () => {
    const me = await api.get('/auth/me')
    setUser(me)
    connectSocket()
    return me
  }, [])

  useEffect(() => {
    session.onLost(() => {
      disconnectSocket()
      setUser(null)
    })
    // Serveur injoignable au démarrage : la session est gardée et l'ouverture réessaie, au lieu d'afficher la connexion.
    let timer
    let active = true
    const open = () => api.restore()
      .then((ok) => (ok ? loadProfile() : null))
      .then(() => {
        if (!active) return
        setOffline(false)
        setReady(true)
      })
      .catch((error) => {
        if (!active) return
        if (session.hasRefresh && (error?.status === 0 || error?.status >= 500)) {
          setOffline(true)
          timer = setTimeout(open, 3000)
        } else setReady(true)
      })
    open()
    return () => { active = false; clearTimeout(timer) }
  }, [loadProfile])

  const value = useMemo(() => ({
    user,
    ready,
    offline,
    can: (...perms) => perms.some((p) => user?.permissions?.includes(p)),
    async login(identifier, password) {
      const data = await api.post('/auth/login', { identifier, password })
      session.set(data)
      setUser(data.user)
      connectSocket()
      return data.user
    },
    async logout() {
      await api.post('/auth/logout').catch(() => null)
      session.clear()
      disconnectSocket()
      setUser(null)
    },
    /** Super Administrateur : entrer dans une entreprise ou revenir à la plateforme. */
    async enterCompany(companyId) {
      const data = await api.post('/auth/enter-company', { companyId })
      session.set(data)
      setUser(data.user)
      connectSocket()
    },
    async leaveCompany() {
      const data = await api.post('/auth/leave-company')
      session.set(data)
      setUser(data.user)
      connectSocket()
    },
    async switchCompany(companyId) {
      const data = await api.post('/auth/switch-company', { companyId })
      session.set(data)
      setUser(data.user)
      connectSocket()
    },
  }), [user, ready, offline])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
