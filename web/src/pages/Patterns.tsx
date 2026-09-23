import { useSearchParams, Link } from 'react-router-dom'
import { useApi } from '../api'
import { useMeta } from '../App'
import { bandLabel, lots, num, pct } from '../format'
import { BuyerLink, Comparability, Loading, Panel, PeerBar, PeerLegend, SupplierLink, Table, StaleNotice } from '../components/ui'

export default function Patterns() {
  const meta = useMeta()
  const [sp, setSp] = useSearchParams()
  const get = (k: string) => sp.get(k) ?? ''
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp)
    if (v) n.set(k, v); else n.delete(k)
    setSp(n, { replace: true })
  }
  const onlyUnusual = get('all') !== '1'
  const persistent = get('persistent') === '1'
  const { data, error, loading, retry } = useApi<any[]>('flags', {
    division: get('division'), kind: get('kind'), province: get('province'), period: get('period'),
    only_unusual: onlyUnusual, persistent, limit: 500,
  })

  return (
    <div className="page">
      <div className="page-head">
        <h1>Where concentration is unusual</h1>
        <p className="lede">
          Buyer, category and period combinations where one supplier won a much larger share of the lots than is typical for buyers of the
          same type and size. A flag needs at least 5 awarded lots, at least 5 peers and reasonably complete data. It marks
          something to look into: framework agreements, specialised markets and local monopolies all produce the same pattern.
        </p>
      </div>
      <div className="filters">
        <label>Category
          <select value={get('division')} onChange={(e) => set('division', e.target.value)}>
            <option value="">All categories</option>
            {meta?.divisions.map((d) => <option key={d.division} value={d.division}>{d.division} · {d.label}</option>)}
          </select>
        </label>
        <label>Buyer type
          <select value={get('kind')} onChange={(e) => set('kind', e.target.value)}>
            <option value="">All types</option>
            {meta?.kinds.map((k) => <option key={k.kind}>{k.kind}</option>)}
          </select>
        </label>
        <label>Province
          <select value={get('province')} onChange={(e) => set('province', e.target.value)}>
            <option value="">All provinces</option>
            {meta?.provinces.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label>Period
          <select value={get('period')} onChange={(e) => set('period', e.target.value)}>
            <option value="">All three-year periods</option>
            {meta?.periods.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={persistent} onChange={(e) => set('persistent', e.target.checked ? '1' : '')} /> Same top supplier in 2+ periods</label>
        <label className="check"><input type="checkbox" checked={!onlyUnusual} onChange={(e) => set('all', e.target.checked ? '1' : '')} /> Include unflagged comparisons</label>
      </div>

      <StaleNotice error={data ? error : null} retry={retry} />
      <Panel title={data ? `${num(data.length)}${data.length === 500 ? '+' : ''} ${onlyUnusual ? 'flagged patterns' : 'comparisons'}` : 'Patterns'} className={loading ? 'stale' : ''}
        note="Sorted by how far the top-supplier share exceeds the peer median.">
        <PeerLegend />
        {!data ? <Loading error={error} /> : (
          <Table rows={data} limit={40} cols={[
            { key: 'buyer_name', label: 'Buyer', render: (r) => <><BuyerLink id={r.buyer_id} name={r.buyer_name} /><span className="sub">{r.kind} · {bandLabel(r.size_band)}{r.province ? ` · ${r.province}` : ''}</span></> },
            { key: 'label', label: 'Category', render: (r) => <>{r.label}<span className="sub">{r.period}</span></> },
            { key: 'n_lots', label: 'Lots', num: true, render: (r) => <>{lots(r.n_lots)}<span className="sub">{r.n_suppliers} suppliers</span></> },
            { key: 'top_share', label: 'Top-supplier share vs peers', render: (r) => <PeerBar value={r.top_share} median={r.peer_median_top_share} p75={r.peer_p75_top_share} />,
              sort: (r) => r.top_share - r.peer_median_top_share },
            { key: 'top_supplier_name', label: 'Top supplier', render: (r) => <><SupplierLink id={r.top_supplier} name={r.top_supplier_name} />
              <span className="sub">{r.supplier_province ? (r.supplier_province === r.province ? 'same province' : r.supplier_province) : ''}</span></> },
            { key: 'n_peers', label: 'Peers', num: true },
            { key: 'persistent_periods', label: 'Periods', num: true, title: 'Number of three-year periods with this supplier on top (≥50% share)' },
            { key: 'comparability', label: 'Data', render: (r) => <><Comparability value={r.comparability} /><span className="sub">KvK {pct(r.kvk_coverage)} · no award {pct(r.no_award_rate)}</span></> },
            { key: 'go', label: '', render: (r) => <Link to={`/compare?division=${r.division}&kind=${encodeURIComponent(r.kind)}&period=${r.period}&size_band=${encodeURIComponent(r.size_band)}&buyer=${encodeURIComponent(r.buyer_id)}`}>Investigate</Link> },
          ]} />
        )}
      </Panel>
    </div>
  )
}
