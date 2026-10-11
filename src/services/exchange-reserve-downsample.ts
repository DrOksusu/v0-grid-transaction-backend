// 거래소 BTC 보유량 — 주 단위 다운샘플 (순수 함수)
import { daysBetween, type ReservePoint } from './exchange-reserve-math'

function sumNonNull(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null)
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0)
}

// series(일자 오름차순)를 최신일 기준 7일 버킷으로 묶는다.
// 대표점: 버킷 내 가장 최근 일자의 date/supply, inflow/outflow는 non-null 합
export function downsampleWeekly(series: ReservePoint[]): ReservePoint[] {
  if (series.length === 0) return []
  const latest = series[series.length - 1].date
  const buckets = new Map<number, ReservePoint[]>()
  for (const point of series) {
    const k = Math.floor(daysBetween(point.date, latest) / 7)
    const bucket = buckets.get(k)
    if (bucket) bucket.push(point)
    else buckets.set(k, [point])
  }
  // k가 클수록 과거 → 내림차순 정렬하면 오름차순 일자
  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, pts]) => {
      const rep = pts[pts.length - 1]
      return {
        date: rep.date,
        supply: rep.supply,
        inflow: sumNonNull(pts.map((q) => q.inflow)),
        outflow: sumNonNull(pts.map((q) => q.outflow)),
      }
    })
}
