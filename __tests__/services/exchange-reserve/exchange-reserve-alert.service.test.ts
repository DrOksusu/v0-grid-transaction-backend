import { prisma } from '../../../__mocks__/database'
import { kakaoNotifyService } from '../../../src/services/kakao-notify.service'
import { runAlertCheck, getAlertConfig } from '../../../src/services/exchange-reserve-alert.service'

jest.mock('../../../src/services/kakao-notify.service', () => ({
  kakaoNotifyService: { sendToMe: jest.fn() },
}))

const cfg = prisma.exchangeReserveAlertConfig as Record<string, jest.Mock>
const alerts = prisma.exchangeReserveAlert as Record<string, jest.Mock>
const daily = prisma.exchangeReserveDaily as Record<string, jest.Mock>
const send = kakaoNotifyService.sendToMe as jest.Mock

// 01-01~01-20 = 100, 01-21 = 99 (lookback 10일이면 갱신)
function dailyRows() {
  const rows = []
  for (let i = 0; i < 21; i++) {
    const date = new Date(Date.UTC(2026, 0, 1 + i))
    rows.push({ date, supplyBtc: i === 20 ? '99' : '100', inflowBtc: null, outflowBtc: null })
  }
  return rows
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, 'error').mockImplementation(() => {})
  cfg.upsert.mockResolvedValue({ id: 1, enabled: true, cooldownDays: 7, lookbackDays: 10 })
  daily.findMany.mockResolvedValue(dailyRows())
})

describe('getAlertConfig', () => {
  it('행이 없어도 기본값으로 upsert', async () => {
    await getAlertConfig()
    expect(cfg.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: { id: 1, enabled: true, cooldownDays: 7, lookbackDays: 365 },
      update: {},
    })
  })
})

describe('runAlertCheck', () => {
  it('신저점이면 카톡 발송 후 이력 기록', async () => {
    alerts.findFirst.mockResolvedValue(null)
    send.mockResolvedValue(undefined)
    const r = await runAlertCheck('2026-01-21')
    expect(r).toEqual({ sent: true, reason: 'new_low', newLowCount: 1 })
    expect(send).toHaveBeenCalledWith(expect.stringContaining('1년 최저 갱신'), 'https://grid.koco.me/admin/exchange-reserve')
    expect(alerts.create.mock.calls[0][0].data).toMatchObject({
      dataDate: new Date('2026-01-21T00:00:00Z'),
      supplyBtc: 99,
      prevLowBtc: 100,
      newLowCount: 1,
    })
  })

  it('카톡 실패 시 이력 기록 안 함 (다음 실행 재시도)', async () => {
    alerts.findFirst.mockResolvedValue(null)
    send.mockRejectedValue(new Error('token expired'))
    const r = await runAlertCheck('2026-01-21')
    expect(r).toEqual({ sent: false, reason: 'send_failed', newLowCount: 1 })
    expect(alerts.create).not.toHaveBeenCalled()
  })

  it('쿨다운 중이면 발송 안 함', async () => {
    alerts.findFirst.mockResolvedValue({ dataDate: new Date('2026-01-18T00:00:00Z') })
    const r = await runAlertCheck('2026-01-21')
    expect(r).toEqual({ sent: false, reason: 'cooldown', newLowCount: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('해당 일자 데이터가 없으면 no_data', async () => {
    const r = await runAlertCheck('2026-02-01')
    expect(r).toEqual({ sent: false, reason: 'no_data', newLowCount: 0 })
  })
})
