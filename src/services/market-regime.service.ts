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

// ============================================================
// reconcile — 두 소스 간 dormant2y 비율 차이가 5%p 초과 시 경고
// ============================================================

export function reconcile(cmDormant2y: number, bdDormant2y: number): boolean {
  return Math.abs(cmDormant2y - bdDormant2y) > MARKET_REGIME_CONFIG.reconcileThreshold
}

// ============================================================
// computeSnapshotRow — 두 소스를 합산해 저장 가능한 행 생성
// ============================================================

export interface SnapshotInput {
  date: Date
  dormant1yRatio: number
  dormant2yRatio: number
  dormant3yRatio: number
  btcPriceUsd: number
  rawCoinmetrics: unknown | null
  rawBitcoinData: unknown | null
  reconcileWarning: boolean
  dataSource: 'PRIMARY' | 'FALLBACK' | 'BOTH' | 'NONE'
}

// BitcoinDataHodlWavesRow의 특정 키 합산 헬퍼
function sumBuckets(bd: Record<string, number | string>, keys: readonly string[]): number {
  return keys.reduce((s, k) => s + (typeof bd[k] === 'number' ? (bd[k] as number) : 0), 0)
}

export function computeSnapshotRow(
  date: Date,
  cm: CoinmetricsRow | null,
  bd: BitcoinDataHodlWavesRow | null,
  fallbackBtcPriceUsd?: number,
): SnapshotInput {
  if (cm && bd) {
    const d1 = 1 - cm.SplyAct1yr / cm.SplyCur
    const d2 = 1 - cm.SplyAct2yr / cm.SplyCur
    const d3 = 1 - cm.SplyAct3yr / cm.SplyCur
    const bdDormant2y = sumBuckets(bd as any, BD_LONG_TERM_BUCKETS)
    return {
      date,
      dormant1yRatio: d1,
      dormant2yRatio: d2,
      dormant3yRatio: d3,
      btcPriceUsd: cm.PriceUSD,
      rawCoinmetrics: cm,
      rawBitcoinData: bd,
      reconcileWarning: reconcile(d2, bdDormant2y),
      dataSource: 'BOTH',
    }
  }
  if (cm) {
    return {
      date,
      dormant1yRatio: 1 - cm.SplyAct1yr / cm.SplyCur,
      dormant2yRatio: 1 - cm.SplyAct2yr / cm.SplyCur,
      dormant3yRatio: 1 - cm.SplyAct3yr / cm.SplyCur,
      btcPriceUsd: cm.PriceUSD,
      rawCoinmetrics: cm,
      rawBitcoinData: null,
      reconcileWarning: false,
      dataSource: 'PRIMARY',
    }
  }
  if (bd) {
    const sum1 = sumBuckets(bd as any, ['1y', ...BD_LONG_TERM_BUCKETS])
    const sum2 = sumBuckets(bd as any, BD_LONG_TERM_BUCKETS)
    const sum3 = sumBuckets(bd as any, ['3y', '5y', '7y', '10y'])
    return {
      date,
      dormant1yRatio: sum1,
      dormant2yRatio: sum2,
      dormant3yRatio: sum3,
      btcPriceUsd: fallbackBtcPriceUsd ?? 0,
      rawCoinmetrics: null,
      rawBitcoinData: bd,
      reconcileWarning: false,
      dataSource: 'FALLBACK',
    }
  }
  throw new Error('computeSnapshotRow: both sources null')
}
