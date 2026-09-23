import { useNavigate } from 'react-router-dom'
import { useApi, type Row } from '../api'
import { lots } from '../format'
import { Chart, base, useTokens } from './Chart'
import { Loading, Table, BuyerLink, SupplierLink } from './ui'

/**
 * Two-hop relationship network. Centre = the profile's buyer or supplier; hop 1 =
 * its counterparties; hop 2 = the counterparties' other main relations.
 */
export function Network({ buyerId, supplierKey, division }: { buyerId?: string; supplierKey?: string; division?: string }) {
  const t = useTokens()
  const nav = useNavigate()
  const { data, error } = useApi<{ nodes: Row[]; links: Row[] }>('network', {
    buyer_id: buyerId, supplier_key: supplierKey, division,
  })
  if (!data) return <Loading error={error} />
  if (!data.nodes.length) return <p className="muted small">No awards with identified suppliers.</p>
  const centre = buyerId ? 'b:' + buyerId : 's:' + supplierKey
  const weight: Record<string, number> = {}
  data.links.forEach((l) => {
    weight[l.source] = (weight[l.source] ?? 0) + l.w
    weight[l.target] = (weight[l.target] ?? 0) + l.w
  })
  const maxW = Math.max(...data.links.map((l) => l.w), 1)
  const nodes = data.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    category: n.type === 'buyer' ? 0 : 1,
    symbolSize: n.id === centre ? 26 : 8 + Math.min(14, Math.sqrt(weight[n.id] ?? 1) * 2),
    itemStyle: { borderColor: t.surface, borderWidth: 2 },
    label: { show: n.id === centre || (weight[n.id] ?? 0) >= maxW * 0.5, color: t.ink2, fontSize: 11, position: 'right' as const },
    value: n,
  }))
  const links = data.links.map((l) => ({
    source: l.source, target: l.target,
    lineStyle: { width: 0.6 + (l.w / maxW) * 4, color: l.hop === 1 ? t.muted : t.hair, opacity: l.hop === 1 ? 0.7 : 0.5 },
    value: l.w,
  }))
  const option = {
    ...base(t),
    tooltip: {
      ...(base(t).tooltip as object),
      formatter: (p: any) =>
        p.dataType === 'edge'
          ? `${lots(p.data.value)} awarded lots`
          : `<b>${p.data.name}</b><br/>${p.data.value.type === 'buyer' ? p.data.value.kind ?? 'Buyer' : 'Supplier'}`,
    },
    legend: [{ data: ['Buyers', 'Suppliers'], textStyle: { color: t.ink2 }, icon: 'circle', top: 0, left: 0 }],
    series: [{
      type: 'graph', layout: 'force', roam: true, draggable: true,
      force: { repulsion: 90, edgeLength: [30, 110], gravity: 0.08 },
      categories: [{ name: 'Buyers', itemStyle: { color: t.s1 } }, { name: 'Suppliers', itemStyle: { color: t.s2 } }],
      data: nodes, links,
      emphasis: { focus: 'adjacency', label: { show: true } },
      top: 30,
    }],
  }
  const onEvents = {
    click: (p: any) => {
      if (p.dataType !== 'node' || p.data.id === centre) return
      const n = p.data.value
      nav(n.type === 'buyer' ? `/buyers/${encodeURIComponent(n.ref)}` : `/suppliers/${encodeURIComponent(n.ref)}`)
    },
  }
  const byId = Object.fromEntries(data.nodes.map((n) => [n.id, n]))
  const table = (
    <Table
      rows={data.links.map((l) => ({ ...l, b: byId[l.source], s: byId[l.target] }))}
      cols={[
        { key: 'b', label: 'Buyer', render: (r) => <BuyerLink id={r.b.ref} name={r.b.name} />, sort: (r) => r.b.name },
        { key: 's', label: 'Supplier', render: (r) => <SupplierLink id={r.s.ref} name={r.s.name} />, sort: (r) => r.s.name },
        { key: 'w', label: 'Awarded lots', num: true, render: (r) => lots(r.w) },
      ]}
      initialSort={{ key: 'w', dir: -1 }}
    />
  )
  return (
    <>
      <Chart option={option as any} height={440} onEvents={onEvents} table={table} />
      <p className="small muted">
        Line width = awarded lots between the two parties. Click a node to open its profile; drag to rearrange, scroll to zoom.
      </p>
    </>
  )
}
