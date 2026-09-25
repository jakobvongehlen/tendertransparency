import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useApi, type Row } from '../api'
import { useMeta } from '../App'
import { eur, lots, num, pct } from '../format'
import { Chart, axisCat, axisVal, base, useTokens } from './Chart'
import {
  Comparability, DirectAwardTag, FewBiddersBadge, Loading, NoticeLink, PeerBar, ProcedureLink, Seg, Stats, SupplierLink, Table, UnusualBadge,
} from './ui'

type LotFilter = 'all' | 'supplier' | 'single' | 'nopub'

/** Plain-language observations about one buyer x category x period. Facts only, no verdicts. */
function observations(d: Row): ReactNode[] {
  const s = d.summary
  const out: ReactNode[] = []
  const top: Row | undefined = d.suppliers[0]
  if (!s || !top) return out
  const lotsWord = (n: number) => `${lots(n)} ${Math.abs(n - 1) < 0.05 ? 'lot' : 'lots'}`
  out.push(<>
    <b>{top.name}</b> won {lotsWord(top.lots)} of {lots(s.n_lots)} ({pct(top.share)})
    {s.peer_median_top_share != null && <>; the typical top supplier at comparable buyers holds {pct(s.peer_median_top_share)}</>}.
  </>)
  if (top.procedures === 1 && top.lots >= 2) {
    out.push(<>All of {top.name}'s lots come from <b>a single procedure</b>. One contract split into lots says less about repeated choices than separate wins would.</>)
  } else if (top.procedures > 1) {
    out.push(<>{top.name} won in <b>{top.procedures} separate procedures</b>, {top.first_year === top.last_year ? `all in ${top.first_year}` : `between ${top.first_year} and ${top.last_year}`}.</>)
  }
  const how: string[] = []
  if (top.bid_lots > 0) how.push(`${top.single_bid_lots} of ${top.bid_lots} competitive lots with a known count drew a single tender`)
  if (top.no_publication_lots > 0) how.push(`${top.no_publication_lots} awarded directly, without a call for competition`)
  if (top.framework_lots > 0) how.push(`${top.framework_lots} under a framework agreement or shared with other winners`)
  if (how.length) out.push(<>For {top.name}: {how.join('; ')}.</>)
  if (s.persistent_periods >= 2) out.push(<>The same supplier held at least half the lots in <b>{s.persistent_periods} three-year periods</b>.</>)
  if (d.gaps.length > 0) out.push(<>{d.gaps.length} {d.gaps.length === 1 ? 'procedure' : 'procedures'} in this category {d.gaps.length === 1 ? 'has' : 'have'} no discoverable award, so the picture may be incomplete.</>)
  if (s.kvk_coverage != null && s.kvk_coverage < 0.6) out.push(<>Only {pct(s.kvk_coverage)} of suppliers are identified by KvK number; name variants of one company may be counted separately.</>)
  return out
}

export function CellDrilldown({ buyerId, division, period, onClose, showBuyer = true, scrollOnOpen = false }: {
  buyerId: string; division: string; period: string; onClose?: () => void; showBuyer?: boolean; scrollOnOpen?: boolean
}) {
  const meta = useMeta()
  const t = useTokens()
  const ref = useRef<HTMLElement>(null)
  const { data, error, loading } = useApi(`buyers/${encodeURIComponent(buyerId)}/cell`, { division, period })
  const [filter, setFilter] = useState<LotFilter>('all')
  const [supplier, setSupplier] = useState('')
  const label = meta?.divisions.find((d) => d.division === division)?.label ?? `CPV ${division}`

  // new selection: reset filters, bring the panel into view when asked
  useEffect(() => { setFilter('all'); setSupplier('') }, [buyerId, division, period])
  useEffect(() => {
    if (scrollOnOpen && data) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [scrollOnOpen, data?.buyer?.buyer_id, data?.division]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickSupplier = (key: string) => { setSupplier(key); setFilter('supplier') }

  const head = (
    <div className="panel-head">
      <div>
        <h2>{showBuyer && data ? <>{data.buyer.name}: </> : null}{label}, {period === 'all' ? 'all years' : period}</h2>
        <p>
          The suppliers and lots behind this comparison.
          {showBuyer && <> <Link to={`/buyers/${encodeURIComponent(buyerId)}`}>Buyer profile</Link>{' · '}</>}
          {!showBuyer && ' '}
          <Link to={`/compare?division=${division}&kind=${encodeURIComponent(data?.buyer.kind ?? '')}&period=${period}&buyer=${encodeURIComponent(buyerId)}`}>Compare with peers</Link>
        </p>
      </div>
      {onClose && <button className="close" onClick={onClose} aria-label="Close details">×</button>}
    </div>
  )

  if (!data) return <section className="panel drill" ref={ref}>{head}<Loading error={error} /></section>
  const s = data.summary
  if (!s) return <section className="panel drill" ref={ref}>{head}<p className="muted small">No awards in this category and period.</p></section>

  const sup: Row[] = data.suppliers
  const obs = observations(data)
  const top4 = sup.slice(0, 4).map((r) => r.supplier_key)
  const years = [...new Set<number>(data.by_year.map((r: Row) => r.year))].sort()
  const colors = [t.s1, t.s2, t.s3, t.s4]
  const lotsIn = (y: number, pred: (k: string) => boolean) =>
    data.by_year.filter((r: Row) => r.year === y && pred(r.supplier_key)).reduce((a: number, r: Row) => a + r.lots, 0)
  const timeline = {
    ...base(t),
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: t.ink2, width: 150, overflow: 'truncate' } },
    grid: { ...(base(t).grid as object), top: sup.length > 2 ? 52 : 32 },
    tooltip: { ...(base(t).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => lots(v) },
    xAxis: { type: 'category', data: years, ...axisCat(t) },
    yAxis: { type: 'value', ...axisVal(t), minInterval: 1 },
    series: [
      ...sup.slice(0, 4).map((r, i) => ({ name: r.name, key: r.supplier_key, color: colors[i] })),
      ...(sup.length > 4 ? [{ name: `${sup.length - 4} other suppliers`, key: '', color: t.axis }] : []),
    ].map((x, i, all) => ({
      name: x.name, type: 'bar', stack: 'y', barMaxWidth: 28,
      data: years.map((y) => lotsIn(y, x.key ? (k) => k === x.key : (k) => !top4.includes(k))),
      itemStyle: { color: x.color, borderColor: t.surface, borderWidth: 1, borderRadius: i === all.length - 1 ? [3, 3, 0, 0] : 0 },
    })),
  }

  const all: Row[] = data.lots
  const shownLots = all.filter((l) =>
    filter === 'supplier' ? l.supplier_key === supplier
      : filter === 'single' ? l.n_bids === 1 && !l.no_publication
        : filter === 'nopub' ? l.no_publication : true)
  const supName = sup.find((r) => r.supplier_key === supplier)?.name
  const nSingle = all.filter((l) => l.n_bids === 1 && !l.no_publication).length
  const nNopub = all.filter((l) => l.no_publication).length

  return (
    <section className={`panel drill ${loading ? 'stale' : ''}`} ref={ref}>
      {head}
      <Stats items={[
        { label: 'Awarded lots', value: lots(s.n_lots), note: `${num(s.n_procedures)} procedures` },
        { label: 'Suppliers', value: num(s.n_suppliers) },
        { label: 'Share of top supplier', value: <PeerBar value={s.top_share} median={s.peer_median_top_share} p75={s.peer_p75_top_share} width={90} />,
          note: s.n_peers ? `vs ${num(s.n_peers)} peers` : 'no peer comparison' },
        { label: 'Single tender', value: (s.n_bid_lots ?? 0) > 0 ? pct(s.single_bid_rate) : '–',
          note: (s.n_bid_lots ?? 0) > 0 ? `${num(s.n_single)} of ${num(s.n_bid_lots)} lots${s.peer_median_single_bid != null ? ` · peers ${pct(s.peer_median_single_bid)}` : ''}` : 'no known tender counts' },
        { label: 'Reported value', value: eur(s.value_known) },
      ]} />
      <div className="row" style={{ margin: '12px 0 4px' }}>
        {s.unusual && <UnusualBadge persistent={s.persistent_periods} />}
        {s.few_bidders && <FewBiddersBadge />}
        <Comparability value={s.comparability} />
      </div>

      {obs.length > 0 && (
        <div className="observations">
          <h3>Notes</h3>
          <ul>{obs.map((o, i) => <li key={i}>{o}</li>)}</ul>
          <p className="small muted">Based on published notices only. Specialised markets, framework agreements and follow-up work can explain any of these.</p>
        </div>
      )}

      <div className="grid g2 drill-grid">
        <div>
          <h3>Suppliers</h3>
          <Table rows={sup} limit={8} rowKey={(r) => r.supplier_key} highlight={(r) => filter === 'supplier' && r.supplier_key === supplier} cols={[
            { key: 'name', label: 'Supplier', render: (r) => <><SupplierLink id={r.supplier_key} name={r.name} /><span className="sub">{[r.locality, r.first_year === r.last_year ? r.first_year : `${r.first_year}–${r.last_year}`].filter(Boolean).join(' · ')}</span></> },
            { key: 'lots', label: 'Lots', num: true, render: (r) => <>{lots(r.lots)}<span className="sub">{pct(r.share)}</span></> },
            { key: 'procedures', label: 'Procedures', num: true },
            { key: 'single_bid_lots', label: 'How won', title: 'Single tender · direct award (no call for competition) · framework or shared lot',
              render: (r) => <span className="small">{[
                r.single_bid_lots ? `${r.single_bid_lots} single tender` : null,
                r.no_publication_lots ? `${r.no_publication_lots} direct award` : null,
                r.framework_lots ? `${r.framework_lots} framework` : null,
              ].filter(Boolean).join(' · ') || <span className="muted">competed</span>}</span> },
            { key: 'show', label: '', render: (r) => <button className="link small nowrap" onClick={() => pickSupplier(r.supplier_key)}>Show lots</button> },
          ]} />
        </div>
        <div>
          <h3>Lots won per year</h3>
          <Chart option={timeline as any} height={240} />
        </div>
      </div>

      <div className="drill-lots">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>Awarded lots, newest first</h3>
          <Seg label="Filter lots" value={filter} onChange={(v) => { setFilter(v); if (v !== 'supplier') setSupplier('') }} options={[
            { value: 'all', label: `All ${all.length}` },
            ...(supplier ? [{ value: 'supplier' as const, label: supName ?? 'Supplier' }] : []),
            ...(nSingle ? [{ value: 'single' as const, label: `Single tender ${nSingle}` }] : []),
            ...(nNopub ? [{ value: 'nopub' as const, label: `Direct award ${nNopub}` }] : []),
          ]} />
        </div>
        <Table rows={shownLots} limit={15} rowKey={(r) => `${r.ocid}-${r.lot_id}-${r.supplier_key}`} cols={[
          { key: 'published', label: 'Published' },
          { key: 'title', label: 'Procedure', render: (r) => <><ProcedureLink ocid={r.ocid}>{r.title}</ProcedureLink>{r.lot_title && r.lot_title !== r.title && <span className="sub">Lot: {r.lot_title}</span>}</> },
          { key: 'supplier_name', label: 'Winner', render: (r) => <><button className="link" onClick={() => pickSupplier(r.supplier_key)}>{r.supplier_name}</button>{r.n_lot_suppliers > 1 && <span className="sub">1 of {r.n_lot_suppliers} winners</span>}</> },
          { key: 'n_bids', label: 'How competed', sort: (r) => (r.no_publication ? -1 : r.n_bids),
            render: (r) => <>
              <span className="row" style={{ gap: 4 }}>
                {r.no_publication ? <DirectAwardTag />
                  : r.n_bids === 1 ? <span className="tag warn">1 tender</span>
                    : r.n_bids ? <span className="tag">{r.n_bids} tenders</span> : <span className="tag muted">tenders unknown</span>}
                {r.framework && <span className="tag">framework</span>}
              </span>
              <span className="sub">{r.procedure ?? '–'}{r.scope === 'Europees' ? ' · EU' : ''}</span>
            </> },
          { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
          { key: 'notice_id', label: 'Source', render: (r) => <NoticeLink id={r.notice_id} /> },
        ]} />
      </div>

      {data.gaps.length > 0 && (
        <div className="drill-lots">
          <h3>Procedures in this category without a discoverable award</h3>
          <Table rows={data.gaps} limit={5} rowKey={(r) => r.ocid} cols={[
            { key: 'first_published', label: 'First notice' },
            { key: 'title', label: 'Procedure', render: (r) => <ProcedureLink ocid={r.ocid}>{r.title}</ProcedureLink> },
            { key: 'procedure', label: 'Type', render: (r) => r.procedure ?? '–' },
            { key: 'last_notice_id', label: 'Source', render: (r) => <NoticeLink id={r.last_notice_id} /> },
          ]} />
        </div>
      )}
    </section>
  )
}
