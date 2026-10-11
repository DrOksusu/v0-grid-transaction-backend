// 거래소 BTC 보유량 — 백필·일일 수집·조회 서비스
import prisma from '../config/database'
import { EXCHANGE_RESERVE_CONFIG as CFG, type ViewRange } from '../config/exchange-reserve'
import { fetchExchangeReserve } from './exchange-reserve.client'
import { downsampleWeekly } from './exchange-reserve-downsample'
import { addDays, dayToDate, toDay, type ReservePoint } from './exchange-reserve-math'
import { computeReserveSummary, type ReserveSummary } from './exchange-reserve-summary'

// 동시 실행 방지 (메인/재시도 cron 겹침)
let collecting = false

function toRow(p: ReservePoint) {
  return {
    date: dayToDate(p.date),
    supplyBtc: p.supply,
    inflowBtc: p.inflow,
    outflowBtc: p.outflow,
  }
}

interface DailyRow {
  date: Date
  supplyBtc: unknown
  inflowBtc: unknown
  outflowBtc: unknown
}

function fromRow(r: DailyRow): ReservePoint {
  return {
    date: toDay(r.date),
    supply: Number(r.supplyBtc),
    inflow: r.inflowBtc === null ? null : Number(r.inflowBtc),
    outflow: r.outflowBtc === null ? null : Number(r.outflowBtc),
  }
}

async function getLatestDay(): Promise<string | null> {
  const latest = await prisma.exchangeReserveDaily.findFirst({
    orderBy: { date: 'desc' },
    select: { date: true },
  })
  return latest ? toDay(latest.date) : null
}

export interface BackfillResult {
  skipped: boolean
  inserted: number
}

// 가장 오래된 행이 historyStart보다 한참 늦으면 전체 기간을 적재 (멱등, 알림 판정 없음)
export async function runBackfill(_now: Date = new Date()): Promise<BackfillResult> {
  const first = await prisma.exchangeReserveDaily.findFirst({
    orderBy: { date: 'asc' },
    select: { date: true },
  })
  const oldest = first ? toDay(first.date) : null
  if (oldest !== null && oldest <= addDays(CFG.historyStart, 7)) return { skipped: true, inserted: 0 }
  const fetched = await fetchExchangeReserve(CFG.historyStart)
  const points = oldest === null ? fetched : fetched.filter((p) => p.date < oldest)
  if (points.length === 0) return { skipped: false, inserted: 0 }
  const result = await prisma.exchangeReserveDaily.createMany({
    data: points.map(toRow),
    skipDuplicates: true,
  })
  return { skipped: false, inserted: result.count }
}

export interface CollectResult {
  status: 'ok' | 'busy'
  upserted: number
  prevLatest: string | null
  latest: string | null
  newData: boolean
}

// 최근 7일(또는 마지막 저장일 이후)을 재조회해 upsert — 잠정치(flash) 수정 반영
export async function runDailyCollect(now: Date = new Date()): Promise<CollectResult> {
  if (collecting) return { status: 'busy', upserted: 0, prevLatest: null, latest: null, newData: false }
  collecting = true
  try {
    const prevLatest = await getLatestDay()
    const recentStart = addDays(toDay(now), -CFG.recollectDays)
    const start = prevLatest !== null && prevLatest < recentStart ? prevLatest : recentStart
    const points = await fetchExchangeReserve(start)
    for (const p of points) {
      const row = toRow(p)
      await prisma.exchangeReserveDaily.upsert({
        where: { date: row.date },
        create: row,
        update: { supplyBtc: row.supplyBtc, inflowBtc: row.inflowBtc, outflowBtc: row.outflowBtc },
      })
    }
    const latest = points.length > 0 ? points[points.length - 1].date : prevLatest
    const newData = latest !== null && (prevLatest === null || latest > prevLatest)
    return { status: 'ok', upserted: points.length, prevLatest, latest, newData }
  } finally {
    collecting = false
  }
}

// fromDay(포함) 이후 시계열, 일자 오름차순
export async function loadSeries(fromDay: string): Promise<ReservePoint[]> {
  const rows = await prisma.exchangeReserveDaily.findMany({
    where: { date: { gte: dayToDate(fromDay) } },
    orderBy: { date: 'asc' },
  })
  return rows.map(fromRow)
}

export interface ReserveView {
  series: ReservePoint[]
  summary: ReserveSummary
}

// 조회 API용: 요약은 일 단위 전체 데이터로 계산, series는 range 구간 (365일 초과·전체는 주 단위)
export async function getReserveView(range: ViewRange, now: Date = new Date()): Promise<ReserveView> {
  const today = toDay(now)
  const from = range === 'all' ? CFG.historyStart : addDays(today, -Math.max(range, CFG.viewLookbackDays))
  const all = await loadSeries(from)
  const summary = computeReserveSummary(all, now)
  const series = range === 'all' ? all : all.filter((p) => p.date > addDays(today, -range))
  const reduced = range === 'all' || range > CFG.downsampleAboveDays
  return { series: reduced ? downsampleWeekly(series) : series, summary }
}
