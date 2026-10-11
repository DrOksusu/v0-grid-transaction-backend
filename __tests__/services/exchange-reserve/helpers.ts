import type { ReservePoint } from '../../../src/services/exchange-reserve-math'

// startDay부터 하루씩 증가하는 시계열 생성 (inflow/outflow는 null)
export function makeSeries(startDay: string, supplies: number[]): ReservePoint[] {
  const start = Date.parse(`${startDay}T00:00:00Z`)
  return supplies.map((supply, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    supply,
    inflow: null,
    outflow: null,
  }))
}
