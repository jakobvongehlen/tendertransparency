import { useEffect, useRef, useState, createContext, useContext } from 'react'
import { NavLink, Route, Routes, useNavigate, useLocation } from 'react-router-dom'
import { getJSON, useApi, type Meta, type Row } from './api'
import { num } from './format'
import Overview from './pages/Overview'
import Buyers from './pages/Buyers'
import BuyerProfile from './pages/BuyerProfile'
import SupplierProfile from './pages/SupplierProfile'
import Compare from './pages/Compare'
import Patterns from './pages/Patterns'
import Gaps from './pages/Gaps'
import Procedure from './pages/Procedure'
import Method from './pages/Method'

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
        ...res.suppliers.map((s) => ({ to: `/suppliers/${encodeURIComponent(s.supplier_key)}`, name: s.name, sub: `${s.locality ?? ''}${s.kvk ? ` · KvK ${s.kvk}` : ''}`, group: 'Suppliers' })),
      ]
    : []

  return (
    <div className="search" ref={box}>
      <input
        type="search"
        placeholder="Search a buyer or supplier, or type a KvK number"
        aria-label="Search buyers and suppliers"
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
        <div className="results" role="listbox">
          {items.length === 0 && <div className="group">No buyer or supplier matches “{q}”.</div>}
          {items.map((it, i) => (
            <div key={it.to}>
              {(i === 0 || items[i - 1].group !== it.group) && <div className="group">{it.group}</div>}
              <a className={`item ${i === sel ? 'sel' : ''}`} href={it.to} role="option" aria-selected={i === sel}
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
            <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="6" fill="#2a3b63" /><rect x="7" y="17" width="4" height="8" rx="1" fill="#86b6ef" /><rect x="14" y="11" width="4" height="14" rx="1" fill="#86b6ef" /><rect x="21" y="6" width="4" height="19" rx="1" fill="#ec835a" /></svg>
            <div>Tender Transparency<small>Public contracts in the Netherlands</small></div>
          </div>
          <nav aria-label="Main">
            <NavLink to="/" end>Overview</NavLink>
            <NavLink to="/buyers">Buyers</NavLink>
            <NavLink to="/compare">Compare peers</NavLink>
            <NavLink to="/patterns">Concentration patterns</NavLink>
            <NavLink to="/gaps">Information gaps</NavLink>
            <NavLink to="/method">How to read this</NavLink>
          </nav>
          <div className="foot">
            Source: <a href="https://www.tenderned.nl/cms/nl/aanbesteden-in-cijfers/datasets-aanbestedingen" target="_blank" rel="noreferrer">TenderNed open data</a>
            {meta && <>, notices up to {meta.cutoff}</>}. Only procedures published on TenderNed are included.
          </div>
        </aside>
        <div className="main">
          <header className="topbar"><Search /></header>
          {error && <div className="page"><p className="error">The API is not reachable ({error}). Start it with <code>uv run uvicorn api.main:app</code>.</p></div>}
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/buyers" element={<Buyers />} />
            <Route path="/buyers/:id" element={<BuyerProfile />} />
            <Route path="/suppliers/:id" element={<SupplierProfile />} />
            <Route path="/compare" element={<Compare />} />
            <Route path="/patterns" element={<Patterns />} />
            <Route path="/gaps" element={<Gaps />} />
            <Route path="/procedures/:ocid" element={<Procedure />} />
            <Route path="/method" element={<Method />} />
            <Route path="*" element={<div className="page"><h1>Page not found</h1><p>Use the menu or search to find a buyer or supplier.</p></div>} />
          </Routes>
        </div>
      </div>
    </MetaContext.Provider>
  )
}
