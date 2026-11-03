"""Export the tables the dashboard reads to Parquet for the static (browser-only) build.

The static site runs DuckDB-WASM in the browser and loads these files on demand, so no server is needed.

    uv run python etl/export_static.py                    # reads data/tenders.duckdb
    uv run python etl/export_static.py --db /path/to/tenders.duckdb

Writes web/public/data/*.parquet, municipalities.geojson, manifest.json and snap/ (precomputed default views). Run it after etl/model.py,
then build the frontend with `pnpm build:static` in web/.
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "data"

# table -> columns to keep (None = all). Only what the dashboard queries.
TABLES = {
    "awards": None,
    "bids": None,
    "buyer_activity": None,
    "buyer_supplier_cells": None,
    "buyers": None,
    "competition_scores": None,
    "concentration": None,
    "cpv_divisions": None,
    "data_cutoff": None,
    "edges": None,
    "flags": None,
    "lot_competition": None,
    "notices": ["ocid", "notice_id", "published", "notice_type", "notice_label", "title"],
    "periods": None,
    "persistence": None,
    "procedures": None,
    "suppliers": None,
}

# Requests each page makes on first load with its default filters (path?query, keys sorted, empty values dropped,
# exactly as web/src/api.ts builds them). These are precomputed with the real API so the first view of every
# page appears without starting DuckDB-WASM. Update this list if a page's default filters change.
SNAPSHOTS = [
    "meta",
    "overview",
    "buyers?limit=500",
    "peers?division=45&kind=Municipality&period=2022-2024",
    "flags?limit=500&only_unusual=true&persistent=false",
    "competition?period=2022-2024",
    "map?period=2022-2024",
    "gaps",
]


def write_snapshots(db: Path):
    """Start the FastAPI app on a free port against `db`, save the default responses, stop it."""
    out = OUT / "snap"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "TT_DB": str(db)}
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "api.main:app", "--port", str(port), "--log-level", "warning"],
                            cwd=ROOT, env=env)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/meta", timeout=2)
                break
            except OSError:
                time.sleep(0.2)
        index = {}
        for i, key in enumerate(SNAPSHOTS):
            body = urllib.request.urlopen(f"http://127.0.0.1:{port}/api/{key}", timeout=120).read()
            name = f"s{i}.json"
            (out / name).write_bytes(body)
            index[key] = name
            print(f"snapshot {key:55s} {len(body) / 1e3:7.1f} kB")
        (out / "index.json").write_text(json.dumps(index, indent=2))
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "data" / "tenders.duckdb"))
    args = ap.parse_args()
    db = Path(args.db)
    con = duckdb.connect(str(db), read_only=True, config={"memory_limit": "1GB", "threads": "2"})

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.parquet"):
        old.unlink()

    sizes = {}
    for table, cols in TABLES.items():
        sel = ", ".join(cols) if cols else "*"
        order = " ORDER BY ocid" if table == "notices" else ""
        path = OUT / f"{table}.parquet"
        con.execute(f"COPY (SELECT {sel} FROM {table}{order}) TO '{path}' (FORMAT parquet, COMPRESSION zstd)")
        sizes[table] = path.stat().st_size
        print(f"{table:22s} {sizes[table] / 1e6:6.1f} MB")

    boundaries = sorted((db.parent / "cache").glob("municipalities_*.geojson"))
    boundary_year = None
    if boundaries:
        shutil.copyfile(boundaries[-1], OUT / "municipalities.geojson")
        boundary_year = boundaries[-1].stem.split("_")[-1]

    manifest = {
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "boundary_year": boundary_year,
        "tables": sizes,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    con.close()
    write_snapshots(db)
    print(f"total {sum(sizes.values()) / 1e6:.1f} MB -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
