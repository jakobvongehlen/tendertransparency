import { useState } from 'react'
import { useApi, type Row } from '../api'
import { useMeta } from '../App'
import { compact, eur, lots, num, pct } from '../format'
import { Chart, axisCat, axisVal, base, useTokens } from '../components/Chart'
import { BuyerLink, Loading, Panel, Stats, SupplierLink, Table } from '../components/ui'
import { Link } from 'react-router-dom'

const STATUS = [
  { key: 'awarded', label: 'Award published' },
  { key: 'no_award_found', label: 'No award found' },
  { key: 'terminated', label: 'Stopped early' },
  { key: 'recent', label: 'Too recent to judge' },
] as const

export default function Overview() {
  const meta = useMeta()
  const t = useTokens()
  const [range, setRange] = useState<[number | '', number | '']>(['', ''])
  const { data, error, loading } = useApi('overview', { year_from: range[0], year_to: range[1] })
  const years = meta ? Array.from({ length: meta.year_range.y1 - meta.year_range.y0 + 1 }, (_, i) => meta.year_range.y0 + i) : []

  if (!data) return <div className="page"><Loading error={error} /></div>
  const k = data.kpis
  const S = [t.s1, t.s2, t.s3, t.s4]

  const yearOption = {
    ...base(t),
    tooltip: { ...(base(t).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: STATUS.map((s) => s.label), top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: t.ink2 } },
    grid: { ...(base(t).grid as object), top: 36 },
    xAxis: { type: 'category', data: data.by_year.map((r: Row) => r.year), ...axisCat(t) },
    yAxis: { type: 'value', ...axisVal(t) },
    series: STATUS.map((s, i) => ({
      name: s.label, type: 'bar', stack: 'p', barMaxWidth: 24,
      data: data.by_year.map((r: Row) => r[s.key]),
      itemStyle: { color: S[i], borderColor: t.surface, borderWidth: 1, borderRadius: i === STATUS.length - 1 ? [4, 4, 0, 0] : 0 },
    })),
  }

  const divs = data.by_division.slice(0, 14).reverse()
  const divOption = {
    ...base(t),
    tooltip: { ...(base(t).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p: any) => { const r = divs[p[0].dataIndex]; return `<b>${r.label}</b><br/>${lots(r.lots)} lots · ${num(r.suppliers)} suppliers · ${eur(r.value)} reported` } },
    xAxis: { type: 'value', ...axisVal(t) },
    yAxis: { type: 'category', data: divs.map((r: Row) => r.label), ...axisCat(t), axisLabel: { color: t.ink2, fontSize: 12, width: 190, overflow: 'truncate' } },
    series: [{ type: 'bar', barMaxWidth: 16, data: divs.map((r: Row) => Math.round(r.lots)), itemStyle: { color: t.s1, borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: t.ink2, fontSize: 11, formatter: (p: any) => compact(p.value) } }],
  }

  return (
    <div className={`page ${loading ? 'stale' : ''}`}>
      <div className="page-head">
        <h1>Who wins public contracts in the Netherlands</h1>
        <p className="lede">
          Every procurement notice published on TenderNed since 2016: who buys, who wins, and how completely the
          outcome is documented. A concentrated pattern is a reason to look closer, not a finding in itself.
        </p>
      </div>

      <div className="filters">
        <label>From
          <select value={range[0]} onChange={(e) => setRange([e.target.value ? +e.target.value : '', range[1]])}>
            <option value="">All years</option>{years.map((y) => <option key={y}>{y}</option>)}
          </select>
        </label>
        <label>To
          <select value={range[1]} onChange={(e) => setRange([range[0], e.target.value ? +e.target.value : ''])}>
            <option value="">All years</option>{years.map((y) => <option key={y}>{y}</option>)}
          </select>
        </label>
      </div>

      <Stats items={[
        { label: 'Procedures', value: num(k.procedures), note: `${num(k.awarded_procedures)} with a published award` },
        { label: 'Awarded lots', value: compact(k.lots), note: 'each lot counts once, shared between winners' },
        { label: 'Buyers awarding', value: num(k.buyers) },
        { label: 'Winning suppliers', value: num(k.suppliers) },
        { label: 'Reported award value', value: eur(k.value_known), note: `known for ${pct(k.value_coverage)} of lots` },
        { label: 'No award found', value: pct(k.no_award_found / k.closed_procedures), note: `${num(k.no_award_found)} closed procedures`, },
      ]} />

      <div className="grid g2">
        <Panel title="Procedures by year and outcome" note="By year of first notice. Procedures from the last 12 months are not yet judged.">
          <Chart option={yearOption as any} height={300} table={
            <Table rows={data.by_year} cols={[{ key: 'year', label: 'Year' }, ...STATUS.map((s) => ({ key: s.key, label: s.label, num: true, render: (r: Row) => num(r[s.key]) }))]} limit={20} />
          } />
        </Panel>
        <Panel title="What is bought" note="Awarded lots by CPV division, top 14.">
          <Chart option={divOption as any} height={300} table={
            <Table rows={data.by_division} cols={[
              { key: 'label', label: 'Category' },
              { key: 'lots', label: 'Lots', num: true, render: (r) => lots(r.lots) },
              { key: 'suppliers', label: 'Suppliers', num: true, render: (r) => num(r.suppliers) },
              { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
            ]} initialSort={{ key: 'lots', dir: -1 }} />
          } />
        </Panel>
      </div>

      <div className="grid g2">
        <Panel title="Largest suppliers" note="By reported award value. Values are missing for many awards, so rankings by value are indicative.">
          <Table rows={data.top_suppliers} limit={15} cols={[
            { key: 'name', label: 'Supplier', render: (r) => <SupplierLink id={r.supplier_key} name={r.name} /> },
            { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
            { key: 'lots', label: 'Lots', num: true, render: (r) => lots(r.lots) },
            { key: 'buyers', label: 'Buyers', num: true },
          ]} />
        </Panel>
        <Panel title="Largest buyers" note="By reported award value.">
          <Table rows={data.top_buyers} limit={15} cols={[
            { key: 'name', label: 'Buyer', render: (r) => <><BuyerLink id={r.buyer_id} name={r.name} /><span className="sub">{r.kind}</span></> },
            { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
            { key: 'lots', label: 'Lots', num: true, render: (r) => lots(r.lots) },
            { key: 'suppliers', label: 'Suppliers', num: true },
          ]} />
        </Panel>
      </div>

      <Panel title="Buyers by type" note={<>Types are derived from names and TenderNed classifications. <Link to="/buyers">Browse all buyers</Link>.</>}>
        <Table rows={data.by_kind} cols={[
          { key: 'kind', label: 'Type', render: (r) => <Link to={`/buyers?kind=${encodeURIComponent(r.kind)}`}>{r.kind}</Link> },
          { key: 'buyers', label: 'Buyers', num: true },
          { key: 'lots', label: 'Awarded lots', num: true, render: (r) => lots(r.lots) },
          { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
        ]} />
      </Panel>
    </div>
  )
}
