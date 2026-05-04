/**
 * bithumb-stablecoin-ws-manager 단위 테스트
 *
 * WS 연결 없이 공개 API 동작을 검증한다.
 * 실제 WebSocket은 jest.mock으로 대체.
 */

jest.mock('ws', () => {
  const EventEmitter = require('events');
  class MockWs extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1; // OPEN
    send = jest.fn();
    close = jest.fn(function (this: any) { this.readyState = 3; });
  }
  return MockWs;
});

// 각 테스트에서 모듈 상태 초기화
beforeEach(() => {
  jest.resetModules();
});

describe('bithumb-stablecoin-ws-manager', () => {
  it('초기 상태 — 캐시 비어 있음', async () => {
    const { getBithumbStablecoinOrderbook } = await import(
      '../../src/services/bithumb-stablecoin-ws-manager'
    );
    expect(getBithumbStablecoinOrderbook('USDT')).toBeNull();
  });

  it('subscribe 후 WS 연결 상태 OPEN 확인', async () => {
    const mod = await import('../../src/services/bithumb-stablecoin-ws-manager');
    mod.subscribeBithumbStablecoinOrderbooks();
    expect(mod.isBithumbStablecoinWsConnected()).toBe(true);
    mod.unsubscribeBithumbStablecoinOrderbooks();
  });

  it('unsubscribe 후 캐시 초기화 + 연결 해제', async () => {
    const mod = await import('../../src/services/bithumb-stablecoin-ws-manager');
    mod.subscribeBithumbStablecoinOrderbooks();
    mod.unsubscribeBithumbStablecoinOrderbooks();

    expect(mod.getBithumbStablecoinOrderbook('USDT')).toBeNull();
    expect(mod.isBithumbStablecoinWsConnected()).toBe(false);
  });

  it('getAllBithumbStablecoinOrderbooks — 불변 복사본 반환 (다른 인스턴스)', async () => {
    const mod = await import('../../src/services/bithumb-stablecoin-ws-manager');
    const a = mod.getAllBithumbStablecoinOrderbooks();
    const b = mod.getAllBithumbStablecoinOrderbooks();
    expect(a).not.toBe(b);
  });

  it('중복 subscribe → ref count 증가, WS 재연결 없음', async () => {
    const mod = await import('../../src/services/bithumb-stablecoin-ws-manager');
    mod.subscribeBithumbStablecoinOrderbooks();
    mod.subscribeBithumbStablecoinOrderbooks(); // 두 번째 구독
    expect(mod.isBithumbStablecoinWsConnected()).toBe(true);
    // 첫 번째 unsubscribe 후에도 연결 유지
    mod.unsubscribeBithumbStablecoinOrderbooks();
    expect(mod.isBithumbStablecoinWsConnected()).toBe(true);
    // 마지막 구독자 해제 → 연결 종료
    mod.unsubscribeBithumbStablecoinOrderbooks();
    expect(mod.isBithumbStablecoinWsConnected()).toBe(false);
  });

  it('BITHUMB_STABLECOIN_SYMBOLS — 5개 심볼 포함', async () => {
    const { BITHUMB_STABLECOIN_SYMBOLS } = await import(
      '../../src/services/bithumb-stablecoin-ws-manager'
    );
    expect(BITHUMB_STABLECOIN_SYMBOLS).toContain('USDT');
    expect(BITHUMB_STABLECOIN_SYMBOLS).toContain('USDC');
    expect(BITHUMB_STABLECOIN_SYMBOLS).toContain('USDS');
    expect(BITHUMB_STABLECOIN_SYMBOLS).toContain('USD1');
    expect(BITHUMB_STABLECOIN_SYMBOLS).toContain('USDE');
    expect(BITHUMB_STABLECOIN_SYMBOLS).toHaveLength(5);
  });
});
