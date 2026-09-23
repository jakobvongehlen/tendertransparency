import { useParams } from 'react-router-dom'
import { useApi } from '../api'
import { eur, num } from '../format'
import { BuyerLink, Loading, NoticeLink, Panel, Stats, SupplierLink, Table } from '../components/ui'

const STATUS: Record<string, string> = {
  awarded: 'Award published', no_award_found: 'No award found', terminated: 'Stopped early', recent: 'Too recent to judge',
  market_consultation: 'Market consultation', prior_information: 'Prior information notice', other: 'Other',
}

export default function Procedure() {
  const { ocid = '' } = useParams()
  const { data, error } = useApi(`procedures/${encodeURIComponent(ocid)}`)
  if (!data) return <div className="page"><Loading error={error} /></div>
  const p = data.procedure
  return (
    <div className="page">
      <div className="page-head">
        <h1>{p.title}</h1>
        <p className="kicker"><BuyerLink id={p.buyer_id} name={p.buyer_name} /> · {p.procedure ?? 'procedure type unknown'} · {p.scope === 'Europees' ? 'EU threshold' : 'National'}</p>
      </div>
      <Stats items={[
        { label: 'Outcome', value: STATUS[p.status] ?? p.status },
        { label: 'First notice', value: p.first_published },
        { label: 'Category', value: p.cpv_label ?? '–', note: p.cpv },
        { label: 'Estimated value', value: eur(p.est_value) },
        { label: 'Notices', value: num(p.n_notices) },
      ]} />
      <Panel title="Notices" note="All notices linked to this procedure, including award notices that TenderNed published under a separate reference.">
        <Table rows={data.notices} limit={50} cols={[
          { key: 'published', label: 'Published' },
          { key: 'notice_label', label: 'Type' },
          { key: 'title', label: 'Title' },
          { key: 'notice_id', label: 'Source', render: (r) => <NoticeLink id={r.notice_id}>Notice {r.notice_id}</NoticeLink> },
        ]} />
      </Panel>
      <Panel title="Awards">
        <Table rows={data.awards} limit={50} empty="No award published for this procedure." cols={[
          { key: 'lot_id', label: 'Lot', render: (r) => <>{r.lot_id}{r.lot_title && <span className="sub">{r.lot_title}</span>}</> },
          { key: 'supplier_name', label: 'Supplier', render: (r) => <SupplierLink id={r.supplier_key} name={r.supplier_name} /> },
          { key: 'value', label: 'Reported value', num: true, render: (r) => eur(r.value) },
          { key: 'max_value', label: 'Maximum value', num: true, render: (r) => eur(r.max_value) },
        ]} />
      </Panel>
      {data.bids.length > 0 && (
        <Panel title="Competition" note="As reported in the award notice.">
          <Table rows={data.bids} cols={[
            { key: 'lot_id', label: 'Lot' },
            { key: 'requests', label: 'Requests / tenders received', num: true },
            { key: 'bids', label: 'Electronic tenders', num: true },
            { key: 'lowest_bid', label: 'Lowest valid tender', num: true, render: (r) => eur(r.lowest_bid) },
            { key: 'highest_bid', label: 'Highest valid tender', num: true, render: (r) => eur(r.highest_bid) },
          ]} />
        </Panel>
      )}
    </div>
  )
}
