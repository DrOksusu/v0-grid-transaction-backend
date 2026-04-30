import { stablecoinPrisma, prisma } from '../../__mocks__/database';

// UpbitService mock 먼저 setup
const mockGetOrdersByMarket = jest.fn();
jest.mock('../../src/services/upbit.service', () => ({
  UpbitService: jest.fn().mockImplementation(() => ({
    getOrdersByMarket: mockGetOrdersByMarket,
  })),
}));

// encryption mock
jest.mock('../../src/utils/encryption', () => ({
  decrypt: jest.fn((s: string) => s),
}));

import { reconcileBotAssets } from '../../src/services/maker-taker-asset-reconciliation.service';

describe('reconcileBotAssets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOrdersByMarket.mockReset();
  });

  const baseBot = {
    id: 1,
    userId: 100,
    makerCoin: 'USDS',
    takerCoin: 'USDT',
    lastResumeAt: new Date('2026-04-30T00:00:00Z'),
    createdAt: new Date('2026-04-29T00:00:00Z'),
  };

  const baseCredential = {
    id: 1,
    userId: 100,
    exchange: 'upbit',
    apiKey: 'enc-access',
    secretKey: 'enc-secret',
  };

  it('filled 0건 + done 0건 → reconciled', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);
    mockGetOrdersByMarket.mockResolvedValue([]);

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.bot.filledTradesCount).toBe(0);
    expect(report.exchange.makerDoneOrderCount).toBe(0);
    expect(report.exchange.takerDoneOrderCount).toBe(0);
    expect(report.diff.makerCoinDiff).toBe('0');
    expect(report.isReconciled).toBe(true);
    expect(report.sinceSource).toBe('lastResumeAt');
  });

  it('filled 1건 (qty=10) + done 매칭 → reconciled', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 1n, quantity: '10', makerFilledAt: new Date('2026-04-30T01:00:00Z') },
    ]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);
    mockGetOrdersByMarket.mockImplementation(async (market: string) => {
      if (market === 'KRW-USDS') {
        return [{ side: 'bid', state: 'done', executed_volume: '10', created_at: '2026-04-30T01:00:00Z' }];
      }
      if (market === 'KRW-USDT') {
        return [{ side: 'ask', state: 'done', executed_volume: '10', created_at: '2026-04-30T01:00:00Z' }];
      }
      return [];
    });

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.diff.makerCoinDiff).toBe('0');
    expect(report.diff.takerCoinDiff).toBe('0');
    expect(report.isReconciled).toBe(true);
  });

  it('filled 1건 + done 0건 → 불일치, makerCoinDiff = 10', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 1n, quantity: '10', makerFilledAt: new Date('2026-04-30T01:00:00Z') },
    ]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);
    mockGetOrdersByMarket.mockResolvedValue([]);

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.diff.makerCoinDiff).toBe('10');
    expect(report.isReconciled).toBe(false);
  });

  it('lastResumeAt=null → fallback createdAt, sinceSource=createdAt', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBot,
      lastResumeAt: null,
    });
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);
    mockGetOrdersByMarket.mockResolvedValue([]);

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.sinceSource).toBe('createdAt');
    expect(report.sinceUtc).toBe(baseBot.createdAt.toISOString());
  });

  it('done order 가 lastResumeAt 이전이면 결과에서 제외', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);
    mockGetOrdersByMarket.mockImplementation(async (market: string) => {
      if (market === 'KRW-USDS') {
        return [
          // before lastResumeAt — 제외
          { side: 'bid', state: 'done', executed_volume: '5', created_at: '2026-04-29T12:00:00Z' },
          // after lastResumeAt — 포함
          { side: 'bid', state: 'done', executed_volume: '7', created_at: '2026-04-30T01:00:00Z' },
        ];
      }
      return [];
    });

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.exchange.makerDoneOrderCount).toBe(1);
    expect(report.exchange.makerDoneBidQty).toBe('7');
  });

  it('done order count===100 → pageTruncated=true', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);
    const hundred = Array.from({ length: 100 }, () => ({
      side: 'bid',
      state: 'done',
      executed_volume: '0.1',
      created_at: '2026-04-30T01:00:00Z',
    }));
    mockGetOrdersByMarket.mockImplementation(async (market: string) => {
      if (market === 'KRW-USDS') return hundred;
      return [];
    });

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.exchange.pageTruncated).toBe(true);
  });

  it('ownership 미일치 → throw', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBot,
      userId: 999,
    });

    await expect(reconcileBotAssets({ botId: 1, userId: 100 })).rejects.toThrow('not owned');
  });

  it('credential 부재 → throw "credential not registered"', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(null);

    await expect(reconcileBotAssets({ botId: 1, userId: 100 })).rejects.toThrow('credential not registered');
  });
});
