import { useParams } from 'react-router-dom'
import { useApi, type Row } from '../api'
import { eur, lots, num, pct } from '../format'
import { Chart, axisCat, axisVal, base, useTokens } from '../components/Chart'
import { Network } from '../components/Network'
import { BuyerLink, Comparability, Loading, NoticeLink, Panel, PeerBar, PeerLegend, ProcedureLink, Stats, Table } from '../components/ui'

export default function SupplierProfile() {
  const { id = '' } = useParams()
  const t = useTokens()
  const { data, error, loading } = useApi(`suppliers/${encodeURIComponent(id)}`)
  if (!data) return <div className="page"><Loading error={error} /></div>
  const s = data.supplier
  const k = data.kpis

  const yearOption = {
    ...base(t),
    tooltip: { ...(base(t).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p: any) => { const r = data.by_year[p[0].dataIndex]; return `<b>${r.year}</b><br/>${lots(r.lots)} lots · ${r.buyers} buyers · ${eur(r.value)} reported` } },
    xAxis: { type: 'category', data: data.by_year.map((r: Row) => r.year), ...axisCat(t) },
    yAxis: { type: 'value', ...axisVal(t) },
    series: [{ type: 'bar', barMaxWidth: 24, data: data.by_year.map((r: Row) => +r.lots.toFixed(1)), itemStyle: { color: t.s2, borderRadius: [4, 4, 0, 0] } }],
  }

  return (
    <div className={`page ${loading ? 'stale' : ''}`}>
      <div className="page-head">
        <h1>{s.name}</h1>
        <p className="kicker">
          {[s.locality, s.province, s.country !== 'Nederland' ? s.country : null].filter(Boolean).join(', ')}
          {s.kvk ? <> · KvK <a href={`https://www.kvk.nl/zoeken/?source=all&q=${s.kvk}`} target="_blank" rel="noreferrer">{s.kvk}</a></> : ' · no KvK number in the notices'}
          {s.sme && ' · SME'}
        </p>
      </div>
      <Stats items={[
        { label: 'Awarded lots', value: lots(k.lots) },
        { label: 'Procedures', value: num(k.procedures) },
        { label: 'Buyers', value: num(k.buyers) },
        { label: 'Reported award value', value: eur(k.value_known), note: `known for ${pct(k.value_coverage)} of lots` },
        { label: 'Active', value: k.first_year === k.last_year ? k.first_year : `${k.first_year}–${k.last_year}` },
      ]} />

      <Panel
        title="How much buyers rely on this supplier"
        note="For each buyer and category: the share of that buyer's awarded lots won by this supplier, next to how concentrated comparable buyers are."
      >
        <PeerLegend />
        <Table rows={data.buyers} limit={15} cols={[
          { key: 'name', label: 'Buyer', render: (r) => <><BuyerLink id={r.buyer_id} name={r.name} /><span className="sub">{r.kind}{r.province ? `, ${r.province}` : ''}</span></> },
          { key: 'label', label: 'Category' },
          { key: 'lots', label: 'Lots won', num: true, render: (r) => `${lots(r.lots)} of ${lots(r.buyer_lots)}` },
          { key: 'share_of_buyer', label: 'Share of buyer’s lots', render: (r) => <PeerBar value={r.share_of_buyer} median={r.peer_median_top_share} /> },
          { key: 'buyer_suppliers', label: 'Buyer’s suppliers', num: true },
          { key: 'comparability', label: 'Comparison', render: (r) => <Comparability value={r.comparability} /> },
        ]} />
      </Panel>

      <div className="grid g2">
        <Panel title="Awarded lots per year">
          <Chart option={yearOption as any} height={240} table={
            <Table rows={data.by_year} cols={[{ key: 'year', label: 'Year' }, { key: 'lots', label: 'Lots', num: true, render: (r) => lots(r.lots) }, { key: 'buyers', label: 'Buyers', num: true }, { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) }]} />
          } />
        </Panel>
        <Panel title="Categories">
          <Table rows={data.divisions} limit={8} cols={[
            { key: 'label', label: 'Category' },
            { key: 'lots', label: 'Lots', num: true, render: (r) => lots(r.lots) },
            { key: 'buyers', label: 'Buyers', num: true },
            { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
          ]} />
        </Panel>
      </div>

      <Panel title="Relationship network" note="This supplier's main buyers and the other suppliers those buyers use.">
        <Network supplierKey={s.supplier_key} />
      </Panel>

      <Panel title="Awards" note="Most recent 200, with links to the original notices.">
        <Table rows={data.awards} limit={20} cols={[
          { key: 'published', label: 'Published' },
          { key: 'buyer_name', label: 'Buyer', render: (r) => <BuyerLink id={r.buyer_id} name={r.buyer_name} /> },
          { key: 'title', label: 'Procedure', render: (r) => <><ProcedureLink ocid={r.ocid}>{r.title}</ProcedureLink>{r.n_lot_suppliers > 1 && <span className="sub">shared with {r.n_lot_suppliers - 1} other suppliers</span>}</> },
          { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
          { key: 'notice_id', label: 'Source', render: (r) => <NoticeLink id={r.notice_id} /> },
        ]} />
      </Panel>
    </div>
  )
}
