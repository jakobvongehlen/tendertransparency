const nf = new Intl.NumberFormat('en-GB')

export const num = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : nf.format(Number(v.toFixed(digits)))

export function compact(v: number | null | undefined) {
  if (v === null || v === undefined) return '–'
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'bn'
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'm'
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k'
  return nf.format(Math.round(v))
}

export const eur = (v: number | null | undefined) => (v === null || v === undefined ? '–' : '€' + compact(v))

export const pct = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : (v * 100).toFixed(digits) + '%'

/** lots are fractional when shared between suppliers; show 1 decimal only when needed */
export const lots = (v: number | null | undefined) =>
  v === null || v === undefined ? '–' : Math.abs(v - Math.round(v)) < 0.05 ? nf.format(Math.round(v)) : v.toFixed(1)

export const bandLabel = (b: string | null | undefined) => (b ? b.replace(/^\d:\s*/, '') : '–')
