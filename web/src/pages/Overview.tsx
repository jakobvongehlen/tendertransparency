import { useState } from 'react'
import { useApi, type Row } from '../api'
import { useMeta } from '../App'
import { compact, eur, lots, num, pct } from '../format'
import { Chart, axisCat, axisVal, base, useTokens } from '../components/Chart'
import { BuyerLink, Loading, Panel, Stats, SupplierLink, Table, StaleNotice } from '../components/ui'
import { Link, useSearchParams } from 'react-router-dom'

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
  const [sp, setSp] = useSearchParams()
  const division = sp.get('division') ?? ''
  const setDivision = (v: string) => {
    const n = new URLSearchParams(sp)
    if (v) n.set('division', v); else n.delete('division')
    setSp(n, { replace: true })
  }
  const { data, error, loading, retry } = useApi('overview', { year_from: range[0], year_to: range[1], division })
  const label = meta?.divisions.find((d) => d.division === division)?.label
  const scope = label ? ` in ${label.toLowerCase()}` : ''
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

  // keep the selected category visible even when it is not among the largest
  const top = data.by_division.slice(0, 14)
  const picked = data.by_division.find((r: Row) => r.division === division)
  const divs = (picked && !top.includes(picked) ? [...top.slice(0, 13), picked] : top).reverse()
  const divOption = {
    ...base(t),
    tooltip: { ...(base(t).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p: any) => { const r = divs[p[0].dataIndex]; return `<b>${r.label}</b><br/>${lots(r.lots)} lots · ${num(r.suppliers)} suppliers · ${eur(r.value)} reported` } },
    xAxis: { type: 'value', ...axisVal(t) },
    yAxis: { type: 'category', data: divs.map((r: Row) => r.label), ...axisCat(t), axisLabel: { color: t.ink2, fontSize: 12, width: 190, overflow: 'truncate' } },
    series: [{ type: 'bar', barMaxWidth: 16, cursor: 'pointer',
      data: divs.map((r: Row) => ({ value: Math.round(r.lots), division: r.division,
        itemStyle: { color: !division || r.division === division ? t.s1 : t.peer } })),
      itemStyle: { borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: t.ink2, fontSize: 11, formatter: (p: any) => compact(p.value) } }],
  }

  return (
    <div className={`page ${loading ? 'stale' : ''}`}>
      <div className="page-head">
        <h1>Who wins public contracts in the Netherlands</h1>
        <p className="lede">
          Procurement notices published on TenderNed since 2016, with buyers, winning suppliers and whether an outcome was
          published. A concentrated pattern can have ordinary causes and is not evidence of wrongdoing.
        </p>
      </div>

      <div className="filters">
        <label>Category
          <select value={division} onChange={(e) => setDivision(e.target.value)}>
            <option value="">All categories</option>
            {meta?.divisions.map((d) => <option key={d.division} value={d.division}>{d.division} · {d.label}</option>)}
          </select>
        </label>
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

      <StaleNotice error={data ? error : null} retry={retry} />
      <Stats items={[
        { label: 'Procedures', value: num(k.procedures), note: `${num(k.awarded_procedures)} with a published award` },
        { label: 'Awarded lots', value: compact(k.lots), note: 'each lot counts once, shared between winners' },
        { label: 'Buyers awarding', value: num(k.buyers) },
        { label: 'Winning suppliers', value: num(k.suppliers) },
        { label: 'Reported award value', value: eur(k.value_known), note: `known for ${pct(k.value_coverage)} of lots` },
        { label: 'No award found', value: pct(k.no_award_found / k.closed_procedures), note: `${num(k.no_award_found)} closed procedures`, },
      ]} />

      <div className="grid g2">
        <Panel title={`Procedures${scope} by year and outcome`} note="By year of first notice. Procedures from the last 12 months are not yet judged.">
          <Chart option={yearOption as any} height={300} table={
            <Table rows={data.by_year} cols={[{ key: 'year', label: 'Year' }, ...STATUS.map((s) => ({ key: s.key, label: s.label, num: true, render: (r: Row) => num(r[s.key]) }))]} limit={20} />
          } />
        </Panel>
        <Panel title="What is bought" note={division
          ? <>Awarded lots by CPV division; {label?.toLowerCase()} highlighted. Click a bar to switch category, or <button className="link" onClick={() => setDivision('')}>show all categories</button>.</>
          : 'Awarded lots by CPV division, top 14. Click a bar to focus the page on that category.'}>
          <Chart option={divOption as any} height={300} onEvents={{ click: (p: any) => p.data?.division && setDivision(p.data.division === division ? '' : p.data.division) }} table={
            <Table rows={data.by_division} cols={[
              { key: 'label', label: 'Category', render: (r) => <button className="link" onClick={() => setDivision(r.division)}>{r.label}</button> },
              { key: 'lots', label: 'Lots', num: true, render: (r) => lots(r.lots) },
              { key: 'suppliers', label: 'Suppliers', num: true, render: (r) => num(r.suppliers) },
              { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
            ]} initialSort={{ key: 'lots', dir: -1 }} />
          } />
        </Panel>
      </div>

      <div className="grid g2">
        <Panel title={`Largest suppliers${scope}`} note="By reported award value. Values are missing for many awards, so rankings by value are indicative.">
          <Table rows={data.top_suppliers} limit={15} cols={[
            { key: 'name', label: 'Supplier', render: (r) => <SupplierLink id={r.supplier_key} name={r.name} /> },
            { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
            { key: 'lots', label: 'Lots', num: true, render: (r) => lots(r.lots) },
            { key: 'buyers', label: 'Buyers', num: true },
          ]} />
        </Panel>
        <Panel title={`Largest buyers${scope}`} note="By reported award value.">
          <Table rows={data.top_buyers} limit={15} cols={[
            { key: 'name', label: 'Buyer', render: (r) => <><BuyerLink id={r.buyer_id} name={r.name} /><span className="sub">{r.kind}</span></> },
            { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
            { key: 'lots', label: 'Lots', num: true, render: (r) => lots(r.lots) },
            { key: 'suppliers', label: 'Suppliers', num: true },
          ]} />
        </Panel>
      </div>

      <Panel title={`Buyers by type${scope}`} note={<>Types are derived from names and TenderNed classifications. <Link to="/buyers">Browse all buyers</Link>.</>}>
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
