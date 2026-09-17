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

describe('processFilledOrder — 매수 체결 시 filledQty 저장', () => {
  function setupFilledOrderMocks() {
    prisma.gridLevel.updateMany.mockResolvedValue({ count: 1 }); // pending→filled 원자 전이 성공
    prisma.gridLevel.update.mockResolvedValue({});
    prisma.bot.update.mockResolvedValue({});
    prisma.trade.findFirst.mockResolvedValue({ id: 77 });
    prisma.trade.update.mockResolvedValue({});
    prisma.bot.findUnique.mockResolvedValue(null); // updatedBot null → 반대주문 스킵 (테스트 격리)
  }

  it('buy 체결이면 GridLevel.filledQty에 실제 체결 수량 저장', async () => {
    await loadTradingService();
    setupFilledOrderMocks();

    const grid = {
      id: 10, botId: 1, type: 'buy', price: 1000,
      orderId: 'uuid-1', buyPrice: null, sellPrice: 1008,
    };
    const order = { state: 'done', avg_price: '999.5', executed_volume: '10.005', trades: [] };

    await (TradingService as any).processFilledOrder(grid, order, {}, 5, 'upbit');

    expect(prisma.gridLevel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10 },
        data: { filledQty: 10.005 },
      })
    );
  });

  it('sell 체결이면 filledQty를 저장하지 않음', async () => {
    await loadTradingService();
    setupFilledOrderMocks();

    const grid = {
      id: 11, botId: 1, type: 'sell', price: 1008,
      orderId: 'uuid-2', buyPrice: 1000, sellPrice: null,
    };
    const order = { state: 'done', avg_price: '1008', executed_volume: '10.005', trades: [] };

    await (TradingService as any).processFilledOrder(grid, order, {}, 5, 'upbit');

    const filledQtyCalls = prisma.gridLevel.update.mock.calls.filter(
      ([arg]: any[]) => arg?.data && 'filledQty' in arg.data
    );
    expect(filledQtyCalls).toHaveLength(0);
  });
});

describe('executeOppositeOrder — 매수 체결 직후 매도 수량', () => {
  function setupOppositeMocks() {
    // 매도 그리드 검색 → 발견
    prisma.gridLevel.findFirst.mockResolvedValue({ id: 20, price: 1008, status: 'inactive' });
    prisma.gridLevel.updateMany.mockResolvedValue({ count: 1 }); // inactive→pending 전이 성공
    prisma.gridLevel.update.mockResolvedValue({});
    prisma.trade.create.mockResolvedValue({ id: 1, createdAt: new Date() });
    return { sellLimit: jest.fn().mockResolvedValue({ uuid: 'sell-1' }) };
  }

  const filledBuyGrid = {
    id: 10, type: 'buy', price: 1000, sellPrice: 1008, buyPrice: null, botId: 1,
  };

  it('coin_neutral: 매도 수량 = 전달된 매수 체결 수량', async () => {
    await loadTradingService();
    const upbit = setupOppositeMocks();

    await (TradingService as any).executeOppositeOrder(
      upbit,
      { id: 1, ticker: 'KRW-USDT', orderAmount: 10000, profitMode: 'coin_neutral' },
      filledBuyGrid,
      0,
      'upbit',
      9.995 // buyFilledQty: 방금 체결된 매수 수량
    );

    expect(upbit.sellLimit).toHaveBeenCalledWith('KRW-USDT', 1008, 9.995);
    // coin_neutral Trade 기록: amount/total이 실제 매도 수량 기준
    expect(prisma.trade.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'sell', amount: 9.995, total: 9.995 * 1008 }),
      })
    );
  });

  it('fixed_amount 회귀: 매도 수량 = orderAmount / sellPrice, total = orderAmount', async () => {
    await loadTradingService();
    const upbit = setupOppositeMocks();

    await (TradingService as any).executeOppositeOrder(
      upbit,
      { id: 1, ticker: 'KRW-USDT', orderAmount: 10000, profitMode: 'fixed_amount' },
      filledBuyGrid,
      0,
      'upbit',
      9.995 // coin_neutral이 아니므로 무시되어야 함
    );

    expect(upbit.sellLimit).toHaveBeenCalledWith('KRW-USDT', 1008, 10000 / 1008);
    expect(prisma.trade.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'sell', total: 10000 }),
      })
    );
  });
});
