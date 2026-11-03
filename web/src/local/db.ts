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

function connect() {
  conn ??= (async () => {
    const bundle = await duckdb.selectBundle({
      mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
      eh: { mainModule: ehWasm, mainWorker: ehWorker },
    })
    const worker = new Worker(bundle.mainWorker!)
    db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
    await db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } })
    const c = await db.connect()
    // Parquet support is an extension; load it from this site (scripts/fetch-duckdb-ext.sh), never from
    // extensions.duckdb.org, and don't autoload anything else, so visitors' browsers only talk to this origin.
    await c.query(`SET autoinstall_known_extensions = false; SET autoload_known_extensions = false`)
    await c.query(`SET custom_extension_repository = '${new URL(`${import.meta.env.BASE_URL}duckdb-ext`, location.href).href}'`)
    await c.query(`INSTALL parquet; LOAD parquet`)
    return c
  })()
  return conn
}

/** Download and load the given tables once (in parallel); later calls resolve immediately. */
export async function ensure(tables: string[]) {
  const c = await connect()
  await Promise.all(tables.map((t) => {
    if (!loaded.has(t)) {
      const p = (async () => {
        const res = await fetch(`${DATA}${t}.parquet`)
        if (!res.ok) throw new Error(`${res.status} could not load ${t}`)
        const buf = new Uint8Array(await res.arrayBuffer())
        await db!.registerFileBuffer(`${t}.parquet`, buf)
        await c.query(`CREATE TABLE IF NOT EXISTS ${t} AS SELECT * FROM read_parquet('${t}.parquet')`)
        await db!.dropFile(`${t}.parquet`)
      })()
      p.catch(() => loaded.delete(t)) // allow a retry after a failed download
      loaded.set(t, p)
    }
    return loaded.get(t)!
  }))
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
