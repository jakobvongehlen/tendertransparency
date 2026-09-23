import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { pct } from '../format'
import type { Row } from '../api'

export const NOTICE_URL = 'https://www.tenderned.nl/aankondigingen/overzicht/'

export function Panel({ title, note, actions, children, className = '' }: {
  title?: ReactNode; note?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || note || actions) && (
        <div className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {note && <p>{note}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function Stats({ items }: { items: { label: string; value: ReactNode; note?: ReactNode }[] }) {
  return (
    <div className="stats">
      {items.map((s) => (
        <div className="stat" key={s.label}>
          <span className="label">{s.label}</span>
          <span className="value">{s.value}</span>
          {s.note && <span className="note">{s.note}</span>}
        </div>
      ))}
    </div>
  )
}

export function BuyerLink({ id, name }: { id: string; name: string }) {
  return <Link to={`/buyers/${encodeURIComponent(id)}`}>{name}</Link>
}
export function SupplierLink({ id, name }: { id: string; name: string }) {
  return <Link to={`/suppliers/${encodeURIComponent(id)}`}>{name}</Link>
}
export function NoticeLink({ id, children }: { id: number | string; children?: ReactNode }) {
  return (
    <a href={NOTICE_URL + id} target="_blank" rel="noreferrer" title="Open the notice on TenderNed">
      {children ?? 'Notice'} <span aria-hidden>↗</span>
    </a>
  )
}
export function ProcedureLink({ ocid, children }: { ocid: string; children: ReactNode }) {
  return <Link to={`/procedures/${encodeURIComponent(ocid)}`}>{children}</Link>
}

/** Comparability of a peer comparison: carries a status dot + words, never colour alone. */
export function Comparability({ value }: { value: string | null | undefined }) {
  const v = value ?? 'fewer than 3 awards'
  const cls = v === 'comparable' ? 'good' : v === 'limited data' ? 'warn' : 'neutral'
  const tip: Record<string, string> = {
    comparable: 'Enough awards, enough peers and complete enough data to compare.',
    'limited data': 'Many suppliers lack a KvK number or many procedures have no discoverable award.',
    'small sample': 'Fewer than 5 awarded lots or fewer than 3 separate procedures in this category and period.',
    'too few peers': 'Fewer than 5 comparable buyers in this category and period.',
    'fewer than 3 awards': 'Too few awards to compare with peers.',
  }
  return <span className={`badge ${cls}`} title={tip[v]}><i />{v}</span>
}

export function UnusualBadge({ persistent }: { persistent?: number | null }) {
  return (
    <span className="badge unusual" title="Top-supplier share well above comparable buyers in this category">
      <i />{persistent && persistent >= 2 ? `unusual · ${persistent} periods` : 'unusual'}
    </span>
  )
}

/** Shared explanation wherever direct awards are shown. */
export const DIRECT_AWARD_TIP =
  'Direct award: the buyer published no contract notice and negotiated with one or a few companies it chose itself ' +
  '(negotiated procedure without prior publication). Allowed only on specific grounds, such as only one possible supplier, ' +
  'extreme urgency or no suitable tenders in an earlier open procedure. Only direct awards reported afterwards on TenderNed are visible.'

export function DirectAwardTag() {
  return <span className="tag warn" title={DIRECT_AWARD_TIP}>direct award</span>
}

export function FewBiddersBadge() {
  return (
    <span className="badge few" title="Half or more of the competitive lots drew a single tender, well above comparable buyers">
      <i />few bidders
    </span>
  )
}

/**
 * Peer context bar: the buyer's value (dot) against the peer median (tick) and
 * the peer interquartile-ish band (median → p75 when known). Scale is 0–100%.
 */
export function PeerBar({ value, median, p75, width = 120 }: {
  value: number | null | undefined; median?: number | null; p75?: number | null; width?: number
}) {
  if (value === null || value === undefined) return <span className="muted">–</span>
  const x = (v: number) => 4 + Math.max(0, Math.min(1, v)) * (width - 8)
  const hasPeers = median !== null && median !== undefined
  const label = `${pct(value)}${hasPeers ? `, peer median ${pct(median)}` : ''}`
  return (
    <span className="peerbar" role="img" aria-label={label} title={label}>
      <svg width={width} height="16" viewBox={`0 0 ${width} 16`}>
        <line x1={x(0)} x2={x(1)} y1="8" y2="8" stroke="var(--hair)" strokeWidth="4" strokeLinecap="round" />
        {hasPeers && p75 !== null && p75 !== undefined && (
          <line x1={x(median!)} x2={x(p75)} y1="8" y2="8" stroke="var(--peer-band)" strokeWidth="4" />
        )}
        {hasPeers && <line x1={x(median!)} x2={x(median!)} y1="2" y2="14" stroke="var(--ink-2)" strokeWidth="1.5" />}
        <circle cx={x(value)} cy="8" r="4.5" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
      </svg>
      <span className="pv">{pct(value)}</span>
    </span>
  )
}

export function PeerLegend() {
  return (
    <div className="legend">
      <span><i className="dot" style={{ background: 'var(--series-1)' }} />this buyer</span>
      <span><i style={{ width: 2, height: 12, background: 'var(--ink-2)', borderRadius: 0 }} />peer median</span>
      <span><i style={{ background: 'var(--peer-band)', height: 5 }} />median to 75th percentile of peers</span>
    </div>
  )
}

export type Col = {
  key: string
  label: ReactNode
  num?: boolean
  render?: (r: Row) => ReactNode
  sort?: (r: Row) => number | string | null
  title?: string
}

export function Table({ rows, cols, initialSort, limit = 25, rowKey, highlight, empty = 'Nothing to show for this selection.' }: {
  rows: Row[]; cols: Col[]; initialSort?: { key: string; dir: 1 | -1 }; limit?: number
  rowKey?: (r: Row, i: number) => string; highlight?: (r: Row) => boolean; empty?: ReactNode
}) {
  const [sort, setSort] = useState(initialSort)
  const [shown, setShown] = useState(limit)
  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = cols.find((c) => c.key === sort.key)
    const get = col?.sort ?? ((r: Row) => r[sort.key])
    return [...rows].sort((a, b) => {
      const va = get(a), vb = get(b)
      if (va === vb) return 0
      if (va === null || va === undefined) return 1
      if (vb === null || vb === undefined) return -1
      return (va > vb ? 1 : -1) * sort.dir
    })
  }, [rows, sort, cols])
  if (!rows.length) return <p className="muted small">{empty}</p>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                className={`${c.num ? 'num' : ''} sortable`}
                title={c.title}
                onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key ? (s.dir === 1 ? -1 : 1) : c.num ? -1 : 1 }))}
                aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
              >
                {c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, shown).map((r, i) => (
            <tr key={rowKey ? rowKey(r, i) : i} className={highlight?.(r) ? 'hl' : ''}>
              {cols.map((c) => (
                <td key={c.key} className={c.num ? 'num' : /published$/.test(c.key) ? 'nowrap' : ''}>{c.render ? c.render(r) : r[c.key] ?? '–'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown && (
        <p className="more">
          Showing {shown} of {rows.length}.{' '}
          <button className="link" onClick={() => setShown((s) => s + 50)}>Show 50 more</button>
        </p>
      )}
    </div>
  )
}

export function Seg<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Loading({ error }: { error?: string | null }) {
  return error ? <p className="error">Could not load data: {error}. Is the API running on port 8000?</p> : <p className="loading">Loading…</p>
}
