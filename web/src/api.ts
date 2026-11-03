import { useEffect, useRef, useState } from 'react'

export type Row = Record<string, any>

let snapIndex: Promise<Record<string, string>> | null = null
const isJSON = (r: Response) => r.ok && (r.headers.get('content-type') ?? '').includes('json')
const snapshots = (): Promise<Record<string, string>> => (snapIndex ??= fetch(`${import.meta.env.BASE_URL}data/snap/index.json`)
  .then((r) => (isJSON(r) ? r.json() : {}))
  .catch(() => ({})))

// number of requests currently waiting for the in-browser database (drives the loading card)
let waiting = 0
const waitListeners = new Set<(n: number) => void>()
const setWaiting = (d: number) => { waiting += d; waitListeners.forEach((f) => f(waiting)) }
export function onWaiting(f: (n: number) => void) {
  waitListeners.add(f)
  f(waiting)
  return () => { waitListeners.delete(f) }
}

/** true in the static build (`pnpm build:static`): queries run in DuckDB-WASM in the browser, no API server */
export const STATIC = import.meta.env.VITE_STATIC === '1'

export async function getJSON<T = any>(path: string, params?: Record<string, unknown>): Promise<T> {
  const qs = new URLSearchParams()
  Object.entries(params ?? {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
  })
  if (STATIC) {
    // default views are precomputed at export time (etl/export_static.py), so first paint needs no database
    qs.sort()
    const key = path + (qs.size ? `?${qs}` : '')
    if ((window as any).__ttLog) (window as any).__ttLog.push(key)
    const snap = (await snapshots())[key]
    if (snap) {
      const res = await fetch(`${import.meta.env.BASE_URL}data/snap/${snap}`).catch(() => null)
      if (res && isJSON(res)) return res.json()
    }
    const { route } = await import('./local/api')
    setWaiting(+1)
    try {
      return (await route(path, Object.fromEntries(qs))) as T
    } finally {
      setWaiting(-1)
    }
  }
  const res = await fetch(`/api/${path}${qs.size ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

/**
 * Fetch on dependency change; keeps the previous data while refetching (no skeleton flash).
 * A failed request is retried once (the API may be restarting); if it fails again, `error` is set
 * while `data` still holds the previous result, so pages must show that it is out of date.
 */
export function useApi<T = any>(path: string | null, params?: Record<string, unknown>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const key = path ? path + JSON.stringify(params ?? {}) : null
  const seq = useRef(0)
  useEffect(() => {
    if (!path) return
    const id = ++seq.current
    setLoading(true)
    getJSON<T>(path, params)
      .catch(() => new Promise<T>((resolve, reject) => setTimeout(() => getJSON<T>(path, params).then(resolve, reject), 800)))
      .then((d) => { if (id === seq.current) { setData(d); setError(null) } })
      .catch((e) => { if (id === seq.current) setError(String(e.message ?? e)) })
      .finally(() => { if (id === seq.current) setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])
  const retry = () => setAttempt((a) => a + 1)
  return { data, error, loading, retry }
}

export type Meta = {
  cutoff: string
  notice_url: string
  divisions: { division: string; label: string }[]
  periods: string[]
  kinds: { kind: string; n: number }[]
  size_bands: { kind: string; bands: string[] }[]
  provinces: string[]
  year_range: { y0: number; y1: number }
}
