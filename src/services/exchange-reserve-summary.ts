// 거래소 BTC 보유량 — 요약 계산 (순수 함수)
import { EXCHANGE_RESERVE_CONFIG } from '../config/exchange-reserve'
import { addDays, daysBetween, isNewLowAt, toDay, type ReservePoint } from './exchange-reserve-math'

export interface ChangeStat {
  abs: number
  pct: number
}

export interface DatedSupply {
  date: string
  supply: number
}

export interface ReserveSummary {
  latestDate: string | null
  supply: number | null
  change1d: ChangeStat | null
  change7d: ChangeStat | null
  change30d: ChangeStat | null
  low1y: DatedSupply | null
  high1y: DatedSupply | null
  isNewLow1y: boolean
  netFlow1d: number | null
  stale: boolean
  status: 'ok' | 'backfilling'
}

const EMPTY_SUMMARY: ReserveSummary = {
  latestDate: null,
  supply: null,
  change1d: null,
  change7d: null,
  change30d: null,
  low1y: null,
  high1y: null,
  isNewLow1y: false,
  netFlow1d: null,
  stale: false,
  status: 'backfilling',
}

// 최신값과 N일 전(그 이하 가장 가까운 일자) 값의 차이
function changeOver(series: ReservePoint[], days: number): ChangeStat | null {
  const latest = series[series.length - 1]
  const target = addDays(latest.date, -days)
  for (let i = series.length - 2; i >= 0; i--) {
    if (series[i].date <= target) {
      const base = series[i].supply
      const abs = latest.supply - base
      return { abs, pct: base === 0 ? 0 : (abs / base) * 100 }
    }
  }
  return null
}

export function computeReserveSummary(
  series: ReservePoint[],
  now: Date,
  lookbackDays: number = EXCHANGE_RESERVE_CONFIG.lookbackDays,
): ReserveSummary {
  if (series.length === 0) return EMPTY_SUMMARY

  const latest = series[series.length - 1]
  const windowStart = addDays(latest.date, -lookbackDays)
  const window = series.filter((p) => p.date > windowStart)
  const low = window.reduce((a, b) => (b.supply < a.supply ? b : a))
  const high = window.reduce((a, b) => (b.supply > a.supply ? b : a))

  return {
    latestDate: latest.date,
    supply: latest.supply,
    change1d: changeOver(series, 1),
    change7d: changeOver(series, 7),
    change30d: changeOver(series, 30),
    low1y: { date: low.date, supply: low.supply },
    high1y: { date: high.date, supply: high.supply },
    isNewLow1y: isNewLowAt(series, series.length - 1, lookbackDays).isLow,
    netFlow1d:
      latest.inflow !== null && latest.outflow !== null ? latest.inflow - latest.outflow : null,
    stale: daysBetween(latest.date, toDay(now)) > EXCHANGE_RESERVE_CONFIG.staleDays,
    status: 'ok',
  }
}
