import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi, type Row } from '../api'
import { useMeta } from '../App'
import { bandLabel, eur, lots, num, pct } from '../format'
import { Chart, axisVal, base, useTokens } from '../components/Chart'
import { CellDrilldown } from '../components/CellDrilldown'
import { DIRECT_AWARD_TIP, BuyerLink, Comparability, FewBiddersBadge, Loading, Panel, PeerBar, Seg, Stats, SupplierLink, Table, UnusualBadge } from '../components/ui'

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
  const single = sp.get('metric') === 'single'
  // scroll to the details only after a deliberate pick, not when arriving with ?buyer= in the URL
  const [jump, setJump] = useState(false)
  const pick = (id: string) => { setJump(true); set('buyer', id) }
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
  // the two views plot a different share against its own sample size
  const plotted = single ? rows.filter((r) => (r.n_bid_lots ?? 0) >= 1) : rows
  const xy = (r: Row) => (single ? [r.n_bid_lots, r.single_bid_rate] : [Math.max(1, r.n_lots), r.top_share])
  const groups = single
    ? [
        { name: 'Comparable', color: t.s1, pick: (r: Row) => r.n_bid_lots >= 5 && r.n_bid_peers >= 5 && !r.few_bidders },
        { name: 'Few bidders', color: t.serious, pick: (r: Row) => r.few_bidders },
        { name: 'Not comparable (fewer than 5 lots with a known count, or few peers)', color: t.muted, pick: (r: Row) => !(r.n_bid_lots >= 5 && r.n_bid_peers >= 5) },
      ]
    : [
        { name: 'Comparable', color: t.s1, pick: (r: Row) => r.comparability === 'comparable' && !r.unusual },
        { name: 'Unusual concentration', color: t.serious, pick: (r: Row) => r.unusual },
        { name: 'Not comparable (small sample, few peers or limited data)', color: t.muted, pick: (r: Row) => r.comparability !== 'comparable' },
      ]
  const tip = (r: Row) => single
    ? `<b>${r.name}</b><br/>${num(r.n_bid_lots)} competitive lots with a known count<br/>Single tender: ${pct(r.single_bid_rate)} (${num(r.n_single)} lots)<br/>Tenders per lot: ${r.avg_bids?.toFixed(1) ?? '–'}<br/>${kind ? '' : r.kind + ', '}${bandLabel(r.size_band)}`
    : `<b>${r.name}</b><br/>${lots(r.n_lots)} lots · ${r.n_suppliers} suppliers<br/>Top supplier ${pct(r.top_share)}: ${r.top_supplier_name ?? ''}<br/>${kind ? '' : r.kind + ', '}${bandLabel(r.size_band)}`
  const option = {
    ...base(t),
    grid: { left: 8, right: 24, top: 44, bottom: 28, containLabel: true },
    legend: { top: 0, left: 0, icon: 'circle', itemWidth: 10, textStyle: { color: t.ink2 } },
    tooltip: { ...(base(t).tooltip as object), trigger: 'item',
      formatter: (p: any) => tip(p.data.r) },
    xAxis: { type: 'log', name: single ? 'Competitive lots with a known tender count (log scale)' : 'Awarded lots (log scale)', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: t.muted }, min: 1, ...axisVal(t) },
    yAxis: { type: 'value', min: 0, max: 1, ...axisVal(t),
      axisLabel: { color: t.muted, formatter: (v: number) => pct(v) } },
    series: [
      ...groups.map((g) => ({
        name: g.name, type: 'scatter', symbolSize: 9,
        itemStyle: { color: g.color, borderColor: t.surface, borderWidth: 2, opacity: 0.9 },
        data: plotted.filter((r) => r.buyer_id !== buyer && g.pick(r)).map((r) => ({ value: xy(r), r })),
        emphasis: { scale: 1.6 },
      })),
      {
        name: 'Selected buyer', type: 'scatter', symbolSize: 16, z: 10,
        itemStyle: { color: t.ink, borderColor: t.surface, borderWidth: 2 },
        label: { show: true, position: 'right', color: t.ink, fontSize: 12, formatter: (p: any) => p.data.r.name },
        data: plotted.filter((r) => r.buyer_id === buyer).map((r) => ({ value: xy(r), r })),
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
          its most frequent supplier, or, in the competition view, what share drew only a single tender. Buyers with only a few lots
          naturally have more extreme shares, so compare dots at similar horizontal positions.
        </p>
      </div>
      <div className="filters">
        <label>Compare
          <Seg label="Measure" value={single ? 'single' : 'share'} onChange={(v) => set('metric', v === 'single' ? 'single' : '')}
            options={[{ value: 'share', label: 'Top-supplier share' }, { value: 'single', label: 'Single tenders' }]} />
        </label>
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
          <select value={buyer} onChange={(e) => pick(e.target.value)}>
            <option value="">None</option>
            {[...rows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => <option key={r.buyer_id} value={r.buyer_id}>{r.name}</option>)}
          </select>
        </label>
      </div>

      {!data ? <Loading error={error} /> : (
        <div className={loading ? 'stale' : ''} style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <Stats items={single ? [
            { label: 'Buyers in this category', value: num(rows.length) },
            { label: 'With 5+ lots with a known tender count', value: num(data.summary.n_bid_eligible) },
            { label: 'Median share of single-tender lots', value: pct(data.summary.median_single_bid), note: 'buyers with 5+ lots' },
            { label: 'Flagged: few bidders', value: num(rows.filter((r) => r.few_bidders).length) },
          ] : [
            { label: 'Buyers in this category', value: num(rows.length) },
            { label: 'With 3 or more awarded lots', value: num(eligible.length) },
            { label: 'Median top-supplier share', value: pct(data.summary.median_top_share), note: 'buyers with 3+ lots' },
            { label: 'Flagged as unusual', value: num(rows.filter((r) => r.unusual).length) },
          ]} />
          {sel && single && (
            <div className="callout">
              <b>{sel.name}</b> {(sel.n_bid_lots ?? 0) > 0
                ? <>had a tender count for {num(sel.n_bid_lots)} competitive lots in {label.toLowerCase()}; {num(sel.n_single)} of them ({pct(sel.single_bid_rate)}) drew a single tender
                  {sel.peer_median_single_bid != null && <>, against a median of {pct(sel.peer_median_single_bid)} for {kind ? 'peers of the same size' : `${sel.kind.toLowerCase()} peers of the same size`}</>}.{' '}
                  {sel.few_bidders && <FewBiddersBadge />}</>
                : <>has no competitive lots with a known tender count in this category and period.</>}
            </div>
          )}
          {sel && !single && (
            <div className="callout">
              <b>{sel.name}</b> awarded {lots(sel.n_lots)} lots in {label.toLowerCase()} to {sel.n_suppliers} suppliers; the most frequent,{' '}
              {sel.top_supplier_name}, won {pct(sel.top_share)}. {sel.hhi_percentile != null && <>Its concentration is higher than {pct(sel.hhi_percentile)} of {kind ? 'peers of the same size' : `${sel.kind.toLowerCase()} peers of the same size`}. </>}
              <Comparability value={sel.comparability} />
            </div>
          )}
          <Panel title={`${label}: ${kind ? kind.toLowerCase() : 'all'} buyers, ${period === 'all' ? 'all years' : period}`}
            note={single
              ? 'Vertical: share of competitive lots that received a single tender. Horizontal: competitive lots with a known tender count.'
              : "Vertical: share of awarded lots won by the buyer's most frequent supplier. Horizontal: number of awarded lots."}>
            <Chart option={option as any} height={420} onEvents={{ click: (p: any) => p.data?.r && pick(p.data.r.buyer_id) }} />
            <p className="small muted">Click a dot to see the suppliers and lots behind it. {kind
              ? `Peer groups for the “${single ? 'few bidders' : 'unusual'}” flag are buyers of the same type and size band.`
              : `All buyer types are shown together; the “${single ? 'few bidders' : 'unusual'}” flag still compares each buyer only with buyers of its own type and size band.`}</p>
          </Panel>
          {sel && <CellDrilldown buyerId={buyer} division={division} period={period} scrollOnOpen={jump} onClose={() => set('buyer', '')} />}
          <Panel title="All buyers in this comparison" note="Click a buyer's row to see the lots behind its figures.">
            <Table rows={rows} limit={30} rowKey={(r) => r.buyer_id} highlight={(r) => r.buyer_id === buyer} initialSort={{ key: 'n_lots', dir: -1 }} cols={[
              { key: 'name', label: 'Buyer', render: (r) => <><button className="link" onClick={() => pick(r.buyer_id)}>{r.name}</button><span className="sub">{[kind ? null : r.kind, r.province, bandLabel(r.size_band)].filter(Boolean).join(' · ')} · <BuyerLink id={r.buyer_id} name="profile" /></span></> },
              { key: 'n_lots', label: 'Lots', num: true, render: (r) => lots(r.n_lots) },
              ...(single ? [] : [{ key: 'n_suppliers', label: 'Suppliers', num: true }]),
              ...(single ? [
                { key: 'single_bid_rate', label: 'Single tender', render: (r: Row) => (r.n_bid_lots ?? 0) > 0
                  ? <PeerBar value={r.single_bid_rate} median={data.summary.median_single_bid} /> : <span className="muted small">no known counts</span>,
                  sort: (r: Row) => ((r.n_bid_lots ?? 0) > 0 ? r.single_bid_rate : null) },
                { key: 'n_bid_lots', label: 'Lots with count', num: true, render: (r: Row) => <>{num(r.n_bid_lots)}<span className="sub">{num(r.n_single)} single</span></> },
                { key: 'avg_bids', label: 'Tenders per lot', num: true, render: (r: Row) => (r.avg_bids != null ? r.avg_bids.toFixed(1) : '–') },
                { key: 'direct_share', label: 'Direct award', num: true, title: DIRECT_AWARD_TIP, render: (r: Row) => pct(r.direct_share) },
              ] : [
                { key: 'top_share', label: 'Top-supplier share', render: (r: Row) => <PeerBar value={r.top_share} median={data.summary.median_top_share} /> },
                { key: 'top_supplier_name', label: 'Top supplier', render: (r: Row) => r.top_supplier ? <SupplierLink id={r.top_supplier} name={r.top_supplier_name} /> : '–' },
              ]),
              ...(single ? [] : [{ key: 'value_known', label: 'Reported value', num: true, render: (r: Row) => eur(r.value_known) }]),
              { key: 'no_award_rate', label: 'No award found', num: true, render: (r) => pct(r.no_award_rate), title: 'Share of closed procedures in this category without a discoverable award' },
              { key: 'comparability', label: 'Comparison', render: (r) => <div className="row">{r.few_bidders && <FewBiddersBadge />}{r.unusual && <UnusualBadge persistent={r.persistent_periods} />}<Comparability value={r.comparability} /></div>,
                sort: (r) => (single ? (r.few_bidders ? 0 : 4) : 0) + (r.unusual ? 0 : 1) + (r.comparability === 'comparable' ? 0 : 2) },
            ]} />
          </Panel>
        </div>
      )}
    </div>
  )
}
