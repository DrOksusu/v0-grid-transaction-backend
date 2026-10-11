import { buildReserveAlertMessage } from '../../../src/services/exchange-reserve-message'

describe('buildReserveAlertMessage', () => {
  it('순유출 + 누적 감소', () => {
    const msg = buildReserveAlertMessage({
      latest: { date: '2026-10-08', supply: 2665392.04, inflow: 27171.07, outflow: 31432.2 },
      prevLow: 2683632.1,
      newLowCount: 4,
    })
    expect(msg).toBe(
      [
        '📉 거래소 BTC 1년 최저 갱신',
        '현재 2,665,392 BTC (이전 최저 2,683,632)',
        '지난 알림 이후 4회 갱신, 누적 -18,240 BTC',
        '전일 순유출 4,261 BTC (입금 27,171 / 출금 31,432)',
        '기준일 2026-10-08 (UTC)',
      ].join('\n'),
    )
  })

  it('유입/유출 없으면 해당 줄 생략', () => {
    const msg = buildReserveAlertMessage({
      latest: { date: '2026-10-08', supply: 100, inflow: null, outflow: null },
      prevLow: 110,
      newLowCount: 1,
    })
    expect(msg).not.toContain('전일')
    expect(msg.split('\n')).toHaveLength(4)
  })
})
