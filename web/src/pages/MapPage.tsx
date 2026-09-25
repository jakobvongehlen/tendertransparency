import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import * as echarts from 'echarts'
import { getJSON, useApi, type Row } from '../api'
import { useMeta } from '../App'
import { bandLabel, lots, num, pct } from '../format'
import { Chart, base, useTokens } from '../components/Chart'
import { Comparability, DIRECT_AWARD_TIP, FewBiddersBadge, Loading, Panel, StaleNotice, Table, UnusualBadge } from '../components/ui'

type Metric = {
  key: string
  label: string
  note: string
  fmt: (v: number) => string
  /** sample needed before the value is shown */
  enough: (r: Row) => boolean
  sample: (r: Row) => string
  divisionOnly?: boolean
  allOnly?: boolean
}

const METRICS: Metric[] = [
  { key: 'single_bid_rate', label: 'Lots with a single tender', note: 'Share of competitive lots with a known tender count that received one tender.',
    fmt: (v) => pct(v), enough: (r) => r.n_bid_lots >= 5, sample: (r) => `${num(r.n_bid_lots)} lots with a known count` },
  { key: 'avg_bids', label: 'Tenders per lot', note: 'Average number of tenders received per competitive lot (at most 20 counted per lot).',
    fmt: (v) => v.toFixed(1), enough: (r) => r.n_bid_lots >= 5, sample: (r) => `${num(r.n_bid_lots)} lots with a known count` },
  { key: 'direct_share', label: 'Direct awards (no call for competition)', note: 'Share of awarded lots given directly: the buyer negotiated with companies of its choosing without publishing a contract notice.',
    fmt: (v) => pct(v), enough: (r) => r.n_lots >= 5, sample: (r) => `${num(r.n_lots)} awarded lots` },
  { key: 'top_share', label: 'Share of top supplier', note: 'Share of awarded lots won by the most frequent supplier in the chosen category.', divisionOnly: true,
    fmt: (v) => pct(v), enough: (r) => r.conc_lots >= 5, sample: (r) => `${lots(r.conc_lots)} awarded lots, ${num(r.n_suppliers)} suppliers` },
  { key: 'n_unusual', label: 'Categories with unusual concentration', note: 'Number of categories flagged as unusually concentrated compared with peers.', allOnly: true,
    fmt: (v) => num(v), enough: () => true, sample: (r) => `${num(r.n_lots)} awarded lots` },
  { key: 'local_share', label: 'Won by suppliers from the municipality', note: 'Share of awarded lots won by suppliers registered in the same municipality.',
    fmt: (v) => pct(v), enough: (r) => r.n_lots >= 5, sample: (r) => `${num(r.n_lots)} awarded lots` },
  { key: 'no_award_rate', label: 'No award found', note: 'Share of closed procedures without a discoverable award notice.',
    fmt: (v) => pct(v), enough: (r) => r.n_closed >= 5, sample: (r) => `${num(r.n_closed)} closed procedures` },
  { key: 'lots_per_10k', label: 'Awarded lots per 10,000 residents', note: 'Published purchasing activity relative to population.',
    fmt: (v) => v.toFixed(1), enough: (r) => r.population > 0, sample: (r) => `${num(r.n_lots)} lots, ${num(r.population)} residents` },
]

let geoLoaded: Promise<void> | null = null
function loadGeo() {
  geoLoaded ??= getJSON('geo/municipalities').then((g) => { echarts.registerMap('nl-municipalities', g) })
  return geoLoaded
}

export default function MapPage() {
  const meta = useMeta()
  const t = useTokens()
  const [sp, setSp] = useSearchParams()
  const division = sp.get('division') ?? ''
  const period = sp.get('period') ?? '2022-2024'
  const available = METRICS.filter((m) => (division ? !m.allOnly : !m.divisionOnly))
  const metric = available.find((m) => m.key === sp.get('metric')) ?? available[0]
  // the requested measure may not exist for this selection (e.g. top-supplier share needs one category)
  const wanted = METRICS.find((m) => m.key === sp.get('metric'))
  const fellBack = wanted && wanted.key !== metric.key ? wanted : null
  const [selected, setSelected] = useState('')
  const [geoReady, setGeoReady] = useState(false)
  const [geoError, setGeoError] = useState<string | null>(null)
  useEffect(() => { loadGeo().then(() => setGeoReady(true), (e) => setGeoError(String(e.message ?? e))) }, [])
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp)
    if (v) n.set(k, v); else n.delete(k)
    setSp(n, { replace: true })
  }
  const { data, error, loading, retry } = useApi('map', { division, period })
  const label = meta?.divisions.find((d) => d.division === division)?.label

  const rows: Row[] = useMemo(() => data?.rows ?? [], [data])
  const shown = rows.filter((r) => metric.enough(r) && r[metric.key] != null)
  const values = shown.map((r) => r[metric.key] as number).sort((a, b) => a - b)
  // clip the colour scale at the 95th percentile so a few extremes don't wash out the rest
  const vmax = values.length ? Math.max(values[Math.floor(values.length * 0.95)] ?? 0, metric.key === 'n_unusual' ? 3 : 0) : 1
  const median = values.length ? values[Math.floor(values.length / 2)] : null
  const sel = rows.find((r) => r.code === selected)
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640

  const option = {
    ...base(t),
    tooltip: { ...(base(t).tooltip as object), trigger: 'item',
      formatter: (p: any) => {
        const r = p.data?.r
        if (!r) return `<b>${p.name}</b><br/>No awards published in this selection`
        const ok = metric.enough(r) && r[metric.key] != null
        return `<b>${r.name.replace(/^Gemeente /, '')}</b><br/>${metric.label}: <b>${ok ? metric.fmt(r[metric.key]) : 'too few to show'}</b><br/><span style="color:${t.muted}">${metric.sample(r)}</span>`
      } },
    visualMap: {
      type: 'continuous', min: 0, max: vmax || 1, dimension: 0, seriesIndex: 0,
      left: 0, bottom: 8, itemHeight: narrow ? 80 : 140, itemWidth: 12, calculable: false, realtime: false,
      text: [`${metric.fmt(vmax || 1)}${values.length && values[values.length - 1] > vmax ? '+' : ''}`, metric.fmt(0)],
      textStyle: { color: t.ink2, fontSize: 12 }, inRange: { color: t.seq },
      outOfRange: { color: t.empty },
    },
    series: [{
      type: 'map', map: 'nl-municipalities', nameProperty: 'code', roam: true, aspectScale: 0.62,
      layoutCenter: ['54%', '50%'], layoutSize: '98%', scaleLimit: { min: 1, max: 8 },
      selectedMode: false,
      itemStyle: { areaColor: t.empty, borderColor: t.surface, borderWidth: 0.6 },
      emphasis: { label: { show: false }, itemStyle: { areaColor: t.s2, borderColor: t.surface } },
      data: rows.map((r) => {
        const ok = metric.enough(r) && r[metric.key] != null
        return {
          name: r.code, r,
          value: ok ? Math.min(r[metric.key], vmax || 1) : NaN,
          itemStyle: r.code === selected ? { borderColor: t.ink, borderWidth: 2 } : undefined,
        }
      }),
    }],
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Map of municipalities</h1>
        <p className="lede">
          Pick a measure to colour municipalities by. Grey means no data or too few awards to show a
          meaningful value. Large and small municipalities differ in what they buy, so use <Link to="/compare">Compare peers</Link> for
          like-for-like comparisons.
        </p>
      </div>
      <div className="filters">
        <label>Colour by
          <select value={metric.key} onChange={(e) => set('metric', e.target.value)}>
            {available.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
        <label>Category
          <select value={division} onChange={(e) => set('division', e.target.value)}>
            <option value="">All categories</option>
            {meta?.divisions.map((d) => <option key={d.division} value={d.division}>{d.division} · {d.label}</option>)}
          </select>
        </label>
        <label>Period
          <select value={period} onChange={(e) => set('period', e.target.value)}>
            {meta?.periods.map((p) => <option key={p}>{p}</option>)}
            <option value="all">All years</option>
          </select>
        </label>
      </div>

      <StaleNotice error={data ? error : null} retry={retry} />
      {fellBack && (
        <div className="callout">
          “{fellBack.label}” is only available {fellBack.divisionOnly ? 'for a single category' : 'for all categories together'}, so the map shows “{metric.label}”.{' '}
          {fellBack.divisionOnly
            ? 'Pick a category to see it again.'
            : <button className="link" onClick={() => set('division', '')}>Show all categories</button>}
        </div>
      )}

      <div className="grid map-grid">
        <Panel
          title={`${metric.label}${label ? `: ${label.toLowerCase()}` : ''}, ${period === 'all' ? 'all years' : period}`}
          note={<>{metric.note} {values.length > 0 && <>Shown for {num(values.length)} municipalities; median {metric.fmt(median!)}.</>} Scroll or pinch to zoom; click a municipality for details.</>}
          className={loading ? 'stale' : ''}
        >
          {geoError ? <p className="error">Municipal boundaries could not be loaded ({geoError}). Run <code>etl/enrich.py</code>.</p>
            : !data || !geoReady ? <Loading error={error} /> : (
              <Chart option={option as any} height={narrow ? 440 : 620}
                onEvents={{ click: (p: any) => setSelected(p.data?.r ? p.data.r.code : '') }}
                table={
                  <Table rows={shown} limit={50} rowKey={(r) => r.code} initialSort={{ key: metric.key, dir: -1 }} cols={[
                    { key: 'name', label: 'Municipality', render: (r) => <Link to={`/buyers/${encodeURIComponent(r.buyer_id)}`}>{r.name.replace(/^Gemeente /, '')}</Link> },
                    { key: metric.key, label: metric.label, num: true, render: (r) => metric.fmt(r[metric.key]) },
                    { key: 'sample', label: 'Based on', render: (r) => <span className="muted">{metric.sample(r)}</span>, sort: (r) => r.n_lots },
                  ]} />
                } />
            )}
        </Panel>
        <div className="map-side">
          {sel ? (
            <Panel title={sel.name.replace(/^Gemeente /, '')} note={`${num(sel.population)} residents · ${bandLabel(sel.size_band)}`}>
              <dl className="facts">
                <dt>Awarded lots</dt><dd>{num(sel.n_lots)}</dd>
                <dt>Single tender</dt><dd>{sel.n_bid_lots >= 5 ? pct(sel.single_bid_rate) : '–'}{sel.n_bid_lots >= 5 && sel.peer_median_single_bid != null && <span className="muted"> · peers {pct(sel.peer_median_single_bid)}</span>}</dd>
                <dt>Tenders per lot</dt><dd>{sel.n_bid_lots >= 5 ? sel.avg_bids?.toFixed(1) : '–'}</dd>
                <dt title={DIRECT_AWARD_TIP}>Direct awards</dt><dd>{pct(sel.direct_share)}</dd>
                <dt>Local suppliers</dt><dd>{pct(sel.local_share)}</dd>
                <dt>No award found</dt><dd>{pct(sel.no_award_rate)}</dd>
                {division
                  ? <><dt>Top-supplier share</dt><dd>{pct(sel.top_share)}</dd></>
                  : <><dt>Unusual categories</dt><dd>{num(sel.n_unusual)}</dd></>}
              </dl>
              <div className="row" style={{ marginTop: 10 }}>
                {sel.few_bidders && <FewBiddersBadge />}
                {division ? (sel.unusual && <UnusualBadge />) : sel.n_unusual > 0 && <UnusualBadge />}
                {division && sel.comparability && <Comparability value={sel.comparability} />}
              </div>
              <p style={{ marginTop: 12 }}><Link to={`/buyers/${encodeURIComponent(sel.buyer_id)}`}>Open profile →</Link></p>
            </Panel>
          ) : (
            <Panel title="Details">
              <p className="small muted">Click a municipality on the map to see its figures here.</p>
            </Panel>
          )}
          <Panel title="Highest values">
            <ol className="rank">
              {[...shown].sort((a, b) => b[metric.key] - a[metric.key]).slice(0, 8).map((r) => (
                <li key={r.code}>
                  <button className="link" onClick={() => setSelected(r.code)}>{r.name.replace(/^Gemeente /, '')}</button>
                  <span className="num">{metric.fmt(r[metric.key])}</span>
                </li>
              ))}
            </ol>
          </Panel>
          <p className="small muted">
            Boundaries: CBS/PDOK {data?.boundary_year ?? ''}. Municipalities that merged earlier are shown only when their successor published awards;
            awards of former municipalities stay with the former municipality in the rest of the dashboard.
          </p>
        </div>
      </div>
    </div>
  )
}
