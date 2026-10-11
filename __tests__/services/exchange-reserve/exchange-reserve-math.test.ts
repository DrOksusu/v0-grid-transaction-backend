import { addDays, daysBetween, isNewLowAt, toDay } from '../../../src/services/exchange-reserve-math'
import { makeSeries } from './helpers'

describe('일자 유틸', () => {
  it('toDay는 UTC 기준 YYYY-MM-DD', () => {
    expect(toDay(new Date('2026-10-09T23:59:59Z'))).toBe('2026-10-09')
  })
  it('addDays는 월/연 경계를 넘는다', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('daysBetween(from, to) = to - from', () => {
    expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7)
    expect(daysBetween('2026-10-08', '2026-10-01')).toBe(-7)
  })
})

describe('isNewLowAt (lookback 10일, 최소 9개)', () => {
  it('직전 10일 최저보다 낮으면 갱신', () => {
    const s = makeSeries('2026-01-01', [...Array(10).fill(100), 99])
    expect(isNewLowAt(s, 10, 10)).toEqual({ isLow: true, prevLow: 100 })
  })
  it('같으면 갱신 아님', () => {
    const s = makeSeries('2026-01-01', [...Array(10).fill(100), 100])
    expect(isNewLowAt(s, 10, 10)).toEqual({ isLow: false, prevLow: 100 })
  })
  it('lookback 밖의 더 낮은 값은 무시', () => {
    // index0=50은 index11 기준 11일 전 → 비교 구간 밖
    const s = makeSeries('2026-01-01', [50, ...Array(10).fill(100), 99])
    expect(isNewLowAt(s, 11, 10)).toEqual({ isLow: true, prevLow: 100 })
  })
  it('정확히 lookbackDays일 전 값도 비교 구간 밖 (요약 low1y 창과 일치)', () => {
    // index0=50은 index10 기준 정확히 10일 전 → 제외, 비교 구간 = 직전 9일
    const s = makeSeries('2026-01-01', [50, ...Array(9).fill(100), 99])
    expect(isNewLowAt(s, 10, 10)).toEqual({ isLow: true, prevLow: 100 })
  })
  it('비교 구간 데이터가 90% 미만이면 갱신 아님', () => {
    const s = makeSeries('2026-01-01', [100, 100, 100, 100, 90])
    expect(isNewLowAt(s, 4, 10)).toEqual({ isLow: false, prevLow: null })
  })
})
