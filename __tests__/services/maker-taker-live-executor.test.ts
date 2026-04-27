/**
 * maker-taker-live-executor 테스트
 *
 * 7개 시나리오 (CASE A 3개 + CASE B 5개 = 총 8개 테스트):
 *  CASE A (PENDING null): 신규 maker bid 주문
 *    1. 정상: 락 free + preCheck ok + 호가 존재 → placeLimit 호출 + placed
 *    2. 락 점유 → noop, placeLimit 미호출
 *    3. preCheck abort → noop, placeLimit 미호출
 *
 *  CASE B (PENDING object): 기존 주문 폴링
 *    4. 미체결 + 만료 전 → waiting
 *    5. 만료 + 미체결 → cancelOrder + expired
 *    6. 체결 + taker 양쪽 성공 → filled (P&L 검증)
 *    7. 체결 + taker step 1 (X 매도) 실패 → partial_hold
 *    8. 체결 + step 2 실패 → step 3 fallback → rolled_back
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

  it('6. 체결 + taker 양쪽 성공 → filled', async () => {
    const client = mkClient();
    client.getOrder.mockResolvedValueOnce({
      uuid: 'limit-existing',
      state: 'done',
      executed_volume: '5',
      paid_fee: '36.225',
      trades: [{ funds: '7245', price: '1449', volume: '5' }],
    });
    // Stage 1: sell USDT
    client.placeBestIoc.mockResolvedValueOnce({
      uuid: 'sell-uuid',
      executed_volume: '5',
      paid_fee: '18.125',
      trades: [{ funds: '7250', price: '1450', volume: '5' }],
    });
    // Stage 2: buy USDC
    client.placeBestIoc.mockResolvedValueOnce({
      uuid: 'buy-uuid',
      executed_volume: '5.0',
      paid_fee: '18.080',
      trades: [{ funds: '7232', price: '1449', volume: '5' }],
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
      expect(result.filledMakerKrw).toBe(7245);
      expect(result.filledSellKrw).toBe(7250);
      expect(result.filledBuyKrw).toBe(7232);
      expect(result.paidFeeKrw).toBeCloseTo(72.43, 1);
      expect(result.netProfitKrw).toBeCloseTo(-67.43, 1);
      expect(result.realizedSpreadBps).toBe(6);
    }
    expect(client.placeBestIoc).toHaveBeenCalledTimes(2);
    // Stage 1: sell USDT
    expect(client.placeBestIoc.mock.calls[0][0]).toBe('KRW-USDT');
    expect(client.placeBestIoc.mock.calls[0][1]).toBe('ask');
    // Stage 2: buy USDC
    expect(client.placeBestIoc.mock.calls[1][0]).toBe('KRW-USDC');
    expect(client.placeBestIoc.mock.calls[1][1]).toBe('bid');
  });

  it('7. 체결 + taker step 1 (X 매도) 실패 → partial_hold', async () => {
    const client = mkClient();
    client.getOrder.mockResolvedValueOnce({
      uuid: 'limit-existing',
      state: 'done',
      executed_volume: '5',
      paid_fee: '36.225',
      trades: [{ funds: '7245', price: '1449', volume: '5' }],
    });
    client.placeBestIoc.mockResolvedValueOnce({
      uuid: 'sell-fail',
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

    expect(result.kind).toBe('partial_hold');
    if (result.kind === 'partial_hold') {
      expect(result.pendingId).toBe(100n);
      expect(result.reason).toMatch(/sell|holding X/i);
    }
    // Stage 2 buy 호출 안 됨
    expect(client.placeBestIoc).toHaveBeenCalledTimes(1);
  });

  it('8. 체결 + step 2 실패 → step 3 fallback → rolled_back', async () => {
    const client = mkClient();
    client.getOrder.mockResolvedValueOnce({
      uuid: 'limit-existing',
      state: 'done',
      executed_volume: '5',
      paid_fee: '36.225',
      trades: [{ funds: '7245', price: '1449', volume: '5' }],
    });
    // Stage 1 sell USDT 성공
    client.placeBestIoc.mockResolvedValueOnce({
      uuid: 'sell-uuid',
      executed_volume: '5',
      paid_fee: '18.125',
      trades: [{ funds: '7250', price: '1450', volume: '5' }],
    });
    // Stage 2 buy USDC 실패
    client.placeBestIoc.mockResolvedValueOnce({
      uuid: 'buy-fail',
      executed_volume: '0',
    });
    // Stage 3 fallback buy USDT 성공
    client.placeBestIoc.mockResolvedValueOnce({
      uuid: 'fallback-uuid',
      executed_volume: '5',
      paid_fee: '18.0',
      trades: [{ funds: '7232', price: '1450', volume: '5' }],
    });

    const result = await processLiveBot({
      bot: baseBot,
      pending: pendingBase,
      books,
      client,
      isLocked: () => false,
      preCheckOk: true,
    });

    expect(result.kind).toBe('rolled_back');
    if (result.kind === 'rolled_back') {
      expect(result.pendingId).toBe(100n);
    }
    expect(client.placeBestIoc).toHaveBeenCalledTimes(3);
    // 마지막(fallback) 호출이 KRW-USDT(makerCoin) bid인지 확인
    const fbCall = client.placeBestIoc.mock.calls[2];
    expect(fbCall[0]).toBe('KRW-USDT');
    expect(fbCall[1]).toBe('bid');
  });
});
