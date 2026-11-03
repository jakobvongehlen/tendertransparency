/**
 * DuckDB-WASM in the browser: the static build's replacement for api/main.py's DuckDB connection.
 * Tables are Parquet files under <base>/data/, downloaded on first use and loaded into memory.
 */
import * as duckdb from '@duckdb/duckdb-wasm'
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'

export type Row = Record<string, any>

export const DATA = `${import.meta.env.BASE_URL}data/`

let conn: Promise<duckdb.AsyncDuckDBConnection> | null = null
let db: duckdb.AsyncDuckDB | null = null
const loaded = new Map<string, Promise<void>>()

// ---- download progress, for the loading indicator (components subscribe with onProgress)
export type Progress = { active: boolean; loaded: number; total: number; items: { name: string; done: boolean }[] }
type Item = { name: string; size: number; got: number; expect: number; done: boolean }
const items = new Map<string, Item>()
const listeners = new Set<(p: Progress) => void>()
const ENGINE_MB = 8 // compressed transfer size of the DuckDB-WASM engine, for display only
function emit() {
  const all = [...items.values()]
  const active = all.some((i) => !i.done)
  const p: Progress = {
    active,
    total: all.reduce((s, i) => s + i.size, 0),
    loaded: all.reduce((s, i) => s + (i.done ? i.size : i.size * Math.min(i.got / i.expect, 0.98)), 0),
    items: all.map((i) => ({ name: i.name, done: i.done })),
  }
  if (!active) items.clear() // next batch starts from zero
  listeners.forEach((f) => f(p))
}
export function onProgress(f: (p: Progress) => void) {
  listeners.add(f)
  return () => { listeners.delete(f) }
}

/** fetch with byte progress; `expect` is the uncompressed size (what the stream reader counts) */
async function download(name: string, url: string, size: number, expect: number): Promise<Uint8Array> {
  const it: Item = { name, size, got: 0, expect: Math.max(expect, 1), done: false }
  items.set(name, it)
  emit()
  try {
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`${res.status} could not load ${name}`)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let last = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      it.got += value.length
      if (performance.now() - last > 120) { last = performance.now(); emit() }
    }
    const buf = new Uint8Array(it.got)
    let o = 0
    for (const c of chunks) { buf.set(c, o); o += c.length }
    return buf
  } finally {
    it.done = true
    emit()
  }
}

type Manifest = { tables?: Record<string, number>; boundary_year?: string }
let manifest: Promise<Manifest> | null = null
export const getManifest = (): Promise<Manifest> => (manifest ??= fetch(`${DATA}manifest.json`)
  .then((r): Promise<Manifest> => (r.ok ? r.json() : Promise.resolve({})))
  .catch((): Manifest => ({})))

function connect() {
  conn ??= (async () => {
    const bundle = await duckdb.selectBundle({
      mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
      eh: { mainModule: ehWasm, mainWorker: ehWorker },
    })
    // download the engine ourselves to show progress, then hand it to DuckDB as a blob URL
    const wasm = await download('database engine', bundle.mainModule, ENGINE_MB * 1e6,
      bundle.mainModule === ehWasm ? 34.2e6 : 39.4e6)
    const wasmUrl = URL.createObjectURL(new Blob([wasm as BlobPart], { type: 'application/wasm' }))
    const worker = new Worker(bundle.mainWorker!)
    db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
    await db.instantiate(wasmUrl, bundle.pthreadWorker)
    URL.revokeObjectURL(wasmUrl)
    await db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } })
    const c = await db.connect()
    // Parquet support is an extension; load it from this site (scripts/fetch-duckdb-ext.sh), never from
    // extensions.duckdb.org, and don't autoload anything else, so visitors' browsers only talk to this origin.
    await c.query(`SET autoinstall_known_extensions = false; SET autoload_known_extensions = false`)
    await c.query(`SET custom_extension_repository = '${new URL(`${import.meta.env.BASE_URL}duckdb-ext`, location.href).href}'`)
    await c.query(`INSTALL parquet; LOAD parquet`)
    return c
  })()
  conn.catch(() => { conn = null }) // allow a retry
  return conn
}

/** Download and load the given tables once; downloads run in parallel with starting the engine. */
export async function ensure(tables: string[]) {
  const sizes = (await getManifest()).tables ?? {}
  const c = connect()
  await Promise.all(tables.map((t) => {
    if (!loaded.has(t)) {
      const p = (async () => {
        const size = sizes[t] ?? 1e6
        const buf = await download(t, `${DATA}${t}.parquet`, size, size)
        const cn = await c
        await db!.registerFileBuffer(`${t}.parquet`, buf)
        await cn.query(`CREATE TABLE IF NOT EXISTS ${t} AS SELECT * FROM read_parquet('${t}.parquet')`)
        await db!.dropFile(`${t}.parquet`)
      })()
      p.catch(() => loaded.delete(t)) // allow a retry after a failed download
      loaded.set(t, p)
    }
    return loaded.get(t)!
  }))
  await c
}

/** Start the engine and load the tables most pages need, in the background (no-op if already loaded). */
export function warm(tables: string[]) {
  ensure(tables).catch(() => {})
}

/** SQL string literal, for the few places where a list has to be inlined. */
export const lit = (s: string) => `'${String(s).replace(/'/g, "''")}'`

// ---- Arrow -> plain JSON, matching what FastAPI returned (dates as YYYY-MM-DD strings, lists as arrays)
const pad = (n: number) => String(n).padStart(2, '0')
const isoDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
const isoTs = (ms: number) => {
  const d = new Date(ms)
  return `${isoDate(ms)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

function conv(v: any, type: any): any {
  if (v === null || v === undefined) return null
  const id = type?.typeId
  if (id === 8) return isoDate(v instanceof Date ? v.getTime() : Number(v)) // Date
  if (id === 10) return isoTs(v instanceof Date ? v.getTime() : Number(v)) // Timestamp
  if (typeof v === 'bigint') return Number(v)
  if (id === 12 || id === 16) { // List / FixedSizeList
    const child = type.children?.[0]?.type
    return Array.from(v.toArray?.() ?? v, (x: any) => conv(x, child))
  }
  if (id === 13) { // Struct
    const o: Row = {}
    for (const f of type.children) o[f.name] = conv(v[f.name], f.type)
    return o
  }
  return v
}

/** Run a query with positional (?) or numbered ($1) parameters; returns plain objects. */
export async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const c = await connect()
  let table
  if (params.length) {
    const stmt = await c.prepare(sql)
    try { table = await stmt.query(...params) } finally { await stmt.close() }
  } else {
    table = await c.query(sql)
  }
  const fields = table.schema.fields
  const out: Row[] = []
  for (let i = 0; i < table.numRows; i++) {
    const r = table.get(i)!
    const o: Row = {}
    for (const f of fields) o[f.name] = conv((r as any)[f.name], f.type)
    out.push(o)
  }
  return out
}

export async function one(sql: string, params: unknown[] = []) {
  return (await q(sql, params))[0] ?? null
}
