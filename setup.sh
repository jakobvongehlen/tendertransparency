#!/usr/bin/env bash
# Build everything from scratch: dependencies, TenderNed data, cleaned DuckDB model, frontend.
# Safe to re-run: valid downloads and enrichment lookups (data/cache/) are reused.
#
#   ./setup.sh               full setup
#   ./setup.sh --no-download use the files already in data/raw/
#   ./setup.sh --no-web      skip the frontend build
set -euo pipefail
cd "$(dirname "$0")"

download=1 web=1
for arg in "$@"; do
  case $arg in
    --no-download) download=0 ;;
    --no-web) web=0 ;;
    -h|--help) sed -n 2,7p "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

step() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)" >&2; exit 1; }; }

need uv "https://docs.astral.sh/uv/"
[ $web = 1 ] && need pnpm "https://pnpm.io/installation"

# DuckDB allows one writer; ingest.py recreates the database file
if pgrep -f "[u]vicorn api[.]main" >/dev/null; then
  echo "The API (uvicorn api.main) is running and holds data/tenders.duckdb. Stop it first." >&2
  exit 1
fi

step "Python dependencies"
uv sync

if [ $download = 1 ]; then
  step "Download TenderNed datasets (~850 MB)"
  uv run python etl/download.py
fi
ls data/raw/Dataset_Tenderned-*.json >/dev/null 2>&1 || { echo "no datasets in data/raw/" >&2; exit 1; }

step "Ingest: OCDS releases to raw tables"
uv run python etl/ingest.py

step "Enrich: PDOK geocoding, CBS population, municipal boundaries (first run takes a while)"
uv run python etl/enrich.py

step "Model: linking, supplier identity, buyer roll-up, value cleaning, peer metrics"
uv run python etl/model.py

if [ $web = 1 ]; then
  step "Frontend"
  (cd web && pnpm install --frozen-lockfile && pnpm build)
fi

step "Done"
echo "Start the dashboard: uv run uvicorn api.main:app --port 8000   (http://localhost:8000)"
