/**
 * 봇별 미체결 매수 상한 정리 테스트 (#118)
 *
 * 대상:
 * - getPendingBuyCap        : 환경변수 GRID_MAX_PENDING_BUYS 파싱 (기본 15, 0=끔, 하방 추가 기준 7 미만 금지)
 * - enforcePendingBuyCap    : 상한 초과 시 원거리 매수부터 사이클당 최대 3개 취소 (무음)
 * - trimBuyOrdersOnInsufficientBalance 안전 검사 : 부분 체결·체결 완료·조회 실패 주문은 취소하지 않음
 */

import prisma from '../../__mocks__/database';

jest.mock('../../src/services/upbit.service');
jest.mock('../../src/services/socket.service');
jest.mock('../../src/services/upbit-price-manager');
jest.mock('../../src/services/profit.service');

import { UpbitService } from '../../src/services/upbit.service';
import { socketService } from '../../src/services/socket.service';
import { priceManager } from '../../src/services/upbit-price-manager';
import { TradingService } from '../../src/services/trading.service';

const mockSocketService = socketService as jest.Mocked<typeof socketService>;

function createMockUpbit() {
  return {
    sellLimit: jest.fn(),
    buyLimit: jest.fn(),
    cancelOrder: jest.fn().mockResolvedValue({ state: 'wait', executed_volume: '0' }),
    getFilledOrders: jest.fn(),
    getOrder: jest.fn().mockResolvedValue({ state: 'wait', executed_volume: '0' }),
  } as any;
}

/** 현재가 50,000원 아래로 1%씩 n개의 미체결 매수 (가까운 순) */
function pendingBuys(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    price: Math.round(50000 * Math.pow(0.99, i + 1)),
    status: 'pending',
    orderId: `order-${i + 1}`,
    type: 'buy',
  }));
}

const ORIGINAL_ENV = process.env.GRID_MAX_PENDING_BUYS;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GRID_MAX_PENDING_BUYS;
  TradingService.clearLastCheckedPrice(1); // 취소 0건 쿨다운이 테스트 간 누수되지 않도록
  prisma.gridLevel.update.mockResolvedValue({});
  prisma.bot.update.mockResolvedValue({});
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.GRID_MAX_PENDING_BUYS;
  else process.env.GRID_MAX_PENDING_BUYS = ORIGINAL_ENV;
});

describe('TradingService.getPendingBuyCap', () => {
  it('환경변수 미설정 시 기본 15', () => {
    expect(TradingService.getPendingBuyCap()).toBe(15);
  });

  it('0이면 끔(0)', () => {
    process.env.GRID_MAX_PENDING_BUYS = '0';
    expect(TradingService.getPendingBuyCap()).toBe(0);
  });

  it('숫자가 아니면 기본 15', () => {
    process.env.GRID_MAX_PENDING_BUYS = 'abc';
    expect(TradingService.getPendingBuyCap()).toBe(15);
  });

  it('하방 추가 기준(7)보다 작으면 7로 올림 — 추가·취소 반복 방지', () => {
    process.env.GRID_MAX_PENDING_BUYS = '3';
    expect(TradingService.getPendingBuyCap()).toBe(7);
  });

  it('20으로 설정하면 20', () => {
    process.env.GRID_MAX_PENDING_BUYS = '20';
    expect(TradingService.getPendingBuyCap()).toBe(20);
  });
});

describe('TradingService.enforcePendingBuyCap', () => {
  it('추정 미체결 매수가 상한 이하면 조회조차 하지 않음', async () => {
    const upbit = createMockUpbit();
    const r = await TradingService.enforcePendingBuyCap(upbit, 1, 'KRW-BTC', 'upbit', 50000, 15);
    expect(r).toEqual({ cancelled: 0 });
    expect(prisma.gridLevel.findMany).not.toHaveBeenCalled();
    expect(upbit.cancelOrder).not.toHaveBeenCalled();
  });

  it('상한이 0(끔)이면 아무것도 취소하지 않음', async () => {
    process.env.GRID_MAX_PENDING_BUYS = '0';
    const upbit = createMockUpbit();
    const r = await TradingService.enforcePendingBuyCap(upbit, 1, 'KRW-BTC', 'upbit', 50000, 40);
    expect(r).toEqual({ cancelled: 0 });
    expect(prisma.gridLevel.findMany).not.toHaveBeenCalled();
  });

  it('18개면 가장 먼(낮은) 3개를 취소하고 15개 유지 — 현재가 재조회·알림·에러 초기화 없음', async () => {
    const upbit = createMockUpbit();
    prisma.gridLevel.findMany.mockResolvedValueOnce(pendingBuys(18));

    const r = await TradingService.enforcePendingBuyCap(upbit, 1, 'KRW-BTC', 'upbit', 50000, 18);

    expect(r.cancelled).toBe(3);
    expect(upbit.cancelOrder).toHaveBeenCalledTimes(3);
    expect(upbit.cancelOrder).toHaveBeenCalledWith('order-18', 'KRW-BTC');
    expect(upbit.cancelOrder).toHaveBeenCalledWith('order-17', 'KRW-BTC');
    expect(upbit.cancelOrder).toHaveBeenCalledWith('order-16', 'KRW-BTC');
    expect(upbit.cancelOrder).not.toHaveBeenCalledWith('order-15', 'KRW-BTC');
    // 취소된 레벨은 available로 되돌림 (가격이 내려오면 다시 주문)
    expect(prisma.gridLevel.update).toHaveBeenCalledWith({
      where: { id: 18 },
      data: { status: 'available', orderId: null },
    });
    // 평상시 정리는 무음: 현재가 REST 재조회·소켓 알림·errorMessage 초기화 없음
    expect(UpbitService.getCurrentPrice).not.toHaveBeenCalled();
    expect(mockSocketService.emitError).not.toHaveBeenCalled();
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it('25개여도 한 사이클에 최대 3개만 취소 (가장 먼 것부터)', async () => {
    const upbit = createMockUpbit();
    prisma.gridLevel.findMany.mockResolvedValueOnce(pendingBuys(25));

    const r = await TradingService.enforcePendingBuyCap(upbit, 1, 'KRW-BTC', 'upbit', 50000, 25);

    expect(r.cancelled).toBe(3);
    expect(upbit.cancelOrder.mock.calls.map((c: any[]) => c[0])).toEqual(['order-25', 'order-24', 'order-23']);
  });

  it('부분 체결된 주문은 취소하지 않음 (코인 추적 상실 방지)', async () => {
    const upbit = createMockUpbit();
    prisma.gridLevel.findMany.mockResolvedValueOnce(pendingBuys(18));
    upbit.getOrder.mockImplementation(async (uuid: string) =>
      uuid === 'order-18' ? { state: 'wait', executed_volume: '0.0001' } : { state: 'wait', executed_volume: '0' }
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation();

    const r = await TradingService.enforcePendingBuyCap(upbit, 1, 'KRW-BTC', 'upbit', 50000, 18);

    expect(upbit.cancelOrder).not.toHaveBeenCalledWith('order-18', 'KRW-BTC');
    expect(r.cancelled).toBe(2);
    warn.mockRestore();
  });

  it('이미 체결 완료된 주문은 취소하지 않음 (체결 처리에 맡김)', async () => {
    const upbit = createMockUpbit();
    prisma.gridLevel.findMany.mockResolvedValueOnce(pendingBuys(16));
    upbit.getOrder.mockResolvedValueOnce({ state: 'done', executed_volume: '0' });

    const r = await TradingService.enforcePendingBuyCap(upbit, 1, 'KRW-BTC', 'upbit', 50000, 16);

    expect(upbit.cancelOrder).not.toHaveBeenCalled();
    expect(r.cancelled).toBe(0);
  });

  it('주문 조회가 실패하면 취소하지 않음 (보수적)', async () => {
    const upbit = createMockUpbit();
    prisma.gridLevel.findMany.mockResolvedValueOnce(pendingBuys(16));
    upbit.getOrder.mockRejectedValueOnce(new Error('timeout'));
    const err = jest.spyOn(console, 'error').mockImplementation();

    const r = await TradingService.enforcePendingBuyCap(upbit, 1, 'KRW-BTC', 'upbit', 50000, 16);

    expect(upbit.cancelOrder).not.toHaveBeenCalled();
    expect(r.cancelled).toBe(0);
    err.mockRestore();
  });

  it('빗썸 PlacedOrder(filledQty) 형식의 부분 체결도 인식', async () => {
    const upbit = createMockUpbit();
    prisma.gridLevel.findMany.mockResolvedValueOnce(pendingBuys(16));
    upbit.getOrder.mockResolvedValueOnce({ status: 'open', filledQty: 0.3 });
    const warn = jest.spyOn(console, 'warn').mockImplementation();

    const r = await TradingService.enforcePendingBuyCap(upbit, 1, 'KRW-XRP', 'bithumb', 50000, 16);

    expect(upbit.cancelOrder).not.toHaveBeenCalled();
    expect(r.cancelled).toBe(0);
    warn.mockRestore();
  });

  it('한 건도 취소하지 못하면 10분간 재시도하지 않음 (점검 중 조회 실패 반복 방지)', async () => {
    const upbit = createMockUpbit();
    prisma.gridLevel.findMany.mockResolvedValueOnce(pendingBuys(16));
    upbit.getOrder.mockRejectedValue(new Error('점검 중'));
    const err = jest.spyOn(console, 'error').mockImplementation();

    const first = await TradingService.enforcePendingBuyCap(upbit, 42, 'KRW-BTC', 'upbit', 50000, 16);
    const second = await TradingService.enforcePendingBuyCap(upbit, 42, 'KRW-BTC', 'upbit', 50000, 16);

    expect(first.cancelled).toBe(0);
    expect(second.cancelled).toBe(0);
    expect(prisma.gridLevel.findMany).toHaveBeenCalledTimes(1); // 두 번째는 쿨다운으로 조회 생략

    // 봇 중지 시 쿨다운도 정리됨
    TradingService.clearLastCheckedPrice(42);
    prisma.gridLevel.findMany.mockResolvedValueOnce([]);
    await TradingService.enforcePendingBuyCap(upbit, 42, 'KRW-BTC', 'upbit', 50000, 16);
    expect(prisma.gridLevel.findMany).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('executeTrade가 사이클 끝에 (기존 미체결 매수 수 + 이번 주문 수)로 정리를 호출', async () => {
    const spy = jest.spyOn(TradingService, 'enforcePendingBuyCap').mockResolvedValue({ cancelled: 0 });
    (priceManager.getPriceWithFallback as jest.Mock).mockResolvedValue(50000);
    prisma.bot.findUnique
      .mockResolvedValueOnce({ id: 9, status: 'running', ticker: 'KRW-BTC', orderAmount: 10000, profitMode: 'fixed_amount', errorMessage: null, userId: 100 })
      .mockResolvedValueOnce({
        id: 9, userId: 100, ticker: 'KRW-BTC', orderAmount: 10000, profitMode: 'fixed_amount', exchange: 'upbit',
        user: { credentials: [{ exchange: 'upbit', apiKey: 'encrypted_k', secretKey: 'encrypted_s' }] },
      });
    // findExecutableGrids(실제 구현): 매수 후보 없음, 매도 없음, 미체결 매수 16개
    prisma.gridLevel.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prisma.gridLevel.count.mockResolvedValueOnce(16);

    await TradingService.executeTrade(9);

    expect(spy).toHaveBeenCalledWith(expect.anything(), 9, 'KRW-BTC', 'upbit', 50000, 16);
    spy.mockRestore();
  });

  it('같은 봇에 정리가 진행 중이면 중복 실행하지 않음', async () => {
    const upbit = createMockUpbit();
    let release!: (v: any) => void;
    prisma.gridLevel.findMany.mockReturnValueOnce(new Promise(res => { release = res; }));

    const first = TradingService.enforcePendingBuyCap(upbit, 7, 'KRW-BTC', 'upbit', 50000, 18);
    const second = await TradingService.enforcePendingBuyCap(upbit, 7, 'KRW-BTC', 'upbit', 50000, 18);
    expect(second).toEqual({ cancelled: 0 });

    release(pendingBuys(18));
    expect((await first).cancelled).toBe(3);
    expect(prisma.gridLevel.findMany).toHaveBeenCalledTimes(1);
  });
});
