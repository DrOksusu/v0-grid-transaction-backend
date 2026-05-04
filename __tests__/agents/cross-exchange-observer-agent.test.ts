/**
 * CrossExchangeObserverAgent 테스트
 *
 * 자동 봇 생성 로직과 스프레드 방향 계산을 검증한다.
 * - N회 연속 스프레드 감지 → 봇 자동 생성
 * - 중복 봇 생성 방지
 * - UB 방향 가격 조합(bithumbBid/upbitAsk) 정확도
 */

jest.mock('ws', () => {
  const EventEmitter = require('events');
  class MockWs extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    send = jest.fn();
    close = jest.fn(function (this: any) { this.readyState = 3; });
  }
  return MockWs;
});

jest.mock('../../src/config/database', () => require('../../__mocks__/database'));

// Upbit: USDT ask=1492
const mockUpbitBooks = new Map([
  ['KRW-USDT', { bid: { price: 1490, size: 100 }, ask: { price: 1492, size: 100 }, market: 'KRW-USDT', timestamp: Date.now() }],
  ['KRW-USDS', { bid: { price: 1491, size: 100 }, ask: { price: 1493, size: 100 }, market: 'KRW-USDS', timestamp: Date.now() }],
  ['KRW-USDC', { bid: { price: 1490, size: 100 }, ask: { price: 1492, size: 100 }, market: 'KRW-USDC', timestamp: Date.now() }],
  ['KRW-USD1', { bid: { price: 1490, size: 100 }, ask: { price: 1492, size: 100 }, market: 'KRW-USD1', timestamp: Date.now() }],
  ['KRW-USDE', { bid: { price: 1490, size: 100 }, ask: { price: 1492, size: 100 }, market: 'KRW-USDE', timestamp: Date.now() }],
]);

jest.mock('../../src/services/upbit-price-manager', () => ({
  getAllStablecoinOrderbooks: jest.fn(() => mockUpbitBooks),
}));

// Bithumb WS: bid=1500 > Upbit ask=1492 → UB spread = 53bps (양수, > 10bps)
const mockBithumbWsBooks = new Map([
  ['USDT', { symbol: 'USDT', bid: 1500, ask: 1502, timestamp: Date.now() }],
  ['USDS', { symbol: 'USDS', bid: 1501, ask: 1503, timestamp: Date.now() }],
  ['USDC', { symbol: 'USDC', bid: 1500, ask: 1502, timestamp: Date.now() }],
  ['USD1', { symbol: 'USD1', bid: 1500, ask: 1502, timestamp: Date.now() }],
  ['USDE', { symbol: 'USDE', bid: 1500, ask: 1502, timestamp: Date.now() }],
]);

jest.mock('../../src/services/bithumb-stablecoin-ws-manager', () => ({
  subscribeBithumbStablecoinOrderbooks: jest.fn(),
  unsubscribeBithumbStablecoinOrderbooks: jest.fn(),
  getAllBithumbStablecoinOrderbooks: jest.fn(() => mockBithumbWsBooks),
  getBithumbStablecoinOrderbook: jest.fn(),
  isBithumbStablecoinWsConnected: jest.fn(() => true),
  BITHUMB_STABLECOIN_SYMBOLS: ['USDT', 'USDC', 'USDS', 'USD1', 'USDE'],
}));

jest.mock('../../src/services/bithumb-price-manager', () => ({
  fetchBithumbOrderbooks: jest.fn().mockResolvedValue(new Map()),
}));

import { CrossExchangeObserverAgent } from '../../src/agents/cross-exchange-observer-agent';

const dbMock = require('../../__mocks__/database');
const { stablecoinPrisma } = dbMock;
const prismaMock = dbMock.default;
const { subscribeBithumbStablecoinOrderbooks, unsubscribeBithumbStablecoinOrderbooks } =
  jest.requireMock('../../src/services/bithumb-stablecoin-ws-manager');

describe('CrossExchangeObserverAgent', () => {
  let agent: CrossExchangeObserverAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    stablecoinPrisma.crossExchangeArbBot.findMany.mockResolvedValue([]);
    stablecoinPrisma.crossExchangeArbBot.create.mockResolvedValue({ id: 99 });
    prismaMock.crossExchangeSnapshot.createMany.mockResolvedValue({ count: 5 });
    agent = new CrossExchangeObserverAgent();
  });

  it('onStart — Bithumb WS 구독 호출', async () => {
    await (agent as any).onStart();
    expect(subscribeBithumbStablecoinOrderbooks).toHaveBeenCalledTimes(1);
  });

  it('onStop — Bithumb WS 구독 해제 호출', async () => {
    await (agent as any).onStop();
    expect(unsubscribeBithumbStablecoinOrderbooks).toHaveBeenCalledTimes(1);
  });

  it('6회 미만 연속 감지 → 봇 생성 없음', async () => {
    for (let i = 0; i < 5; i++) {
      await (agent as any).onCycle();
    }
    expect(stablecoinPrisma.crossExchangeArbBot.create).not.toHaveBeenCalled();
  });

  it('정확히 6회 연속 감지 → 봇 자동 생성 호출', async () => {
    for (let i = 0; i < 6; i++) {
      await (agent as any).onCycle();
    }
    expect(stablecoinPrisma.crossExchangeArbBot.create).toHaveBeenCalled();
    const firstCall = stablecoinPrisma.crossExchangeArbBot.create.mock.calls[0][0];
    expect(firstCall.data.enabled).toBe(true);
  });

  it('7번째 이후 사이클 — 동일 streak에서 중복 생성 없음 (cap 동작)', async () => {
    for (let i = 0; i < 6; i++) {
      await (agent as any).onCycle();
    }
    const callsAfter6 = stablecoinPrisma.crossExchangeArbBot.create.mock.calls.length;
    await (agent as any).onCycle();
    expect(stablecoinPrisma.crossExchangeArbBot.create.mock.calls.length).toBe(callsAfter6);
  });

  it('기존 동종 봇 있을 때 중복 생성 방지 (dedup)', async () => {
    stablecoinPrisma.crossExchangeArbBot.findMany.mockImplementation(({ where }: any) => {
      if (where?.targetDirection === 'UB') {
        return Promise.resolve([{ coin: 'USDT', buyCoin: null, sellCoin: null }]);
      }
      return Promise.resolve([]);
    });

    for (let i = 0; i < 6; i++) {
      await (agent as any).onCycle();
    }

    const createdKeys = stablecoinPrisma.crossExchangeArbBot.create.mock.calls.map(
      (call: any[]) =>
        `${call[0].data.buyCoin}→${call[0].data.sellCoin}:${call[0].data.targetDirection}`,
    );
    expect(createdKeys).not.toContain('USDT→USDT:UB');
  });

  it('UB 방향 — bithumbBid/upbitAsk 기반 봇 생성 확인', async () => {
    // Upbit USDT ask=1492, Bithumb USDT bid=1500 → UB spread = 53bps
    for (let i = 0; i < 6; i++) {
      await (agent as any).onCycle();
    }
    const ubUsdtCall = stablecoinPrisma.crossExchangeArbBot.create.mock.calls.find(
      (call: any[]) =>
        call[0].data.targetDirection === 'UB' &&
        call[0].data.buyCoin === 'USDT' &&
        call[0].data.sellCoin === 'USDT',
    );
    expect(ubUsdtCall).toBeDefined();
  });

  it('onCycle — 스냅샷 DB 저장 호출', async () => {
    await (agent as any).onCycle();
    expect(prismaMock.crossExchangeSnapshot.createMany).toHaveBeenCalled();
  });
});
