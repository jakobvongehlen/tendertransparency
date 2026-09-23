import { useState } from 'react'
import { useApi, type Row } from '../api'
import { useMeta } from '../App'
import { num, pct } from '../format'
import { Chart, axisCat, axisVal, base, useTokens } from '../components/Chart'
import { BuyerLink, Loading, NoticeLink, Panel, ProcedureLink, Table } from '../components/ui'

const QUALITY = [
  { key: 'kvk_coverage', label: 'Supplier identified by KvK number' },
  { key: 'value_coverage', label: 'Award value reported' },
] as const

export default function Gaps() {
  const meta = useMeta()
  const t = useTokens()
  const [kind, setKind] = useState('')
  const { data, error, loading } = useApi('gaps', { kind })
  if (!data) return <div className="page"><Loading error={error} /></div>

  const years = [...new Set<number>(data.status_by_year.map((r: Row) => r.year))].sort()
  const cell = (y: number, s: string) => data.status_by_year.find((r: Row) => r.year === y && r.status === s)?.n ?? 0
  const rateRows = years.map((y) => {
    const closed = cell(y, 'awarded') + cell(y, 'no_award_found') + cell(y, 'terminated')
    return { year: y, no_award: cell(y, 'no_award_found'), closed, rate: closed ? cell(y, 'no_award_found') / closed : null, recent: cell(y, 'recent') }
  }).filter((r) => r.closed > 0)

  const rateOption = {
    ...base(t),
    tooltip: { ...(base(t).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p: any) => { const r = rateRows[p[0].dataIndex]; return `<b>${r.year}</b><br/>${pct(r.rate, 1)} of ${num(r.closed)} closed procedures<br/>${num(r.no_award)} without a discoverable award` } },
    xAxis: { type: 'category', data: rateRows.map((r) => r.year), ...axisCat(t) },
    yAxis: { type: 'value', ...axisVal(t), axisLabel: { color: t.muted, formatter: (v: number) => pct(v) } },
    series: [{ type: 'bar', barMaxWidth: 24, data: rateRows.map((r) => r.rate), itemStyle: { color: t.s2, borderRadius: [4, 4, 0, 0] },
      label: { show: true, position: 'top', color: t.ink2, fontSize: 11, formatter: (p: any) => pct(p.value) } }],
  }
  const qualOption = {
    ...base(t),
    tooltip: { ...(base(t).tooltip as object), trigger: 'axis', valueFormatter: (v: number) => pct(v) },
    legend: { data: QUALITY.map((q) => q.label), top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 3, textStyle: { color: t.ink2 } },
    grid: { ...(base(t).grid as object), top: 36 },
    xAxis: { type: 'category', data: data.award_quality.map((r: Row) => r.year), ...axisCat(t) },
    yAxis: { type: 'value', min: 0, max: 1, ...axisVal(t), axisLabel: { color: t.muted, formatter: (v: number) => pct(v) } },
    series: QUALITY.map((q, i) => ({
      name: q.label, type: 'line', data: data.award_quality.map((r: Row) => r[q.key]),
      lineStyle: { width: 2, color: [t.s1, t.s3][i] }, itemStyle: { color: [t.s1, t.s3][i], borderColor: t.surface, borderWidth: 2 },
      symbol: 'circle', symbolSize: 8,
      endLabel: { show: true, color: t.ink2, formatter: (p: any) => pct(p.value) },
    })),
  }

  return (
    <div className={`page ${loading ? 'stale' : ''}`}>
      <div className="page-head">
        <h1>Where the record is incomplete</h1>
        <p className="lede">
          A comparison is only as good as the data behind it. Here: procedures whose outcome was never published on TenderNed, and
          awards that name no identifiable supplier or no value. National (below-threshold) procedures have lighter publication duties,
          so a missing award notice is not necessarily a breach.
        </p>
      </div>
      <div className="filters">
        <label>Buyer type
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All types</option>
            {meta?.kinds.map((k) => <option key={k.kind}>{k.kind}</option>)}
          </select>
        </label>
      </div>

      <div className="grid g2">
        <Panel title="Procedures without a discoverable award" note="Share of closed procedures (award, early termination or older than 12 months) with a contract notice but no award notice.">
          <Chart option={rateOption as any} height={260} table={
            <Table rows={rateRows} cols={[{ key: 'year', label: 'Year' }, { key: 'no_award', label: 'No award found', num: true }, { key: 'closed', label: 'Closed', num: true }, { key: 'rate', label: 'Share', num: true, render: (r) => pct(r.rate, 1) }]} />
          } />
        </Panel>
        <Panel title="Quality of published awards" note="Share of awarded lots. Supplier identity includes names matched to a KvK number found in other notices.">
          <Chart option={qualOption as any} height={260} table={
            <Table rows={data.award_quality} cols={[{ key: 'year', label: 'Year' }, ...QUALITY.map((q) => ({ key: q.key, label: q.label, num: true, render: (r: Row) => pct(r[q.key], 1) })),
              { key: 'placeholder_share', label: 'Placeholder values (< €100)', num: true, render: (r: Row) => pct(r.placeholder_share, 1) }]} />
          } />
        </Panel>
      </div>

      <div className="grid g2">
        <Panel title="By buyer type">
          <Table rows={data.by_kind} cols={[
            { key: 'kind', label: 'Type' },
            { key: 'no_award', label: 'No award found', num: true, render: (r) => num(r.no_award) },
            { key: 'closed', label: 'Closed procedures', num: true, render: (r) => num(r.closed) },
            { key: 'rate', label: 'Share', num: true, render: (r) => pct(r.rate, 1) },
          ]} initialSort={{ key: 'rate', dir: -1 }} />
        </Panel>
        <Panel title="By procedure type" note="Procedure types with at least 50 closed procedures.">
          <Table rows={data.by_scope} cols={[
            { key: 'procedure', label: 'Procedure', render: (r) => <>{r.procedure}<span className="sub">{r.scope === 'Europees' ? 'EU threshold' : r.scope === 'Nationaal' ? 'National' : r.scope}</span></> },
            { key: 'no_award', label: 'No award found', num: true, render: (r) => num(r.no_award) },
            { key: 'rate', label: 'Share', num: true, render: (r) => pct(r.no_award / r.closed, 1), sort: (r) => r.no_award / r.closed },
          ]} initialSort={{ key: 'no_award', dir: -1 }} />
        </Panel>
      </div>

      <Panel title="Buyers with the most procedures lacking an outcome" note="Buyers with at least 10 closed procedures.">
        <Table rows={data.worst_buyers} limit={15} cols={[
          { key: 'name', label: 'Buyer', render: (r) => <><BuyerLink id={r.buyer_id} name={r.name} /><span className="sub">{r.kind}</span></> },
          { key: 'no_award', label: 'No award found', num: true },
          { key: 'closed', label: 'Closed procedures', num: true },
          { key: 'rate', label: 'Share', num: true, render: (r) => pct(r.rate) },
        ]} />
      </Panel>

      <Panel title="Most recent procedures without a discoverable award" note="Check the notice on TenderNed: the outcome may have been published elsewhere or under a different reference.">
        <Table rows={data.missing} limit={20} cols={[
          { key: 'first_published', label: 'First notice' },
          { key: 'title', label: 'Procedure', render: (r) => <ProcedureLink ocid={r.ocid}>{r.title}</ProcedureLink> },
          { key: 'buyer_name', label: 'Buyer', render: (r) => <BuyerLink id={r.buyer_id} name={r.buyer_name} /> },
          { key: 'procedure', label: 'Type', render: (r) => <>{r.procedure ?? '–'}<span className="sub">{r.scope}</span></> },
          { key: 'last_notice_id', label: 'Source', render: (r) => <NoticeLink id={r.last_notice_id} /> },
        ]} />
      </Panel>
    </div>
  )
}
