#!/usr/bin/env sh
# Download the official (signed) DuckDB-WASM Parquet extension so the static site can load it from its own
# origin instead of extensions.duckdb.org at runtime. The version must match the DuckDB core bundled in
# @duckdb/duckdb-wasm (1.32.0 ships DuckDB v1.4.3); bump both together.
set -eu
V=v1.4.3
cd "$(dirname "$0")/.."
for P in wasm_eh wasm_mvp; do
  mkdir -p "public/duckdb-ext/$V/$P"
  F="public/duckdb-ext/$V/$P/parquet.duckdb_extension.wasm"
  [ -s "$F" ] || curl -fsSL "https://extensions.duckdb.org/$V/$P/parquet.duckdb_extension.wasm" -o "$F"
done
echo "duckdb extensions ready ($V)"
