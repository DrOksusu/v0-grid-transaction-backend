import { fetchExchangeReserve } from '../../../src/services/exchange-reserve.client'

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
})

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

const row = (day: string, sply: string, inflow?: string, outflow?: string) => ({
  asset: 'btc',
  time: `${day}T00:00:00.000000000Z`,
  SplyExNtv: sply,
  'SplyExNtv-status': 'flash',
  ...(inflow !== undefined ? { FlowInExNtv: inflow } : {}),
  ...(outflow !== undefined ? { FlowOutExNtv: outflow } : {}),
})

describe('fetchExchangeReserve', () => {
  it('문자열 숫자를 파싱하고 일자 오름차순으로 반환', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      okJson({
        data: [
          row('2026-10-09', '2672865.55765548', '27171.07', '22909.79'),
          row('2026-10-08', '2665392.03622638', '28184.93', '27937.59'),
        ],
      }),
    )
    global.fetch = fetchMock as any
    const out = await fetchExchangeReserve('2026-10-08')
    expect(out).toEqual([
      { date: '2026-10-08', supply: 2665392.03622638, inflow: 28184.93, outflow: 27937.59 },
      { date: '2026-10-09', supply: 2672865.55765548, inflow: 27171.07, outflow: 22909.79 },
    ])
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('metrics=SplyExNtv%2CFlowInExNtv%2CFlowOutExNtv')
    expect(url).toContain('paging_from=start')
    expect(url).toContain('start_time=2026-10-08')
  })

  it('next_page_url이 있으면 이어서 조회', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(okJson({ data: [row('2026-10-08', '100')], next_page_url: 'https://x/page2' }))
      .mockResolvedValueOnce(okJson({ data: [row('2026-10-09', '99')] }))
    global.fetch = fetchMock as any
    const out = await fetchExchangeReserve('2026-10-08')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('https://x/page2')
    expect(out.map((p) => p.date)).toEqual(['2026-10-08', '2026-10-09'])
  })

  it('SplyExNtv가 없는 행은 버리고, 유입/유출 누락은 null', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      okJson({
        data: [
          { asset: 'btc', time: '2026-10-07T00:00:00.000000000Z', FlowInExNtv: '1' },
          row('2026-10-08', '100'),
        ],
      }),
    ) as any
    const out = await fetchExchangeReserve('2026-10-07')
    expect(out).toEqual([{ date: '2026-10-08', supply: 100, inflow: null, outflow: null }])
  })

  it('metric·next_page_url이 null이어도 응답 전체를 버리지 않음', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      okJson({
        data: [
          { asset: 'btc', time: '2026-10-07T00:00:00.000000000Z', SplyExNtv: null },
          { asset: 'btc', time: '2026-10-08T00:00:00.000000000Z', SplyExNtv: '100', FlowInExNtv: null },
        ],
        next_page_url: null,
      }),
    ) as any
    const out = await fetchExchangeReserve('2026-10-07')
    expect(out).toEqual([{ date: '2026-10-08', supply: 100, inflow: null, outflow: null }])
  })

  it('HTTP 오류면 throw', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }) as any
    await expect(fetchExchangeReserve('2026-10-08')).rejects.toThrow('CoinMetrics 503')
  })

  it('스키마 불일치면 throw', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ data: [{ asset: 'btc', time: '2026-10-08', SplyExNtv: 'abc' }] })) as any
    await expect(fetchExchangeReserve('2026-10-08')).rejects.toThrow()
  })
})
