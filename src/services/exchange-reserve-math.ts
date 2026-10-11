// 거래소 BTC 보유량 — 순수 계산 유틸 (DB/네트워크 없음)

export interface ReservePoint {
  date: string            // 'YYYY-MM-DD' (UTC)
  supply: number          // 거래소 보유량 BTC
  inflow: number | null   // 입금량 BTC
  outflow: number | null  // 출금량 BTC
}

const DAY_MS = 86_400_000
// 비교 구간 데이터가 이 비율 미만이면 최저 판정하지 않음 (데이터 부족 오탐 방지)
export const MIN_COVERAGE = 0.9

export function toDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`)
}

export function addDays(day: string, n: number): string {
  return toDay(new Date(dayToDate(day).getTime() + n * DAY_MS))
}

// to - from (일)
export function daysBetween(from: string, to: string): number {
  return Math.round((dayToDate(to).getTime() - dayToDate(from).getTime()) / DAY_MS)
}

// series(일자 오름차순)[idx]가 직전 lookbackDays일 최저보다 낮은지 판정
export function isNewLowAt(
  series: ReservePoint[],
  idx: number,
  lookbackDays: number,
): { isLow: boolean; prevLow: number | null } {
  const target = series[idx]
  let min = Infinity
  let count = 0
  for (let i = idx - 1; i >= 0; i--) {
    const gap = daysBetween(series[i].date, target.date)
    if (gap >= lookbackDays) break // 비교 구간 = 직전 1 ~ (lookbackDays-1)일 (요약 low1y 창과 일치)
    if (gap < 1) continue
    count++
    if (series[i].supply < min) min = series[i].supply
  }
  if (count < Math.ceil(lookbackDays * MIN_COVERAGE)) return { isLow: false, prevLow: null }
  return { isLow: target.supply < min, prevLow: min }
}
