// listing-auto-seller의 BITHUMB 주문 매도 가드 검증 (Important #3, Task 6).
// Task 7 머지 전 임시 안전장치 — order.source === 'BITHUMB' 인 주문은 매도 시도 안 함.
// Task 7에서 source별 config 분기 완료 후 가드 제거 예정.

const mockGetConfig = jest.fn();

jest.mock('../../src/services/listing-auto-trader.service', () => ({
  listingAutoTraderService: { getConfig: mockGetConfig },
}));
// 거래소 클라이언트는 매도 시 실제 import만 막기 위해 stub (이번 테스트에서 호출되면 안 됨)
jest.mock('../../src/services/exchange/bithumb-client', () => ({
  BithumbClient: jest.fn(),
}));
jest.mock('../../src/utils/encryption', () => ({
  decrypt: jest.fn((v: string) => v),
}));

const prisma = require('../../__mocks__/database').default;
const {
  listingAutoSellerService: seller,
} = require('../../src/services/listing-auto-seller.service');

beforeEach(() => {
  jest.clearAllMocks();
  // 기본 config: autoSellEnabled=true, 충분히 짧은 maxHoldMinutes로 매도 트리거 가능
  mockGetConfig.mockResolvedValue({
    source: 'UPBIT',
    enabled: true,
    killSwitch: false,
    amountKrw: 100000,
    useBinance: true,
    useBithumb: true,
    useMexc: false,
    useGateio: false,
    autoSellEnabled: true,
    takeProfitPct: 20,
    stopLossPct: 10,
    maxHoldMinutes: 0, // 즉시 time_cut 트리거 → 매도 시도 발생
    useTrailingStop: false,
    trailingStopPct: 20,
    minTakerBalance: null,
  });
  prisma.listingAutoOrder.findMany.mockResolvedValue([]);
  prisma.listingAutoOrder.update.mockResolvedValue({});
});

describe('listing-auto-seller BITHUMB 가드 (Task 6 Important #3)', () => {
  it('order.source === "BITHUMB" 인 주문은 evaluateOrder가 호출되지 않음 (매도 가드)', async () => {
    prisma.listingAutoOrder.findMany.mockResolvedValue([
      {
        id: 1,
        source: 'BITHUMB',
        exchange: 'binance',
        ticker: 'BCOIN',
        filledQty: 100,
        filledPrice: 1.5,
        createdAt: new Date(Date.now() - 60 * 60 * 1000), // 1h 전 매수
        announcement: { ticker: 'BCOIN', source: 'BITHUMB' },
      },
    ]);

    await seller.checkAndSell();

    // BITHUMB 주문은 매도 시도(update sellStatus pending) 자체가 발생하지 않아야 함
    expect(prisma.listingAutoOrder.update).not.toHaveBeenCalled();
  });

  it('order.source === "UPBIT" 인 주문은 정상적으로 evaluateOrder 진행 (매도 시도)', async () => {
    prisma.listingAutoOrder.findMany.mockResolvedValue([
      {
        id: 2,
        source: 'UPBIT',
        exchange: 'binance',
        ticker: 'UCOIN',
        filledQty: 100,
        filledPrice: 1.5,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'UCOIN', source: 'UPBIT' },
      },
    ]);

    await seller.checkAndSell();

    // UPBIT 주문은 evaluateOrder 진입 → 시간 컷 sellStatus='pending' upsert 발생
    expect(prisma.listingAutoOrder.update).toHaveBeenCalled();
    const call = prisma.listingAutoOrder.update.mock.calls[0][0];
    expect(call.where.id).toBe(2);
    // 매도 마킹 (sellStatus pending, reason: time_cut — maxHoldMinutes=0 이므로 즉시 트리거)
    expect(call.data.sellStatus).toBe('pending');
  });

  it('UPBIT/BITHUMB 혼합 시 BITHUMB는 skip, UPBIT만 매도 시도', async () => {
    prisma.listingAutoOrder.findMany.mockResolvedValue([
      {
        id: 10,
        source: 'BITHUMB',
        exchange: 'binance',
        ticker: 'BX',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'BX', source: 'BITHUMB' },
      },
      {
        id: 11,
        source: 'UPBIT',
        exchange: 'binance',
        ticker: 'UX',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'UX', source: 'UPBIT' },
      },
    ]);

    await seller.checkAndSell();

    // 정확히 UPBIT 1건만 매도 마킹 (BITHUMB는 가드로 차단)
    const updateCalls = prisma.listingAutoOrder.update.mock.calls.filter(
      (c: any) => c[0].data.sellStatus === 'pending',
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0].where.id).toBe(11); // UPBIT만
  });

  it('autoSellEnabled=false면 source 무관하게 모두 skip', async () => {
    mockGetConfig.mockResolvedValueOnce({
      source: 'UPBIT',
      enabled: true,
      killSwitch: false,
      amountKrw: 100000,
      useBinance: true,
      useBithumb: true,
      useMexc: false,
      useGateio: false,
      autoSellEnabled: false, // ← 매도 비활성
      takeProfitPct: 20,
      stopLossPct: 10,
      maxHoldMinutes: 0,
      useTrailingStop: false,
      trailingStopPct: 20,
      minTakerBalance: null,
    });
    prisma.listingAutoOrder.findMany.mockResolvedValue([
      {
        id: 99,
        source: 'UPBIT',
        exchange: 'binance',
        ticker: 'X',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'X', source: 'UPBIT' },
      },
    ]);

    await seller.checkAndSell();

    // autoSellEnabled=false면 findMany도 호출 안 되고 매도 시도 안 함
    expect(prisma.listingAutoOrder.update).not.toHaveBeenCalled();
  });
});
