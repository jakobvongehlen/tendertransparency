import { Link, useSearchParams } from 'react-router-dom'
import { useApi, type Row } from '../api'
import { useMeta } from '../App'
import { bandLabel, num, pct } from '../format'
import { Chart, axisCat, axisVal, base, useTokens } from '../components/Chart'
import { DIRECT_AWARD_TIP, BuyerLink, FewBiddersBadge, Loading, Panel, PeerBar, PeerLegend, Stats, Table, UnusualBadge, StaleNotice } from '../components/ui'

const avg = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v.toFixed(1))

export default function Competition() {
  const meta = useMeta()
  const t = useTokens()
  const [sp, setSp] = useSearchParams()
  const kind = sp.get('kind') ?? ''
  const division = sp.get('division') ?? ''
  const period = sp.get('period') ?? '2022-2024'
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp)
    if (v) n.set(k, v); else n.delete(k)
    setSp(n, { replace: true })
  }
  const { data, error, loading, retry } = useApi('competition', { kind, division, period })
  const label = meta?.divisions.find((d) => d.division === division)?.label
  const scope = [kind ? kind.toLowerCase() + ' buyers' : 'all buyers', label?.toLowerCase()].filter(Boolean).join(', ')

  if (!data) return <div className="page"><Loading error={error} /></div>
  const s = data.summary
  const years: Row[] = data.by_year

  const trendOption = {
    ...base(t),
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 3, textStyle: { color: t.ink2 } },
    grid: { ...(base(t).grid as object), top: 36, right: 40 },
    tooltip: { ...(base(t).tooltip as object), trigger: 'axis',
      formatter: (p: any) => { const r = years[p[0].dataIndex]; return `<b>${r.year}</b><br/>Single tender: ${pct(r.single_bid_rate, 1)} of ${num(r.bid_lots)} lots with a known count<br/>Direct awards: ${pct(r.direct_share, 1)} of ${num(r.lots)} lots<br/>Tender count known for ${pct(r.bid_coverage)} of competitive lots` } },
    xAxis: { type: 'category', data: years.map((r) => r.year), ...axisCat(t) },
    yAxis: { type: 'value', min: 0, ...axisVal(t), axisLabel: { color: t.muted, formatter: (v: number) => pct(v) } },
    series: [
      { name: 'Lots with a single tender', data: years.map((r) => r.single_bid_rate), color: t.s1 },
      { name: 'Lots awarded directly (no call for competition)', data: years.map((r) => r.direct_share), color: t.s2 },
    ].map((x) => ({
      ...x, type: 'line', symbol: 'circle', symbolSize: 7, lineStyle: { width: 2, color: x.color },
      itemStyle: { color: x.color, borderColor: t.surface, borderWidth: 2 },
      endLabel: { show: true, color: t.ink2, formatter: (p: any) => pct(p.value) },
    })),
  }
  const hist: Row[] = data.histogram
  const histTotal = hist.reduce((a, r) => a + r.lots, 0)
  const histOption = {
    ...base(t),
    grid: { ...(base(t).grid as object), top: 24 },
    tooltip: { ...(base(t).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p: any) => { const r = hist[p[0].dataIndex]; return `<b>${r.bids === 10 ? '10 or more' : r.bids} ${r.bids === 1 ? 'tender' : 'tenders'}</b><br/>${num(r.lots)} lots (${pct(r.lots / histTotal, 1)})` } },
    xAxis: { type: 'category', data: hist.map((r) => (r.bids === 10 ? '10+' : String(r.bids))), name: 'Tenders received', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: t.muted }, ...axisCat(t) },
    yAxis: { type: 'value', ...axisVal(t), axisLabel: { color: t.muted, formatter: (v: number) => pct(v) } },
    series: [{
      type: 'bar', barMaxWidth: 32, data: hist.map((r) => ({ value: r.lots / histTotal, itemStyle: { color: r.bids === 1 ? t.s2 : t.s1 } })),
      itemStyle: { borderRadius: [4, 4, 0, 0] },
      label: { show: true, position: 'top', color: t.ink2, fontSize: 11, formatter: (p: any) => pct(p.value) },
    }],
  }

  const metricCols = [
    { key: 'lots', label: 'Awarded lots', num: true, render: (r: Row) => num(r.lots) },
    { key: 'single_bid_rate', label: 'Single tender', num: true, title: 'Share of competitive lots with a known tender count that received one tender', render: (r: Row) => pct(r.single_bid_rate, 1) },
    { key: 'avg_bids', label: 'Tenders per lot', num: true, title: 'Average, counting at most 20 per lot', render: (r: Row) => <>{avg(r.avg_bids)}<span className="sub">median {num(r.median_bids)}</span></> },
    { key: 'direct_share', label: 'Direct award', num: true, title: DIRECT_AWARD_TIP, render: (r: Row) => pct(r.direct_share, 1) },
    { key: 'bid_coverage', label: 'Count known', num: true, title: 'Share of competitive lots with a reported tender count', render: (r: Row) => pct(r.bid_coverage) },
  ]

  return (
    <div className={`page ${loading ? 'stale' : ''}`}>
      <div className="page-head">
        <h1>Competition</h1>
        <p className="lede">
          How many firms tendered for each lot. A lot that draws only one tender leaves the buyer
          no choice, and a direct award, where the buyer negotiates with a company of its choosing without announcing the contract, involves no open competition at all. Both have ordinary causes,
          such as niche markets, urgent work and follow-up assignments, so compare with similar buyers first.
        </p>
      </div>
      <div className="filters">
        <label>Buyer type
          <select value={kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="">All types</option>
            {meta?.kinds.map((k) => <option key={k.kind}>{k.kind}</option>)}
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
      <Stats items={[
        { label: 'Lots with a single tender', value: pct(s.single_bid_rate, 1), note: `of ${num(s.bid_lots)} competitive lots with a known count` },
        { label: 'Tenders per lot', value: avg(s.avg_bids), note: `median ${num(s.median_bids)}` },
        { label: 'Direct awards', value: pct(s.direct_share, 1), note: <span title={DIRECT_AWARD_TIP}>of {num(s.lots)} awarded lots, no call for competition</span> },
        { label: 'Tender count known', value: pct(s.bid_coverage), note: 'of competitive lots' },
        { label: 'Flagged: few bidders', value: num(data.n_flagged), note: division ? 'buyers in this category' : 'buyers, all categories together' },
      ]} />

      <div className="grid g2">
        <Panel title="Single tenders and direct awards by year" note={`Share of awarded lots, ${scope}. Tender counts are less complete in 2016 and during the switch to eForms in 2024.`}>
          <Chart option={trendOption as any} height={270} table={
            <Table rows={years} cols={[{ key: 'year', label: 'Year' }, ...metricCols]} />
          } />
        </Panel>
        <Panel title="Tenders received per lot" note={`Competitive lots with a known count, ${period === 'all' ? 'all years' : period}. Single-tender lots in orange.`}>
          <Chart option={histOption as any} height={270} table={
            <Table rows={hist} cols={[{ key: 'bids', label: 'Tenders', render: (r) => (r.bids === 10 ? '10 or more' : r.bids) }, { key: 'lots', label: 'Lots', num: true }, { key: 'share', label: 'Share', num: true, render: (r) => pct(r.lots / histTotal, 1) }]} />
          } />
        </Panel>
      </div>

      <Panel
        title={division ? `Buyers in ${label?.toLowerCase()}` : 'Buyers, all categories together'}
        note="Buyers with at least 5 competitive lots with a known tender count. Peers: same type and size band, same category and period. Flagged buyers first, then by distance from the peer median."
      >
        <PeerLegend />
        <Table rows={data.buyers} limit={25} rowKey={(r) => r.buyer_id} cols={[
          { key: 'name', label: 'Buyer', render: (r) => <><BuyerLink id={r.buyer_id} name={r.name} /><span className="sub">{[r.kind, r.province, bandLabel(r.size_band)].filter(Boolean).join(' · ')}</span></> },
          { key: 'n_bid_lots', label: 'Lots', num: true, title: 'Competitive lots with a known tender count', render: (r) => <>{num(r.n_bid_lots)}<span className="sub">{num(r.n_single)} single</span></> },
          { key: 'single_bid_rate', label: 'Single tender vs peers', render: (r) => <PeerBar value={r.single_bid_rate} median={r.peer_median_single_bid} p75={r.peer_p75_single_bid} />,
            sort: (r) => r.single_bid_rate - (r.peer_median_single_bid ?? 0) },
          { key: 'avg_bids', label: 'Tenders per lot', num: true, render: (r) => <>{avg(r.avg_bids)}{r.peer_median_avg_bids != null && <span className="sub">peers {avg(r.peer_median_avg_bids)}</span>}</> },
          { key: 'direct_share', label: 'Direct award', num: true, title: DIRECT_AWARD_TIP, render: (r) => <>{pct(r.direct_share)}{r.peer_median_direct_share != null && <span className="sub">peers {pct(r.peer_median_direct_share)}</span>}</> },
          { key: 'n_bid_peers', label: 'Peers', num: true },
          { key: 'few_bidders', label: 'Flags', render: (r) => <div className="row">{r.few_bidders && <FewBiddersBadge />}{r.unusual && <UnusualBadge />}</div>,
            sort: (r) => (r.few_bidders ? 0 : 2) + (r.unusual ? 0 : 1) },
          { key: 'go', label: '', render: (r) => division && r.kind
            ? <Link to={`/compare?division=${division}&kind=${encodeURIComponent(r.kind)}&period=${period}&metric=single&buyer=${encodeURIComponent(r.buyer_id)}`}>Peers</Link> : null },
        ]} />
      </Panel>

      <div className="grid">
        {!division && (
          <Panel title="By category" note="Categories with at least 30 lots with a known tender count. Click a category to filter.">
            <Table rows={data.by_division} limit={15} rowKey={(r) => r.division} initialSort={{ key: 'single_bid_rate', dir: -1 }} cols={[
              { key: 'label', label: 'Category', render: (r) => <button className="link" onClick={() => set('division', r.division)}>{r.label}</button> },
              { key: 'buyers', label: 'Buyers', num: true, render: (r) => num(r.buyers) },
              ...metricCols,
            ]} />
          </Panel>
        )}
        {!kind && (
          <Panel title="By buyer type">
            <Table rows={data.by_kind} rowKey={(r) => r.kind} cols={[
              { key: 'kind', label: 'Type', render: (r) => <button className="link" onClick={() => set('kind', r.kind)}>{r.kind}</button> },
              { key: 'buyers', label: 'Buyers', num: true, render: (r) => num(r.buyers) },
              ...metricCols,
            ]} />
          </Panel>
        )}
      </div>
    </div>
  )
}
