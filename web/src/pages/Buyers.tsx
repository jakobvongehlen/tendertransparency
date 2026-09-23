import { useSearchParams } from 'react-router-dom'
import { useApi } from '../api'
import { useMeta } from '../App'
import { bandLabel, eur, lots, num } from '../format'
import { BuyerLink, Loading, Panel, Table } from '../components/ui'

export default function Buyers() {
  const meta = useMeta()
  const [sp, setSp] = useSearchParams()
  const kind = sp.get('kind') ?? ''
  const province = sp.get('province') ?? ''
  const size = sp.get('size_band') ?? ''
  const q = sp.get('q') ?? ''
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp)
    if (v) n.set(k, v); else n.delete(k)
    if (k === 'kind') n.delete('size_band')
    setSp(n, { replace: true })
  }
  const { data, error, loading } = useApi('buyers', { kind, province, size_band: size, q, limit: 500 })
  const bands = meta?.size_bands.find((b) => b.kind === kind)?.bands ?? []

  return (
    <div className="page">
      <div className="page-head">
        <h1>Buyers</h1>
        <p className="lede">Public bodies that published procedures on TenderNed. Municipal departments are counted with their municipality.</p>
      </div>
      <div className="filters">
        <label>Type
          <select value={kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="">All types</option>
            {meta?.kinds.map((k) => <option key={k.kind} value={k.kind}>{k.kind} ({k.n})</option>)}
          </select>
        </label>
        <label>Province
          <select value={province} onChange={(e) => set('province', e.target.value)}>
            <option value="">All provinces</option>
            {meta?.provinces.map((p) => <option key={p}>{p}</option>)}
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
        <label>Name
          <input type="text" defaultValue={q} placeholder="Filter by name" onChange={(e) => set('q', e.target.value)} />
        </label>
      </div>
      <Panel title={data ? `${num(data.total)} buyers` : 'Buyers'} className={loading ? 'stale' : ''}>
        {!data ? <Loading error={error} /> : (
          <Table rows={data.rows} limit={50} rowKey={(r) => r.buyer_id} cols={[
            { key: 'name', label: 'Buyer', render: (r) => <BuyerLink id={r.buyer_id} name={r.name} /> },
            { key: 'kind', label: 'Type' },
            { key: 'province', label: 'Province' },
            { key: 'size_band', label: 'Size', render: (r) => bandLabel(r.size_band) },
            { key: 'n_procedures', label: 'Procedures', num: true, render: (r) => num(r.n_procedures) },
            { key: 'lots', label: 'Awarded lots', num: true, render: (r) => lots(r.lots) },
            { key: 'suppliers', label: 'Suppliers', num: true, render: (r) => num(r.suppliers) },
            { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
            { key: 'n_flags', label: 'Unusual patterns', num: true, title: 'Category-periods where the top-supplier share is well above comparable buyers',
              render: (r) => r.n_flags ? <span className="badge unusual"><i />{r.n_flags}</span> : <span className="muted">–</span> },
          ]} />
        )}
      </Panel>
    </div>
  )
}
