import type { Request, Response } from 'express'
import { getExchangeReserve } from '../../src/controllers/exchange-reserve.controller'
import { getReserveView } from '../../src/services/exchange-reserve.service'

jest.mock('../../src/services/exchange-reserve.service', () => ({
  getReserveView: jest.fn(),
}))

describe('GET /api/exchange-reserve', () => {
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

  it('days 미지정이면 365로 조회', async () => {
    ;(getReserveView as jest.Mock).mockResolvedValue({ series: [], summary: {} })
    await getExchangeReserve({ query: {} } as Request, res as Response, next)
    expect(getReserveView).toHaveBeenCalledWith(365)
    expect(json).toHaveBeenCalledWith({ series: [], summary: {} })
  })

  it('days=90 허용', async () => {
    ;(getReserveView as jest.Mock).mockResolvedValue({ series: [], summary: {} })
    await getExchangeReserve({ query: { days: '90' } } as unknown as Request, res as Response, next)
    expect(getReserveView).toHaveBeenCalledWith(90)
  })

  it('허용되지 않은 days는 400', async () => {
    await getExchangeReserve({ query: { days: '30' } } as unknown as Request, res as Response, next)
    expect(status).toHaveBeenCalledWith(400)
    expect(getReserveView).not.toHaveBeenCalled()
  })

  it('서비스 오류는 next로 전달', async () => {
    const err = new Error('db down')
    ;(getReserveView as jest.Mock).mockRejectedValue(err)
    await getExchangeReserve({ query: {} } as Request, res as Response, next)
    expect(next).toHaveBeenCalledWith(err)
  })
})
