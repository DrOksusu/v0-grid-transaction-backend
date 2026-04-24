/**
 * subscribeStablecoinOrderbooks / unsubscribeStablecoinOrderbooks의
 * 다중 구독자 공유 동작 검증 (ref count).
 *
 * 배경: 세션 8에서 MakerTakerSimulatorAgent 추가 시, 기존 StablecoinArbAgent와
 * WS를 공유하게 됨. ref count 없으면 한 에이전트 stop 시 상대 WS까지 죽는 버그.
 *
 * WS 자체는 Upbit 실제 연결이므로 mock. subscriberCount만 검증.
 */
jest.mock('ws', () => {
  class FakeWs {
    readyState = 1; // OPEN
    on() {}
    send() {}
    close() { this.readyState = 3; }
    removeAllListeners() {}
  }
  return FakeWs;
});

import {
  subscribeStablecoinOrderbooks,
  unsubscribeStablecoinOrderbooks,
  _debugStablecoinSubscriberCount,
} from '../../src/services/upbit-price-manager';

describe('subscribeStablecoinOrderbooks ref count', () => {
  beforeEach(() => {
    // 각 테스트 시작 시 count를 0으로 드레인 (이전 테스트 누수 방지)
    while (_debugStablecoinSubscriberCount() > 0) {
      unsubscribeStablecoinOrderbooks();
    }
  });

  it('subscribe 2회 + unsubscribe 1회 = count 1 (WS 유지)', () => {
    subscribeStablecoinOrderbooks();
    subscribeStablecoinOrderbooks();
    expect(_debugStablecoinSubscriberCount()).toBe(2);

    unsubscribeStablecoinOrderbooks();
    expect(_debugStablecoinSubscriberCount()).toBe(1);
  });

  it('unsubscribe 2회 모두 호출 시 count = 0 (마지막에 cleanup)', () => {
    subscribeStablecoinOrderbooks();
    subscribeStablecoinOrderbooks();

    unsubscribeStablecoinOrderbooks();
    unsubscribeStablecoinOrderbooks();
    expect(_debugStablecoinSubscriberCount()).toBe(0);
  });

  it('unsubscribe를 과도하게 호출해도 count는 0 미만으로 내려가지 않음', () => {
    subscribeStablecoinOrderbooks();
    unsubscribeStablecoinOrderbooks();
    unsubscribeStablecoinOrderbooks();
    unsubscribeStablecoinOrderbooks();
    expect(_debugStablecoinSubscriberCount()).toBe(0);
  });

  it('subscribe 1회만 하고 unsubscribe 하면 기존 단일 에이전트 동작과 동일', () => {
    subscribeStablecoinOrderbooks();
    expect(_debugStablecoinSubscriberCount()).toBe(1);
    unsubscribeStablecoinOrderbooks();
    expect(_debugStablecoinSubscriberCount()).toBe(0);
  });
});
