"""Read-only JSON API over data/tenders.duckdb (built by etl/)."""

from pathlib import Path

import duckdb
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "tenders.duckdb"
DIST = ROOT / "web" / "dist"
BOUNDARIES = sorted((ROOT / "data" / "cache").glob("municipalities_*.geojson"))
NOTICE_URL = "https://www.tenderned.nl/aankondigingen/overzicht/"

app = FastAPI(title="Tender Transparency NL")
_con = duckdb.connect(str(DB), read_only=True)


def q(sql, params=None):
    cur = _con.cursor()
    rel = cur.execute(sql, params or [])
    cols = [d[0] for d in rel.description]
    return [dict(zip(cols, row)) for row in rel.fetchall()]


def one(sql, params=None):
    rows = q(sql, params)
    return rows[0] if rows else None


# competition fields joined from competition_scores (alias cs) next to the concentration fields
COMP_COLS = """cs.n_bid_lots, cs.n_single, cs.single_bid_rate, cs.avg_bids, cs.direct_share, cs.n_direct,
               cs.bid_coverage, cs.local_share, cs.n_bid_peers, cs.peer_median_single_bid, cs.peer_p75_single_bid,
               cs.peer_median_avg_bids, cs.peer_median_direct_share, coalesce(cs.few_bidders, false) AS few_bidders"""


def years(y0, y1):
    return [y0 or 2000, y1 or 2100]


# ------------------------------------------------------------------ meta
@app.get("/api/meta")
def meta():
    return dict(
        cutoff=one("SELECT cutoff FROM data_cutoff")["cutoff"],
        notice_url=NOTICE_URL,
        divisions=q("SELECT division, label FROM cpv_divisions ORDER BY division"),
        periods=[r["period"] for r in q("SELECT period FROM periods ORDER BY y0")],
        kinds=q("SELECT kind, count(*) AS n FROM buyers GROUP BY 1 ORDER BY 2 DESC"),
        size_bands=q("SELECT kind, list(DISTINCT size_band ORDER BY size_band) AS bands FROM buyers GROUP BY 1"),
        provinces=[r["province"] for r in q("SELECT DISTINCT province FROM buyers WHERE province IS NOT NULL ORDER BY 1")],
        year_range=one("SELECT min(year) AS y0, max(year) AS y1 FROM awards"),
    )


@app.get("/api/search")
def search(q_: str = Query(..., alias="q", min_length=2), limit: int = 12):
    like = f"%{q_}%"
    return dict(
        buyers=q(
            """SELECT b.buyer_id, b.name, b.kind, b.locality, coalesce(a.n_procedures, 0) AS n_procedures
               FROM buyers b LEFT JOIN buyer_activity a USING (buyer_id)
               WHERE b.name ILIKE ? OR b.buyer_id = ? ORDER BY n_procedures DESC LIMIT ?""",
            [like, q_, limit],
        ),
        suppliers=q(
            """SELECT s.supplier_key, s.name, s.kvk, s.locality, sum(e.w) AS lots
               FROM suppliers s JOIN edges e USING (supplier_key)
               WHERE s.name ILIKE ? OR s.kvk = ? GROUP BY ALL ORDER BY lots DESC LIMIT ?""",
            [like, q_.zfill(8), limit],
        ),
    )


# ------------------------------------------------------------------ overview
@app.get("/api/overview")
def overview(year_from: int | None = None, year_to: int | None = None):
    y = years(year_from, year_to)
    kpis = one(
        """
        WITH a AS (SELECT * FROM awards WHERE year BETWEEN ? AND ?),
             p AS (SELECT * FROM procedures WHERE year(first_published) BETWEEN ? AND ?)
        SELECT (SELECT count(*) FROM p) AS procedures,
               (SELECT count(*) FROM p WHERE status = 'awarded') AS awarded_procedures,
               (SELECT count(*) FROM p WHERE status = 'no_award_found') AS no_award_found,
               (SELECT count(*) FROM p WHERE status IN ('awarded','no_award_found','terminated')) AS closed_procedures,
               (SELECT sum(weight) FROM a) AS lots,
               (SELECT count(DISTINCT buyer_id) FROM a) AS buyers,
               (SELECT count(DISTINCT supplier_key) FROM a) AS suppliers,
               (SELECT sum(value) FROM a) AS value_known,
               (SELECT sum(weight * (value IS NOT NULL)::INT) / sum(weight) FROM a) AS value_coverage
        """,
        y + y,
    )
    by_year = q(
        """
        WITH p AS (SELECT year(first_published) AS year, status FROM procedures WHERE year(first_published) BETWEEN ? AND ?),
             a AS (SELECT year, sum(weight) AS lots, sum(value) AS value, count(DISTINCT supplier_key) AS suppliers
                   FROM awards WHERE year BETWEEN ? AND ? GROUP BY 1)
        SELECT p.year, count(*) AS procedures,
               count(*) FILTER (status = 'awarded') AS awarded,
               count(*) FILTER (status = 'no_award_found') AS no_award_found,
               count(*) FILTER (status = 'terminated') AS terminated,
               count(*) FILTER (status = 'recent') AS recent,
               any_value(a.lots) AS lots, any_value(a.value) AS value, any_value(a.suppliers) AS suppliers
        FROM p LEFT JOIN a USING (year) GROUP BY 1 ORDER BY 1
        """,
        y + y,
    )
    by_division = q(
        """
        SELECT a.division, d.label, sum(weight) AS lots, sum(value) AS value,
               count(DISTINCT supplier_key) AS suppliers, count(DISTINCT buyer_id) AS buyers
        FROM awards a JOIN cpv_divisions d USING (division)
        WHERE year BETWEEN ? AND ? GROUP BY ALL ORDER BY lots DESC
        """,
        y,
    )
    by_kind = q(
        """
        SELECT b.kind, count(DISTINCT a.buyer_id) AS buyers, sum(weight) AS lots, sum(value) AS value
        FROM awards a JOIN buyers b USING (buyer_id) WHERE year BETWEEN ? AND ? GROUP BY 1 ORDER BY lots DESC
        """,
        y,
    )
    top_suppliers = q(
        """
        SELECT a.supplier_key, s.name, sum(weight) AS lots, sum(value) AS value, count(DISTINCT a.buyer_id) AS buyers
        FROM awards a JOIN suppliers s USING (supplier_key) WHERE year BETWEEN ? AND ?
        GROUP BY ALL ORDER BY value DESC NULLS LAST LIMIT 15
        """,
        y,
    )
    top_buyers = q(
        """
        SELECT a.buyer_id, b.name, b.kind, sum(weight) AS lots, sum(value) AS value, count(DISTINCT supplier_key) AS suppliers
        FROM awards a JOIN buyers b USING (buyer_id) WHERE year BETWEEN ? AND ?
        GROUP BY ALL ORDER BY value DESC NULLS LAST LIMIT 15
        """,
        y,
    )
    return dict(kpis=kpis, by_year=by_year, by_division=by_division, by_kind=by_kind,
                top_suppliers=top_suppliers, top_buyers=top_buyers)


# ------------------------------------------------------------------ buyers
@app.get("/api/buyers")
def buyers(kind: str | None = None, province: str | None = None, size_band: str | None = None,
           q_: str | None = Query(None, alias="q"), limit: int = 100, offset: int = 0):
    where, params = ["1=1"], []
    for col, val in (("kind", kind), ("province", province), ("size_band", size_band)):
        if val:
            where.append(f"b.{col} = ?")
            params.append(val)
    if q_:
        where.append("b.name ILIKE ?")
        params.append(f"%{q_}%")
    w = " AND ".join(where)
    rows = q(
        f"""
        SELECT b.buyer_id, b.name, b.kind, b.province, b.size_band, b.population,
               coalesce(ba.n_procedures, 0) AS n_procedures, e.lots, e.value, e.suppliers,
               (SELECT count(*) FROM flags f WHERE f.buyer_id = b.buyer_id AND f.unusual AND f.period <> 'all') AS n_flags
        FROM buyers b
        LEFT JOIN buyer_activity ba USING (buyer_id)
        LEFT JOIN (SELECT buyer_id, sum(w) AS lots, sum(value) AS value, count(*) AS suppliers FROM edges GROUP BY 1) e USING (buyer_id)
        WHERE {w} ORDER BY n_procedures DESC LIMIT ? OFFSET ?
        """,
        params + [limit, offset],
    )
    total = one(f"SELECT count(*) AS n FROM buyers b WHERE {w}", params)["n"]
    return dict(total=total, rows=rows)


@app.get("/api/buyers/{buyer_id}")
def buyer(buyer_id: str, period: str = "all"):
    b = one("SELECT * FROM buyers WHERE buyer_id = ?", [buyer_id])
    if not b:
        raise HTTPException(404, "buyer not found")
    kpis = one(
        """
        SELECT (SELECT count(*) FROM procedures WHERE buyer_id = $1) AS procedures,
               (SELECT count(*) FROM procedures WHERE buyer_id = $1 AND status = 'no_award_found') AS no_award_found,
               (SELECT count(*) FROM procedures WHERE buyer_id = $1 AND status IN ('awarded','no_award_found','terminated')) AS closed,
               (SELECT sum(weight) FROM awards WHERE buyer_id = $1) AS lots,
               (SELECT sum(value) FROM awards WHERE buyer_id = $1) AS value_known,
               (SELECT sum(weight * (value IS NOT NULL)::INT) / sum(weight) FROM awards WHERE buyer_id = $1) AS value_coverage,
               (SELECT count(DISTINCT supplier_key) FROM awards WHERE buyer_id = $1) AS suppliers
        """,
        [buyer_id],
    )
    by_year = q(
        """
        SELECT year(first_published) AS year, count(*) AS procedures,
               count(*) FILTER (status = 'awarded') AS awarded,
               count(*) FILTER (status = 'no_award_found') AS no_award_found,
               any_value(v.lots) AS lots, any_value(v.value) AS value
        FROM procedures p
        LEFT JOIN (SELECT year, sum(weight) AS lots, sum(value) AS value FROM awards WHERE buyer_id = $1 GROUP BY 1) v
          ON v.year = year(p.first_published)
        WHERE buyer_id = $1 GROUP BY 1 ORDER BY 1
        """,
        [buyer_id],
    )
    categories = q(
        """
        SELECT c.division, d.label, c.n_lots, c.n_suppliers, c.n_procedures, c.top_share, c.hhi,
               c.top_supplier, s.name AS top_supplier_name, c.value_known, c.kvk_coverage, c.value_coverage,
               c.n_no_award, c.no_award_rate,
               f.n_peers, f.peer_median_top_share, f.peer_p75_top_share, f.peer_median_hhi, f.peer_median_suppliers, f.hhi_percentile,
               coalesce(f.comparability, 'fewer than 3 awards') AS comparability, coalesce(f.unusual, false) AS unusual,
               f.persistent_periods, {COMP_COLS}
        FROM concentration c
        JOIN cpv_divisions d USING (division)
        LEFT JOIN suppliers s ON s.supplier_key = c.top_supplier
        LEFT JOIN flags f USING (buyer_id, division, period)
        LEFT JOIN competition_scores cs USING (buyer_id, division, period)
        WHERE c.buyer_id = ? AND c.period = ? ORDER BY c.n_lots DESC
        """.replace("{COMP_COLS}", COMP_COLS),
        [buyer_id, period],
    )
    competition = one(
        "SELECT * EXCLUDE (buyer_id, kind, size_band, province, municipality_code) FROM competition_scores "
        "WHERE buyer_id = ? AND division = '*' AND period = ?",
        [buyer_id, period],
    )
    suppliers = q(
        """
        SELECT e.supplier_key, s.name, s.locality, s.province, s.sme, e.w AS lots, e.n_procedures, e.value,
               e.first_year, e.last_year, e.divisions, e.w / sum(e.w) OVER () AS share
        FROM edges e JOIN suppliers s USING (supplier_key)
        WHERE e.buyer_id = ? ORDER BY e.w DESC LIMIT 50
        """,
        [buyer_id],
    )
    persistence = q(
        """
        SELECT p.division, d.label, p.top_supplier, s.name AS supplier_name, p.n_periods, p.periods, p.avg_top_share, p.n_lots
        FROM persistence p JOIN cpv_divisions d USING (division) JOIN suppliers s ON s.supplier_key = p.top_supplier
        WHERE p.buyer_id = ? AND p.n_periods >= 2 ORDER BY p.n_periods DESC, p.n_lots DESC
        """,
        [buyer_id],
    )
    return dict(buyer=b, kpis=kpis, by_year=by_year, categories=categories, competition=competition,
                suppliers=suppliers, persistence=persistence, period=period)


@app.get("/api/buyers/{buyer_id}/awards")
def buyer_awards(buyer_id: str, division: str | None = None, supplier_key: str | None = None, limit: int = 200):
    where, params = ["a.buyer_id = ?"], [buyer_id]
    if division:
        where.append("a.division = ?")
        params.append(division)
    if supplier_key:
        where.append("a.supplier_key = ?")
        params.append(supplier_key)
    return q(
        f"""
        SELECT a.ocid, a.notice_id, a.published, a.title, a.lot_id, a.lot_title, a.division, a.cpv, a.procedure,
               a.supplier_key, s.name AS supplier_name, a.value, a.max_value, a.weight, a.n_lot_suppliers
        FROM awards a JOIN suppliers s USING (supplier_key)
        WHERE {' AND '.join(where)} ORDER BY a.published DESC LIMIT ?
        """,
        params + [limit],
    )


@app.get("/api/buyers/{buyer_id}/gaps")
def buyer_gaps(buyer_id: str, limit: int = 200):
    return q(
        """
        SELECT ocid, title, division, procedure, scope, first_published, contract_notice_id, last_notice_id, n_notices
        FROM procedures WHERE buyer_id = ? AND status = 'no_award_found' ORDER BY first_published DESC LIMIT ?
        """,
        [buyer_id, limit],
    )


# ------------------------------------------------------------------ suppliers
@app.get("/api/suppliers/{supplier_key}")
def supplier(supplier_key: str):
    s = one("SELECT * FROM suppliers WHERE supplier_key = ?", [supplier_key])
    if not s:
        raise HTTPException(404, "supplier not found")
    kpis = one(
        """
        SELECT sum(weight) AS lots, count(DISTINCT ocid) AS procedures, count(DISTINCT buyer_id) AS buyers,
               sum(value) AS value_known, sum(weight * (value IS NOT NULL)::INT) / sum(weight) AS value_coverage,
               min(year) AS first_year, max(year) AS last_year
        FROM awards WHERE supplier_key = ?
        """,
        [supplier_key],
    )
    by_year = q(
        "SELECT year, sum(weight) AS lots, sum(value) AS value, count(DISTINCT buyer_id) AS buyers "
        "FROM awards WHERE supplier_key = ? GROUP BY 1 ORDER BY 1",
        [supplier_key],
    )
    divisions = q(
        """
        SELECT a.division, d.label, sum(weight) AS lots, sum(value) AS value, count(DISTINCT buyer_id) AS buyers
        FROM awards a JOIN cpv_divisions d USING (division) WHERE supplier_key = ? GROUP BY ALL ORDER BY lots DESC
        """,
        [supplier_key],
    )
    # how much each buyer relies on this supplier within the categories they share
    buyers = q(
        """
        WITH mine AS (
          SELECT buyer_id, division, w, value FROM buyer_supplier_cells WHERE supplier_key = $1 AND period = 'all'
        )
        SELECT m.buyer_id, b.name, b.kind, b.province, m.division, d.label, m.w AS lots, m.value,
               c.n_lots AS buyer_lots, m.w / c.n_lots AS share_of_buyer, c.n_suppliers AS buyer_suppliers,
               f.peer_median_top_share, f.comparability
        FROM mine m JOIN buyers b USING (buyer_id) JOIN cpv_divisions d USING (division)
        JOIN concentration c ON c.buyer_id = m.buyer_id AND c.division = m.division AND c.period = 'all'
        LEFT JOIN flags f ON f.buyer_id = m.buyer_id AND f.division = m.division AND f.period = 'all'
        ORDER BY m.w DESC LIMIT 100
        """,
        [supplier_key],
    )
    awards = q(
        """
        SELECT a.ocid, a.notice_id, a.published, a.title, a.lot_title, a.division, a.procedure, a.buyer_id,
               b.name AS buyer_name, a.value, a.max_value, a.weight, a.n_lot_suppliers
        FROM awards a JOIN buyers b USING (buyer_id) WHERE supplier_key = ? ORDER BY published DESC LIMIT 200
        """,
        [supplier_key],
    )
    return dict(supplier=s, kpis=kpis, by_year=by_year, divisions=divisions, buyers=buyers, awards=awards)


# ------------------------------------------------------------------ network
@app.get("/api/network")
def network(buyer_id: str | None = None, supplier_key: str | None = None, division: str | None = None,
            first: int = 20, second: int = 6):
    if not (buyer_id or supplier_key):
        raise HTTPException(400, "buyer_id or supplier_key required")
    div = "AND ? = ANY(divisions)" if division else ""
    dp = [division] if division else []
    if buyer_id:
        hop1 = q(f"SELECT * FROM edges WHERE buyer_id = ? {div} ORDER BY w DESC LIMIT ?", [buyer_id] + dp + [first])
        keys = [e["supplier_key"] for e in hop1]
        hop2 = q(
            f"""SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY supplier_key ORDER BY w DESC) rn
                FROM edges WHERE supplier_key IN (SELECT unnest(?)) AND buyer_id <> ? {div}) WHERE rn <= ?""",
            [keys, buyer_id] + dp + [second],
        )
    else:
        hop1 = q(f"SELECT * FROM edges WHERE supplier_key = ? {div} ORDER BY w DESC LIMIT ?", [supplier_key] + dp + [first])
        keys = [e["buyer_id"] for e in hop1]
        hop2 = q(
            f"""SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY buyer_id ORDER BY w DESC) rn
                FROM edges WHERE buyer_id IN (SELECT unnest(?)) AND supplier_key <> ? {div}) WHERE rn <= ?""",
            [keys, supplier_key] + dp + [second],
        )
    edges = hop1 + hop2
    bids = sorted({e["buyer_id"] for e in edges})
    sids = sorted({e["supplier_key"] for e in edges})
    nodes = [dict(id="b:" + r["buyer_id"], ref=r["buyer_id"], type="buyer", name=r["name"], kind=r["kind"])
             for r in q("SELECT buyer_id, name, kind FROM buyers WHERE buyer_id IN (SELECT unnest(?))", [bids])]
    nodes += [dict(id="s:" + r["supplier_key"], ref=r["supplier_key"], type="supplier", name=r["name"])
              for r in q("SELECT supplier_key, name FROM suppliers WHERE supplier_key IN (SELECT unnest(?))", [sids])]
    links = [dict(source="b:" + e["buyer_id"], target="s:" + e["supplier_key"], w=e["w"], value=e["value"],
                  n_procedures=e["n_procedures"], hop=1 if i < len(hop1) else 2) for i, e in enumerate(edges)]
    return dict(nodes=nodes, links=links)


# ------------------------------------------------------------------ peers & concentration
@app.get("/api/peers")
def peers(division: str, period: str = "2022-2024", kind: str | None = None, size_band: str | None = None,
          buyer_id: str | None = None):
    """kind=None compares all buyer types; size bands are type-specific, so they only apply with a kind."""
    if kind and buyer_id and not size_band:
        size_band = (one("SELECT size_band FROM buyers WHERE buyer_id = ?", [buyer_id]) or {}).get("size_band")
    where, params = ["c.division = ?", "c.period = ?"], [division, period]
    if kind:
        where.append("c.kind = ?")
        params.append(kind)
    if kind and size_band:
        where.append("c.size_band = ?")
        params.append(size_band)
    rows = q(
        f"""
        SELECT c.buyer_id, b.name, b.kind, b.province, b.size_band, b.population, c.n_lots, c.n_suppliers, c.n_procedures,
               c.top_share, c.hhi, c.top_supplier, s.name AS top_supplier_name, c.value_known,
               c.kvk_coverage, c.value_coverage, c.n_no_award, c.no_award_rate,
               f.hhi_percentile, coalesce(f.comparability, 'fewer than 3 awards') AS comparability,
               coalesce(f.unusual, false) AS unusual, f.persistent_periods, {COMP_COLS}
        FROM concentration c JOIN buyers b USING (buyer_id)
        LEFT JOIN suppliers s ON s.supplier_key = c.top_supplier
        LEFT JOIN flags f USING (buyer_id, division, period)
        LEFT JOIN competition_scores cs USING (buyer_id, division, period)
        WHERE {' AND '.join(where)} ORDER BY c.n_lots DESC
        """,
        params,
    )
    eligible = [r for r in rows if r["n_lots"] >= 3]
    tops = sorted(r["top_share"] for r in eligible)
    singles = sorted(r["single_bid_rate"] for r in rows if (r["n_bid_lots"] or 0) >= 5)
    summary = dict(
        n_buyers=len(rows),
        n_eligible=len(eligible),
        median_top_share=tops[len(tops) // 2] if tops else None,
        n_bid_eligible=len(singles),
        median_single_bid=singles[len(singles) // 2] if singles else None,
        size_band=size_band,
    )
    return dict(summary=summary, rows=rows)


@app.get("/api/flags")
def flags(division: str | None = None, period: str | None = None, kind: str | None = None,
          province: str | None = None, only_unusual: bool = True, persistent: bool = False, limit: int = 300):
    where, params = ["f.period <> 'all'" if not period else "f.period = ?"], [] if not period else [period]
    for col, val in (("division", division), ("kind", kind), ("province", province)):
        if val:
            where.append(f"f.{col} = ?")
            params.append(val)
    if only_unusual:
        where.append("f.unusual")
    if persistent:
        where.append("f.persistent_periods >= 2")
    return q(
        f"""
        SELECT f.buyer_id, b.name AS buyer_name, f.kind, f.size_band, f.province, f.division, d.label, f.period,
               f.n_lots, f.n_suppliers, f.top_share, f.hhi, f.top_supplier, s.name AS top_supplier_name,
               f.n_peers, f.peer_median_top_share, f.peer_p75_top_share, f.peer_median_hhi, f.hhi_percentile, f.comparability, f.unusual,
               f.persistent_periods, f.kvk_coverage, f.value_coverage, f.no_award_rate, f.value_known,
               s.province AS supplier_province
        FROM flags f JOIN buyers b USING (buyer_id) JOIN cpv_divisions d USING (division)
        LEFT JOIN suppliers s ON s.supplier_key = f.top_supplier
        WHERE {' AND '.join(where)}
        ORDER BY f.top_share - f.peer_median_top_share DESC, f.n_lots DESC LIMIT ?
        """,
        params + [limit],
    )


@app.get("/api/concentration/distribution")
def distribution(division: str, period: str = "2022-2024", kind: str = "Municipality"):
    """Top-supplier share of every comparable buyer, by size band - for strip plots."""
    return q(
        """
        SELECT f.buyer_id, b.name, f.size_band, f.top_share, f.hhi, f.n_lots, f.unusual, f.comparability
        FROM flags f JOIN buyers b USING (buyer_id)
        WHERE f.division = ? AND f.period = ? AND f.kind = ? ORDER BY f.size_band, f.top_share
        """,
        [division, period, kind],
    )


# ------------------------------------------------------------------ competition
LOT_FILTER = """FROM lot_competition l JOIN buyers b USING (buyer_id)
    WHERE (? = '' OR b.kind = ?) AND (? = '' OR l.division = ?)"""


def lot_metrics():
    return """count(*) AS lots,
        count(*) FILTER (NOT no_publication AND n_bids IS NOT NULL) AS bid_lots,
        avg((n_bids = 1)::INT) FILTER (NOT no_publication AND n_bids IS NOT NULL) AS single_bid_rate,
        avg(least(n_bids, 20)) FILTER (NOT no_publication AND n_bids IS NOT NULL) AS avg_bids,
        median(n_bids) FILTER (NOT no_publication AND n_bids IS NOT NULL) AS median_bids,
        avg(no_publication::INT) AS direct_share,
        count(*) FILTER (NOT no_publication AND n_bids IS NOT NULL) / nullif(count(*) FILTER (NOT no_publication), 0) AS bid_coverage"""


@app.get("/api/competition")
def competition(period: str = "2022-2024", kind: str = "", division: str = "", limit: int = 400):
    f = [kind, kind, division, division]
    per = one("SELECT y0, y1 FROM periods WHERE period = ?", [period]) or dict(y0=2000, y1=2100)
    py = [per["y0"], per["y1"]]
    summary = one(f"SELECT {lot_metrics()} {LOT_FILTER} AND l.year BETWEEN ? AND ?", f + py)
    by_year = q(f"SELECT l.year, {lot_metrics()} {LOT_FILTER} GROUP BY 1 ORDER BY 1", f)
    by_division = q(
        f"""SELECT l.division, d.label, count(DISTINCT l.buyer_id) AS buyers, {lot_metrics()}
            {LOT_FILTER.replace("USING (buyer_id)", "USING (buyer_id) JOIN cpv_divisions d USING (division)")}
              AND l.year BETWEEN ? AND ?
            GROUP BY ALL HAVING bid_lots >= 30 ORDER BY lots DESC""",
        f + py,
    )
    by_kind = q(
        f"""SELECT b.kind, count(DISTINCT l.buyer_id) AS buyers, {lot_metrics()}
            {LOT_FILTER} AND l.year BETWEEN ? AND ? GROUP BY 1 ORDER BY lots DESC""",
        f + py,
    )
    histogram = q(
        f"""SELECT least(n_bids, 10)::INT AS bids, count(*) AS lots
            {LOT_FILTER} AND l.year BETWEEN ? AND ? AND NOT no_publication AND n_bids IS NOT NULL GROUP BY 1 ORDER BY 1""",
        f + py,
    )
    buyers = q(
        """
        SELECT cs.buyer_id, b.name, cs.kind, cs.size_band, cs.province, cs.n_lots, cs.n_bid_lots, cs.n_single,
               cs.single_bid_rate, cs.avg_bids, cs.direct_share, cs.n_direct, cs.bid_coverage, cs.n_bid_peers,
               cs.peer_median_single_bid, cs.peer_p75_single_bid, cs.peer_median_avg_bids, cs.peer_median_direct_share,
               cs.few_bidders, coalesce(f.unusual, false) AS unusual
        FROM competition_scores cs JOIN buyers b USING (buyer_id)
        LEFT JOIN flags f USING (buyer_id, division, period)
        WHERE cs.period = ? AND cs.division = ? AND (? = '' OR cs.kind = ?) AND cs.n_bid_lots >= 5
        ORDER BY cs.few_bidders DESC, cs.single_bid_rate - coalesce(cs.peer_median_single_bid, 0) DESC, cs.n_bid_lots DESC
        LIMIT ?
        """,
        [period, division or "*", kind, kind, limit],
    )
    n_flagged = one(
        "SELECT count(*) AS n FROM competition_scores WHERE period = ? AND division = ? AND (? = '' OR kind = ?) AND few_bidders",
        [period, division or "*", kind, kind],
    )["n"]
    return dict(summary=summary, by_year=by_year, by_division=by_division, by_kind=by_kind, histogram=histogram,
                buyers=buyers, n_flagged=n_flagged)


# ------------------------------------------------------------------ map
@app.get("/api/geo/municipalities")
def municipality_boundaries():
    if not BOUNDARIES:
        raise HTTPException(404, "run etl/enrich.py to fetch municipal boundaries")
    return FileResponse(BOUNDARIES[-1], media_type="application/geo+json",
                        headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/map")
def map_data(period: str = "2022-2024", division: str = ""):
    """One row per municipality (as buyer) with the metrics the map can colour by."""
    div = division or "*"
    rows = q(
        """
        WITH fl AS (
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
        WHERE b.kind = 'Municipality' AND b.buyer_id LIKE 'GM:%'
        """,
        [period, div],
    )
    return dict(rows=rows, boundary_year=BOUNDARIES[-1].stem.split("_")[-1] if BOUNDARIES else None)


# ------------------------------------------------------------------ gaps
@app.get("/api/gaps")
def gaps(year_from: int | None = None, year_to: int | None = None, kind: str | None = None):
    y = years(year_from, year_to)
    kf, kp = ("AND b.kind = ?", [kind]) if kind else ("", [])
    base = f"""
        FROM procedures p JOIN buyers b USING (buyer_id)
        WHERE year(p.first_published) BETWEEN ? AND ? {kf}
          AND p.status IN ('awarded', 'no_award_found', 'terminated', 'recent')
    """
    status_by_year = q(
        f"""SELECT year(p.first_published) AS year, p.status, count(*) AS n {base} GROUP BY ALL ORDER BY 1, 2""",
        y + kp,
    )
    by_kind = q(
        f"""SELECT b.kind, count(*) FILTER (p.status = 'no_award_found') AS no_award,
                   count(*) FILTER (p.status <> 'recent') AS closed,
                   count(*) FILTER (p.status = 'no_award_found') / nullif(count(*) FILTER (p.status <> 'recent'), 0) AS rate
            {base} GROUP BY 1 ORDER BY rate DESC""",
        y + kp,
    )
    by_scope = q(
        f"""SELECT coalesce(p.scope, 'unknown') AS scope, coalesce(p.procedure, 'unknown') AS procedure,
                   count(*) FILTER (p.status = 'no_award_found') AS no_award,
                   count(*) FILTER (p.status <> 'recent') AS closed
            {base} GROUP BY ALL HAVING closed >= 50 ORDER BY closed DESC""",
        y + kp,
    )
    award_quality = q(
        f"""SELECT a.year, sum(a.weight) AS lots,
                   sum(a.weight * a.has_kvk::INT) / sum(a.weight) AS kvk_coverage,
                   sum(a.weight * (a.value IS NOT NULL)::INT) / sum(a.weight) AS value_coverage,
                   sum(a.weight * a.placeholder_value::INT) / sum(a.weight) AS placeholder_share
            FROM awards a JOIN buyers b USING (buyer_id) WHERE a.year BETWEEN ? AND ? {kf} GROUP BY 1 ORDER BY 1""",
        y + kp,
    )
    worst_buyers = q(
        f"""SELECT b.buyer_id, b.name, b.kind, count(*) FILTER (p.status = 'no_award_found') AS no_award,
                   count(*) FILTER (p.status <> 'recent') AS closed,
                   count(*) FILTER (p.status = 'no_award_found') / count(*) FILTER (p.status <> 'recent') AS rate
            {base} GROUP BY ALL HAVING closed >= 10 ORDER BY no_award DESC LIMIT 50""",
        y + kp,
    )
    missing = q(
        f"""SELECT p.ocid, p.title, p.buyer_id, b.name AS buyer_name, b.kind, p.division, p.procedure, p.scope,
                   p.first_published, p.contract_notice_id, p.last_notice_id
            {base} AND p.status = 'no_award_found' ORDER BY p.first_published DESC LIMIT 300""",
        y + kp,
    )
    return dict(status_by_year=status_by_year, by_kind=by_kind, by_scope=by_scope, award_quality=award_quality,
                worst_buyers=worst_buyers, missing=missing)


# ------------------------------------------------------------------ procedures
@app.get("/api/procedures/{ocid}")
def procedure(ocid: str):
    p = one("SELECT p.*, b.name AS buyer_name FROM procedures p JOIN buyers b USING (buyer_id) WHERE ocid = ?", [ocid])
    if not p:
        raise HTTPException(404, "procedure not found")
    notices = q(
        "SELECT notice_id, published, notice_type, notice_label, title FROM notices WHERE ocid = ? ORDER BY published",
        [ocid],
    )
    awards = q(
        """SELECT a.lot_id, a.lot_title, a.supplier_key, s.name AS supplier_name, a.value, a.max_value, a.notice_id,
                  a.n_lot_suppliers FROM awards a JOIN suppliers s USING (supplier_key) WHERE ocid = ? ORDER BY lot_id""",
        [ocid],
    )
    bids = q("SELECT lot_id, requests, bids, lowest_bid, highest_bid FROM bids WHERE ocid = ? ORDER BY notice_id DESC", [ocid])
    return dict(procedure=p, notices=notices, awards=awards, bids=bids)


# ------------------------------------------------------------------ frontend
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
