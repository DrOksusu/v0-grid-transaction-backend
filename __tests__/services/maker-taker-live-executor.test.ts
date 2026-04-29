/**
 * maker-taker-live-executor 테스트 (PR E2: spec § 2 정합 재구현 기준)
 *
 * 시나리오 (CASE A 3개 + CASE B 7개 = 총 10개 테스트):
 *  CASE A (PENDING null): 신규 maker bid 주문
 *    1. 정상: 락 free + preCheck ok + 호가 존재 → placeLimit 호출 + placed
 *    2. 락 점유 → noop, placeLimit 미호출
 *    3. preCheck abort → noop, placeLimit 미호출
 *
 *  CASE B (PENDING object): 기존 주문 폴링
 *    4. 미체결 + 만료 전 → waiting
 *    5. 만료 + 미체결 → cancelOrder + expired
 *    6. 체결 + taker(Y) 매도 즉시 성공 → filled (P&L 검증, sim 공식)
 *    7. 체결 + taker(Y) 매도 IOC 즉시 0 + 1.5초 재폴링도 0 → partial_hold
 *    8. 체결 + taker(Y) 매도 IOC 즉시 0 + 1.5초 재폴링에서 체결 발견 → filled
 *    9. 체결됐지만 trades funds=0 → partial_hold (defensive, divide-by-zero 방지)
 *   10. sim/live P&L 정합성 sanity — 동일 조건에서 simulator와 live의 netProfitKrw 일치
 */

import {
  processLiveBot,
  type OrderClient,
  type UpbitOrderResp,
  type LiveBotInput,
  type PendingTradeInput,
} from '../../src/services/maker-taker-live-executor';
import type { OrderbookTop } from '../../src/services/upbit-price-manager';

const baseBot: LiveBotInput = {
  id: 1,
  userId: 2,
  makerCoin: 'USDT',
  takerCoin: 'USDC',
  bidOffsetKrw: -1,
  quantity: 5,
  maxPendingMs: 600_000,
  killSwitch: false,
};

const books: ReadonlyMap<string, OrderbookTop> = new Map([
  [
    'KRW-USDT',
    {
      market: 'KRW-USDT',
      bid: { price: 1450, size: 1000 },
      ask: { price: 1451, size: 1000 },
      timestamp: 0,
    },
  ],
  [
    'KRW-USDC',
    {
      market: 'KRW-USDC',
      bid: { price: 1448, size: 1000 },
      ask: { price: 1449, size: 1000 },
      timestamp: 0,
    },
  ],
]);

interface MockOrderClient extends OrderClient {
  placeLimit: jest.Mock<
    Promise<UpbitOrderResp>,
    [string, 'bid' | 'ask', { price?: string; volume?: string; postOnly?: boolean }]
  >;
  placeBestIoc: jest.Mock<
    Promise<UpbitOrderResp>,
    [string, 'bid' | 'ask', { price?: string; volume?: string }]
  >;
  getOrder: jest.Mock<Promise<UpbitOrderResp>, [string]>;
  cancelOrder: jest.Mock<Promise<unknown>, [string]>;
}

const mkClient = (): MockOrderClient =>
  ({
    placeLimit: jest.fn(),
    placeBestIoc: jest.fn(),
    getOrder: jest.fn(),
    cancelOrder: jest.fn(),
  } as unknown as MockOrderClient);

describe('processLiveBot — CASE A (PENDING null, 신규 maker bid)', () => {
  it('1. preCheck ok + lock free + book present → placed', async () => {
    const client = mkClient();
    client.placeLimit.mockResolvedValueOnce({
      uuid: 'new-limit-uuid',
      state: 'wait',
    });

    const result = await processLiveBot({
      bot: baseBot,
      pending: null,
      books,
      client,
      isLocked: () => false,
      preCheckOk: true,
    });

    expect(client.placeLimit).toHaveBeenCalledTimes(1);
    expect(client.placeLimit).toHaveBeenCalledWith(
      'KRW-USDT',
      'bid',
      { price: '1449', volume: '5', postOnly: true },
    );
    expect(result.kind).toBe('placed');
    if (result.kind === 'placed') {
      expect(result.makerOrderUuid).toBe('new-limit-uuid');
      expect(result.makerOrderPrice).toBe(1449);
    }
  });

  it('2. 락 점유 → noop, placeLimit 미호출', async () => {
    const client = mkClient();

    const result = await processLiveBot({
      bot: baseBot,
      pending: null,
      books,
      client,
      isLocked: () => true,
      preCheckOk: true,
    });

    expect(client.placeLimit).not.toHaveBeenCalled();
    expect(result.kind).toBe('noop');
  });

  it('3. preCheck abort → noop, placeLimit 미호출', async () => {
    const client = mkClient();

    const result = await processLiveBot({
      bot: baseBot,
      pending: null,
      books,
      client,
      isLocked: () => false,
      preCheckOk: false,
    });

    expect(client.placeLimit).not.toHaveBeenCalled();
    expect(result.kind).toBe('noop');
  });
});

describe('processLiveBot — CASE B (PENDING 폴링)', () => {
  const pendingBase: PendingTradeInput = {
    id: 100n,
    status: 'PENDING',
    makerOrderUuid: 'limit-existing',
    makerOrderPrice: 1449,
    createdAt: new Date(Date.now() - 10_000),
    notes: 'created',
  };

  it('4. 미체결 + 만료 전 → waiting', async () => {
    const client = mkClient();
    client.getOrder.mockResolvedValueOnce({
      uuid: 'limit-existing',
      state: 'wait',
      executed_volume: '0',
    });

    const result = await processLiveBot({
      bot: baseBot,
      pending: pendingBase,
      books,
      client,
      isLocked: () => false,
      preCheckOk: true,
    });

    expect(client.getOrder).toHaveBeenCalledWith('limit-existing');
    expect(client.cancelOrder).not.toHaveBeenCalled();
    expect(client.placeBestIoc).not.toHaveBeenCalled();
    expect(result.kind).toBe('waiting');
    if (result.kind === 'waiting') {
      expect(result.pendingId).toBe(100n);
    }
  });

  it('5. 만료 + 미체결 → cancelOrder + expired', async () => {
    const client = mkClient();
    client.getOrder.mockResolvedValueOnce({
      uuid: 'limit-existing',
      state: 'wait',
      executed_volume: '0',
    });
    client.cancelOrder.mockResolvedValueOnce({ uuid: 'limit-existing' });

    const expired: PendingTradeInput = {
      ...pendingBase,
      createdAt: new Date(Date.now() - 700_000),
    };

    const result = await processLiveBot({
      bot: baseBot,
      pending: expired,
      books,
      client,
      isLocked: () => false,
      preCheckOk: true,
    });

    expect(client.cancelOrder).toHaveBeenCalledWith('limit-existing');
    expect(result.kind).toBe('expired');
    if (result.kind === 'expired') {
      expect(result.pendingId).toBe(100n);
    }
  });

  it('6. 체결 + taker(Y) 매도 즉시 성공 → filled (sim 공식 P&L)', async () => {
    const client = mkClient();
    // maker(USDT) leg 체결: maker 매수 5개 × 1449 KRW = funds 7245
    client.getOrder.mockResolvedValueOnce({
      uuid: 'limit-existing',
      state: 'done',
      executed_volume: '5',
      paid_fee: '36.225',
      trades: [{ funds: '7245', price: '1449', volume: '5' }],
    });
    // taker(USDC) 시장가 매도 즉시 성공: 5개 × 1448 KRW = 7240 (best bid)
    client.placeBestIoc.mockResolvedValueOnce({
      uuid: 'taker-sell-uuid',
      executed_volume: '5',
      paid_fee: '18.10',
      trades: [{ funds: '7240', price: '1448', volume: '5' }],
    });

    const result = await processLiveBot({
      bot: baseBot,
      pending: pendingBase,
      books,
      client,
      isLocked: () => false,
      preCheckOk: true,
    });

    expect(result.kind).toBe('filled');
    if (result.kind === 'filled') {
      expect(result.pendingId).toBe(100n);
      expect(result.filledQty).toBe(5);
      expect(result.filledMakerKrw).toBe(7245); // makerCoin 매수 지불 KRW
      expect(result.filledSellKrw).toBe(7240); // takerCoin 매도 받은 KRW
      // P&L: (7240 - 7245) - (36.225 + 18.10) = -5 - 54.325 = -59.325
      expect(result.paidFeeKrw).toBeCloseTo(54.325, 2);
      expect(result.netProfitKrw).toBeCloseTo(-59.325, 2);
      // realizedSpreadBps: floor((7240/7245 - 1) * 10000) = floor(-6.9...) = -7
      expect(result.realizedSpreadBps).toBe(-7);
    }
    expect(client.placeBestIoc).toHaveBeenCalledTimes(1);
    // Taker leg = takerCoin(USDC) 시장가 매도 (spec § 2)
    expect(client.placeBestIoc.mock.calls[0][0]).toBe('KRW-USDC');
    expect(client.placeBestIoc.mock.calls[0][1]).toBe('ask');
    expect(client.placeBestIoc.mock.calls[0][2]).toEqual({ volume: '5' });
  });

  it('7. 체결 + taker(Y) 매도 IOC 즉시 0 + 1.5초 재폴링도 0 → partial_hold', async () => {
    jest.useFakeTimers();
    const client = mkClient();
    client.getOrder
      .mockResolvedValueOnce({
        // 1차 호출: maker 주문 상태 (체결)
        uuid: 'limit-existing',
        state: 'done',
        executed_volume: '5',
        paid_fee: '36.225',
        trades: [{ funds: '7245', price: '1449', volume: '5' }],
      })
      .mockResolvedValueOnce({
        // 2차 호출: taker IOC 재폴링 — 여전히 0
        uuid: 'taker-sell-fail',
        executed_volume: '0',
      });
    client.placeBestIoc.mockResolvedValueOnce({
      uuid: 'taker-sell-fail',
      executed_volume: '0',
    });

    const promise = processLiveBot({
      bot: baseBot,
      pending: pendingBase,
      books,
      client,
      isLocked: () => false,
      preCheckOk: true,
    });
    // 1.5초 sleep을 fake timer로 진행
    await jest.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result.kind).toBe('partial_hold');
    if (result.kind === 'partial_hold') {
      expect(result.pendingId).toBe(100n);
      expect(result.reason).toMatch(/taker|holding X/i);
    }
    // taker IOC 1회 + getOrder 재폴링 1회 + maker getOrder 1회 = total 2 getOrder, 1 placeBestIoc
    expect(client.placeBestIoc).toHaveBeenCalledTimes(1);
    expect(client.getOrder).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('8. 체결 + taker(Y) IOC 즉시 0 + 1.5초 재폴링에서 체결 발견 → filled', async () => {
    jest.useFakeTimers();
    const client = mkClient();
    client.getOrder
      .mockResolvedValueOnce({
        // 1차: maker 주문 상태
        uuid: 'limit-existing',
        state: 'done',
        executed_volume: '5',
        paid_fee: '36.225',
        trades: [{ funds: '7245', price: '1449', volume: '5' }],
      })
      .mockResolvedValueOnce({
        // 2차: taker IOC 재폴링 — 늦게 체결 확인됨 (PR D 사례 b04515ce 패턴)
        uuid: 'taker-sell-late',
        state: 'done',
        executed_volume: '5',
        paid_fee: '18.10',
        trades: [{ funds: '7240', price: '1448', volume: '5' }],
      });
    client.placeBestIoc.mockResolvedValueOnce({
      // 즉시 응답은 0 (false positive 가능성)
      uuid: 'taker-sell-late',
      executed_volume: '0',
    });

    const promise = processLiveBot({
      bot: baseBot,
      pending: pendingBase,
      books,
      client,
      isLocked: () => false,
      preCheckOk: true,
    });
    await jest.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result.kind).toBe('filled');
    if (result.kind === 'filled') {
      expect(result.filledQty).toBe(5);
      expect(result.filledSellKrw).toBe(7240); // 재폴링에서 가져온 trades funds
      expect(result.netProfitKrw).toBeCloseTo(-59.325, 2);
    }
    expect(client.placeBestIoc).toHaveBeenCalledTimes(1);
    expect(client.getOrder).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('9. 체결됐지만 trades funds=0 → partial_hold (defensive, divide-by-zero 방지)', async () => {
    const client = mkClient();
    // executed_volume>0 인데 trades funds 합이 0인 비정상 응답
    client.getOrder.mockResolvedValueOnce({
      uuid: 'limit-existing',
      state: 'done',
      executed_volume: '5',
      paid_fee: '0',
      trades: [{ funds: '0', price: '0', volume: '5' }],
    });

    const result = await processLiveBot({
      bot: baseBot,
      pending: pendingBase,
      books,
      client,
      isLocked: () => false,
      preCheckOk: true,
    });

    expect(result.kind).toBe('partial_hold');
    if (result.kind === 'partial_hold') {
      expect(result.pendingId).toBe(100n);
      expect(result.reason).toMatch(/funds.*0|defensive/i);
    }
    // Stage 1 sell도 호출 안 됨 (가드가 그 전에 차단)
    expect(client.placeBestIoc).not.toHaveBeenCalled();
  });
});

describe('processLiveBot — sim/live P&L 정합성 sanity (시나리오 10)', () => {
  /**
   * PR D 사고 핵심 원인은 simulator와 live executor의 P&L 메커니즘이 달랐다는 것.
   *   - simulator: (takerPrice − makerFilledPrice) × q − fees  (cross-coin direct swap)
   *   - PR D 시점 live: USDS 매도 → KRW로 USDT 매수 (KRW 우회 패턴)
   *
   * PR E2 이후에는 둘이 동일한 공식을 써야 한다. 이 테스트는 향후 변경이 다시 어긋나면 즉시 잡는다.
   */
  it('10. 동일 호가/체결 조건에서 simulator와 live의 netProfitKrw 일치', async () => {
    // Given: maker 체결가 M=1500, taker 체결가 T=1502, q=10, makerFee=5bps, takerFee=5bps
    const M = 1500;
    const T = 1502;
    const q = 10;
    const makerFeeBps = 5;
    const takerFeeBps = 5;

    // Simulator 직접 호출
    const { simulateTakerLeg, isAbort } = await import(
      '../../src/services/maker-taker-simulator.service'
    );
    const simResult = simulateTakerLeg({
      makerFilledPrice: M,
      takerOrderbook: {
        market: 'KRW-Y',
        bid: { price: T, size: 100 },
        ask: { price: T + 1, size: 100 },
        timestamp: 0,
      },
      quantity: q,
      feeBpsMaker: makerFeeBps,
      feeBpsTaker: takerFeeBps,
    });
    if (isAbort(simResult)) {
      throw new Error('sim aborted unexpectedly');
    }
    const simNet = simResult.netProfitKrw;

    // Live executor mock — 동일 가격/수수료 가정
    // maker leg paid_fee = M*q*makerFeeBps/10000 = 1500*10*5/10000 = 7.5
    // taker leg paid_fee = T*q*takerFeeBps/10000 = 1502*10*5/10000 = 7.51
    const client = mkClient();
    client.getOrder.mockResolvedValueOnce({
      uuid: 'maker-uuid',
      state: 'done',
      executed_volume: String(q),
      paid_fee: '7.5',
      trades: [{ funds: String(M * q), price: String(M), volume: String(q) }],
    });
    client.placeBestIoc.mockResolvedValueOnce({
      uuid: 'taker-uuid',
      executed_volume: String(q),
      paid_fee: '7.51',
      trades: [{ funds: String(T * q), price: String(T), volume: String(q) }],
    });

    const liveResult = await processLiveBot({
      bot: baseBot,
      pending: {
        ...({
          id: 999n,
          status: 'PENDING',
          makerOrderUuid: 'maker-uuid',
          makerOrderPrice: M,
          createdAt: new Date(Date.now() - 10_000),
          notes: 'sanity',
        } as PendingTradeInput),
      },
      books,
      client,
      isLocked: () => false,
      preCheckOk: true,
    });

    expect(liveResult.kind).toBe('filled');
    if (liveResult.kind !== 'filled') return;

    // 정합성: |sim - live| < 1 KRW (수수료 round 허용)
    expect(Math.abs(liveResult.netProfitKrw - simNet)).toBeLessThan(1);

    // 둘 다 spec 공식: (T - M) * q − fees
    const expected = (T - M) * q - (M * q * makerFeeBps + T * q * takerFeeBps) / 10000;
    expect(liveResult.netProfitKrw).toBeCloseTo(expected, 2);
    expect(simNet).toBeCloseTo(expected, 2);
  });
});
