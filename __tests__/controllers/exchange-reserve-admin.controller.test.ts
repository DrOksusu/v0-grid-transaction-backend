import type { Request, Response } from 'express'
import { getAlerts, putConfig } from '../../src/controllers/exchange-reserve-admin.controller'
import { listAlerts, updateAlertConfig } from '../../src/services/exchange-reserve-alert.service'

jest.mock('../../src/services/exchange-reserve-alert.service', () => ({
  getAlertConfig: jest.fn(),
  updateAlertConfig: jest.fn(),
  listAlerts: jest.fn(),
}))

describe('exchange-reserve admin controller', () => {
  let json: jest.Mock
  let status: jest.Mock
  let res: Partial<Response>
  let next: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    json = jest.fn()
    status = jest.fn().mockReturnValue({ json })
    res = { json, status }
    next = jest.fn()
  })

  it('PUT config: 범위 밖 cooldownDays는 400', async () => {
    await putConfig({ body: { cooldownDays: 0 } } as Request, res as Response, next)
    expect(status).toHaveBeenCalledWith(400)
    expect(updateAlertConfig).not.toHaveBeenCalled()
  })

  it('PUT config: 정상 값은 서비스로 전달', async () => {
    ;(updateAlertConfig as jest.Mock).mockResolvedValue({ id: 1, enabled: false, cooldownDays: 3, lookbackDays: 365 })
    await putConfig({ body: { enabled: false, cooldownDays: 3 } } as Request, res as Response, next)
    expect(updateAlertConfig).toHaveBeenCalledWith({ enabled: false, cooldownDays: 3 })
    expect(json).toHaveBeenCalledWith({ id: 1, enabled: false, cooldownDays: 3, lookbackDays: 365 })
  })

  it('GET alerts: Decimal/Date 직렬화, limit 기본 50', async () => {
    ;(listAlerts as jest.Mock).mockResolvedValue([
      {
        id: 1,
        dataDate: new Date('2026-10-08T00:00:00Z'),
        supplyBtc: '2665392.04',
        prevLowBtc: '2672865.56',
        newLowCount: 2,
        message: 'm',
        sentAt: new Date('2026-10-09T02:30:05Z'),
      },
    ])
    await getAlerts({ query: {} } as unknown as Request, res as Response, next)
    expect(listAlerts).toHaveBeenCalledWith(50)
    expect(json).toHaveBeenCalledWith({
      alerts: [
        {
          id: 1,
          dataDate: '2026-10-08',
          supplyBtc: 2665392.04,
          prevLowBtc: 2672865.56,
          newLowCount: 2,
          message: 'm',
          sentAt: '2026-10-09T02:30:05.000Z',
        },
      ],
    })
  })
})
