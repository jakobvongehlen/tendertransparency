/**
 * Browser port of api/main.py for the static build. Same endpoints, same SQL, same JSON shapes:
 * route(path, params) is what getJSON() calls instead of fetch('/api/...').
 * Keep this in sync with api/main.py when queries change.
 */
import { DATA, ensure, lit, one, q, type Row } from './db'

const NOTICE_URL = 'https://www.tenderned.nl/aankondigingen/overzicht/'

class HttpError extends Error {
  constructor(status: number, msg: string) { super(`${status} ${msg}`) }
}

const COMP_COLS = `cs.n_bid_lots, cs.n_single, cs.single_bid_rate, cs.avg_bids, cs.direct_share, cs.n_direct,
               cs.bid_coverage, cs.local_share, cs.n_bid_peers, cs.peer_median_single_bid, cs.peer_p75_single_bid,
               cs.peer_median_avg_bids, cs.peer_median_direct_share, coalesce(cs.few_bidders, false) AS few_bidders`

type P = Record<string, string | undefined>
const int = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : parseInt(v, 10))
const optInt = (v: string | undefined) => (v === undefined || v === '' ? null : parseInt(v, 10))
const str = (v: string | undefined, d = '') => (v === undefined ? d : v)
const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === 'true' || v === '1')
const years = (y0: number | null, y1: number | null) => [y0 ?? 2000, y1 ?? 2100]

// ------------------------------------------------------------------ meta
async function meta() {
  await ensure(['data_cutoff', 'cpv_divisions', 'periods', 'buyers', 'awards'])
  return {
    cutoff: (await one('SELECT cutoff FROM data_cutoff'))!.cutoff,
    notice_url: NOTICE_URL,
    divisions: await q('SELECT division, label FROM cpv_divisions ORDER BY division'),
    periods: (await q('SELECT period FROM periods ORDER BY y0')).map((r) => r.period),
    kinds: await q('SELECT kind, count(*) AS n FROM buyers GROUP BY 1 ORDER BY 2 DESC'),
    size_bands: await q('SELECT kind, list(DISTINCT size_band ORDER BY size_band) AS bands FROM buyers GROUP BY 1'),
    provinces: (await q('SELECT DISTINCT province FROM buyers WHERE province IS NOT NULL ORDER BY 1')).map((r) => r.province),
    year_range: await one('SELECT min(year) AS y0, max(year) AS y1 FROM awards'),
  }
}

async function search(p: P) {
  const term = str(p.q)
  if (term.length < 2) throw new HttpError(422, 'q must be at least 2 characters')
  const limit = int(p.limit, 12)
  await ensure(['buyers', 'buyer_activity', 'suppliers', 'edges'])
  const like = `%${term}%`
  return {
    buyers: await q(
      `SELECT b.buyer_id, b.name, b.kind, b.locality, coalesce(a.n_procedures, 0) AS n_procedures
       FROM buyers b LEFT JOIN buyer_activity a USING (buyer_id)
       WHERE b.name ILIKE ? OR b.buyer_id = ? ORDER BY n_procedures DESC LIMIT ?`,
      [like, term, limit],
    ),
    suppliers: await q(
      `SELECT s.supplier_key, s.name, s.kvk, s.locality, sum(e.w) AS lots
       FROM suppliers s JOIN edges e USING (supplier_key)
       WHERE s.name ILIKE ? OR s.kvk = ? GROUP BY ALL ORDER BY lots DESC LIMIT ?`,
      [like, term.padStart(8, '0'), limit],
    ),
  }
}

// ------------------------------------------------------------------ overview
async function overview(p: P) {
  const y = years(optInt(p.year_from), optInt(p.year_to))
  const division = str(p.division)
  const d = [division, division]
  const df = "AND (? = '' OR division = ?)"
  await ensure(['awards', 'procedures', 'cpv_divisions', 'buyers', 'suppliers'])
  const kpis = await one(
    `WITH a AS (SELECT * FROM awards WHERE year BETWEEN ? AND ? ${df}),
          p AS (SELECT * FROM procedures WHERE year(first_published) BETWEEN ? AND ? ${df})
     SELECT (SELECT count(*) FROM p) AS procedures,
            (SELECT count(*) FROM p WHERE status = 'awarded') AS awarded_procedures,
            (SELECT count(*) FROM p WHERE status = 'no_award_found') AS no_award_found,
            (SELECT count(*) FROM p WHERE status IN ('awarded','no_award_found','terminated')) AS closed_procedures,
            (SELECT sum(weight) FROM a) AS lots,
            (SELECT count(DISTINCT buyer_id) FROM a) AS buyers,
            (SELECT count(DISTINCT supplier_key) FROM a) AS suppliers,
            (SELECT sum(value) FROM a) AS value_known,
            (SELECT sum(weight * (value IS NOT NULL)::INT) / sum(weight) FROM a) AS value_coverage`,
    [...y, ...d, ...y, ...d],
  )
  const by_year = await q(
    `WITH p AS (SELECT year(first_published) AS year, status FROM procedures
                WHERE year(first_published) BETWEEN ? AND ? ${df}),
          a AS (SELECT year, sum(weight) AS lots, sum(value) AS value, count(DISTINCT supplier_key) AS suppliers
                FROM awards WHERE year BETWEEN ? AND ? ${df} GROUP BY 1)
     SELECT p.year, count(*) AS procedures,
            count(*) FILTER (status = 'awarded') AS awarded,
            count(*) FILTER (status = 'no_award_found') AS no_award_found,
            count(*) FILTER (status = 'terminated') AS terminated,
            count(*) FILTER (status = 'recent') AS recent,
            any_value(a.lots) AS lots, any_value(a.value) AS value, any_value(a.suppliers) AS suppliers
     FROM p LEFT JOIN a USING (year) GROUP BY 1 ORDER BY 1`,
    [...y, ...d, ...y, ...d],
  )
  const by_division = await q(
    `SELECT a.division, d.label, sum(weight) AS lots, sum(value) AS value,
            count(DISTINCT supplier_key) AS suppliers, count(DISTINCT buyer_id) AS buyers
     FROM awards a JOIN cpv_divisions d USING (division)
     WHERE year BETWEEN ? AND ? GROUP BY ALL ORDER BY lots DESC`,
    y,
  )
  const by_kind = await q(
    `SELECT b.kind, count(DISTINCT a.buyer_id) AS buyers, sum(weight) AS lots, sum(value) AS value
     FROM awards a JOIN buyers b USING (buyer_id) WHERE year BETWEEN ? AND ? ${df} GROUP BY 1 ORDER BY lots DESC`,
    [...y, ...d],
  )
  const top_suppliers = await q(
    `SELECT a.supplier_key, s.name, sum(weight) AS lots, sum(value) AS value, count(DISTINCT a.buyer_id) AS buyers
     FROM awards a JOIN suppliers s USING (supplier_key) WHERE year BETWEEN ? AND ? ${df}
     GROUP BY ALL ORDER BY value DESC NULLS LAST LIMIT 15`,
    [...y, ...d],
  )
  const top_buyers = await q(
    `SELECT a.buyer_id, b.name, b.kind, sum(weight) AS lots, sum(value) AS value, count(DISTINCT supplier_key) AS suppliers
     FROM awards a JOIN buyers b USING (buyer_id) WHERE year BETWEEN ? AND ? ${df}
     GROUP BY ALL ORDER BY value DESC NULLS LAST LIMIT 15`,
    [...y, ...d],
  )
  return { kpis, by_year, by_division, by_kind, top_suppliers, top_buyers }
}

// ------------------------------------------------------------------ buyers
async function buyers(p: P) {
  const where = ['1=1']
  const params: unknown[] = []
  for (const col of ['kind', 'province', 'size_band'] as const) {
    if (p[col]) { where.push(`b.${col} = ?`); params.push(p[col]) }
  }
  if (p.q) { where.push('b.name ILIKE ?'); params.push(`%${p.q}%`) }
  const w = where.join(' AND ')
  await ensure(['buyers', 'buyer_activity', 'edges', 'flags'])
  const rows = await q(
    `SELECT b.buyer_id, b.name, b.kind, b.province, b.size_band, b.population,
            coalesce(ba.n_procedures, 0) AS n_procedures, e.lots, e.value, e.suppliers,
            (SELECT count(*) FROM flags f WHERE f.buyer_id = b.buyer_id AND f.unusual AND f.period <> 'all') AS n_flags
     FROM buyers b
     LEFT JOIN buyer_activity ba USING (buyer_id)
     LEFT JOIN (SELECT buyer_id, sum(w) AS lots, sum(value) AS value, count(*) AS suppliers FROM edges GROUP BY 1) e USING (buyer_id)
     WHERE ${w} ORDER BY n_procedures DESC LIMIT ? OFFSET ?`,
    [...params, int(p.limit, 100), int(p.offset, 0)],
  )
  const total = (await one(`SELECT count(*) AS n FROM buyers b WHERE ${w}`, params))!.n
  return { total, rows }
}

async function buyer(buyerId: string, p: P) {
  const period = str(p.period, 'all')
  await ensure(['buyers', 'procedures', 'awards', 'concentration', 'cpv_divisions', 'suppliers', 'flags',
    'competition_scores', 'edges', 'persistence'])
  const b = await one('SELECT * FROM buyers WHERE buyer_id = ?', [buyerId])
  if (!b) throw new HttpError(404, 'buyer not found')
  const kpis = await one(
    `SELECT (SELECT count(*) FROM procedures WHERE buyer_id = $1) AS procedures,
            (SELECT count(*) FROM procedures WHERE buyer_id = $1 AND status = 'no_award_found') AS no_award_found,
            (SELECT count(*) FROM procedures WHERE buyer_id = $1 AND status IN ('awarded','no_award_found','terminated')) AS closed,
            (SELECT sum(weight) FROM awards WHERE buyer_id = $1) AS lots,
            (SELECT sum(value) FROM awards WHERE buyer_id = $1) AS value_known,
            (SELECT sum(weight * (value IS NOT NULL)::INT) / sum(weight) FROM awards WHERE buyer_id = $1) AS value_coverage,
            (SELECT count(DISTINCT supplier_key) FROM awards WHERE buyer_id = $1) AS suppliers`,
    [buyerId],
  )
  const by_year = await q(
    `SELECT year(first_published) AS year, count(*) AS procedures,
            count(*) FILTER (status = 'awarded') AS awarded,
            count(*) FILTER (status = 'no_award_found') AS no_award_found,
            any_value(v.lots) AS lots, any_value(v.value) AS value
     FROM procedures p
     LEFT JOIN (SELECT year, sum(weight) AS lots, sum(value) AS value FROM awards WHERE buyer_id = $1 GROUP BY 1) v
       ON v.year = year(p.first_published)
     WHERE buyer_id = $1 GROUP BY 1 ORDER BY 1`,
    [buyerId],
  )
  const categories = await q(
    `SELECT c.division, d.label, c.n_lots, c.n_suppliers, c.n_procedures, c.top_share, c.hhi,
            c.top_supplier, s.name AS top_supplier_name, c.value_known, c.kvk_coverage, c.value_coverage,
            c.n_no_award, c.no_award_rate,
            f.n_peers, f.peer_median_top_share, f.peer_p75_top_share, f.peer_median_hhi, f.peer_median_suppliers, f.hhi_percentile,
            coalesce(f.comparability, 'fewer than 3 awards') AS comparability, coalesce(f.unusual, false) AS unusual,
            f.persistent_periods, ${COMP_COLS}
     FROM concentration c
     JOIN cpv_divisions d USING (division)
     LEFT JOIN suppliers s ON s.supplier_key = c.top_supplier
     LEFT JOIN flags f USING (buyer_id, division, period)
     LEFT JOIN competition_scores cs USING (buyer_id, division, period)
     WHERE c.buyer_id = ? AND c.period = ? ORDER BY c.n_lots DESC`,
    [buyerId, period],
  )
  const competition = await one(
    `SELECT * EXCLUDE (buyer_id, kind, size_band, province, municipality_code) FROM competition_scores
     WHERE buyer_id = ? AND division = '*' AND period = ?`,
    [buyerId, period],
  )
  const suppliers = await q(
    `SELECT e.supplier_key, s.name, s.locality, s.province, s.sme, e.w AS lots, e.n_procedures, e.value,
            e.first_year, e.last_year, e.divisions, e.w / sum(e.w) OVER () AS share
     FROM edges e JOIN suppliers s USING (supplier_key)
     WHERE e.buyer_id = ? ORDER BY e.w DESC LIMIT 50`,
    [buyerId],
  )
  const persistence = await q(
    `SELECT p.division, d.label, p.top_supplier, s.name AS supplier_name, p.n_periods, p.periods, p.avg_top_share, p.n_lots
     FROM persistence p JOIN cpv_divisions d USING (division) JOIN suppliers s ON s.supplier_key = p.top_supplier
     WHERE p.buyer_id = ? AND p.n_periods >= 2 ORDER BY p.n_periods DESC, p.n_lots DESC`,
    [buyerId],
  )
  return { buyer: b, kpis, by_year, categories, competition, suppliers, persistence, period }
}

async function buyerCell(buyerId: string, p: P) {
  const division = str(p.division)
  const period = str(p.period, 'all')
  await ensure(['periods', 'buyers', 'concentration', 'suppliers', 'flags', 'competition_scores', 'awards',
    'lot_competition', 'procedures'])
  const per = (await one('SELECT y0, y1 FROM periods WHERE period = ?', [period])) ?? { y0: 2000, y1: 2100 }
  const y = [per.y0, per.y1]
  const b = await one('SELECT buyer_id, name, kind, size_band, province FROM buyers WHERE buyer_id = ?', [buyerId])
  if (!b) throw new HttpError(404, 'buyer not found')
  const summary = await one(
    `SELECT c.n_lots, c.n_suppliers, c.n_procedures, c.top_share, c.hhi, c.top_supplier, s.name AS top_supplier_name,
            c.value_known, c.kvk_coverage, c.no_award_rate, c.n_no_award,
            f.n_peers, f.peer_median_top_share, f.peer_p75_top_share, f.hhi_percentile,
            coalesce(f.comparability, 'fewer than 3 awards') AS comparability, coalesce(f.unusual, false) AS unusual,
            f.persistent_periods, ${COMP_COLS}
     FROM concentration c
     LEFT JOIN suppliers s ON s.supplier_key = c.top_supplier
     LEFT JOIN flags f USING (buyer_id, division, period)
     LEFT JOIN competition_scores cs USING (buyer_id, division, period)
     WHERE c.buyer_id = ? AND c.division = ? AND c.period = ?`,
    [buyerId, division, period],
  )
  const lotsSql = `
     SELECT a.ocid, a.notice_id, a.published, a.year, a.title, a.lot_id, a.lot_title, a.procedure, a.scope,
            a.supplier_key, s.name AS supplier_name, s.locality AS supplier_locality, a.value, a.weight,
            a.n_lot_suppliers, l.n_bids, coalesce(l.no_publication, false) AS no_publication,
            (a.n_lot_suppliers > 1 OR a.title ILIKE '%raamovereenkomst%' OR a.title ILIKE '%raamcontract%'
             OR a.title ILIKE '%framework%') AS framework
     FROM awards a JOIN suppliers s USING (supplier_key)
     LEFT JOIN lot_competition l USING (ocid, lot_id)
     WHERE a.buyer_id = ? AND a.division = ? AND a.year BETWEEN ? AND ?`
  const params = [buyerId, division, ...y]
  const suppliers = await q(
    `WITH x AS (${lotsSql})
     SELECT supplier_key, any_value(supplier_name) AS name, any_value(supplier_locality) AS locality,
            sum(weight) AS lots, sum(weight) / sum(sum(weight)) OVER () AS share,
            count(DISTINCT ocid) AS procedures, sum(value) AS value,
            min(year) AS first_year, max(year) AS last_year,
            count(*) FILTER (n_bids = 1 AND NOT no_publication) AS single_bid_lots,
            count(*) FILTER (n_bids IS NOT NULL AND NOT no_publication) AS bid_lots,
            count(*) FILTER (no_publication) AS no_publication_lots,
            count(*) FILTER (framework) AS framework_lots,
            avg(least(n_bids, 20)) FILTER (n_bids IS NOT NULL AND NOT no_publication) AS avg_bids
     FROM x GROUP BY 1 ORDER BY lots DESC, value DESC NULLS LAST`,
    params,
  )
  const by_year = await q(
    `WITH x AS (${lotsSql}) SELECT year, supplier_key, sum(weight) AS lots FROM x GROUP BY ALL ORDER BY 1`,
    params,
  )
  const lots = await q(`${lotsSql} ORDER BY a.published DESC, a.ocid, a.lot_id LIMIT 500`, params)
  const gaps = await q(
    `SELECT ocid, title, procedure, scope, first_published, last_notice_id
     FROM procedures WHERE buyer_id = ? AND division = ? AND status = 'no_award_found'
       AND year(first_published) BETWEEN ? AND ?
     ORDER BY first_published DESC LIMIT 100`,
    params,
  )
  return { buyer: b, division, period, summary, suppliers, by_year, lots, gaps }
}

async function buyerAwards(buyerId: string, p: P) {
  const where = ['a.buyer_id = ?']
  const params: unknown[] = [buyerId]
  if (p.division) { where.push('a.division = ?'); params.push(p.division) }
  if (p.supplier_key) { where.push('a.supplier_key = ?'); params.push(p.supplier_key) }
  await ensure(['awards', 'suppliers'])
  return q(
    `SELECT a.ocid, a.notice_id, a.published, a.title, a.lot_id, a.lot_title, a.division, a.cpv, a.procedure,
            a.supplier_key, s.name AS supplier_name, a.value, a.max_value, a.weight, a.n_lot_suppliers
     FROM awards a JOIN suppliers s USING (supplier_key)
     WHERE ${where.join(' AND ')} ORDER BY a.published DESC LIMIT ?`,
    [...params, int(p.limit, 200)],
  )
}

async function buyerGaps(buyerId: string, p: P) {
  await ensure(['procedures'])
  return q(
    `SELECT ocid, title, division, procedure, scope, first_published, contract_notice_id, last_notice_id, n_notices
     FROM procedures WHERE buyer_id = ? AND status = 'no_award_found' ORDER BY first_published DESC LIMIT ?`,
    [buyerId, int(p.limit, 200)],
  )
}

// ------------------------------------------------------------------ suppliers
async function supplier(key: string) {
  await ensure(['suppliers', 'awards', 'cpv_divisions', 'buyer_supplier_cells', 'buyers', 'concentration', 'flags'])
  const s = await one('SELECT * FROM suppliers WHERE supplier_key = ?', [key])
  if (!s) throw new HttpError(404, 'supplier not found')
  const kpis = await one(
    `SELECT sum(weight) AS lots, count(DISTINCT ocid) AS procedures, count(DISTINCT buyer_id) AS buyers,
            sum(value) AS value_known, sum(weight * (value IS NOT NULL)::INT) / sum(weight) AS value_coverage,
            min(year) AS first_year, max(year) AS last_year
     FROM awards WHERE supplier_key = ?`,
    [key],
  )
  const by_year = await q(
    `SELECT year, sum(weight) AS lots, sum(value) AS value, count(DISTINCT buyer_id) AS buyers
     FROM awards WHERE supplier_key = ? GROUP BY 1 ORDER BY 1`,
    [key],
  )
  const divisions = await q(
    `SELECT a.division, d.label, sum(weight) AS lots, sum(value) AS value, count(DISTINCT buyer_id) AS buyers
     FROM awards a JOIN cpv_divisions d USING (division) WHERE supplier_key = ? GROUP BY ALL ORDER BY lots DESC`,
    [key],
  )
  const buyers_ = await q(
    `WITH mine AS (
       SELECT buyer_id, division, w, value FROM buyer_supplier_cells WHERE supplier_key = $1 AND period = 'all'
     )
     SELECT m.buyer_id, b.name, b.kind, b.province, m.division, d.label, m.w AS lots, m.value,
            c.n_lots AS buyer_lots, m.w / c.n_lots AS share_of_buyer, c.n_suppliers AS buyer_suppliers,
            f.peer_median_top_share, f.comparability
     FROM mine m JOIN buyers b USING (buyer_id) JOIN cpv_divisions d USING (division)
     JOIN concentration c ON c.buyer_id = m.buyer_id AND c.division = m.division AND c.period = 'all'
     LEFT JOIN flags f ON f.buyer_id = m.buyer_id AND f.division = m.division AND f.period = 'all'
     ORDER BY m.w DESC LIMIT 100`,
    [key],
  )
  const awards = await q(
    `SELECT a.ocid, a.notice_id, a.published, a.title, a.lot_title, a.division, a.procedure, a.buyer_id,
            b.name AS buyer_name, a.value, a.max_value, a.weight, a.n_lot_suppliers
     FROM awards a JOIN buyers b USING (buyer_id) WHERE supplier_key = ? ORDER BY published DESC LIMIT 200`,
    [key],
  )
  return { supplier: s, kpis, by_year, divisions, buyers: buyers_, awards }
}

// ------------------------------------------------------------------ network
async function network(p: P) {
  const buyerId = p.buyer_id || null
  const supplierKey = p.supplier_key || null
  const division = p.division || null
  const first = int(p.first, 20)
  const second = int(p.second, 6)
  if (!(buyerId || supplierKey)) throw new HttpError(400, 'buyer_id or supplier_key required')
  await ensure(['edges', 'buyers', 'suppliers'])
  const div = division ? 'AND ? = ANY(divisions)' : ''
  const dp = division ? [division] : []
  let hop1: Row[], hop2: Row[]
  if (buyerId) {
    hop1 = await q(`SELECT * FROM edges WHERE buyer_id = ? ${div} ORDER BY w DESC LIMIT ?`, [buyerId, ...dp, first])
    const keys = hop1.map((e) => e.supplier_key)
    hop2 = keys.length ? await q(
      `SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY supplier_key ORDER BY w DESC) rn
       FROM edges WHERE supplier_key IN (${keys.map(lit).join(',')}) AND buyer_id <> ? ${div}) WHERE rn <= ?`,
      [buyerId, ...dp, second],
    ) : []
  } else {
    hop1 = await q(`SELECT * FROM edges WHERE supplier_key = ? ${div} ORDER BY w DESC LIMIT ?`, [supplierKey, ...dp, first])
    const keys = hop1.map((e) => e.buyer_id)
    hop2 = keys.length ? await q(
      `SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY buyer_id ORDER BY w DESC) rn
       FROM edges WHERE buyer_id IN (${keys.map(lit).join(',')}) AND supplier_key <> ? ${div}) WHERE rn <= ?`,
      [supplierKey, ...dp, second],
    ) : []
  }
  const edges = [...hop1, ...hop2]
  const bids = [...new Set(edges.map((e) => e.buyer_id))].sort()
  const sids = [...new Set(edges.map((e) => e.supplier_key))].sort()
  const nodes: Row[] = []
  if (bids.length) {
    for (const r of await q(`SELECT buyer_id, name, kind FROM buyers WHERE buyer_id IN (${bids.map(lit).join(',')})`))
      nodes.push({ id: 'b:' + r.buyer_id, ref: r.buyer_id, type: 'buyer', name: r.name, kind: r.kind })
  }
  if (sids.length) {
    for (const r of await q(`SELECT supplier_key, name FROM suppliers WHERE supplier_key IN (${sids.map(lit).join(',')})`))
      nodes.push({ id: 's:' + r.supplier_key, ref: r.supplier_key, type: 'supplier', name: r.name })
  }
  const links = edges.map((e, i) => ({
    source: 'b:' + e.buyer_id, target: 's:' + e.supplier_key, w: e.w, value: e.value,
    n_procedures: e.n_procedures, hop: i < hop1.length ? 1 : 2,
  }))
  return { nodes, links }
}

// ------------------------------------------------------------------ peers & concentration
async function peers(p: P) {
  const division = str(p.division)
  const period = str(p.period, '2022-2024')
  const kind = p.kind || null
  let sizeBand = p.size_band || null
  await ensure(['buyers', 'concentration', 'suppliers', 'flags', 'competition_scores'])
  if (kind && p.buyer_id && !sizeBand)
    sizeBand = (await one('SELECT size_band FROM buyers WHERE buyer_id = ?', [p.buyer_id]))?.size_band ?? null
  const where = ['c.division = ?', 'c.period = ?']
  const params: unknown[] = [division, period]
  if (kind) { where.push('c.kind = ?'); params.push(kind) }
  if (kind && sizeBand) { where.push('c.size_band = ?'); params.push(sizeBand) }
  const rows = await q(
    `SELECT c.buyer_id, b.name, b.kind, b.province, b.size_band, b.population, c.n_lots, c.n_suppliers, c.n_procedures,
            c.top_share, c.hhi, c.top_supplier, s.name AS top_supplier_name, c.value_known,
            c.kvk_coverage, c.value_coverage, c.n_no_award, c.no_award_rate,
            f.hhi_percentile, coalesce(f.comparability, 'fewer than 3 awards') AS comparability,
            coalesce(f.unusual, false) AS unusual, f.persistent_periods, ${COMP_COLS}
     FROM concentration c JOIN buyers b USING (buyer_id)
     LEFT JOIN suppliers s ON s.supplier_key = c.top_supplier
     LEFT JOIN flags f USING (buyer_id, division, period)
     LEFT JOIN competition_scores cs USING (buyer_id, division, period)
     WHERE ${where.join(' AND ')} ORDER BY c.n_lots DESC`,
    params,
  )
  const eligible = rows.filter((r) => r.n_lots >= 3)
  const tops = eligible.map((r) => r.top_share).sort((a, b) => a - b)
  const singles = rows.filter((r) => (r.n_bid_lots ?? 0) >= 5).map((r) => r.single_bid_rate).sort((a, b) => a - b)
  const summary = {
    n_buyers: rows.length,
    n_eligible: eligible.length,
    median_top_share: tops.length ? tops[Math.floor(tops.length / 2)] : null,
    n_bid_eligible: singles.length,
    median_single_bid: singles.length ? singles[Math.floor(singles.length / 2)] : null,
    size_band: sizeBand,
  }
  return { summary, rows }
}

async function flags(p: P) {
  const period = p.period || null
  const where = [period ? 'f.period = ?' : "f.period <> 'all'"]
  const params: unknown[] = period ? [period] : []
  for (const col of ['division', 'kind', 'province'] as const) {
    if (p[col]) { where.push(`f.${col} = ?`); params.push(p[col]) }
  }
  if (bool(p.only_unusual, true)) where.push('f.unusual')
  if (bool(p.persistent, false)) where.push('f.persistent_periods >= 2')
  await ensure(['flags', 'buyers', 'cpv_divisions', 'suppliers'])
  return q(
    `SELECT f.buyer_id, b.name AS buyer_name, f.kind, f.size_band, f.province, f.division, d.label, f.period,
            f.n_lots, f.n_suppliers, f.top_share, f.hhi, f.top_supplier, s.name AS top_supplier_name,
            f.n_peers, f.peer_median_top_share, f.peer_p75_top_share, f.peer_median_hhi, f.hhi_percentile, f.comparability, f.unusual,
            f.persistent_periods, f.kvk_coverage, f.value_coverage, f.no_award_rate, f.value_known,
            s.province AS supplier_province
     FROM flags f JOIN buyers b USING (buyer_id) JOIN cpv_divisions d USING (division)
     LEFT JOIN suppliers s ON s.supplier_key = f.top_supplier
     WHERE ${where.join(' AND ')}
     ORDER BY f.top_share - f.peer_median_top_share DESC, f.n_lots DESC LIMIT ?`,
    [...params, int(p.limit, 300)],
  )
}

async function distribution(p: P) {
  await ensure(['flags', 'buyers'])
  return q(
    `SELECT f.buyer_id, b.name, f.size_band, f.top_share, f.hhi, f.n_lots, f.unusual, f.comparability
     FROM flags f JOIN buyers b USING (buyer_id)
     WHERE f.division = ? AND f.period = ? AND f.kind = ? ORDER BY f.size_band, f.top_share`,
    [str(p.division), str(p.period, '2022-2024'), str(p.kind, 'Municipality')],
  )
}

// ------------------------------------------------------------------ competition
const LOT_FILTER = `FROM lot_competition l JOIN buyers b USING (buyer_id)
    WHERE (? = '' OR b.kind = ?) AND (? = '' OR l.division = ?)`

const LOT_METRICS = `count(*) AS lots,
    count(*) FILTER (NOT no_publication AND n_bids IS NOT NULL) AS bid_lots,
    avg((n_bids = 1)::INT) FILTER (NOT no_publication AND n_bids IS NOT NULL) AS single_bid_rate,
    avg(least(n_bids, 20)) FILTER (NOT no_publication AND n_bids IS NOT NULL) AS avg_bids,
    median(n_bids) FILTER (NOT no_publication AND n_bids IS NOT NULL) AS median_bids,
    avg(no_publication::INT) AS direct_share,
    count(*) FILTER (NOT no_publication AND n_bids IS NOT NULL) / nullif(count(*) FILTER (NOT no_publication), 0) AS bid_coverage`

async function competition(p: P) {
  const period = str(p.period, '2022-2024')
  const kind = str(p.kind)
  const division = str(p.division)
  const limit = int(p.limit, 400)
  await ensure(['periods', 'lot_competition', 'buyers', 'cpv_divisions', 'competition_scores', 'flags'])
  const f = [kind, kind, division, division]
  const per = (await one('SELECT y0, y1 FROM periods WHERE period = ?', [period])) ?? { y0: 2000, y1: 2100 }
  const py = [per.y0, per.y1]
  const summary = await one(`SELECT ${LOT_METRICS} ${LOT_FILTER} AND l.year BETWEEN ? AND ?`, [...f, ...py])
  const by_year = await q(`SELECT l.year, ${LOT_METRICS} ${LOT_FILTER} GROUP BY 1 ORDER BY 1`, f)
  const by_division = await q(
    `SELECT l.division, d.label, count(DISTINCT l.buyer_id) AS buyers, ${LOT_METRICS}
     ${LOT_FILTER.replace('USING (buyer_id)', 'USING (buyer_id) JOIN cpv_divisions d USING (division)')}
       AND l.year BETWEEN ? AND ?
     GROUP BY ALL HAVING bid_lots >= 30 ORDER BY lots DESC`,
    [...f, ...py],
  )
  const by_kind = await q(
    `SELECT b.kind, count(DISTINCT l.buyer_id) AS buyers, ${LOT_METRICS}
     ${LOT_FILTER} AND l.year BETWEEN ? AND ? GROUP BY 1 ORDER BY lots DESC`,
    [...f, ...py],
  )
  const histogram = await q(
    `SELECT least(n_bids, 10)::INT AS bids, count(*) AS lots
     ${LOT_FILTER} AND l.year BETWEEN ? AND ? AND NOT no_publication AND n_bids IS NOT NULL GROUP BY 1 ORDER BY 1`,
    [...f, ...py],
  )
  const buyers_ = await q(
    `SELECT cs.buyer_id, b.name, cs.kind, cs.size_band, cs.province, cs.n_lots, cs.n_bid_lots, cs.n_single,
            cs.single_bid_rate, cs.avg_bids, cs.direct_share, cs.n_direct, cs.bid_coverage, cs.n_bid_peers,
            cs.peer_median_single_bid, cs.peer_p75_single_bid, cs.peer_median_avg_bids, cs.peer_median_direct_share,
            cs.few_bidders, coalesce(f.unusual, false) AS unusual
     FROM competition_scores cs JOIN buyers b USING (buyer_id)
     LEFT JOIN flags f USING (buyer_id, division, period)
     WHERE cs.period = ? AND cs.division = ? AND (? = '' OR cs.kind = ?) AND cs.n_bid_lots >= 5
     ORDER BY cs.few_bidders DESC, cs.single_bid_rate - coalesce(cs.peer_median_single_bid, 0) DESC, cs.n_bid_lots DESC
     LIMIT ?`,
    [period, division || '*', kind, kind, limit],
  )
  const n_flagged = (await one(
    `SELECT count(*) AS n FROM competition_scores WHERE period = ? AND division = ? AND (? = '' OR kind = ?) AND few_bidders`,
    [period, division || '*', kind, kind],
  ))!.n
  return { summary, by_year, by_division, by_kind, histogram, buyers: buyers_, n_flagged }
}

// ------------------------------------------------------------------ map
let manifest: Promise<Row> | null = null // { built, boundary_year, tables }
const getManifest = () => (manifest ??= fetch(`${DATA}manifest.json`).then((r): Promise<Row> => (r.ok ? r.json() : Promise.resolve({}))))

async function boundaries() {
  const res = await fetch(`${DATA}municipalities.geojson`)
  if (!res.ok) throw new HttpError(404, 'municipal boundaries not exported')
  return res.json()
}

async function mapData(p: P) {
  const period = str(p.period, '2022-2024')
  const div = p.division || '*'
  await ensure(['flags', 'buyers', 'competition_scores', 'concentration'])
  const rows = await q(
    `WITH fl AS (
       SELECT buyer_id, count(*) FILTER (unusual) AS n_unusual FROM flags WHERE period = $1 GROUP BY 1
     )
     SELECT b.buyer_id, b.name, b.municipality_code AS code, b.population, b.size_band,
            cs.n_lots, cs.n_bid_lots, cs.single_bid_rate, cs.avg_bids, cs.direct_share, cs.local_share, cs.province_share,
            cs.no_award_rate, cs.n_closed, cs.few_bidders, cs.peer_median_single_bid,
            c.top_share, c.n_lots AS conc_lots, c.n_suppliers, f.unusual, f.comparability,
            coalesce(fl.n_unusual, 0) AS n_unusual,
            cs.n_lots / nullif(b.population, 0) * 10000 AS lots_per_10k
     FROM buyers b
     JOIN competition_scores cs ON cs.buyer_id = b.buyer_id AND cs.period = $1 AND cs.division = $2
     LEFT JOIN concentration c ON c.buyer_id = b.buyer_id AND c.period = $1 AND c.division = $2
     LEFT JOIN flags f ON f.buyer_id = b.buyer_id AND f.period = $1 AND f.division = $2
     LEFT JOIN fl ON fl.buyer_id = b.buyer_id
     WHERE b.kind = 'Municipality' AND b.buyer_id LIKE 'GM:%'`,
    [period, div],
  )
  return { rows, boundary_year: (await getManifest()).boundary_year ?? null }
}

// ------------------------------------------------------------------ gaps
async function gaps(p: P) {
  const y = years(optInt(p.year_from), optInt(p.year_to))
  const kind = p.kind || null
  const kf = kind ? 'AND b.kind = ?' : ''
  const kp = kind ? [kind] : []
  await ensure(['procedures', 'buyers', 'awards'])
  const base = `
     FROM procedures p JOIN buyers b USING (buyer_id)
     WHERE year(p.first_published) BETWEEN ? AND ? ${kf}
       AND p.status IN ('awarded', 'no_award_found', 'terminated', 'recent')`
  const status_by_year = await q(
    `SELECT year(p.first_published) AS year, p.status, count(*) AS n ${base} GROUP BY ALL ORDER BY 1, 2`, [...y, ...kp])
  const by_kind = await q(
    `SELECT b.kind, count(*) FILTER (p.status = 'no_award_found') AS no_award,
            count(*) FILTER (p.status <> 'recent') AS closed,
            count(*) FILTER (p.status = 'no_award_found') / nullif(count(*) FILTER (p.status <> 'recent'), 0) AS rate
     ${base} GROUP BY 1 ORDER BY rate DESC`, [...y, ...kp])
  const by_scope = await q(
    `SELECT coalesce(p.scope, 'unknown') AS scope, coalesce(p.procedure, 'unknown') AS procedure,
            count(*) FILTER (p.status = 'no_award_found') AS no_award,
            count(*) FILTER (p.status <> 'recent') AS closed
     ${base} GROUP BY ALL HAVING closed >= 50 ORDER BY closed DESC`, [...y, ...kp])
  const award_quality = await q(
    `SELECT a.year, sum(a.weight) AS lots,
            sum(a.weight * a.has_kvk::INT) / sum(a.weight) AS kvk_coverage,
            sum(a.weight * (a.value IS NOT NULL)::INT) / sum(a.weight) AS value_coverage,
            sum(a.weight * a.placeholder_value::INT) / sum(a.weight) AS placeholder_share
     FROM awards a JOIN buyers b USING (buyer_id) WHERE a.year BETWEEN ? AND ? ${kf} GROUP BY 1 ORDER BY 1`, [...y, ...kp])
  const worst_buyers = await q(
    `SELECT b.buyer_id, b.name, b.kind, count(*) FILTER (p.status = 'no_award_found') AS no_award,
            count(*) FILTER (p.status <> 'recent') AS closed,
            count(*) FILTER (p.status = 'no_award_found') / count(*) FILTER (p.status <> 'recent') AS rate
     ${base} GROUP BY ALL HAVING closed >= 10 ORDER BY no_award DESC LIMIT 50`, [...y, ...kp])
  const missing = await q(
    `SELECT p.ocid, p.title, p.buyer_id, b.name AS buyer_name, b.kind, p.division, p.procedure, p.scope,
            p.first_published, p.contract_notice_id, p.last_notice_id
     ${base} AND p.status = 'no_award_found' ORDER BY p.first_published DESC LIMIT 300`, [...y, ...kp])
  return { status_by_year, by_kind, by_scope, award_quality, worst_buyers, missing }
}

// ------------------------------------------------------------------ procedures
async function procedure(ocid: string) {
  await ensure(['procedures', 'buyers', 'notices', 'awards', 'suppliers', 'bids'])
  const p = await one('SELECT p.*, b.name AS buyer_name FROM procedures p JOIN buyers b USING (buyer_id) WHERE ocid = ?', [ocid])
  if (!p) throw new HttpError(404, 'procedure not found')
  const notices = await q(
    'SELECT notice_id, published, notice_type, notice_label, title FROM notices WHERE ocid = ? ORDER BY published', [ocid])
  const awards = await q(
    `SELECT a.lot_id, a.lot_title, a.supplier_key, s.name AS supplier_name, a.value, a.max_value, a.notice_id,
            a.n_lot_suppliers FROM awards a JOIN suppliers s USING (supplier_key) WHERE ocid = ? ORDER BY lot_id`, [ocid])
  const bids = await q('SELECT lot_id, requests, bids, lowest_bid, highest_bid FROM bids WHERE ocid = ? ORDER BY notice_id DESC', [ocid])
  return { procedure: p, notices, awards, bids }
}

// ------------------------------------------------------------------ router
export async function route(path: string, params: P): Promise<any> {
  const parts = path.split('/').map(decodeURIComponent)
  const [a, b, c] = parts
  switch (a) {
    case 'meta': return meta()
    case 'search': return search(params)
    case 'overview': return overview(params)
    case 'buyers':
      if (!b) return buyers(params)
      if (c === 'cell') return buyerCell(b, params)
      if (c === 'awards') return buyerAwards(b, params)
      if (c === 'gaps') return buyerGaps(b, params)
      return buyer(b, params)
    case 'suppliers': return supplier(b)
    case 'network': return network(params)
    case 'peers': return peers(params)
    case 'flags': return flags(params)
    case 'concentration': return distribution(params)
    case 'competition': return competition(params)
    case 'geo': return boundaries()
    case 'map': return mapData(params)
    case 'gaps': return gaps(params)
    case 'procedures': return procedure(b)
  }
  throw new HttpError(404, `unknown endpoint ${path}`)
}
