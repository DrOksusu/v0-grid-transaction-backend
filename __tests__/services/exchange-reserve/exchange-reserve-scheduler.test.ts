import { runCycle } from '../../../src/services/exchange-reserve-scheduler.service'
import { runBackfill, runDailyCollect } from '../../../src/services/exchange-reserve.service'

jest.mock('../../../src/services/exchange-reserve.service', () => ({
  runBackfill: jest.fn(),
  runDailyCollect: jest.fn(),
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
})
