import { prisma } from '../../../__mocks__/database'
import { fetchExchangeReserve } from '../../../src/services/exchange-reserve.client'
import {
  getReserveView,
  runBackfill,
  runDailyCollect,
} from '../../../src/services/exchange-reserve.service'

jest.mock('../../../src/services/exchange-reserve.client', () => ({
  fetchExchangeReserve: jest.fn(),
}))

const fetchMock = fetchExchangeReserve as jest.Mock
const db = prisma.exchangeReserveDaily as Record<string, jest.Mock>
const NOW = new Date('2026-10-11T03:00:00Z')
const p = (date: string, supply: number) => ({ date, supply, inflow: 10, outflow: 20 })

beforeEach(() => {
  jest.clearAllMocks()
})

describe('runBackfill', () => {
  it('가장 오래된 일자가 historyStart면 건너뜀 (fetch 없음)', async () => {
    db.findFirst.mockResolvedValueOnce({ date: new Date('2011-04-24T00:00:00Z') })
    expect(await runBackfill(NOW)).toEqual({ skipped: true, inserted: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.createMany).not.toHaveBeenCalled()
  })

  it('행이 없으면 historyStart부터 조회해 전부 createMany(skipDuplicates)', async () => {
    db.findFirst.mockResolvedValueOnce(null)
    fetchMock.mockResolvedValue([p('2011-04-24', 100), p('2011-04-25', 99)])
    db.createMany.mockResolvedValue({ count: 2 })
    expect(await runBackfill(NOW)).toEqual({ skipped: false, inserted: 2 })
    expect(fetchMock).toHaveBeenCalledWith('2011-04-24')
    const arg = db.createMany.mock.calls[0][0]
    expect(arg.skipDuplicates).toBe(true)
    expect(arg.data).toHaveLength(2)
    expect(arg.data[0]).toEqual({
      date: new Date('2011-04-24T00:00:00Z'),
      supplyBtc: 100,
      inflowBtc: 10,
      outflowBtc: 20,
    })
  })

  it('가장 오래된 일자가 2024-10-11이면 그 이전 행만 createMany', async () => {
    db.findFirst.mockResolvedValueOnce({ date: new Date('2024-10-11T00:00:00Z') })
    fetchMock.mockResolvedValue([p('2011-04-24', 100), p('2024-10-10', 98), p('2024-10-11', 97), p('2024-10-12', 96)])
    db.createMany.mockResolvedValue({ count: 2 })
    expect(await runBackfill(NOW)).toEqual({ skipped: false, inserted: 2 })
    expect(fetchMock).toHaveBeenCalledWith('2011-04-24')
    const arg = db.createMany.mock.calls[0][0]
    expect(arg.data.map((r: { date: Date }) => r.date.toISOString().slice(0, 10))).toEqual(['2011-04-24', '2024-10-10'])
  })
})

describe('runDailyCollect', () => {
  it('최근 7일을 upsert하고 최신 일자가 늘면 newData=true', async () => {
    db.findFirst.mockResolvedValue({ date: new Date('2026-10-08T00:00:00Z') })
    fetchMock.mockResolvedValue([p('2026-10-08', 100), p('2026-10-09', 99)])
    db.upsert.mockResolvedValue({})
    const r = await runDailyCollect(NOW)
    expect(fetchMock).toHaveBeenCalledWith('2026-10-04')
    expect(db.upsert).toHaveBeenCalledTimes(2)
    expect(db.upsert.mock.calls[1][0].where).toEqual({ date: new Date('2026-10-09T00:00:00Z') })
    expect(r).toEqual({ status: 'ok', upserted: 2, prevLatest: '2026-10-08', latest: '2026-10-09', newData: true })
  })

  it('최신 일자가 그대로면 newData=false', async () => {
    db.findFirst.mockResolvedValue({ date: new Date('2026-10-09T00:00:00Z') })
    fetchMock.mockResolvedValue([p('2026-10-09', 99)])
    db.upsert.mockResolvedValue({})
    const r = await runDailyCollect(NOW)
    expect(r.newData).toBe(false)
    expect(r.latest).toBe('2026-10-09')
  })

  it('마지막 저장일이 7일보다 오래되면 그 날부터 조회해 빈 구간을 채움', async () => {
    db.findFirst.mockResolvedValue({ date: new Date('2026-09-20T00:00:00Z') })
    fetchMock.mockResolvedValue([])
    await runDailyCollect(NOW)
    expect(fetchMock).toHaveBeenCalledWith('2026-09-20')
  })
})

describe('getReserveView', () => {
  it('Decimal을 숫자로 바꾸고 days 구간만 series로 반환, summary는 전체로 계산', async () => {
    db.findMany.mockResolvedValue([
      { date: new Date('2026-06-01T00:00:00Z'), supplyBtc: '300', inflowBtc: null, outflowBtc: null },
      { date: new Date('2026-10-09T00:00:00Z'), supplyBtc: '2672865.5', inflowBtc: '27171', outflowBtc: '22909' },
    ])
    const v = await getReserveView(90, NOW)
    expect(v.series).toEqual([{ date: '2026-10-09', supply: 2672865.5, inflow: 27171, outflow: 22909 }])
    expect(v.summary.latestDate).toBe('2026-10-09')
    expect(v.summary.low1y).toEqual({ date: '2026-06-01', supply: 300 })
    expect(db.findMany.mock.calls[0][0].where.date.gte).toEqual(new Date('2025-09-06T00:00:00Z'))
  })

  it('1095일은 gte가 today-1095이고 주 단위로 줄어듦', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 9, 11 - 14 + i)),
      supplyBtc: String(100 + i),
      inflowBtc: null,
      outflowBtc: null,
    }))
    db.findMany.mockResolvedValue(rows)
    const v = await getReserveView(1095, NOW)
    expect(db.findMany.mock.calls[0][0].where.date.gte).toEqual(new Date('2023-10-12T00:00:00Z'))
    expect(v.series).toHaveLength(3)
    expect(v.series[v.series.length - 1].date).toBe('2026-10-11')
  })

  it("'all'은 gte가 historyStart(2011-04-24)이고 주 단위로 줄어듦", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 9, 11 - 14 + i)),
      supplyBtc: String(100 + i),
      inflowBtc: null,
      outflowBtc: null,
    }))
    db.findMany.mockResolvedValue(rows)
    const v = await getReserveView('all', NOW)
    expect(db.findMany.mock.calls[0][0].where.date.gte).toEqual(new Date('2011-04-24T00:00:00Z'))
    expect(v.series).toHaveLength(3)
  })
})
