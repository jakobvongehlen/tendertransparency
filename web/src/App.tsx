import { useEffect, useRef, useState, createContext, useContext } from 'react'
import { NavLink, Route, Routes, useNavigate, useLocation } from 'react-router-dom'
import { getJSON, onWaiting, useApi, type Meta, type Row, STATIC } from './api'
import { num, place } from './format'
import Overview from './pages/Overview'
import Buyers from './pages/Buyers'
import BuyerProfile from './pages/BuyerProfile'
import SupplierProfile from './pages/SupplierProfile'
import Compare from './pages/Compare'
import Patterns from './pages/Patterns'
import Gaps from './pages/Gaps'
import Competition from './pages/Competition'
import MapPage from './pages/MapPage'
import Procedure from './pages/Procedure'
import Method from './pages/Method'

/** optional legal links (set at build time, e.g. by scripts/deploy-pages.sh) */
const IMPRINT = import.meta.env.VITE_IMPRINT_URL as string | undefined
const PRIVACY = import.meta.env.VITE_PRIVACY_URL as string | undefined

/** Static build only: progress while the in-browser database downloads (first visit), so it never looks stuck. */
function DataLoading() {
  const [p, setP] = useState<{ active: boolean; loaded: number; total: number; items: { name: string; done: boolean }[] } | null>(null)
  const [waitingN, setWaitingN] = useState(0)
  useEffect(() => {
    let off = () => {}
    let cancelled = false
    import('./local/api').then((m) => {
      if (cancelled) return
      off = m.onProgress(setP)
      // after first paint, prepare the data behind the filters unless the visitor asked to save data
      const conn = (navigator as any).connection
      if (!conn?.saveData && !/(^|-)2g$/.test(conn?.effectiveType ?? '')) setTimeout(m.warmUp, 1200)
    })
    const off2 = onWaiting(setWaitingN)
    return () => { cancelled = true; off(); off2() }
  }, [])
  if (!p?.active) return null
  const pct = p.total ? Math.min(99, Math.round((100 * p.loaded) / p.total)) : 0
  if (!waitingN) return <div className="dl-pill" role="status">Preparing data for filters · {pct}%</div>
  const current = p.items.find((i) => !i.done)?.name
  return (
    <div className="dl-card" role="status" aria-live="polite">
      <div className="dl-title">Loading the data into your browser</div>
      <div className="dl-sub">This dashboard runs entirely on your device. The first load takes a moment; after that, filters are instant.</div>
      <div className="dl-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
      <div className="dl-meta">
        <span>{(p.loaded / 1e6).toFixed(1)} of {Math.max(1, Math.round(p.total / 1e6))} MB</span>
        {current && <span>{current === 'database engine' ? 'starting the database engine' : `loading ${current.replace(/_/g, ' ')}`}</span>}
      </div>
    </div>
  )
}

const MetaContext = createContext<Meta | null>(null)
export const useMeta = () => useContext(MetaContext)

function Search() {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<{ buyers: Row[]; suppliers: Row[] } | null>(null)
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)
  const nav = useNavigate()
  const loc = useLocation()
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => { setOpen(false); setQ('') }, [loc.pathname])
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return }
    const h = setTimeout(() => getJSON('search', { q: q.trim() }).then((r) => { setRes(r); setSel(0) }), 180)
    return () => clearTimeout(h)
  }, [q])
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const items = res
    ? [
        ...res.buyers.map((b) => ({ to: `/buyers/${encodeURIComponent(b.buyer_id)}`, name: b.name, sub: `${b.kind} · ${num(b.n_procedures)} procedures`, group: 'Buyers' })),
        ...res.suppliers.map((s) => ({ to: `/suppliers/${encodeURIComponent(s.supplier_key)}`, name: s.name, sub: [place(s.locality), s.kvk ? `KvK ${s.kvk}` : null].filter(Boolean).join(' · '), group: 'Suppliers' })),
      ]
    : []

  return (
    <div className="search" ref={box}>
      <input
        type="search"
        placeholder="Search buyers, suppliers or a KvK number"
        aria-label="Search buyers and suppliers, or type a KvK number"
        role="combobox"
        aria-autocomplete="list"
        aria-controls="search-results"
        aria-expanded={Boolean(open && res)}
        aria-activedescendant={open && items[sel] ? `search-opt-${sel}` : undefined}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { setSel((s) => Math.min(s + 1, items.length - 1)); e.preventDefault() }
          if (e.key === 'ArrowUp') { setSel((s) => Math.max(s - 1, 0)); e.preventDefault() }
          if (e.key === 'Enter' && items[sel]) nav(items[sel].to)
          if (e.key === 'Escape') setOpen(false)
        }}
      />
      {open && res && (
        <div className="results" role="listbox" id="search-results" aria-label="Search results">
          {items.length === 0 && <div className="group" role="presentation">No buyer or supplier matches “{q}”. Try part of the name, or an 8-digit KvK number.</div>}
          {items.map((it, i) => (
            <div key={it.to} role="presentation">
              {(i === 0 || items[i - 1].group !== it.group) && <div className="group" role="presentation">{it.group}</div>}
              <a id={`search-opt-${i}`} className={`item ${i === sel ? 'sel' : ''}`} href={it.to} role="option" aria-selected={i === sel}
                onClick={(e) => { e.preventDefault(); nav(it.to) }} onMouseEnter={() => setSel(i)}>
                <span>{it.name}</span><span>{it.sub}</span>
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const { data: meta, error } = useApi<Meta>('meta')
  const loc = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [loc.pathname])
  return (
    <MetaContext.Provider value={meta}>
      <div className="shell">
        <aside className="nav">
          <div className="brand">
            <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="7" fill="var(--brand)" /><rect x="7" y="17" width="4" height="8" rx="1" fill="#fff" fillOpacity=".75" /><rect x="14" y="11" width="4" height="14" rx="1" fill="#fff" fillOpacity=".75" /><rect x="21" y="6" width="4" height="19" rx="1" fill="#fff" /></svg>
            <div>Tender Transparency<small>Public contracts in the Netherlands</small></div>
          </div>
          <nav aria-label="Main">
            {/* grouped by kind of page: browse the data, analyse it, learn how to read it */}
            <div className="nav-group" role="group" aria-labelledby="nav-explore">
              <span className="nav-label" id="nav-explore">Explore</span>
              <NavLink to="/" end>Overview</NavLink>
              <NavLink to="/buyers">Buyers</NavLink>
              <NavLink to="/map">Map</NavLink>
            </div>
            <div className="nav-group" role="group" aria-labelledby="nav-analyse">
              <span className="nav-label" id="nav-analyse">Analyse</span>
              <NavLink to="/compare">Compare peers</NavLink>
              <NavLink to="/patterns">Concentration patterns</NavLink>
              <NavLink to="/competition">Competition</NavLink>
              <NavLink to="/gaps">Information gaps</NavLink>
            </div>
            <div className="nav-group" role="group" aria-labelledby="nav-help">
              <span className="nav-label" id="nav-help">Help</span>
              <NavLink to="/method">How to read this</NavLink>
            </div>
          </nav>
          <div className="foot">
            Source: <a href="https://www.tenderned.nl/cms/nl/aanbesteden-in-cijfers/datasets-aanbestedingen" target="_blank" rel="noreferrer">TenderNed open data</a>
            {meta && <>, notices up to {meta.cutoff}</>}. Only procedures published on TenderNed are included.
            {(IMPRINT || PRIVACY) && (
              <div className="legal">
                {IMPRINT && <a href={IMPRINT}>Imprint</a>}
                {IMPRINT && PRIVACY && ' · '}
                {PRIVACY && <a href={PRIVACY}>Privacy</a>}
              </div>
            )}
          </div>
        </aside>
        <div className="main">
          <header className="topbar"><Search /></header>
          {error && <div className="page"><p className="error">{STATIC
            ? <>The data could not be loaded ({error}). Check your connection and reload the page.</>
            : <>The API is not reachable ({error}). Start it with <code>uv run uvicorn api.main:app</code>.</>}</p></div>}
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/buyers" element={<Buyers />} />
            <Route path="/buyers/:id" element={<BuyerProfile />} />
            <Route path="/suppliers/:id" element={<SupplierProfile />} />
            <Route path="/compare" element={<Compare />} />
            <Route path="/patterns" element={<Patterns />} />
            <Route path="/competition" element={<Competition />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/gaps" element={<Gaps />} />
            <Route path="/procedures/:ocid" element={<Procedure />} />
            <Route path="/method" element={<Method />} />
            <Route path="*" element={<div className="page"><h1>Page not found</h1><p>Use the menu or search to find a buyer or supplier.</p></div>} />
          </Routes>
          {STATIC && <DataLoading />}
          {(IMPRINT || PRIVACY) && (
            <footer className="legal-mobile">
              {IMPRINT && <a href={IMPRINT}>Imprint</a>}
              {IMPRINT && PRIVACY && ' · '}
              {PRIVACY && <a href={PRIVACY}>Privacy</a>}
            </footer>
          )}
        </div>
      </div>
    </MetaContext.Provider>
  )
}
