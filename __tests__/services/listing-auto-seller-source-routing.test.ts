// listing-auto-seller의 source별 config 분기 검증 (Task 7).
// Task 6의 임시 BITHUMB skip 가드를 제거하고, 각 주문의 order.source 기반으로
// 별도 config(UPBIT|BITHUMB)를 로드해서 매도 조건을 평가하는지 확인.

const mockGetConfig = jest.fn();

jest.mock('../../src/services/listing-auto-trader.service', () => ({
  listingAutoTraderService: { getConfig: mockGetConfig },
}));
// 거래소 클라이언트는 매도 시 실제 import만 막기 위해 stub (이번 테스트에서 호출되면 안 됨 —
// pending 마킹 단계에서 sellStatus update만 검증)
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

// source별 default config 팩토리 — 매도 즉시 트리거되도록 maxHoldMinutes=0
function upbitConfig(overrides: Record<string, any> = {}) {
  return {
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
    maxHoldMinutes: 30, // UPBIT default
    useTrailingStop: false,
    trailingStopPct: 20,
    minTakerBalance: null,
    ...overrides,
  };
}

function bithumbConfig(overrides: Record<string, any> = {}) {
  return {
    source: 'BITHUMB',
    enabled: true,
    killSwitch: false,
    amountKrw: 10000,
    useBinance: true,
    useBithumb: false,
    useMexc: true,
    useGateio: true,
    autoSellEnabled: true,
    takeProfitPct: 10,
    stopLossPct: 5,
    maxHoldMinutes: 15, // BITHUMB default (UPBIT보다 짧음)
    useTrailingStop: true,
    trailingStopPct: 10,
    minTakerBalance: null,
    ...overrides,
  };
}

// mockGetConfig가 source별로 분기된 config를 반환하도록 설정
function setupConfigBySource(opts: {
  upbit?: Record<string, any>;
  bithumb?: Record<string, any>;
} = {}) {
  mockGetConfig.mockImplementation(async (source: string) => {
    if (source === 'BITHUMB') return bithumbConfig(opts.bithumb);
    return upbitConfig(opts.upbit);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupConfigBySource();
  prisma.listingAutoOrder.findMany.mockResolvedValue([]);
  prisma.listingAutoOrder.update.mockResolvedValue({});
});

describe('listing-auto-seller source 분기 (Task 7)', () => {
  it('BITHUMB 주문 매도 시 getConfig가 "BITHUMB"으로 호출됨', async () => {
    // 1시간 전 매수 → BITHUMB maxHoldMinutes(15) 초과 → time_cut 트리거
    prisma.listingAutoOrder.findMany.mockResolvedValue([
      {
        id: 1,
        source: 'BITHUMB',
        exchange: 'binance',
        ticker: 'BCOIN',
        filledQty: 100,
        filledPrice: 1.5,
        createdAt: new Date(Date.now() - 60 * 60 * 1000), // 1h 전 매수
        announcement: { ticker: 'BCOIN' },
      },
    ]);

    await seller.checkAndSell();

    // getConfig는 'BITHUMB'으로 호출되어야 함 (이전엔 'UPBIT' 하드코딩)
    expect(mockGetConfig).toHaveBeenCalledWith('BITHUMB');
    // BITHUMB 주문도 정상적으로 evaluateOrder 진입 → pending 마킹
    expect(prisma.listingAutoOrder.update).toHaveBeenCalled();
    const call = prisma.listingAutoOrder.update.mock.calls[0][0];
    expect(call.where.id).toBe(1);
    expect(call.data.sellStatus).toBe('pending');
  });

  it('UPBIT 주문 매도 시 getConfig가 "UPBIT"으로 호출됨', async () => {
    // 1시간 전 매수 → UPBIT maxHoldMinutes(30) 초과 → time_cut 트리거
    prisma.listingAutoOrder.findMany.mockResolvedValue([
      {
        id: 2,
        source: 'UPBIT',
        exchange: 'binance',
        ticker: 'UCOIN',
        filledQty: 100,
        filledPrice: 1.5,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'UCOIN' },
      },
    ]);

    await seller.checkAndSell();

    expect(mockGetConfig).toHaveBeenCalledWith('UPBIT');
    expect(prisma.listingAutoOrder.update).toHaveBeenCalled();
    const call = prisma.listingAutoOrder.update.mock.calls[0][0];
    expect(call.where.id).toBe(2);
    expect(call.data.sellStatus).toBe('pending');
  });

  it('UPBIT/BITHUMB 혼합 — 각 주문이 source별 config로 매도됨', async () => {
    prisma.listingAutoOrder.findMany.mockResolvedValue([
      {
        id: 10,
        source: 'BITHUMB',
        exchange: 'binance',
        ticker: 'BX',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'BX' },
      },
      {
        id: 11,
        source: 'UPBIT',
        exchange: 'binance',
        ticker: 'UX',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'UX' },
      },
    ]);

    await seller.checkAndSell();

    // 두 source 모두 config 조회 (캐싱으로 source당 1회씩)
    const calledSources = mockGetConfig.mock.calls.map((c: any[]) => c[0]).sort();
    expect(calledSources).toEqual(['BITHUMB', 'UPBIT']);

    // 양쪽 모두 pending 마킹 (Task 6의 BITHUMB skip 가드 제거 확인)
    const pendingUpdates = prisma.listingAutoOrder.update.mock.calls.filter(
      (c: any) => c[0].data.sellStatus === 'pending',
    );
    expect(pendingUpdates).toHaveLength(2);
    const updatedIds = pendingUpdates.map((c: any) => c[0].where.id).sort();
    expect(updatedIds).toEqual([10, 11]);
  });

  it('BITHUMB config.autoSellEnabled=false → BITHUMB 주문 skip, UPBIT 주문은 정상 매도', async () => {
    setupConfigBySource({
      bithumb: { autoSellEnabled: false },
    });

    prisma.listingAutoOrder.findMany.mockResolvedValue([
      {
        id: 20,
        source: 'BITHUMB',
        exchange: 'binance',
        ticker: 'BSKIP',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'BSKIP' },
      },
      {
        id: 21,
        source: 'UPBIT',
        exchange: 'binance',
        ticker: 'UOK',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'UOK' },
      },
    ]);

    await seller.checkAndSell();

    // UPBIT 1건만 pending 마킹, BITHUMB 주문은 skip
    const pendingUpdates = prisma.listingAutoOrder.update.mock.calls.filter(
      (c: any) => c[0].data.sellStatus === 'pending',
    );
    expect(pendingUpdates).toHaveLength(1);
    expect(pendingUpdates[0][0].where.id).toBe(21);
  });

  it('BITHUMB config.killSwitch=true → BITHUMB 주문 skip, UPBIT는 정상', async () => {
    setupConfigBySource({
      bithumb: { killSwitch: true },
    });

    prisma.listingAutoOrder.findMany.mockResolvedValue([
      {
        id: 30,
        source: 'BITHUMB',
        exchange: 'binance',
        ticker: 'BKS',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'BKS' },
      },
      {
        id: 31,
        source: 'UPBIT',
        exchange: 'binance',
        ticker: 'UOK',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'UOK' },
      },
    ]);

    await seller.checkAndSell();

    const pendingUpdates = prisma.listingAutoOrder.update.mock.calls.filter(
      (c: any) => c[0].data.sellStatus === 'pending',
    );
    expect(pendingUpdates).toHaveLength(1);
    expect(pendingUpdates[0][0].where.id).toBe(31);
  });

  it('같은 source 주문 여러 개 — getConfig는 source당 1회만 호출 (캐싱)', async () => {
    prisma.listingAutoOrder.findMany.mockResolvedValue([
      {
        id: 40,
        source: 'BITHUMB',
        exchange: 'binance',
        ticker: 'B1',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'B1' },
      },
      {
        id: 41,
        source: 'BITHUMB',
        exchange: 'binance',
        ticker: 'B2',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'B2' },
      },
      {
        id: 42,
        source: 'UPBIT',
        exchange: 'binance',
        ticker: 'U1',
        filledQty: 100,
        filledPrice: 1.0,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        announcement: { ticker: 'U1' },
      },
    ]);

    await seller.checkAndSell();

    // BITHUMB 1회 + UPBIT 1회 = 총 2회만 호출
    expect(mockGetConfig).toHaveBeenCalledTimes(2);
    const calledSources = mockGetConfig.mock.calls.map((c: any[]) => c[0]).sort();
    expect(calledSources).toEqual(['BITHUMB', 'UPBIT']);
  });
});
