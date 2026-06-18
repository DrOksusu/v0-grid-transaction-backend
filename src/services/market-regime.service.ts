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

// ============================================================
// runBackfill — DB가 비어있을 때 최대 10년치 데이터 일괄 적재
// ============================================================

export interface BackfillResult {
  skipped: boolean
  inserted: number
}

export async function runBackfill(): Promise<BackfillResult> {
  // 이미 데이터가 있으면 건너뜀
  const existing = await prisma.btcDormantSnapshot.count()
  if (existing > 0) return { skipped: true, inserted: 0 }

  const end = new Date()
  end.setUTCDate(end.getUTCDate() - 1)
  end.setUTCHours(0, 0, 0, 0)
  const start = new Date(end)
  start.setUTCFullYear(start.getUTCFullYear() - MARKET_REGIME_CONFIG.backfillYears)

  // 두 소스를 병렬로 fetch (실패 시 빈 배열)
  const [cmRows, bdRows] = await Promise.all([
    withRetry(() => fetchFromCoinMetrics(start, end), MARKET_REGIME_CONFIG.retryDelaysMs).catch(() => []),
    withRetry(() => fetchFromBitcoinData(), MARKET_REGIME_CONFIG.retryDelaysMs).catch(() => []),
  ])

  const bdByDate = new Map(bdRows.map((r) => [r.d.slice(0, 10), r]))
  const cmByDate = new Map(cmRows.map((r) => [r.time.slice(0, 10), r]))
  const dates = new Set([...bdByDate.keys(), ...cmByDate.keys()])

  const rows: SnapshotInput[] = []
  for (const dstr of dates) {
    const date = new Date(`${dstr}T00:00:00Z`)
    if (date < start || date > end) continue
    const cm = cmByDate.get(dstr) ?? null
    const bd = bdByDate.get(dstr) ?? null
    if (!cm && !bd) continue
    try {
      rows.push(computeSnapshotRow(date, cm, bd))
    } catch {
      /* 둘 다 null인 경우 — 건너뜀 */
    }
  }

  if (rows.length === 0) return { skipped: false, inserted: 0 }

  const result = await prisma.btcDormantSnapshot.createMany({
    data: rows.map((r) => ({
      date: r.date,
      dormant1yRatio: r.dormant1yRatio,
      dormant2yRatio: r.dormant2yRatio,
      dormant3yRatio: r.dormant3yRatio,
      btcPriceUsd: r.btcPriceUsd,
      rawCoinmetrics: r.rawCoinmetrics as any,
      rawBitcoinData: r.rawBitcoinData as any,
      reconcileWarning: r.reconcileWarning,
      dataSource: r.dataSource,
    })),
    skipDuplicates: true,
  })

  return { skipped: false, inserted: result.count }
}

// ============================================================
// runDailyPoll — 어제 날짜 데이터 upsert (Cycle F에서 완성)
// ============================================================

export interface DailyPollResult {
  status: 'ok' | 'skipped_existing' | 'failed'
  date?: string
  dataSource?: string
}

export async function runDailyPoll(): Promise<DailyPollResult> {
  // 어제 날짜를 기준 날짜로 설정
  const fetchDate = new Date()
  fetchDate.setUTCDate(fetchDate.getUTCDate() - 1)
  fetchDate.setUTCHours(0, 0, 0, 0)
  const dstr = fetchDate.toISOString().slice(0, 10)

  // 이미 존재하면 skip
  const existing = await prisma.btcDormantSnapshot.findUnique({ where: { date: fetchDate } })
  if (existing) return { status: 'skipped_existing', date: dstr }

  // 두 소스를 순차적으로 fetch (실패 시 null)
  const cmResult = await withRetry(
    () => fetchFromCoinMetrics(fetchDate, fetchDate),
    MARKET_REGIME_CONFIG.retryDelaysMs,
  ).catch(() => null)

  const bdResult = await withRetry(
    () => fetchFromBitcoinData(),
    MARKET_REGIME_CONFIG.retryDelaysMs,
  ).catch(() => null)

  const cm = cmResult?.find((r) => r.time.slice(0, 10) === dstr) ?? null
  const bd = bdResult?.find((r) => r.d.slice(0, 10) === dstr) ?? null

  // 두 소스 모두 없으면 실패
  if (!cm && !bd) return { status: 'failed', date: dstr }

  const row = computeSnapshotRow(fetchDate, cm, bd)
  await prisma.btcDormantSnapshot.upsert({
    where: { date: fetchDate },
    create: {
      date: row.date,
      dormant1yRatio: row.dormant1yRatio,
      dormant2yRatio: row.dormant2yRatio,
      dormant3yRatio: row.dormant3yRatio,
      btcPriceUsd: row.btcPriceUsd,
      rawCoinmetrics: row.rawCoinmetrics as any,
      rawBitcoinData: row.rawBitcoinData as any,
      reconcileWarning: row.reconcileWarning,
      dataSource: row.dataSource,
    },
    update: {
      dormant1yRatio: row.dormant1yRatio,
      dormant2yRatio: row.dormant2yRatio,
      dormant3yRatio: row.dormant3yRatio,
      btcPriceUsd: row.btcPriceUsd,
      rawCoinmetrics: row.rawCoinmetrics as any,
      rawBitcoinData: row.rawBitcoinData as any,
      reconcileWarning: row.reconcileWarning,
      dataSource: row.dataSource,
    },
  })
  return { status: 'ok', date: dstr, dataSource: row.dataSource }
}
