import { decideAlert } from '../../../src/services/exchange-reserve-alert'
import { makeSeries } from './helpers'

const base = { cooldownDays: 7, lookbackDays: 10, enabled: true }
const flat = (n: number) => Array(n).fill(100)

describe('decideAlert', () => {
  it('갱신 없음 → 미발송', () => {
    const series = makeSeries('2026-01-01', flat(25))
    const d = decideAlert({ ...base, series, latestDate: '2026-01-25', lastAlertDataDate: null })
    expect(d).toMatchObject({ send: false, reason: 'no_new_low' })
  })

  it('첫 가동 + 오늘 갱신 → 발송, count=1', () => {
    const series = makeSeries('2026-01-01', [...flat(20), 99])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-21', lastAlertDataDate: null })
    expect(d).toEqual({ send: true, reason: 'new_low', newLowCount: 1, prevLow: 100, lowDates: ['2026-01-21'] })
  })

  it('첫 가동 시 쿨다운 이전의 과거 갱신만 있으면 미발송', () => {
    // 01-21=90(갱신) 후 01-22~01-30 = 95 → 최근 7일(01-24~01-30) 안에는 갱신 없음
    const series = makeSeries('2026-01-01', [...flat(20), 90, ...Array(9).fill(95)])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-30', lastAlertDataDate: null })
    expect(d).toMatchObject({ send: false, reason: 'no_new_low' })
  })

  it('쿨다운 중 갱신 → 미발송', () => {
    const series = makeSeries('2026-01-01', [...flat(20), 99])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-21', lastAlertDataDate: '2026-01-18' })
    expect(d).toMatchObject({ send: false, reason: 'cooldown' })
  })

  it('쿨다운 만료 + 오늘 비갱신 + 묶인 갱신 3건 → 발송, count=3', () => {
    // 01-21=99, 01-22=98, 01-23=97 (갱신), 01-24~01-27=97.5 (비갱신)
    const series = makeSeries('2026-01-01', [...flat(20), 99, 98, 97, 97.5, 97.5, 97.5, 97.5])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-27', lastAlertDataDate: '2026-01-20' })
    expect(d).toEqual({
      send: true,
      reason: 'new_low',
      newLowCount: 3,
      prevLow: 100,
      lowDates: ['2026-01-21', '2026-01-22', '2026-01-23'],
    })
  })

  it('쿨다운 만료 + 오늘 갱신 + 묶인 2건 → count=3', () => {
    // 01-21=99, 01-22=98 (갱신), 01-23~01-26=98.5, 01-27=97 (갱신)
    const series = makeSeries('2026-01-01', [...flat(20), 99, 98, 98.5, 98.5, 98.5, 98.5, 97])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-27', lastAlertDataDate: '2026-01-20' })
    expect(d.send).toBe(true)
    expect(d.newLowCount).toBe(3)
    expect(d.lowDates).toEqual(['2026-01-21', '2026-01-22', '2026-01-27'])
  })

  it('lookback 데이터 부족 → 갱신 아님', () => {
    const series = makeSeries('2026-01-01', [100, 100, 100, 100, 50])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-05', lastAlertDataDate: null })
    expect(d).toMatchObject({ send: false, reason: 'no_new_low' })
  })

  it('장기 미발송(알림 OFF·발송 실패 지속) 후에도 최근 cooldownDays일 밖의 오래된 갱신은 보내지 않음', () => {
    // 01-21=90(갱신) 후 01-22~01-30 = 95, 마지막 알림은 01-10 → 최근 7일(01-24~) 안에 갱신 없음
    const series = makeSeries('2026-01-01', [...flat(20), 90, ...Array(9).fill(95)])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-30', lastAlertDataDate: '2026-01-10' })
    expect(d).toMatchObject({ send: false, reason: 'no_new_low' })
  })

  it('enabled=false → 미발송', () => {
    const series = makeSeries('2026-01-01', [...flat(20), 99])
    const d = decideAlert({ ...base, enabled: false, series, latestDate: '2026-01-21', lastAlertDataDate: null })
    expect(d).toMatchObject({ send: false, reason: 'disabled' })
  })
})
