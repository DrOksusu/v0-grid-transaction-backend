import { reconcileCrossExchangeBot } from '../../src/services/cross-exchange-reconciliation.service';

const mockBot = (overrides: Record<string, any> = {}) => ({
  id: 1, coin: 'USDE', targetDirection: 'UB',
  lastResumeAt: new Date('2026-05-01T00:00:00Z'),
  createdAt: new Date('2026-04-30T00:00:00Z'),
  ...overrides,
}) as any;

describe('reconcileCrossExchangeBot', () => {
  it('DB FILLED 와 거래소 done order 일치 시 isReconciled=true', async () => {
    const stablecoinPrisma = {
      crossExchangeArbBot: { findUnique: jest.fn().mockResolvedValue(mockBot()) },
      crossExchangeArbTrade: {
        findMany: jest.fn().mockResolvedValue([
          { id: BigInt(1), status: 'FILLED', legAFilledQty: 10, legBFilledQty: 10, createdAt: new Date('2026-05-01T01:00:00Z') },
        ]),
      },
    };
    const upbitClient = {} as any;
    const bithumbClient = {} as any;

    const result = await reconcileCrossExchangeBot(1, stablecoinPrisma, upbitClient, bithumbClient, {
      mockUpbitOrders: [{ filledQty: 10, side: 'buy', timestamp: new Date('2026-05-01T01:00:00Z') }],
      mockBithumbOrders: [{ filledQty: 10, side: 'sell', timestamp: new Date('2026-05-01T01:00:00Z') }],
    });

    expect(result.isReconciled).toBe(true);
    expect(result.dbFilledCount).toBe(1);
    expect(result.sinceSource).toBe('lastResumeAt');
  });

  it('DB FILLED 보다 거래소 done order 가 적으면 불일치', async () => {
    const stablecoinPrisma = {
      crossExchangeArbBot: { findUnique: jest.fn().mockResolvedValue(mockBot()) },
      crossExchangeArbTrade: {
        findMany: jest.fn().mockResolvedValue([
          { id: BigInt(1), status: 'FILLED', legAFilledQty: 10, legBFilledQty: 10, createdAt: new Date('2026-05-01T01:00:00Z') },
        ]),
      },
    };
    const result = await reconcileCrossExchangeBot(1, stablecoinPrisma, {} as any, {} as any, {
      mockUpbitOrders: [],
      mockBithumbOrders: [],
    });
    expect(result.isReconciled).toBe(false);
    expect(result.diff).toBeDefined();
  });

  it('100건 초과 시 pageTruncated=true', async () => {
    const stablecoinPrisma = {
      crossExchangeArbBot: { findUnique: jest.fn().mockResolvedValue(mockBot()) },
      crossExchangeArbTrade: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: 101 }, (_, i) => ({ id: BigInt(i + 1), status: 'FILLED', legAFilledQty: 10, legBFilledQty: 10, createdAt: new Date() })),
        ),
      },
    };
    const result = await reconcileCrossExchangeBot(1, stablecoinPrisma, {} as any, {} as any, {
      mockUpbitOrders: [], mockBithumbOrders: [],
    });
    expect(result.pageTruncated).toBe(true);
    expect(result.dbFilledCount).toBe(100);
  });

  it('pageTruncated=true 면 카운트 일치해도 isReconciled=false (false-positive 방지)', async () => {
    const stablecoinPrisma = {
      crossExchangeArbBot: { findUnique: jest.fn().mockResolvedValue(mockBot()) },
      crossExchangeArbTrade: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: 101 }, (_, i) => ({ id: BigInt(i + 1), status: 'FILLED', legAFilledQty: 10, legBFilledQty: 10, createdAt: new Date() })),
        ),
      },
    };
    const result = await reconcileCrossExchangeBot(1, stablecoinPrisma, {} as any, {} as any, {
      mockUpbitOrders: Array.from({ length: 100 }, () => ({ filledQty: 10, side: 'buy' as const, timestamp: new Date() })),
      mockBithumbOrders: Array.from({ length: 100 }, () => ({ filledQty: 10, side: 'sell' as const, timestamp: new Date() })),
    });
    expect(result.pageTruncated).toBe(true);
    expect(result.isReconciled).toBe(false);
    expect(result.diff).toContain('truncated');
  });

  it('lastResumeAt 없으면 sinceSource=createdAt fallback', async () => {
    const stablecoinPrisma = {
      crossExchangeArbBot: { findUnique: jest.fn().mockResolvedValue(mockBot({ lastResumeAt: null })) },
      crossExchangeArbTrade: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const result = await reconcileCrossExchangeBot(1, stablecoinPrisma, {} as any, {} as any, {
      mockUpbitOrders: [], mockBithumbOrders: [],
    });
    expect(result.sinceSource).toBe('createdAt');
    expect(result.sinceAt.toISOString()).toBe('2026-04-30T00:00:00.000Z');
  });
});
