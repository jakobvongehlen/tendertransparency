import { useSearchParams } from 'react-router-dom'
import { useApi, type Row } from '../api'
import { useMeta } from '../App'
import { bandLabel, eur, lots, num, pct } from '../format'
import { Chart, axisVal, base, useTokens } from '../components/Chart'
import { BuyerLink, Comparability, Loading, Panel, PeerBar, Stats, SupplierLink, Table, UnusualBadge } from '../components/ui'

export default function Compare() {
  const meta = useMeta()
  const t = useTokens()
  const [sp, setSp] = useSearchParams()
  const division = sp.get('division') ?? '45'
  const kindParam = sp.get('kind') ?? 'Municipality'
  const kind = kindParam === 'all' ? '' : kindParam
  const period = sp.get('period') ?? '2022-2024'
  const size = sp.get('size_band') ?? ''
  const buyer = sp.get('buyer') ?? ''
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp)
    if (v) n.set(k, v); else n.delete(k)
    if (k === 'kind') { n.delete('size_band'); n.delete('buyer') }
    setSp(n, { replace: true })
  }
  const { data, error, loading } = useApi('peers', { division, kind, period, size_band: kind ? size : '' })
  const bands = meta?.size_bands.find((b) => b.kind === kind)?.bands ?? []
  const label = meta?.divisions.find((d) => d.division === division)?.label ?? division

  const rows: Row[] = data?.rows ?? []
  const eligible = rows.filter((r) => r.n_lots >= 3)
  const groups = [
    { name: 'Comparable', color: t.s1, pick: (r: Row) => r.comparability === 'comparable' && !r.unusual },
    { name: 'Unusual concentration', color: t.serious, pick: (r: Row) => r.unusual },
    { name: 'Not comparable (small sample, few peers or limited data)', color: t.muted, pick: (r: Row) => r.comparability !== 'comparable' },
  ]
  const option = {
    ...base(t),
    grid: { left: 8, right: 24, top: 44, bottom: 28, containLabel: true },
    legend: { top: 0, left: 0, icon: 'circle', itemWidth: 10, textStyle: { color: t.ink2 } },
    tooltip: { ...(base(t).tooltip as object), trigger: 'item',
      formatter: (p: any) => { const r = p.data.r; return `<b>${r.name}</b><br/>${lots(r.n_lots)} lots · ${r.n_suppliers} suppliers<br/>Top supplier ${pct(r.top_share)}: ${r.top_supplier_name ?? ''}<br/>${kind ? '' : r.kind + ', '}${bandLabel(r.size_band)}` } },
    xAxis: { type: 'log', name: 'Awarded lots (log scale)', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: t.muted }, min: 1, ...axisVal(t) },
    yAxis: { type: 'value', min: 0, max: 1, ...axisVal(t),
      axisLabel: { color: t.muted, formatter: (v: number) => pct(v) } },
    series: [
      ...groups.map((g) => ({
        name: g.name, type: 'scatter', symbolSize: 9,
        itemStyle: { color: g.color, borderColor: t.surface, borderWidth: 2, opacity: 0.9 },
        data: rows.filter((r) => r.buyer_id !== buyer && g.pick(r)).map((r) => ({ value: [Math.max(1, r.n_lots), r.top_share], r })),
        emphasis: { scale: 1.6 },
      })),
      {
        name: 'Selected buyer', type: 'scatter', symbolSize: 16, z: 10,
        itemStyle: { color: t.ink, borderColor: t.surface, borderWidth: 2 },
        label: { show: true, position: 'right', color: t.ink, fontSize: 12, formatter: (p: any) => p.data.r.name },
        data: rows.filter((r) => r.buyer_id === buyer).map((r) => ({ value: [Math.max(1, r.n_lots), r.top_share], r })),
      },
    ],
  }
  const sel = rows.find((r) => r.buyer_id === buyer)

  return (
    <div className="page">
      <div className="page-head">
        <h1>Compare similar buyers</h1>
        <p className="lede">
          Pick a category and a type of buyer. Each dot is one buyer: how many lots it awarded in the category and what share went to
          its most frequent supplier. Buyers with only a few lots are naturally more concentrated, so compare dots at similar horizontal positions.
        </p>
      </div>
      <div className="filters">
        <label>Category
          <select value={division} onChange={(e) => set('division', e.target.value)}>
            {meta?.divisions.map((d) => <option key={d.division} value={d.division}>{d.division} · {d.label}</option>)}
          </select>
        </label>
        <label>Buyer type
          <select value={kindParam} onChange={(e) => set('kind', e.target.value)}>
            <option value="all">All types</option>
            {meta?.kinds.map((k) => <option key={k.kind}>{k.kind}</option>)}
          </select>
        </label>
        {kind && (
          <label>Size
            <select value={size} onChange={(e) => set('size_band', e.target.value)}>
              <option value="">All sizes</option>
              {bands.map((b) => <option key={b} value={b}>{bandLabel(b)}</option>)}
            </select>
          </label>
        )}
        <label>Period
          <select value={period} onChange={(e) => set('period', e.target.value)}>
            {meta?.periods.map((p) => <option key={p}>{p}</option>)}
            <option value="all">All years</option>
          </select>
        </label>
        <label>Highlight buyer
          <select value={buyer} onChange={(e) => set('buyer', e.target.value)}>
            <option value="">None</option>
            {[...rows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => <option key={r.buyer_id} value={r.buyer_id}>{r.name}</option>)}
          </select>
        </label>
      </div>

      {!data ? <Loading error={error} /> : (
        <div className={loading ? 'stale' : ''} style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <Stats items={[
            { label: 'Buyers in this category', value: num(rows.length) },
            { label: 'With 3 or more awarded lots', value: num(eligible.length) },
            { label: 'Median top-supplier share', value: pct(data.summary.median_top_share), note: 'buyers with 3+ lots' },
            { label: 'Flagged as unusual', value: num(rows.filter((r) => r.unusual).length) },
          ]} />
          {sel && (
            <div className="callout">
              <b>{sel.name}</b> awarded {lots(sel.n_lots)} lots in {label.toLowerCase()} to {sel.n_suppliers} suppliers; the most frequent,{' '}
              {sel.top_supplier_name}, won {pct(sel.top_share)}. {sel.hhi_percentile != null && <>Its concentration is higher than {pct(sel.hhi_percentile)} of {kind ? 'peers of the same size' : `${sel.kind.toLowerCase()} peers of the same size`}. </>}
              <Comparability value={sel.comparability} />
            </div>
          )}
          <Panel title={`${label}: ${kind ? kind.toLowerCase() : 'all'} buyers, ${period === 'all' ? 'all years' : period}`} note="Vertical: share of awarded lots won by the buyer's most frequent supplier. Horizontal: number of awarded lots.">
            <Chart option={option as any} height={420} onEvents={{ click: (p: any) => p.data?.r && set('buyer', p.data.r.buyer_id) }} />
            <p className="small muted">Click a dot to highlight that buyer. {kind
              ? 'Peer groups for the “unusual” flag are buyers of the same type and size band.'
              : 'All buyer types are shown together; the “unusual” flag and comparability still compare each buyer only with buyers of its own type and size band.'}</p>
          </Panel>
          <Panel title="All buyers in this comparison">
            <Table rows={rows} limit={30} rowKey={(r) => r.buyer_id} highlight={(r) => r.buyer_id === buyer} initialSort={{ key: 'n_lots', dir: -1 }} cols={[
              { key: 'name', label: 'Buyer', render: (r) => <><BuyerLink id={r.buyer_id} name={r.name} /><span className="sub">{[kind ? null : r.kind, r.province, bandLabel(r.size_band)].filter(Boolean).join(' · ')}</span></> },
              { key: 'n_lots', label: 'Lots', num: true, render: (r) => lots(r.n_lots) },
              { key: 'n_suppliers', label: 'Suppliers', num: true },
              { key: 'top_share', label: 'Top-supplier share', render: (r) => <PeerBar value={r.top_share} median={data.summary.median_top_share} /> },
              { key: 'top_supplier_name', label: 'Top supplier', render: (r) => r.top_supplier ? <SupplierLink id={r.top_supplier} name={r.top_supplier_name} /> : '–' },
              { key: 'value_known', label: 'Reported value', num: true, render: (r) => eur(r.value_known) },
              { key: 'no_award_rate', label: 'No award found', num: true, render: (r) => pct(r.no_award_rate), title: 'Share of closed procedures in this category without a discoverable award' },
              { key: 'comparability', label: 'Comparison', render: (r) => <div className="row">{r.unusual && <UnusualBadge persistent={r.persistent_periods} />}<Comparability value={r.comparability} /></div>,
                sort: (r) => (r.unusual ? 0 : 1) + (r.comparability === 'comparable' ? 0 : 2) },
            ]} />
          </Panel>
        </div>
      )}
    </div>
  )
}
