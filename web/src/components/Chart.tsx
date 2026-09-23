import { useEffect, useState, type ReactNode } from 'react'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption } from 'echarts'

export type Tokens = Record<
  'surface' | 'ink' | 'ink2' | 'muted' | 'hair' | 'axis' | 's1' | 's2' | 's3' | 's4' | 'serious' | 'peer' | 'empty',
  string
> & { seq: string[] }

function readTokens(): Tokens {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  return {
    surface: v('--surface'), ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'), hair: v('--hair'),
    axis: v('--axis'), s1: v('--series-1'), s2: v('--series-2'), s3: v('--series-3'), s4: v('--series-4'),
    serious: v('--serious'), peer: v('--peer-band'), empty: v('--map-empty'),
    seq: [1, 2, 3, 4, 5].map((i) => v(`--seq-${i}`)),
  }
}

/** Colour tokens that follow the light/dark scheme. */
export function useTokens() {
  const [t, setT] = useState<Tokens>(readTokens)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setT(readTokens())
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return t
}

/** Shared chrome: recessive hairline grid, muted axis text, sans font, tooltip on the surface. */
export function base(t: Tokens): EChartsOption {
  return {
    textStyle: { fontFamily: "'Public Sans', system-ui, sans-serif", color: t.ink2 },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      backgroundColor: t.surface, borderColor: t.hair, borderWidth: 1,
      textStyle: { color: t.ink, fontSize: 13 }, extraCssText: 'box-shadow:0 6px 18px rgba(10,20,40,.12);border-radius:8px;',
    },
    animationDuration: 300,
  }
}

export const axisCat = (t: Tokens) => ({
  axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false },
  axisLabel: { color: t.muted, fontSize: 12 },
})
export const axisVal = (t: Tokens) => ({
  splitLine: { lineStyle: { color: t.hair, width: 1 } }, axisLine: { show: false }, axisTick: { show: false },
  axisLabel: { color: t.muted, fontSize: 12 },
})

export function Chart({ option, height = 260, table, onEvents }: {
  option: EChartsOption; height?: number; table?: ReactNode; onEvents?: Record<string, (p: any) => void>
}) {
  const [showTable, setShowTable] = useState(false)
  return (
    <div>
      {showTable && table ? table : (
        <ReactECharts option={option} style={{ height, width: '100%' }} notMerge onEvents={onEvents} opts={{ renderer: 'svg' }} />
      )}
      {table && (
        <div className="row small" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="link" onClick={() => setShowTable((s) => !s)}>{showTable ? 'Show chart' : 'Show as table'}</button>
        </div>
      )}
    </div>
  )
}
