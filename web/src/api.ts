import { useEffect, useRef, useState } from 'react'

export type Row = Record<string, any>

export async function getJSON<T = any>(path: string, params?: Record<string, unknown>): Promise<T> {
  const qs = new URLSearchParams()
  Object.entries(params ?? {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
  })
  const res = await fetch(`/api/${path}${qs.size ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

/** Fetch on dependency change; keeps the previous data while refetching (no skeleton flash). */
export function useApi<T = any>(path: string | null, params?: Record<string, unknown>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const key = path ? path + JSON.stringify(params ?? {}) : null
  const seq = useRef(0)
  useEffect(() => {
    if (!path) return
    const id = ++seq.current
    setLoading(true)
    getJSON<T>(path, params)
      .then((d) => { if (id === seq.current) { setData(d); setError(null) } })
      .catch((e) => { if (id === seq.current) setError(String(e.message ?? e)) })
      .finally(() => { if (id === seq.current) setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return { data, error, loading }
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
