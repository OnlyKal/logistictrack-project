import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'

/** Charge une ressource. `path` nul : rien n'est chargé. */
export function useFetch(path) {
  const [state, setState] = useState({ data: null, loading: !!path, error: null })
  const seq = useRef(0)
  const reload = useCallback(async () => {
    if (!path) return
    const id = ++seq.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const data = await api.get(path)
      if (id === seq.current) setState({ data, loading: false, error: null })
    } catch (error) {
      if (id === seq.current) setState({ data: null, loading: false, error })
    }
  }, [path])
  useEffect(() => {
    reload()
  }, [reload])
  return { ...state, reload }
}

export function useList(path) {
  const [state, setState] = useState({ items: [], meta: {}, loading: true, error: null })
  const seq = useRef(0)
  const reload = useCallback(async () => {
    const id = ++seq.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const { items, meta } = await api.list(path)
      if (id === seq.current) setState({ items, meta, loading: false, error: null })
    } catch (error) {
      if (id === seq.current) setState({ items: [], meta: {}, loading: false, error })
    }
  }, [path])
  useEffect(() => {
    reload()
  }, [reload])
  return { ...state, reload }
}

export function useDebounced(value, ms = 280) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}
