import { downsampleWeekly } from '../../../src/services/exchange-reserve-downsample'
import { makeSeries } from './helpers'

describe('downsampleWeekly', () => {
  it('빈 배열이면 빈 배열', () => {
    expect(downsampleWeekly([])).toEqual([])
  })

  it('15일 → 3개 버킷, 최신일 포함, 대표점은 버킷 내 가장 최근 일자 값', () => {
    // 2026-10-01 ~ 2026-10-15 (supply 1..15), 최신일 L = 10-15
    const series = makeSeries('2026-10-01', Array.from({ length: 15 }, (_, i) => i + 1))
    const out = downsampleWeekly(series)
    expect(out).toHaveLength(3)
    // k=0: 10-09~10-15 → 대표 10-15, k=1: 10-02~10-08 → 대표 10-08, k=2: 10-01 → 대표 10-01
    expect(out.map((q) => q.date)).toEqual(['2026-10-01', '2026-10-08', '2026-10-15'])
    expect(out.map((q) => q.supply)).toEqual([1, 8, 15])
  })

  it('inflow/outflow는 non-null 합, 모두 null이면 null', () => {
    const series = makeSeries('2026-10-01', Array.from({ length: 8 }, () => 100))
    series[7].inflow = 5 // 10-08 (k=0 버킷: 10-02~10-08)
    series[6].inflow = 7
    series[0].outflow = 3 // 10-01 (k=1 버킷)
    const out = downsampleWeekly(series)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ date: '2026-10-01', inflow: null, outflow: 3 })
    expect(out[1]).toMatchObject({ date: '2026-10-08', inflow: 12, outflow: null })
  })

  it('결측일이 있어도 인덱스가 아닌 일자 차로 버킷을 계산', () => {
    const series = [
      { date: '2026-09-01', supply: 1, inflow: null, outflow: null },
      { date: '2026-10-01', supply: 2, inflow: null, outflow: null },
      { date: '2026-10-03', supply: 3, inflow: null, outflow: null },
      { date: '2026-10-08', supply: 4, inflow: null, outflow: null },
    ]
    const out = downsampleWeekly(series)
    // L=10-08: 10-08 k=0, 10-03 k=0(5일), 10-01 k=1(7일), 09-01 k=5
    expect(out.map((q) => q.date)).toEqual(['2026-09-01', '2026-10-01', '2026-10-08'])
    expect(out.map((q) => q.supply)).toEqual([1, 2, 4])
  })
})
