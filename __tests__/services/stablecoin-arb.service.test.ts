import { stablecoinPrisma } from '../../__mocks__/database';
import {
  getOpportunityStats,
  listRecentOpportunities,
  getSimOverview,
} from '../../src/services/stablecoin-arb.service';

describe('stablecoin-arb.service 신규 헬퍼', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getOpportunityStats', () => {
    it('total/last24h/last1h/ge20bpLast24h 카운트를 반환한다', async () => {
      const countMock = stablecoinPrisma.stablecoinArbOpportunity.count as jest.Mock;
      countMock
        .mockResolvedValueOnce(373) // total
        .mockResolvedValueOnce(370) // last24h
        .mockResolvedValueOnce(0)   // last1h
        .mockResolvedValueOnce(19); // ge20bpLast24h

      const stats = await getOpportunityStats();
      expect(stats).toEqual({
        total: 373,
        last24h: 370,
        last1h: 0,
        ge20bpLast24h: 19,
      });
      expect(countMock).toHaveBeenCalledTimes(4);

      // 4번 count 호출의 인자가 정확한지 검증 (회귀 방어)
      expect(countMock).toHaveBeenNthCalledWith(1);  // total: 인자 없음
      expect(countMock).toHaveBeenNthCalledWith(2, {
        where: { detectedAt: { gt: expect.any(Date) } },
      });
      expect(countMock).toHaveBeenNthCalledWith(3, {
        where: { detectedAt: { gt: expect.any(Date) } },
      });
      expect(countMock).toHaveBeenNthCalledWith(4, {
        where: { detectedAt: { gt: expect.any(Date) }, spreadBps: { gte: 20 } },
      });
    });
  });

  describe('listRecentOpportunities', () => {
    it('default limit=20으로 detectedAt desc 정렬 조회한다', async () => {
      const findManyMock = stablecoinPrisma.stablecoinArbOpportunity.findMany as jest.Mock;
      findManyMock.mockResolvedValueOnce([{ id: 1n, spreadBps: 20 }]);

      const rows = await listRecentOpportunities();
      expect(findManyMock).toHaveBeenCalledWith({
        orderBy: { detectedAt: 'desc' },
        take: 20,
      });
      expect(rows).toHaveLength(1);
    });

    it('limit=5 인자를 그대로 전달한다', async () => {
      const findManyMock = stablecoinPrisma.stablecoinArbOpportunity.findMany as jest.Mock;
      findManyMock.mockResolvedValueOnce([]);

      await listRecentOpportunities(5);
      expect(findManyMock).toHaveBeenCalledWith({
        orderBy: { detectedAt: 'desc' },
        take: 5,
      });
    });

    it('limit > 100 인 경우 100으로 클램프한다', async () => {
      const findManyMock = stablecoinPrisma.stablecoinArbOpportunity.findMany as jest.Mock;
      findManyMock.mockResolvedValueOnce([]);

      await listRecentOpportunities(500);
      expect(findManyMock).toHaveBeenCalledWith({
        orderBy: { detectedAt: 'desc' },
        take: 100,
      });
    });

    it('limit=NaN 인 경우 default 20으로 폴백한다', async () => {
      const findManyMock = stablecoinPrisma.stablecoinArbOpportunity.findMany as jest.Mock;
      findManyMock.mockResolvedValueOnce([]);

      await listRecentOpportunities(NaN);
      expect(findManyMock).toHaveBeenCalledWith({
        orderBy: { detectedAt: 'desc' },
        take: 20,
      });
    });

    it('limit=0 인 경우 1로 클램프한다', async () => {
      const findManyMock = stablecoinPrisma.stablecoinArbOpportunity.findMany as jest.Mock;
      findManyMock.mockResolvedValueOnce([]);

      await listRecentOpportunities(0);
      expect(findManyMock).toHaveBeenCalledWith({
        orderBy: { detectedAt: 'desc' },
        take: 1,
      });
    });

    it('limit=-5 인 경우 1로 클램프한다', async () => {
      const findManyMock = stablecoinPrisma.stablecoinArbOpportunity.findMany as jest.Mock;
      findManyMock.mockResolvedValueOnce([]);

      await listRecentOpportunities(-5);
      expect(findManyMock).toHaveBeenCalledWith({
        orderBy: { detectedAt: 'desc' },
        take: 1,
      });
    });
  });

  describe('getSimOverview', () => {
    it('bots / stats / recentTrades 를 묶어서 반환한다', async () => {
      const botsMock = stablecoinPrisma.makerTakerSimBot.findMany as jest.Mock;
      const tradesFindManyMock = stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock;
      const groupByMock = stablecoinPrisma.makerTakerSimTrade.groupBy as jest.Mock;
      const aggregateMock = stablecoinPrisma.makerTakerSimTrade.aggregate as jest.Mock;

      botsMock.mockResolvedValueOnce([
        { id: 1, makerCoin: 'USDS', takerCoin: 'USDT', bidOffsetKrw: -2, quantity: '10', enabled: true, killSwitch: false },
      ]);
      groupByMock.mockResolvedValueOnce([
        { status: 'PENDING', _count: { id: 3 } },
        { status: 'FILLED', _count: { id: 12 } },
        { status: 'EXPIRED', _count: { id: 5 } },
      ]);
      aggregateMock.mockResolvedValueOnce({ _sum: { netProfitKrw: '100' } });
      tradesFindManyMock.mockResolvedValueOnce([{ id: 1n, status: 'PENDING' }]);

      const overview = await getSimOverview();
      expect(overview.bots).toHaveLength(1);
      expect(overview.stats).toEqual({
        pending: 3,
        filled: 12,
        expired: 5,
        cancelled: 0,
        totalNetProfitKrw: '100',
      });
      expect(overview.recentTrades).toHaveLength(1);

      // 4 prisma 호출 인자 검증 (회귀 방어)
      expect(botsMock).toHaveBeenCalledWith({ orderBy: { id: 'asc' } });
      expect(groupByMock).toHaveBeenCalledWith({
        by: ['status'],
        _count: { id: true },
      });
      expect(aggregateMock).toHaveBeenCalledWith({
        _sum: { netProfitKrw: true },
      });
      expect(tradesFindManyMock).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
    });
  });
});
