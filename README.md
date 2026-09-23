# Tender Transparency NL

Interactive dashboard for exploring who wins Dutch public contracts, how concentrated
purchasing is compared with similar buyers, and where the published record is incomplete.
Source: [TenderNed open data](https://www.tenderned.nl/cms/nl/aanbesteden-in-cijfers/datasets-aanbestedingen)
(OCDS JSON, 2016 onwards), enriched with PDOK (municipality, province) and CBS (population).

## Run

```bash
uv sync
cd web && pnpm install && pnpm build && cd ..
uv run uvicorn api.main:app --port 8000     # serves API + built frontend on http://localhost:8000
```

For frontend development, run `pnpm dev` in `web/` (proxies `/api` to port 8000).

## Build or refresh the data

TenderNed publishes a new dataset every six months.

```bash
# download the yearly JSON files into data/raw/ (links on the TenderNed dataset page)
uv run python etl/ingest.py    # raw notices, parties, lots, bids, awards  (~1.5 min)
uv run python etl/enrich.py    # PDOK geocoding, CBS population, municipal boundaries; cached in data/cache/
uv run python etl/model.py     # procedures, awards, buyers, suppliers, peer metrics
```

Stop the API first: DuckDB allows only one writer.

## Layout

- `etl/ingest.py`: OCDS releases to raw DuckDB tables
- `etl/enrich.py`: postcode/municipality/province lookups, population and map boundaries
- `etl/model.sql`: all analysis logic: procedure linking, supplier identity, buyer roll-up, value cleaning, concentration, competition, peer groups, flags
- `api/main.py`: read-only FastAPI JSON API over `data/tenders.duckdb`
- `web/`: React + Vite + ECharts dashboard

## Method in brief

The in-app page "How to read this" is the full reference. Key choices:

- Award notices imported from Mercell often carry a new procedure ID. They are re-attached to the open contract notice with the same buyer and the same title or buyer reference, which cut the apparent "no award found" rate from about 22% to about 12% in 2023–2024.
- Each lot counts once and is split between its winners, so open-house admission procedures with hundreds of suppliers don't dominate.
- Suppliers are keyed by KvK number. Before 2024 many notices only give a name; unambiguous names are matched to KvK numbers seen in other notices.
- Municipal departments are rolled up to the municipality (CBS code). Peers are buyers of the same type and size band, in the same CPV division and three-year period.
- Competition: tenders received per lot, the share of competitive lots with a single tender, and the share of lots awarded without prior publication. Before eForms (late 2023) tender counts are per procedure, so multi-lot procedures only count when a single tender came in. Staffing platforms that report "1 tender" by default are excluded per year. "Few bidders" flags buyers where at least half the lots drew one tender, 25 points above the peer median.
- A flag ("unusual") needs at least 5 lots from at least 3 procedures, at least 5 peers, and adequate data. The top supplier must hold at least 50%, the buyer must be in the top 10% of peers by HHI, and the share must be at least 20 points above the peer median. A flag is a prompt to look closer, not a finding.

## Scope

Netherlands only, TenderNed only. The model keeps country-specific parts (buyer typing,
CBS population, PDOK) separate so other countries (for example TED data) can be added later.
