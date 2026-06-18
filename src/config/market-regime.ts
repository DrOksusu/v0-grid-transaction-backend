export type Regime = 'BOTTOM' | 'NEUTRAL' | 'TOP'
export type Series = '1y' | '2y' | '3y'

const env2y = {
  bottom: Number(process.env.REGIME_2Y_BOTTOM_CUTOFF ?? '0.65'),
  top: Number(process.env.REGIME_2Y_TOP_CUTOFF ?? '0.55'),
}

// 부동소수점 덧셈 오차 방지: 소수점 4자리로 반올림
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

// 2y 기준 ±5pt offset
export const REGIME_THRESHOLDS: Record<Series, { bottom: number; top: number }> = {
  '1y': { bottom: round4(env2y.bottom + 0.05), top: round4(env2y.top + 0.05) },
  '2y': { bottom: env2y.bottom, top: env2y.top },
  '3y': { bottom: round4(env2y.bottom - 0.05), top: round4(env2y.top - 0.05) },
}

export const MARKET_REGIME_CONFIG = {
  coinmetricsBase: process.env.COINMETRICS_API_BASE ?? 'https://community-api.coinmetrics.io/v4',
  coinmetricsApiKey: process.env.COINMETRICS_API_KEY ?? '',
  bitcoinDataBase: process.env.BITCOIN_DATA_API_BASE ?? 'https://bitcoin-data.com/api/v1',
  cron: process.env.MARKET_REGIME_CRON ?? '0 1 * * *',
  backfillYears: Number(process.env.MARKET_REGIME_BACKFILL_YEARS ?? '10'),
  reconcileThreshold: 0.05,
  fetchTimeoutMs: 30_000,
  retryDelaysMs: [10_000, 30_000, 90_000] as const,
} as const

export function classifyRegime(ratio: number, series: Series): Regime {
  const t = REGIME_THRESHOLDS[series]
  if (ratio >= t.bottom) return 'BOTTOM'
  if (ratio <= t.top) return 'TOP'
  return 'NEUTRAL'
}
