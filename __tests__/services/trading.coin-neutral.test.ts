/**
 * 그리드 코인 중립(coin_neutral) 모드 테스트
 * - resolveSellVolume: 매도 수량 계산 분기 (설계서 §8)
 * - processFilledOrder: 매수 체결 시 GridLevel.filledQty 저장 (Task 3)
 * - executeOppositeOrder: coin_neutral 매도 수량 (Task 4)
 */
jest.mock('../../src/services/upbit.service', () => ({
  UpbitService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../src/services/exchange/bithumb-client', () => ({
  BithumbClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../src/services/grid.service', () => ({
  GridService: { findExecutableGrids: jest.fn(), updateGridLevel: jest.fn() },
}));
jest.mock('../../src/services/socket.service', () => ({
  socketService: {
    emitNewTrade: jest.fn(),
    emitTradeFilled: jest.fn(),
    emitBotUpdate: jest.fn(),
    emitError: jest.fn(),
    emitBalanceUpdate: jest.fn(),
  },
}));
jest.mock('../../src/services/upbit-price-manager', () => ({
  priceManager: { getPriceWithFallback: jest.fn() },
}));
jest.mock('../../src/services/bithumb-grid-price-manager', () => ({
  bithumbPriceManager: { getPriceWithFallback: jest.fn() },
}));
jest.mock('../../src/services/profit.service', () => ({
  ProfitService: { recordProfit: jest.fn() },
}));

let prisma: any;
let TradingService: any;

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
});

async function loadTradingService() {
  const dbMock = await import('../../__mocks__/database');
  prisma = dbMock.default;
  const mod = await import('../../src/services/trading.service');
  TradingService = mod.TradingService;
}

describe('resolveSellVolume — 매도 수량 계산 분기', () => {
  it('fixed_amount: orderAmount / 매도가 (기존 동작 회귀 고정)', async () => {
    await loadTradingService();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'fixed_amount' },
      { price: 1008, buyPrice: 1000 }
    );
    expect(volume).toBeCloseTo(10000 / 1008, 10);
    expect(prisma.gridLevel.findFirst).not.toHaveBeenCalled();
  });

  it('profitMode 미지정(undefined)이어도 기존 동작 유지', async () => {
    await loadTradingService();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000 },
      { price: 1008, buyPrice: 1000 }
    );
    expect(volume).toBeCloseTo(10000 / 1008, 10);
    expect(prisma.gridLevel.findFirst).not.toHaveBeenCalled();
  });

  it('coin_neutral + directFilledQty: 전달된 체결 수량 사용 (DB 조회 없음)', async () => {
    await loadTradingService();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'coin_neutral' },
      { price: 1008, buyPrice: 1000 },
      9.995
    );
    expect(volume).toBe(9.995);
    expect(prisma.gridLevel.findFirst).not.toHaveBeenCalled();
  });

  it('coin_neutral: 대응 매수 GridLevel.filledQty 사용 (주기 매도 경로)', async () => {
    await loadTradingService();
    prisma.gridLevel.findFirst.mockResolvedValue({ filledQty: 10.005 });
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'coin_neutral' },
      { price: 1008, buyPrice: 1000 }
    );
    expect(volume).toBe(10.005);
    expect(prisma.gridLevel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: 1,
          type: 'buy',
          filledQty: { not: null },
        }),
      })
    );
  });

  it('coin_neutral + filledQty 미존재: 정액 방식 폴백 + console.warn', async () => {
    await loadTradingService();
    prisma.gridLevel.findFirst.mockResolvedValue(null);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'coin_neutral' },
      { price: 1008, buyPrice: 1000 }
    );
    expect(volume).toBeCloseTo(10000 / 1008, 10);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('폴백'));
    warnSpy.mockRestore();
  });

  it('coin_neutral + filledQty=0: 0 수량 매도 방지 → 폴백 + 경고', async () => {
    await loadTradingService();
    prisma.gridLevel.findFirst.mockResolvedValue({ filledQty: 0 });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'coin_neutral' },
      { price: 1008, buyPrice: 1000 }
    );
    expect(volume).toBeCloseTo(10000 / 1008, 10);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('coin_neutral + buyPrice null: DB 조회 없이 폴백 + 경고', async () => {
    await loadTradingService();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'coin_neutral' },
      { price: 1008, buyPrice: null }
    );
    expect(volume).toBeCloseTo(10000 / 1008, 10);
    expect(prisma.gridLevel.findFirst).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
