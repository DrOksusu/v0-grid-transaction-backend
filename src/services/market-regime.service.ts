// BTC LTH (Long-Term Holder) regime 데이터 수집 서비스
// 외부 API 호출, 백필, 일별 폴링 기능 제공

import { MARKET_REGIME_CONFIG } from '../config/market-regime'
import {
  coinmetricsResponseSchema,
  type CoinmetricsRow,
  bitcoinDataHodlWavesSchema,
  type BitcoinDataHodlWavesRow,
  BD_LONG_TERM_BUCKETS,
} from './market-regime.schemas'
import prisma from '../config/database'

// 날짜를 YYYY-MM-DD 문자열로 변환
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// ============================================================
// 재시도 유틸 — delaysMs 배열 길이만큼 재시도
// ============================================================

export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[],
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= delaysMs.length; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i === delaysMs.length) break
      await new Promise((r) => setTimeout(r, delaysMs[i]))
    }
  }
  throw lastErr
}

// ============================================================
// bitcoin-data.com HODL 웨이브 API fetch
// ============================================================

export async function fetchFromBitcoinData(): Promise<BitcoinDataHodlWavesRow[]> {
  const url = `${MARKET_REGIME_CONFIG.bitcoinDataBase}/hodl-waves`
  const ctl = new AbortController()
  const to = setTimeout(() => ctl.abort(), MARKET_REGIME_CONFIG.fetchTimeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`bitcoin-data ${res.status}`)
    const json = await res.json()
    return bitcoinDataHodlWavesSchema.parse(json)
  } finally {
    clearTimeout(to)
  }
}

// ============================================================
// CoinMetrics 커뮤니티 API fetch
// ============================================================

export async function fetchFromCoinMetrics(
  start: Date,
  end: Date,
): Promise<CoinmetricsRow[]> {
  const params = new URLSearchParams({
    assets: 'btc',
    metrics: 'SplyAct1yr,SplyAct2yr,SplyAct3yr,SplyCur,PriceUSD',
    start_time: fmtDate(start),
    end_time: fmtDate(end),
    frequency: '1d',
    page_size: '10000',
  })
  if (MARKET_REGIME_CONFIG.coinmetricsApiKey) {
    params.set('api_key', MARKET_REGIME_CONFIG.coinmetricsApiKey)
  }
  const url = `${MARKET_REGIME_CONFIG.coinmetricsBase}/timeseries/asset-metrics?${params}`
  const ctl = new AbortController()
  const to = setTimeout(() => ctl.abort(), MARKET_REGIME_CONFIG.fetchTimeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`CoinMetrics ${res.status}`)
    const json = await res.json()
    return coinmetricsResponseSchema.parse(json).data
  } finally {
    clearTimeout(to)
  }
}
