import { runCycle } from '../../../src/services/exchange-reserve-scheduler.service'
import { runBackfill, runDailyCollect } from '../../../src/services/exchange-reserve.service'
import { runAlertCheck } from '../../../src/services/exchange-reserve-alert.service'

jest.mock('../../../src/services/exchange-reserve.service', () => ({
  runBackfill: jest.fn(),
  runDailyCollect: jest.fn(),
}))

jest.mock('../../../src/services/exchange-reserve-alert.service', () => ({
  runAlertCheck: jest.fn(),
}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

describe('runCycle', () => {
  it('백필 확인 후 일일 수집 실행', async () => {
    ;(runBackfill as jest.Mock).mockResolvedValue({ skipped: true, inserted: 0 })
    ;(runDailyCollect as jest.Mock).mockResolvedValue({ status: 'ok', newData: false })
    await runCycle('main')
    expect(runBackfill).toHaveBeenCalled()
    expect(runDailyCollect).toHaveBeenCalled()
  })

  it('오류가 나도 throw하지 않음 (cron 보호)', async () => {
    ;(runBackfill as jest.Mock).mockRejectedValue(new Error('CoinMetrics 503'))
    await expect(runCycle('main')).resolves.toBeUndefined()
  })

  it('새 최신 일자가 들어오면 알림 판정 실행', async () => {
    ;(runBackfill as jest.Mock).mockResolvedValue({ skipped: true, inserted: 0 })
    ;(runDailyCollect as jest.Mock).mockResolvedValue({ status: 'ok', newData: true, latest: '2026-10-10' })
    ;(runAlertCheck as jest.Mock).mockResolvedValue({ sent: false, reason: 'cooldown', newLowCount: 0 })
    await runCycle('main')
    expect(runAlertCheck).toHaveBeenCalledWith('2026-10-10')
  })

  it('새 데이터가 없으면 알림 판정 생략 (재시도 실행 중복 방지)', async () => {
    ;(runBackfill as jest.Mock).mockResolvedValue({ skipped: true, inserted: 0 })
    ;(runDailyCollect as jest.Mock).mockResolvedValue({ status: 'ok', newData: false, latest: '2026-10-10' })
    await runCycle('retry')
    expect(runAlertCheck).not.toHaveBeenCalled()
  })
})
