"""Numbers and figures for the blog post "Fewer bidders, more direct awards".

Reads the Parquet tables the static dashboard ships (see analysis/README.md), writes every number the
post quotes to analysis/out/numbers.json and, with --post, replaces the figure blocks in the post's HTML
(between <!-- fig:NAME --> and <!-- /fig:NAME -->) with freshly rendered charts.

    uv run python analysis/blog_figures.py --data data/static/data
    uv run python analysis/blog_figures.py --data data/static/data --post ../jakobvongehlen.github.io/blog/fewer-bidders.html

Charts are plain HTML and CSS (positions in %, lines in a stretched SVG with non-scaling strokes), so text
stays at its real size on phones and colours come from the page's CSS variables in light and dark mode.
"""

import argparse
import html
import json
import re
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
TABLES = ["awards", "buyers", "competition_scores", "cpv_divisions", "data_cutoff", "flags", "lot_competition",
          "persistence", "procedures", "suppliers"]
BEFORE, AFTER = (2016, 2021), (2022, 2025)
FLAG_ERRORS = [("GM:GM0307", "66", "2022-2024"), ("381687890", "79", "2025-2026"), ("1829383", "79", "2022-2024"),
               ("161955419", "79", "2022-2024"), ("222072340", "79", "2022-2024"), ("GM:GM1911", "79", "2025-2026")]  # 2026 is a half year (data ends 30 June 2026)


def connect(data: Path):
    con = duckdb.connect()
    for t in TABLES:
        con.execute(f"CREATE VIEW {t} AS SELECT * FROM read_parquet('{data / (t + '.parquet')}')")
    return con


def rows(con, sql, *params):
    cur = con.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def one(con, sql, *params):
    return rows(con, sql, *params)[0]


def r1(x, d=1):
    return None if x is None else round(float(x), d)


# ---------------------------------------------------------------- numbers
def compute(con):
    n = {}
    n["cutoff"] = str(one(con, "SELECT cutoff FROM data_cutoff")["cutoff"])
    k = one(con, """
        SELECT (SELECT count(*) FROM procedures) AS procedures,
               (SELECT count(DISTINCT buyer_id) FROM awards) AS buyers,
               (SELECT count(DISTINCT supplier_key) FROM awards) AS suppliers,
               (SELECT round(sum(weight)) FROM awards) AS lots,
               (SELECT sum(value) FROM awards) AS value_known,
               (SELECT sum(weight * (value IS NOT NULL)::INT) / sum(weight) FROM awards) AS value_coverage""")
    n["kpis"] = {**k, "value_known_bn": r1(k["value_known"] / 1e9, 0), "value_coverage": r1(100 * k["value_coverage"])}

    # tenders per competitive awarded lot (no direct awards), by year of award
    comp = """WITH nl AS (SELECT ocid, count(*) AS nlots FROM lot_competition GROUP BY 1)
              SELECT * FROM lot_competition JOIN nl USING (ocid) WHERE NOT no_publication AND n_bids IS NOT NULL"""
    n["bidders_by_year"] = rows(con, f"""
        WITH c AS ({comp})
        SELECT year, count(*) AS lots,
          round(100 * avg((n_bids = 1)::INT), 1) AS one,
          round(100 * avg((n_bids = 2)::INT), 1) AS two,
          round(100 * avg((n_bids BETWEEN 3 AND 5)::INT), 1) AS three_to_five,
          round(100 * avg((n_bids >= 6)::INT), 1) AS six_plus,
          median(n_bids) AS median_bids,
          round(100 * avg((n_bids = 1)::INT) FILTER (WHERE nlots = 1), 1) AS one_single_lot_procs,
          round(100 * avg((n_bids >= 6)::INT) FILTER (WHERE nlots = 1), 1) AS six_plus_single_lot_procs
        FROM c WHERE year <= 2025 GROUP BY 1 ORDER BY 1""")
    n["one_bid_by_half_year"] = rows(con, f"""
        WITH c AS ({comp})
        SELECT year || '-H' || CASE WHEN month(p) <= 6 THEN 1 ELSE 2 END AS half, count(*) AS lots,
          round(100 * avg((n_bids = 1)::INT), 1) AS one, round(100 * avg((n_bids >= 6)::INT), 1) AS six_plus
        FROM c JOIN (SELECT ocid, lot_id, min(published) AS p FROM awards GROUP BY ALL) USING (ocid, lot_id)
        WHERE year BETWEEN 2020 AND 2023 AND year(p) = year GROUP BY 1 ORDER BY 1""")
    n["bidders_pooled"] = rows(con, f"""
        WITH c AS ({comp})
        SELECT CASE WHEN year <= {BEFORE[1]} THEN 'before' ELSE 'after' END AS per, count(*) AS lots,
          round(100 * avg((n_bids = 1)::INT), 1) AS one, round(100 * avg((n_bids >= 6)::INT), 1) AS six_plus,
          median(n_bids) AS median_bids
        FROM c WHERE year BETWEEN {BEFORE[0]} AND {AFTER[1]} GROUP BY 1 ORDER BY 1 DESC""")
    # same rate with the category x buyer-type mix held fixed
    n["one_bid_mix_adjusted"] = rows(con, f"""
        WITH c AS (SELECT l.*, b.kind FROM ({comp}) l JOIN buyers b USING (buyer_id) WHERE year <= 2025),
        cell AS (SELECT division, kind, year, avg((n_bids = 1)::INT) AS r FROM c GROUP BY ALL),
        w AS (SELECT division, kind, count(*) AS w FROM c GROUP BY ALL)
        SELECT year, round(100 * sum(r * w) / sum(w), 1) AS one FROM cell JOIN w USING (division, kind)
        GROUP BY 1 ORDER BY 1""")
    n["one_bid_buyer_level"] = one(con, f"""
        WITH c AS ({comp}),
        b AS (SELECT buyer_id, count(*) FILTER (WHERE year <= {BEFORE[1]}) AS nb, count(*) FILTER (WHERE year >= {AFTER[0]} AND year <= {AFTER[1]}) AS na,
                avg((n_bids = 1)::INT) FILTER (WHERE year <= {BEFORE[1]}) AS rb,
                avg((n_bids = 1)::INT) FILTER (WHERE year >= {AFTER[0]} AND year <= {AFTER[1]}) AS ra
              FROM c GROUP BY 1),
        top10 AS (SELECT buyer_id FROM c WHERE year <= {AFTER[1]} GROUP BY 1 ORDER BY count(*) DESC, buyer_id LIMIT 10)
        SELECT (SELECT count(*) FROM b WHERE nb >= 30 AND na >= 30) AS buyers_30_lots_each_period,
               (SELECT count(*) FROM b WHERE nb >= 30 AND na >= 30 AND ra > rb) AS of_which_rose,
               (SELECT round(100 * avg((n_bids = 1)::INT) FILTER (WHERE year <= {BEFORE[1]}), 1) FROM c
                 WHERE buyer_id NOT IN (SELECT buyer_id FROM top10)) AS without_top10_before,
               (SELECT round(100 * avg((n_bids = 1)::INT) FILTER (WHERE year BETWEEN {AFTER[0]} AND {AFTER[1]}), 1) FROM c
                 WHERE buyer_id NOT IN (SELECT buyer_id FROM top10)) AS without_top10_after""")
    split = f"""round(100 * avg((n_bids = 1)::INT) FILTER (WHERE year BETWEEN {BEFORE[0]} AND {BEFORE[1]}), 1) AS before,
                round(100 * avg((n_bids = 1)::INT) FILTER (WHERE year BETWEEN {AFTER[0]} AND {AFTER[1]}), 1) AS after"""
    n["one_bid_by_category"] = rows(con, f"""
        WITH c AS ({comp})
        SELECT division, d.label, count(*) AS lots, {split}
        FROM c LEFT JOIN cpv_divisions d USING (division) WHERE year <= {AFTER[1]}
        GROUP BY ALL HAVING count(*) >= 2000 ORDER BY after DESC""")
    n["one_bid_by_buyer_type"] = rows(con, f"""
        WITH c AS ({comp})
        SELECT b.kind, count(*) AS lots, {split}
        FROM c JOIN buyers b USING (buyer_id) WHERE year <= {AFTER[1]}
        GROUP BY ALL HAVING count(*) >= 1000 ORDER BY lots DESC""")

    # direct awards (negotiated without a prior call for competition), share of awarded lots
    n["direct_by_year"] = rows(con, """
        SELECT year, count(*) AS lots, round(100 * avg(no_publication::INT), 1) AS direct
        FROM lot_competition WHERE year <= 2025 GROUP BY 1 ORDER BY 1""")
    dsplit = f"""round(100 * avg(no_publication::INT) FILTER (WHERE year BETWEEN {BEFORE[0]} AND {BEFORE[1]}), 1) AS before,
                 round(100 * avg(no_publication::INT) FILTER (WHERE year BETWEEN {AFTER[0]} AND {AFTER[1]}), 1) AS after"""
    n["direct_pooled"] = one(con, f"SELECT {dsplit} FROM lot_competition")
    n["direct_by_category"] = rows(con, f"""
        SELECT division, d.label, count(*) FILTER (WHERE no_publication AND year BETWEEN {AFTER[0]} AND {AFTER[1]}) AS direct_lots_after,
          {dsplit}
        FROM lot_competition LEFT JOIN cpv_divisions d USING (division)
        GROUP BY ALL HAVING count(*) >= 1500 ORDER BY after - before DESC""")
    n["direct_by_buyer_type"] = rows(con, f"""
        SELECT b.kind, count(*) AS lots, {dsplit}
        FROM lot_competition JOIN buyers b USING (buyer_id) GROUP BY ALL HAVING count(*) >= 1000 ORDER BY lots DESC""")

    # concentration: how many buyer x category x period cells can be compared, and how many are flagged
    n["cells"] = rows(con, """
        SELECT comparability, count(*) AS cells FROM flags WHERE period <> 'all' GROUP BY 1 ORDER BY 2 DESC""")
    f = one(con, """
        SELECT count(*) AS cells, count(*) FILTER (WHERE comparability = 'comparable') AS comparable,
          count(*) FILTER (WHERE unusual) AS unusual, count(DISTINCT buyer_id) FILTER (WHERE unusual) AS buyers_flagged
        FROM flags WHERE period <> 'all'""")
    f["comparable_pct"] = r1(100 * f["comparable"] / f["cells"])
    f["unusual_pct_of_comparable"] = r1(100 * f["unusual"] / f["comparable"])
    n["flags"] = f
    n["flags_by_buyer_type"] = rows(con, """
        SELECT kind, count(*) FILTER (WHERE comparability = 'comparable') AS comparable, count(*) FILTER (WHERE unusual) AS unusual
        FROM flags WHERE period <> 'all' GROUP BY 1 ORDER BY 3 DESC, 2 DESC""")
    # flags where every award to the dominant supplier in that cell was published within 90 days:
    # one purchasing round published as several procedures, not a repeated choice over the years
    n["flags_batch"] = rows(con, """
        WITH f AS (SELECT * FROM flags WHERE unusual AND period <> 'all'),
        p AS (SELECT * FROM (VALUES ('2016-2018', 2016, 2018), ('2019-2021', 2019, 2021), ('2022-2024', 2022, 2024),
                                    ('2025-2026', 2025, 2026)) t(period, y0, y1)),
        a AS (SELECT f.buyer_id, f.division, f.period, f.kind, max(a.published) - min(a.published) AS span_days,
                count(DISTINCT a.ocid) AS n_procs
              FROM f JOIN p USING (period)
              JOIN awards a ON a.buyer_id = f.buyer_id AND a.division = f.division AND a.supplier_key = f.top_supplier
                           AND a.year BETWEEN p.y0 AND p.y1
              GROUP BY ALL)
        SELECT coalesce(kind, 'All') AS kind, count(*) AS flags, count(*) FILTER (WHERE span_days <= 90) AS within_90_days,
          count(*) FILTER (WHERE span_days <= 90 AND n_procs = 1) AS within_90_days_one_procedure,
          median(span_days) AS median_span_days
        FROM a GROUP BY ROLLUP (kind) ORDER BY flags DESC""")
    # found by reading the 61 flags: the top "supplier" is the placeholder KvK 12345678 or the buyer itself
    n["flags_record_errors"] = rows(con, f"""
        SELECT f.buyer_id, f.division, f.period, b.name AS buyer, s.name AS top_supplier, s.kvk
        FROM flags f JOIN buyers b USING (buyer_id) JOIN suppliers s ON s.supplier_key = f.top_supplier
        WHERE f.unusual AND (f.buyer_id, f.division, f.period) IN ({", ".join(f"('{b}', '{d}', '{p}')" for b, d, p in FLAG_ERRORS)})
        ORDER BY 1""")
    # the 61 flags split into: record errors, one round of purchasing (within 90 days, not an error), the rest
    errs = ", ".join(f"('{b}', '{d}', '{p}')" for b, d, p in FLAG_ERRORS)
    n["flags_explained"] = one(con, f"""
        WITH f AS (SELECT * FROM flags WHERE unusual AND period <> 'all'),
        p AS (SELECT * FROM (VALUES ('2016-2018', 2016, 2018), ('2019-2021', 2019, 2021), ('2022-2024', 2022, 2024),
                                    ('2025-2026', 2025, 2026)) t(period, y0, y1)),
        a AS (SELECT f.buyer_id, f.division, f.period, max(a.published) - min(a.published) AS span_days
              FROM f JOIN p USING (period)
              JOIN awards a ON a.buyer_id = f.buyer_id AND a.division = f.division AND a.supplier_key = f.top_supplier
                           AND a.year BETWEEN p.y0 AND p.y1
              GROUP BY ALL),
        c AS (SELECT *, (buyer_id, division, period) IN ({errs}) AS error FROM a)
        SELECT count(*) AS flags, count(*) FILTER (WHERE error) AS record_errors,
          count(*) FILTER (WHERE error AND span_days <= 90) AS errors_within_90_days,
          count(*) FILTER (WHERE NOT error AND span_days <= 90) AS one_round_not_error,
          count(*) FILTER (WHERE NOT error AND span_days > 90) AS remaining
        FROM c""")
    n["persistence"] = rows(con, """
        SELECT n_periods, count(*) AS buyer_category_pairs FROM persistence GROUP BY 1 ORDER BY 1""")

    # suppliers: the national market is fragmented
    n["suppliers"] = one(con, """
        WITH w AS (SELECT supplier_key, sum(weight) AS w FROM awards GROUP BY 1),
        r AS (SELECT *, row_number() OVER (ORDER BY w DESC, supplier_key) AS rk FROM w)
        SELECT count(*) AS suppliers, round(100 * sum(w) FILTER (WHERE rk <= 10) / sum(w), 1) AS top10_share,
          round(100 * sum(w) FILTER (WHERE rk <= 100) / sum(w), 1) AS top100_share,
          round(100 * count(*) FILTER (WHERE w <= 1) / count(*), 1) AS at_most_one_lot_weighted_pct
        FROM r""")
    n["suppliers"]["exactly_one_distinct_lot_pct"] = one(con, """
        SELECT round(100 * avg((nl = 1)::INT), 1) AS p
        FROM (SELECT supplier_key, count(DISTINCT (ocid, lot_id)) AS nl FROM awards GROUP BY 1)""")["p"]
    n["placeholder_kvk_12345678"] = one(con, """
        SELECT count(DISTINCT supplier_name) AS names, count(*) AS awards FROM awards WHERE supplier_kvk = '12345678'""")
    n["local_by_municipality_size"] = rows(con, """
        WITH a AS (SELECT a.weight, b.size_band, s.municipality_code = b.municipality_code AS local,
                     s.province = b.province AS same_province
                   FROM awards a JOIN buyers b USING (buyer_id) JOIN suppliers s USING (supplier_key)
                   WHERE b.kind = 'Municipality' AND b.size_band LIKE '%residents' AND s.municipality_code IS NOT NULL)
        SELECT size_band, round(sum(weight)) AS lots, round(100 * sum(weight) FILTER (WHERE local) / sum(weight), 1) AS local,
          round(100 * sum(weight) FILTER (WHERE same_province) / sum(weight), 1) AS same_province
        FROM a GROUP BY 1 ORDER BY 1""")

    # the record itself
    n["record_by_year"] = rows(con, """
        WITH p AS (SELECT year(first_published) AS year, status FROM procedures),
        a AS (SELECT year, round(100 * avg(has_kvk::INT), 1) AS kvk,
                round(100 * sum(weight * (value IS NOT NULL)::INT) / sum(weight), 1) AS value_known FROM awards GROUP BY 1)
        SELECT year, count(*) AS procedures,
          round(100 * count(*) FILTER (WHERE status = 'no_award_found')
                / count(*) FILTER (WHERE status IN ('awarded', 'no_award_found', 'terminated')), 1) AS no_award_found,
          any_value(a.kvk) AS kvk, any_value(a.value_known) AS value_known
        FROM p LEFT JOIN a USING (year) GROUP BY 1 ORDER BY 1""")
    # the estimate field mostly repeats the award value, so it can't measure what competition saves
    n["estimate_equals_award"] = one(con, """
        WITH nl AS (SELECT ocid, count(DISTINCT lot_id) AS nl FROM awards GROUP BY 1)
        SELECT count(*) AS awards,
          round(100 * avg((abs(a.value_reported / p.est_value - 1) < 0.001)::INT), 1) AS equal_pct
        FROM awards a JOIN nl USING (ocid) JOIN procedures p USING (ocid)
        WHERE nl = 1 AND a.n_lot_suppliers = 1 AND NOT a.value_suspect AND a.value >= 10000 AND p.est_value >= 10000""")
    return n


# ---------------------------------------------------------------- figures
def esc(s):
    return html.escape(str(s), quote=True)


def pct(v, d=1):
    return f"{v:.{d}f}%"


def data_table(head, body):
    th = "".join(f"<th>{esc(h)}</th>" for h in head)
    tr = "".join("<tr>" + "".join(f"<td>{esc(c)}</td>" for c in r) + "</tr>" for r in body)
    return (f'<details class="fig-data"><summary>Show the numbers</summary><div class="tbl">'
            f'<table><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table></div></details>')


def figure(fid, title, sub, inner, note):
    return (f'<figure class="fig" id="{fid}">\n<figcaption><strong>{esc(title)}</strong>'
            f'<span>{esc(sub)}</span></figcaption>\n{inner}\n<p class="fig-note">{esc(note)}</p>\n</figure>')


def line_chart(xs, series, ymax, yticks, tips, inline_labels=(), height=220):
    """series: [{cls, label, values}], values in % units. inline_labels: (series index, x index, 'above'|'below')."""
    nx = len(xs)
    X = [100 * i / (nx - 1) for i in range(nx)]
    Y = lambda v: 100 * v / ymax  # noqa: E731  (% from bottom)
    out = [f'<div class="lc" style="--h:{height}px">', '<div class="plot">']
    for t in yticks:
        out.append(f'<div class="gl" style="bottom:{Y(t):.2f}%"><span>{t}%</span></div>')
    out.append('<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">')
    for s in series:
        pts = " ".join(f"{x:.3f},{100 - Y(v):.3f}" for x, v in zip(X, s["values"]))
        out.append(f'<polyline class="ln {s["cls"]}" points="{pts}"/>')
    out.append("</svg>")
    # end markers and end values (nudged apart when they would overlap)
    ends = sorted(((Y(s["values"][-1]) / 100 * height, s) for s in series), key=lambda e: e[0])
    placed = []
    for px, s in ends:
        if placed and px - placed[-1][0] < 16:
            mid = (px + placed[-1][0]) / 2
            placed[-1] = (mid - 8, placed[-1][1])
            px = mid + 8
        placed.append((px, s))
    for s in series:
        out.append(f'<span class="pt {s["cls"]}" style="left:100%;bottom:{Y(s["values"][-1]):.2f}%"></span>')
    for px, s in placed:
        out.append(f'<span class="endv {s["cls"]}" style="bottom:{px:.1f}px">{pct(s["values"][-1])}</span>')
    for si, xi, where in inline_labels:
        s = series[si]
        off = "+ .5rem" if where == "above" else "- 1.6rem"
        out.append(f'<span class="inl {s["cls"]}" style="left:{X[xi]:.2f}%;bottom:calc({Y(s["values"][xi]):.2f}% {off})">'
                   f'{esc(s["label"])}</span>')
    # hover / focus targets, one per x value
    w = 100 / (nx - 1)
    for i, x in enumerate(X):
        dots = "".join(f'<b class="{s["cls"]}" style="bottom:{Y(s["values"][i]):.2f}%"></b>' for s in series)
        out.append(f'<span class="hit" tabindex="0" style="left:{x:.3f}%;width:{w:.3f}%" '
                   f'data-tip="{esc(tips[i])}" aria-label="{esc(tips[i])}"><i></i>{dots}</span>')
    out.append("</div>")
    out.append('<div class="xa" aria-hidden="true">' + "".join(
        f'<span class="{"minor" if i % 3 and i < nx - 1 else ""}" style="left:{x:.3f}%">{xs[i]}</span>' for i, x in enumerate(X))
               + "</div>")  # phones show every third year plus the last
    out.append("</div>")
    return "\n".join(out)


def legend(items):
    return '<div class="legend">' + "".join(f'<span class="key {c}">{esc(l)}</span>' for c, l in items) + "</div>"


def dumbbell(items, xmax, ticks, a_label, b_label):
    """items: [{label, a, b, tip}] in % units; a = before (blue), b = after (accent)."""
    X = lambda v: 100 * v / xmax  # noqa: E731
    out = ['<div class="db">', '<div class="db-grid" aria-hidden="true">']
    for t in ticks:
        out.append(f'<span style="left:{X(t):.2f}%"><em>{t}%</em></span>')
    out.append("</div>")
    for it in items:
        lo, hi = sorted((it["a"], it["b"]))
        out.append(
            f'<div class="db-row" tabindex="0" data-tip="{esc(it["tip"])}" aria-label="{esc(it["tip"])}">'
            f'<span class="db-lab">{esc(it["label"])}</span><span class="db-track">'
            f'<i class="db-con" style="left:{X(lo):.2f}%;width:{X(hi) - X(lo):.2f}%"></i>'
            f'<b class="s2" style="left:{X(it["a"]):.2f}%"></b><b class="s1" style="left:{X(it["b"]):.2f}%"></b>'
            f'<em class="db-v" style="left:{X(max(it["a"], it["b"])):.2f}%">{pct(it["b"])}</em></span></div>')
    out.append("</div>")
    return legend([("s2", a_label), ("s1", b_label)]) + "\n" + "\n".join(out)


def hbars(items, xmax):
    """items: [{label, value, display, cls, tip}]"""
    out = ['<div class="hb">']
    for it in items:
        out.append(
            f'<div class="hb-row" tabindex="0" data-tip="{esc(it["tip"])}" aria-label="{esc(it["tip"])}">'
            f'<span class="hb-lab">{esc(it["label"])}</span><span class="hb-track" style="--w:{100 * it["value"] / xmax:.2f}%">'
            f'<i class="{it["cls"]}"></i>'
            f'<em>{esc(it["display"])}</em></span></div>')
    out.append("</div>")
    return "\n".join(out)


def figures(n):
    figs = {}
    by = n["bidders_by_year"]
    years = [r["year"] for r in by]
    one_ = [r["one"] for r in by]
    six = [r["six_plus"] for r in by]
    tips = [f"{r['year']}\nOne bid: {pct(r['one'])}\nSix or more: {pct(r['six_plus'])}\n{r['lots']:,} lots" for r in by]
    figs["bidders"] = figure(
        "fig-bidders", "Lots with a single bid are now as common as lots with six or more",
        "Share of competitively tendered lots by number of bids received, by year of award",
        legend([("s1", "One bid"), ("s2", "Six or more bids")]) + "\n" + line_chart(
            years, [{"cls": "s1", "label": "One bid", "values": one_},
                    {"cls": "s2", "label": "Six or more", "values": six}],
            35, [0, 10, 20, 30], tips, inline_labels=[(1, 1, "above"), (0, 1, "below")])
        + "\n" + data_table(["Year", "Lots", "One bid", "Two", "3–5", "Six or more", "Median bids"],
                            [[r["year"], f"{r['lots']:,}", pct(r["one"]), pct(r["two"]), pct(r["three_to_five"]),
                              pct(r["six_plus"]), f"{r['median_bids']:g}"] for r in by]),
        "Awarded lots with a known bid count, excluding direct awards. 2026 (January to June) not shown. "
        "Source: TenderNed open data, own processing.")

    cats = n["one_bid_by_category"]
    figs["categories"] = figure(
        "fig-categories", "Single bids became more common in almost every large category",
        "Share of competitively tendered lots that received one bid",
        dumbbell([{"label": c["label"], "a": c["before"], "b": c["after"],
                   "tip": f"{c['label']}\n{BEFORE[0]}–{BEFORE[1]}: {pct(c['before'])}\n{AFTER[0]}–{AFTER[1]}: {pct(c['after'])}\n{c['lots']:,} lots"}
                  for c in cats], 30, [0, 10, 20, 30], f"{BEFORE[0]}–{BEFORE[1]}", f"{AFTER[0]}–{AFTER[1]}")
        + "\n" + data_table(["Category (CPV division)", "Lots", f"{BEFORE[0]}–{BEFORE[1]}", f"{AFTER[0]}–{AFTER[1]}"],
                            [[f"{c['label']} ({c['division']})", f"{c['lots']:,}", pct(c["before"]), pct(c["after"])] for c in cats]),
        "The twelve categories with at least 2,000 lots with a known bid count. Source: TenderNed open data, own processing.")

    d = n["direct_by_year"]
    figs["direct"] = figure(
        "fig-direct", "Direct awards went from 1 in 30 lots to 1 in 7",
        "Share of awarded lots given without a prior call for competition, by year of award",
        line_chart([r["year"] for r in d], [{"cls": "s1", "label": "Direct awards", "values": [r["direct"] for r in d]}],
                   16, [0, 5, 10, 15], [f"{r['year']}\nDirect awards: {pct(r['direct'])}\n{r['lots']:,} awarded lots" for r in d])
        + "\n" + data_table(["Year", "Awarded lots", "Direct awards"], [[r["year"], f"{r['lots']:,}", pct(r["direct"])] for r in d]),
        "Procedures registered as negotiated without prior publication. Only direct awards that were published "
        "on TenderNed are counted. Source: TenderNed open data, own processing.")

    labels = {"comparable": "Comparable", "small sample": "Too small (under 5 lots or 3 procedures)",
              "too few peers": "Fewer than 5 similar buyers", "limited data": "Too many gaps in the record"}
    total = sum(c["cells"] for c in n["cells"])
    order = ["comparable", "too few peers", "limited data", "small sample"]  # the order the tests are applied in
    cells = sorted(n["cells"], key=lambda c: order.index(c["comparability"]))
    figs["cells"] = figure(
        "fig-cells", "Most buyer–category combinations can't be judged",
        f"{total:,} combinations of buyer, category and three-year period with at least 3 awarded lots",
        hbars([{"label": labels[c["comparability"]], "value": c["cells"],
                "display": f"{c['cells']:,} · {100 * c['cells'] / total:.0f}%",
                "cls": "s1" if c["comparability"] == "comparable" else "s0",
                "tip": f"{labels[c['comparability']]}\n{c['cells']:,} of {total:,}"} for c in cells], 3000),
        "Each combination is counted under the first test it fails, in this order: similar buyers, gaps in the record "
        "(under 60% of awards identify the supplier by KvK number, or over 30% of procedures have no published award), "
        "size. Source: TenderNed open data, own processing.")
    return figs


def inject(post: Path, figs):
    text = post.read_text()
    for name, body in figs.items():
        pat = re.compile(rf"(<!-- fig:{name} -->).*?(<!-- /fig:{name} -->)", re.S)
        if not pat.search(text):
            raise SystemExit(f"marker <!-- fig:{name} --> not found in {post}")
        text = pat.sub(lambda m: f"{m.group(1)}\n{body}\n{m.group(2)}", text)
    post.write_text(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "data" / "static" / "data"), help="folder with the exported Parquet tables")
    ap.add_argument("--post", help="blog post HTML whose figure blocks to replace")
    args = ap.parse_args()
    con = connect(Path(args.data))
    n = compute(con)
    out = ROOT / "analysis" / "out"
    out.mkdir(parents=True, exist_ok=True)
    (out / "numbers.json").write_text(json.dumps(n, indent=2, default=str) + "\n")
    print(f"wrote {out / 'numbers.json'}")
    if args.post:
        inject(Path(args.post), figures(n))
        print(f"updated figures in {args.post}")


if __name__ == "__main__":
    main()
