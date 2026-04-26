import { tradingLock } from '../../src/services/stablecoin-trading-lock';

describe('tradingLock', () => {
  beforeEach(() => {
    // 각 테스트 전 lock 강제 해제 (다른 테스트 영향 방지)
    (tradingLock as any)._reset?.();
  });

  it('처음 acquire는 성공한다', () => {
    expect(tradingLock.tryAcquire('test-A')).toBe(true);
    expect(tradingLock.isLocked()).toBe(true);
    tradingLock.release('test-A');
    expect(tradingLock.isLocked()).toBe(false);
  });

  it('점유 중에 다른 holder의 acquire는 실패한다 (contention)', () => {
    expect(tradingLock.tryAcquire('A')).toBe(true);
    expect(tradingLock.tryAcquire('B')).toBe(false);
    expect(tradingLock.isLocked()).toBe(true);
    tradingLock.release('A');
  });

  it('다른 holder의 release는 무시된다 (안전)', () => {
    tradingLock.tryAcquire('A');
    tradingLock.release('B'); // 잘못된 holder — 무시
    expect(tradingLock.isLocked()).toBe(true);
    tradingLock.release('A');
    expect(tradingLock.isLocked()).toBe(false);
  });

  it('30초 timeout 후 강제 release되어 새 acquire 가능 (deadlock 방어)', () => {
    jest.useFakeTimers();
    tradingLock.tryAcquire('stuck');
    expect(tradingLock.isLocked()).toBe(true);

    // 31초 경과
    jest.advanceTimersByTime(31_000);

    // 새 acquire 시도 — timeout으로 강제 해제 후 성공
    expect(tradingLock.tryAcquire('B')).toBe(true);
    tradingLock.release('B');
    jest.useRealTimers();
  });
});
