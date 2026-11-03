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
  v === null || v === undefined ? '–' : Math.abs(v - Math.round(v)) < 0.05 ? nf.format(Math.round(v)) : num(v, 1)

export const bandLabel = (b: string | null | undefined) => (b ? b.replace(/^\d:\s*/, '') : '–')

/** TenderNed procedure types in English; the Dutch term stays available as a tooltip. */
const PROCEDURE_EN: Record<string, string> = {
  'Openbaar': 'Open',
  'Niet-openbaar': 'Restricted',
  'Onderhandelingsprocedure zonder voorafgaande oproep tot mededinging': 'Negotiated, no prior call for competition',
  'Onderhandeling zonder bekendmaking': 'Negotiated without publication',
  'Mededingingsprocedure met onderhandeling': 'Competitive with negotiation',
  'Concurrentiegerichte dialoog': 'Competitive dialogue',
  'Concurrentiegerichte aanbesteding': 'Competitive tendering',
  'Innovatiepartnerschap': 'Innovation partnership',
  'Marktconsultatie': 'Market consultation',
  'Onderhandse procedure': 'Invited (private) procedure',
  'Procedure IIB diensten': 'Part IIB services',
  'Andere procedure in één fase': 'Other single-stage procedure',
  'Andere procedure in meerdere fasen': 'Other multi-stage procedure',
  'Open House': 'Open house',
}
export const procedureLabel = (p: string | null | undefined) =>
  !p || p === 'unknown' ? 'Type not stated' : PROCEDURE_EN[p] ?? p

/** Europees / Nationaal publication regime. */
export const scopeLabel = (s: string | null | undefined) =>
  s === 'Europees' ? 'EU threshold' : s === 'Nationaal' ? 'National' : ''

const SMALL = new Set(['aan', 'den', 'de', 'der', 'het', 'op', 'in', 'bij', 'van', 'en', 'onder', 'over'])
/** Some notices give the place in capitals; show it like the rest ("ALBLASSERDAM" → "Alblasserdam"). */
export function place(v: string | null | undefined) {
  if (!v || v !== v.toUpperCase() || !/[A-Z]/.test(v)) return v ?? ''
  return v.toLowerCase().replace(/[^\s-]+/g, (w, i: number) => {
    if (/^'[st]$/.test(w)) return w
    if (i > 0 && SMALL.has(w)) return w
    return w.startsWith('ij') ? 'IJ' + w.slice(2) : w[0].toUpperCase() + w.slice(1)
  })
}
