import { computeReserveSummary } from '../../../src/services/exchange-reserve-summary'
import { makeSeries } from './helpers'

const NOW = new Date('2026-01-31T05:00:00Z')

describe('computeReserveSummary', () => {
  it('데이터 0건 → backfilling', () => {
    const s = computeReserveSummary([], NOW, 10)
    expect(s.status).toBe('backfilling')
    expect(s.latestDate).toBeNull()
    expect(s.supply).toBeNull()
    expect(s.isNewLow1y).toBe(false)
  })

  it('1d/7d 변화와 비율', () => {
    // 01-01 ~ 01-30, 마지막 값만 다르게
    const series = makeSeries('2026-01-01', [...Array(29).fill(200), 190])
    const s = computeReserveSummary(series, NOW, 10)
    expect(s.latestDate).toBe('2026-01-30')
    expect(s.supply).toBe(190)
    expect(s.change1d).toEqual({ abs: -10, pct: -5 })
    expect(s.change7d).toEqual({ abs: -10, pct: -5 })
    expect(s.change30d).toBeNull() // 30일 전(12-31) 이하 데이터 없음
    expect(s.status).toBe('ok')
  })

  it('lookback 구간 최저/최고 + 최신이 신저점이면 isNewLow1y', () => {
    const series = makeSeries('2026-01-01', [300, ...Array(18).fill(200), 250, 190])
    // lookback 10일 → 01-11 초과 구간만 low/high 대상 (01-01의 300은 제외)
    const s = computeReserveSummary(series, NOW, 10)
    expect(s.low1y).toEqual({ date: '2026-01-21', supply: 190 })
    expect(s.high1y).toEqual({ date: '2026-01-20', supply: 250 })
    expect(s.isNewLow1y).toBe(true)
  })

  it('netFlow1d = inflow - outflow, 없으면 null', () => {
    const series = makeSeries('2026-01-29', [100, 100])
    series[1] = { ...series[1], inflow: 20, outflow: 35 }
    expect(computeReserveSummary(series, NOW, 10).netFlow1d).toBe(-15)
    const noFlow = makeSeries('2026-01-29', [100, 100])
    expect(computeReserveSummary(noFlow, NOW, 10).netFlow1d).toBeNull()
  })

  it('stale: 최신 일자가 오늘(UTC) 기준 2일 초과 경과', () => {
    expect(computeReserveSummary(makeSeries('2026-01-29', [1]), NOW, 10).stale).toBe(false) // 2일
    expect(computeReserveSummary(makeSeries('2026-01-28', [1]), NOW, 10).stale).toBe(true)  // 3일
  })
})
