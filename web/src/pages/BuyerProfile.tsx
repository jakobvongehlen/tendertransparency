import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useApi, type Row } from '../api'
import { useMeta } from '../App'
import { bandLabel, eur, lots, num, pct } from '../format'
import { Chart, axisCat, axisVal, base, useTokens } from '../components/Chart'
import { Network } from '../components/Network'
import { CellDrilldown } from '../components/CellDrilldown'
import {
  Comparability, FewBiddersBadge, Loading, NoticeLink, Panel, PeerBar, PeerLegend, ProcedureLink, Seg, Stats, SupplierLink, Table, UnusualBadge,
} from '../components/ui'

export default function BuyerProfile() {
  const { id = '' } = useParams()
  const meta = useMeta()
  const t = useTokens()
  const [period, setPeriod] = useState('all')
  const [division, setDivision] = useState('')
  const [view, setView] = useState<'concentration' | 'competition'>('concentration')
  const [drill, setDrill] = useState('')
  const { data, error, loading } = useApi(`buyers/${encodeURIComponent(id)}`, { period })
  const awards = useApi<Row[]>(`buyers/${encodeURIComponent(id)}/awards`, { division })
  const gaps = useApi<Row[]>(`buyers/${encodeURIComponent(id)}/gaps`)

  if (!data) return <div className="page"><Loading error={error} /></div>
  const b = data.buyer
  const k = data.kpis
  const flagged = data.categories.filter((c: Row) => c.unusual)
  const c = data.competition
  const fewBidders = data.categories.filter((r: Row) => r.few_bidders)

  const yearOption = {
    ...base(t),
    tooltip: { ...(base(t).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['Award published', 'No award found'], top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: t.ink2 } },
    grid: { ...(base(t).grid as object), top: 36 },
    xAxis: { type: 'category', data: data.by_year.map((r: Row) => r.year), ...axisCat(t) },
    yAxis: { type: 'value', ...axisVal(t), minInterval: 1 },
    series: [
      { name: 'Award published', type: 'bar', stack: 'y', barMaxWidth: 24, data: data.by_year.map((r: Row) => r.awarded), itemStyle: { color: t.s1, borderColor: t.surface, borderWidth: 1 } },
      { name: 'No award found', type: 'bar', stack: 'y', barMaxWidth: 24, data: data.by_year.map((r: Row) => r.no_award_found), itemStyle: { color: t.s2, borderColor: t.surface, borderWidth: 1, borderRadius: [4, 4, 0, 0] } },
    ],
  }

  return (
    <div className={`page ${loading ? 'stale' : ''}`}>
      <div className="page-head">
        <h1>{b.name}</h1>
        <p className="kicker">
          {b.kind}{b.province ? ` in ${b.province}` : ''} · {b.population ? `${num(b.population)} residents` : bandLabel(b.size_band)}
          {b.n_units > 1 && ` · combines ${b.n_units} registered departments`}
        </p>
      </div>

      <Stats items={[
        { label: 'Procedures', value: num(k.procedures) },
        { label: 'Awarded lots', value: lots(k.lots) },
        { label: 'Different suppliers', value: num(k.suppliers) },
        { label: 'Reported award value', value: eur(k.value_known), note: `known for ${pct(k.value_coverage)} of lots` },
        { label: 'No award found', value: pct(k.closed ? k.no_award_found / k.closed : null), note: `${num(k.no_award_found)} of ${num(k.closed)} closed procedures` },
        { label: 'Lots with a single tender', value: c && c.n_bid_lots >= 5 ? pct(c.single_bid_rate) : '–',
          note: c && c.n_bid_lots >= 5
            ? <>{c.peer_median_single_bid != null ? `peers ${pct(c.peer_median_single_bid)} · ` : ''}{period === 'all' ? 'all years' : period}</>
            : 'too few lots with a known tender count' },
      ]} />

      {flagged.length > 0 && (
        <div className="callout">
          In {flagged.length} {flagged.length === 1 ? 'category' : 'categories'} this buyer's awards are markedly more concentrated than
          at comparable {b.kind.toLowerCase()} buyers{period !== 'all' ? ` in ${period}` : ''}. That can have ordinary explanations
          (framework agreements, a specialised market, a local monopoly) and is a starting point for questions.
        </div>
      )}

      {fewBidders.length > 0 && (
        <div className="callout">
          In {fewBidders.length} {fewBidders.length === 1 ? 'category' : 'categories'} at least half of the competitive lots drew a single
          tender, well above comparable buyers. See the competition view below.
        </div>
      )}

      <Panel
        title="Categories compared with similar buyers"
        note={<>Peers: other {b.kind.toLowerCase()} buyers of size “{bandLabel(b.size_band)}” buying in the same category and period.</>}
        actions={
          <div className="row">
            <Seg label="View" value={view} onChange={setView} options={[{ value: 'concentration', label: 'Concentration' }, { value: 'competition', label: 'Competition' }]} />
            <Seg label="Period" value={period} onChange={setPeriod} options={[{ value: 'all', label: 'All years' }, ...(meta?.periods ?? []).map((p) => ({ value: p, label: p }))]} />
          </div>
        }
      >
        <PeerLegend />
        {view === 'competition' ? (
          <Table rows={data.categories} rowKey={(r) => r.division} limit={20} highlight={(r) => r.division === drill} empty="No competition data for this period." cols={[
            { key: 'label', label: 'Category', render: (r) => <><button className="link" onClick={() => setDrill(r.division)}>{r.label}</button><span className="sub">CPV {r.division}</span></> },
            { key: 'n_bid_lots', label: 'Lots', num: true, title: 'Competitive lots with a known tender count', render: (r) => <>{num(r.n_bid_lots)}<span className="sub">{num(r.n_single)} single</span></> },
            { key: 'single_bid_rate', label: 'Single tender', title: 'Share of competitive lots that received one tender',
              render: (r) => (r.n_bid_lots ?? 0) >= 3 ? <PeerBar value={r.single_bid_rate} median={r.peer_median_single_bid} p75={r.peer_p75_single_bid} /> : <span className="muted small">fewer than 3 lots</span>,
              sort: (r) => ((r.n_bid_lots ?? 0) >= 3 ? r.single_bid_rate : null) },
            { key: 'avg_bids', label: 'Tenders per lot', num: true, render: (r) => <>{r.avg_bids != null ? r.avg_bids.toFixed(1) : '–'}{r.peer_median_avg_bids != null && <span className="sub">peers {r.peer_median_avg_bids.toFixed(1)}</span>}</> },
            { key: 'direct_share', label: 'No prior publication', num: true, render: (r) => <>{pct(r.direct_share)}{r.peer_median_direct_share != null && <span className="sub">peers {pct(r.peer_median_direct_share)}</span>}</> },
            { key: 'few_bidders', label: 'Flags', render: (r) => <div className="row">{r.few_bidders && <FewBiddersBadge />}{r.unusual && <UnusualBadge persistent={r.persistent_periods} />}</div>,
              sort: (r) => (r.few_bidders ? 0 : 2) + (r.unusual ? 0 : 1) },
            { key: 'go', label: '', render: (r) => <Link to={`/compare?division=${r.division}&kind=${encodeURIComponent(b.kind)}&period=${period === 'all' ? '2022-2024' : period}&metric=single&buyer=${encodeURIComponent(b.buyer_id)}`}>Peers</Link> },
          ]} />
        ) : (
        <Table rows={data.categories} rowKey={(r) => r.division} limit={20} highlight={(r) => r.division === drill} cols={[
          { key: 'label', label: 'Category', render: (r) => <><button className="link" onClick={() => setDrill(r.division)}>{r.label}</button><span className="sub">CPV {r.division}</span></> },
          { key: 'n_lots', label: 'Lots', num: true, render: (r) => lots(r.n_lots) },
          { key: 'n_suppliers', label: 'Suppliers', num: true, render: (r) => <>{r.n_suppliers}{r.peer_median_suppliers != null && <span className="sub">peers {num(r.peer_median_suppliers)}</span>}</> },
          { key: 'top_share', label: 'Share of top supplier', title: 'Share of awarded lots going to the most frequent supplier',
            render: (r) => <PeerBar value={r.top_share} median={r.peer_median_top_share} p75={r.peer_p75_top_share} /> },
          { key: 'top_supplier_name', label: 'Top supplier', render: (r) => <SupplierLink id={r.top_supplier} name={r.top_supplier_name} /> },
          { key: 'comparability', label: 'Comparison', render: (r) => <div className="row">{r.unusual && <UnusualBadge persistent={r.persistent_periods} />}<Comparability value={r.comparability} /></div>,
            sort: (r) => (r.unusual ? 0 : 1) + (r.comparability === 'comparable' ? 0 : 2) },
          { key: 'go', label: '', render: (r) => <Link to={`/compare?division=${r.division}&kind=${encodeURIComponent(b.kind)}&period=${period === 'all' ? '2022-2024' : period}&buyer=${encodeURIComponent(b.buyer_id)}`}>Peers</Link> },
        ]} />
        )}
        <p className="small muted" style={{ marginTop: 8 }}>Click a category to see its suppliers and lots.</p>
      </Panel>

      {drill && <CellDrilldown buyerId={b.buyer_id} division={drill} period={period} showBuyer={false} scrollOnOpen onClose={() => setDrill('')} />}

      {data.persistence.length > 0 && (
        <Panel title="Same top supplier across periods" note="Categories where one supplier won at least half of the lots in two or more three-year periods.">
          <Table rows={data.persistence} cols={[
            { key: 'label', label: 'Category' },
            { key: 'supplier_name', label: 'Supplier', render: (r) => <SupplierLink id={r.top_supplier} name={r.supplier_name} /> },
            { key: 'periods', label: 'Periods', render: (r) => r.periods.join(', ') },
            { key: 'avg_top_share', label: 'Average share', num: true, render: (r) => pct(r.avg_top_share) },
            { key: 'n_lots', label: 'Lots', num: true, render: (r) => lots(r.n_lots) },
          ]} />
        </Panel>
      )}

      <div className="grid g2">
        <Panel title="Procedures per year" note="By year of first notice.">
          <Chart option={yearOption as any} height={260} table={
            <Table rows={data.by_year} cols={[
              { key: 'year', label: 'Year' }, { key: 'awarded', label: 'Award published', num: true },
              { key: 'no_award_found', label: 'No award found', num: true }, { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
            ]} />
          } />
        </Panel>
        <Panel title="Suppliers" note="All categories, all years. Share = share of this buyer's awarded lots.">
          <Table rows={data.suppliers} limit={10} rowKey={(r) => r.supplier_key} cols={[
            { key: 'name', label: 'Supplier', render: (r) => <><SupplierLink id={r.supplier_key} name={r.name} /><span className="sub">{[r.locality, r.sme ? 'SME' : null].filter(Boolean).join(' · ')}</span></> },
            { key: 'lots', label: 'Lots', num: true, render: (r) => lots(r.lots) },
            { key: 'share', label: 'Share', num: true, render: (r) => pct(r.share, 1) },
            { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
            { key: 'last_year', label: 'Years', num: true, render: (r) => r.first_year === r.last_year ? r.first_year : `${r.first_year}–${r.last_year}` },
          ]} />
        </Panel>
      </div>

      <Panel title="Relationship network" note="This buyer's main suppliers and the other buyers those suppliers work for.">
        <Network buyerId={b.buyer_id} />
      </Panel>

      <Panel
        title="Awards"
        note="Most recent 200. Every row links to the original notice on TenderNed."
        actions={
          <label className="small">Category{' '}
            <select value={division} onChange={(e) => setDivision(e.target.value)}>
              <option value="">All categories</option>
              {data.categories.map((c: Row) => <option key={c.division} value={c.division}>{c.label}</option>)}
            </select>
          </label>
        }
      >
        {!awards.data ? <Loading error={awards.error} /> : (
          <Table rows={awards.data} limit={20} cols={[
            { key: 'published', label: 'Published' },
            { key: 'title', label: 'Procedure', render: (r) => <><ProcedureLink ocid={r.ocid}>{r.title}</ProcedureLink>{r.lot_title && r.lot_title !== r.title && <span className="sub">Lot: {r.lot_title}</span>}</> },
            { key: 'supplier_name', label: 'Supplier', render: (r) => <><SupplierLink id={r.supplier_key} name={r.supplier_name} />{r.n_lot_suppliers > 1 && <span className="sub">1 of {r.n_lot_suppliers} suppliers on this lot</span>}</> },
            { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
            { key: 'notice_id', label: 'Source', render: (r) => <NoticeLink id={r.notice_id} /> },
          ]} />
        )}
      </Panel>

      <Panel title="Procedures without a discoverable award" note="Contract notice published more than a year before the data cutoff, but no award notice or early-termination notice found.">
        {!gaps.data ? <Loading error={gaps.error} /> : (
          <Table rows={gaps.data} limit={10} empty="None: every closed procedure has a published outcome." cols={[
            { key: 'first_published', label: 'First notice' },
            { key: 'title', label: 'Procedure', render: (r) => <ProcedureLink ocid={r.ocid}>{r.title}</ProcedureLink> },
            { key: 'procedure', label: 'Procedure type', render: (r) => <>{r.procedure ?? '–'}<span className="sub">{r.scope}</span></> },
            { key: 'last_notice_id', label: 'Source', render: (r) => <NoticeLink id={r.last_notice_id} /> },
          ]} />
        )}
      </Panel>
    </div>
  )
}
