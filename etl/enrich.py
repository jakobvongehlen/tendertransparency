"""Enrich buyers/suppliers with municipality, province and coordinates (PDOK
Locatieserver), municipalities with population (CBS StatLine 03759ned), and fetch
generalised municipal boundaries for the map (CBS/PDOK gebiedsindelingen).

Lookups are cached in data/cache so re-runs only hit the network for new values.
"""

import json
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb
import pyarrow as pa

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "tenders.duckdb"
CACHE = ROOT / "data" / "cache"
PDOK = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free"
CBS = "https://opendata.cbs.nl/ODataApi/odata/03759ned/TypedDataSet"
FIELDS = "gemeentenaam,gemeentecode,provincienaam,centroide_ll"
BOUNDARY_YEAR = 2026
BOUNDARIES = (
    f"https://service.pdok.nl/cbs/gebiedsindelingen/{BOUNDARY_YEAR}/wfs/v1_0?request=GetFeature&service=WFS"
    "&version=2.0.0&typeName=gemeente_gegeneraliseerd&outputFormat=json&srsName=EPSG:4326"
)


def get_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def pdok(query, fq):
    url = f"{PDOK}?" + urllib.parse.urlencode({"q": query, "fq": fq, "fl": FIELDS, "rows": 1})
    for _ in range(3):
        try:
            docs = get_json(url)["response"]["docs"]
            break
        except Exception:
            continue
    else:
        return None
    if not docs:
        return {}
    d = docs[0]
    m = re.match(r"POINT\(([\d.]+) ([\d.]+)\)", d.get("centroide_ll", ""))
    return dict(
        municipality=d.get("gemeentenaam"),
        municipality_code="GM" + d["gemeentecode"] if d.get("gemeentecode") else None,
        province=d.get("provincienaam"),
        lon=float(m[1]) if m else None,
        lat=float(m[2]) if m else None,
    )


def lookup(key):
    kind, value = key.split(":", 1)
    if kind == "pc":
        return pdok(f"postcode:{value}", "type:postcode")
    return pdok(value, "type:woonplaats")


def cached(name, keys, fn, workers=8):
    path = CACHE / f"{name}.json"
    cache = json.loads(path.read_text()) if path.exists() else {}
    todo = [k for k in keys if k not in cache]
    print(f"{name}: {len(keys)} keys, {len(todo)} to fetch")
    with ThreadPoolExecutor(workers) as ex:
        for i, (k, v) in enumerate(zip(todo, ex.map(fn, todo))):
            if v is not None:  # None = network failure, retry next run
                cache[k] = v
            if i % 1000 == 999:
                path.write_text(json.dumps(cache))
                print(f"  {i + 1}/{len(todo)}")
    path.write_text(json.dumps(cache))
    return cache


def boundaries():
    """Municipal boundaries as small GeoJSON: coordinates rounded to ~10 m, repeated points dropped."""
    path = CACHE / f"municipalities_{BOUNDARY_YEAR}.geojson"
    if path.exists():
        return

    def ring(pts):
        out = []
        for x, y in pts:
            p = [round(x, 4), round(y, 4)]
            if not out or out[-1] != p:
                out.append(p)
        return out if len(out) >= 4 else None

    features = []
    for f in get_json(BOUNDARIES)["features"]:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        polys = [[r for r in map(ring, poly) if r] for poly in polys]
        features.append(dict(
            type="Feature",
            properties=dict(code=f["properties"]["statcode"], name=f["properties"]["statnaam"]),
            geometry=dict(type="MultiPolygon", coordinates=[p for p in polys if p]),
        ))
    path.write_text(json.dumps(dict(type="FeatureCollection", features=features), separators=(",", ":")))
    print("boundaries", len(features), f"{path.stat().st_size / 1e6:.1f} MB")


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB))
    places = con.sql(
        """
        SELECT DISTINCT postal_code, locality FROM buyers_raw
        UNION SELECT DISTINCT postal_code, locality FROM suppliers_raw
        WHERE country IS NULL OR country IN ('Nederland', 'NL', 'NLD', 'Netherlands')
        """
    ).fetchall()
    keys = set()
    for pc, loc in places:
        if pc and re.fullmatch(r"\d{4}[A-Z]{2}", pc):
            keys.add("pc:" + pc)
        elif loc:
            keys.add("wp:" + loc.strip().lower())
    geo = cached("geo", sorted(keys), lookup)
    rows = [dict(geo_key=k, **v) for k, v in geo.items() if v]
    tbl = pa.Table.from_pylist(rows)  # noqa: F841
    con.execute("CREATE OR REPLACE TABLE geo AS SELECT * FROM tbl")

    pop_path = CACHE / "population.json"
    if not pop_path.exists():
        values = []
        for year in range(2015, 2027):
            flt = (
                "Geslacht eq 'T001038' and Leeftijd eq '10000' and BurgerlijkeStaat eq 'T001019' "
                f"and substring(RegioS,0,2) eq 'GM' and Perioden eq '{year}JJ00'"
            )
            url = f"{CBS}?" + urllib.parse.urlencode(
                {"$filter": flt, "$select": "RegioS,Perioden,BevolkingOp1Januari_1"}
            )
            values += get_json(url)["value"]
        pop_path.write_text(json.dumps(values))
    reg_path = CACHE / "regions.json"
    if not reg_path.exists():
        reg_path.write_text(json.dumps(get_json(CBS.replace("TypedDataSet", "RegioS"))["value"]))
    regions = [
        dict(municipality_code=v["Key"].strip(), name=v["Title"].strip())
        for v in json.loads(reg_path.read_text())
        if v["Key"].startswith("GM")
    ]
    tbl = pa.Table.from_pylist(regions)  # noqa: F841
    con.execute("CREATE OR REPLACE TABLE municipalities AS SELECT * FROM tbl")

    pop = [
        dict(municipality_code=v["RegioS"].strip(), year=int(v["Perioden"][:4]), population=v["BevolkingOp1Januari_1"])
        for v in json.loads(pop_path.read_text())
        if v["BevolkingOp1Januari_1"] and int(v["Perioden"][:4]) >= 2015
    ]
    tbl = pa.Table.from_pylist(pop)  # noqa: F841
    con.execute("CREATE OR REPLACE TABLE population AS SELECT * FROM tbl")
    print("geo", len(rows), "population rows", len(pop))
    boundaries()


if __name__ == "__main__":
    main()
