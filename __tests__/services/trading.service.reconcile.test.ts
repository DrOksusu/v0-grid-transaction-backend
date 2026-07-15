/**
 * TradingService.reconcileBotDeadZone 테스트 (dead-zone 자가치유 오케스트레이션)
 *
 * 검증 게이트:
 * - not-running / dead-zone false / no-candidates → healed 0
 * - happy path: 재활성 + heal 쿨다운 설정 + 소켓 알림
 * - heal 쿨다운: 직후 재호출 시 스킵
 * - balance 쿨다운: buy-heal 억제
 *
 * 모듈 레벨 Map(healCooldownMap 등) 격리를 위해 매 테스트 jest.resetModules() 후 동적 import.
 */

jest.mock('../../src/services/upbit.service', () => ({
  UpbitService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../src/services/exchange/bithumb-client', () => ({
  BithumbClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../src/services/grid.service', () => ({
  GridService: {
    detectDeadZone: jest.fn(),
    findHealCandidates: jest.fn(),
    reactivateLevel: jest.fn(),
  },
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
let GridService: any;
let socketService: any;
let bithumbPriceManager: any;

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
});

async function load() {
  prisma = (await import('../../__mocks__/database')).default;
  GridService = (await import('../../src/services/grid.service')).GridService;
  socketService = (await import('../../src/services/socket.service')).socketService;
  bithumbPriceManager = (await import('../../src/services/bithumb-grid-price-manager')).bithumbPriceManager;
  TradingService = (await import('../../src/services/trading.service')).TradingService;
}

const runningBithumbBot = {
  id: 359,
  status: 'running',
  ticker: 'KRW-USDC',
  userId: 2,
  exchange: 'bithumb',
  lowerPrice: 1400,
  upperPrice: 1600,
  priceChangePercent: 0.7,
};

describe('TradingService.reconcileBotDeadZone', () => {
  it('봇이 running이 아니면 not-running 스킵', async () => {
    await load();
    prisma.bot.findUnique.mockResolvedValue({ ...runningBithumbBot, status: 'stopped' });
    const r = await TradingService.reconcileBotDeadZone(359);
    expect(r).toEqual({ healed: 0, skippedReason: 'not-running' });
    expect(GridService.detectDeadZone).not.toHaveBeenCalled();
  });

  it('dead-zone이 아니면 healed 0 (후보 조회 안 함)', async () => {
    await load();
    prisma.bot.findUnique.mockResolvedValue(runningBithumbBot);
    bithumbPriceManager.getPriceWithFallback.mockResolvedValue(1474);
    GridService.detectDeadZone.mockResolvedValue(false);
    const r = await TradingService.reconcileBotDeadZone(359);
    expect(r).toEqual({ healed: 0 });
    expect(GridService.findHealCandidates).not.toHaveBeenCalled();
  });

  it('dead-zone이지만 후보가 없으면 no-candidates', async () => {
    await load();
    prisma.bot.findUnique.mockResolvedValue(runningBithumbBot);
    bithumbPriceManager.getPriceWithFallback.mockResolvedValue(1474);
    GridService.detectDeadZone.mockResolvedValue(true);
    GridService.findHealCandidates.mockResolvedValue({ buyHeals: [] });
    const r = await TradingService.reconcileBotDeadZone(359);
    expect(r).toEqual({ healed: 0, skippedReason: 'no-candidates' });
  });

  it('happy path: 재활성 + heal 쿨다운 설정 + 소켓 알림', async () => {
    await load();
    prisma.bot.findUnique.mockResolvedValue(runningBithumbBot);
    bithumbPriceManager.getPriceWithFallback.mockResolvedValue(1474);
    GridService.detectDeadZone.mockResolvedValue(true);
    GridService.findHealCandidates.mockResolvedValue({
      buyHeals: [{ id: 10, price: 1470, sellPrice: 1480 }],
    });
    GridService.reactivateLevel.mockResolvedValue(1);

    const r = await TradingService.reconcileBotDeadZone(359);
    expect(r).toEqual({ healed: 1 });
    expect(GridService.reactivateLevel).toHaveBeenCalledWith(10, 'filled');
    expect(socketService.emitError).toHaveBeenCalledWith(
      359,
      expect.objectContaining({ type: 'system_error' })
    );
  });

  it('원자 전이 실패(reactivateLevel→0)면 healed 0, 쿨다운 미설정', async () => {
    await load();
    prisma.bot.findUnique.mockResolvedValue(runningBithumbBot);
    bithumbPriceManager.getPriceWithFallback.mockResolvedValue(1474);
    GridService.detectDeadZone.mockResolvedValue(true);
    GridService.findHealCandidates.mockResolvedValue({
      buyHeals: [{ id: 10, price: 1470, sellPrice: 1480 }],
    });
    GridService.reactivateLevel.mockResolvedValue(0); // 동시 전이

    const r = await TradingService.reconcileBotDeadZone(359);
    expect(r).toEqual({ healed: 0 });
    expect(socketService.emitError).not.toHaveBeenCalled();
  });

  it('heal 성공 직후 재호출 시 heal-cooldown으로 스킵', async () => {
    await load();
    prisma.bot.findUnique.mockResolvedValue(runningBithumbBot);
    bithumbPriceManager.getPriceWithFallback.mockResolvedValue(1474);
    GridService.detectDeadZone.mockResolvedValue(true);
    GridService.findHealCandidates.mockResolvedValue({
      buyHeals: [{ id: 10, price: 1470, sellPrice: 1480 }],
    });
    GridService.reactivateLevel.mockResolvedValue(1);

    const first = await TradingService.reconcileBotDeadZone(359);
    expect(first.healed).toBe(1);

    const second = await TradingService.reconcileBotDeadZone(359);
    expect(second).toEqual({ healed: 0, skippedReason: 'heal-cooldown' });
    // 2번째는 봇 조회조차 안 함(쿨다운이 최우선 게이트)
    expect(prisma.bot.findUnique).toHaveBeenCalledTimes(1);
  });

  it('봇 잔고 쿨다운 중이면 balance-cooldown으로 buy-heal 억제', async () => {
    await load();
    prisma.bot.findUnique.mockResolvedValue(runningBithumbBot);
    jest.spyOn(TradingService, 'isBotOnBalanceCooldown').mockReturnValue(true);
    const r = await TradingService.reconcileBotDeadZone(359);
    expect(r).toEqual({ healed: 0, skippedReason: 'balance-cooldown' });
    expect(GridService.detectDeadZone).not.toHaveBeenCalled();
  });

  it('현재가 조회 실패 시 price-fetch-failed', async () => {
    await load();
    prisma.bot.findUnique.mockResolvedValue(runningBithumbBot);
    bithumbPriceManager.getPriceWithFallback.mockRejectedValue(new Error('현재가 조회 실패'));
    const r = await TradingService.reconcileBotDeadZone(359);
    expect(r).toEqual({ healed: 0, skippedReason: 'price-fetch-failed' });
  });
});
