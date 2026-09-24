import { checkInventoryStable, peekInventoryStable } from '../../../src/services/inventory-arb/inventory-stability';

// 실제 에이전트는 5초마다 check → 연속 관측(공백<20s)을 시뮬레이션하는 헬퍼.
// step(ms)씩 시간을 전진하며 매 스텝 check 호출, 마지막 반환값을 돌려준다.
function observe(key: string, balance: number, stableSec: number, totalMs: number, stepMs = 5_000) {
  let last = { stable: false, waitMs: 0 };
  for (let t = 0; t < totalMs; t += stepMs) {
    jest.advanceTimersByTime(stepMs);
    last = checkInventoryStable(key, balance, stableSec);
  }
  return last;
}

describe('inventory-stability (재고 안정화 게이트)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-24T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('stableSec<=0 이면 항상 stable (비활성)', () => {
    expect(checkInventoryStable('k1', 100, 0).stable).toBe(true);
    expect(checkInventoryStable('k1', 100, -5).stable).toBe(true);
  });

  it('첫 관측은 not stable, 연속 관측 60초 후 stable', () => {
    const key = 'k2';
    expect(checkInventoryStable(key, 100, 60).stable).toBe(false); // 관측 시작
    expect(observe(key, 100, 60, 55_000).stable).toBe(false); // 55s < 60s
    expect(observe(key, 100, 60, 10_000).stable).toBe(true); // 누적 65s
  });

  it('잔고 변동 시 타이머 리셋 → 다시 60초 필요', () => {
    const key = 'k3';
    checkInventoryStable(key, 100, 60);
    expect(observe(key, 100, 60, 65_000).stable).toBe(true);
    // 잔고 변동(그리드봇 매수 등) → 리셋
    expect(checkInventoryStable(key, 105, 60).stable).toBe(false);
    expect(observe(key, 105, 60, 50_000).stable).toBe(false);
    expect(observe(key, 105, 60, 15_000).stable).toBe(true);
  });

  it('관측 공백(>20s)이면 안정성 주장 불가 → 리셋', () => {
    const key = 'k4';
    checkInventoryStable(key, 100, 60);
    jest.advanceTimersByTime(30_000); // 20s 초과 공백
    expect(checkInventoryStable(key, 100, 60).stable).toBe(false); // 공백으로 리셋
    // 연속 관측 재개 → 60초 후 stable
    expect(observe(key, 100, 60, 65_000).stable).toBe(true);
  });

  it('peek는 맵을 갱신하지 않아 실행 추적(check)을 방해하지 않는다', () => {
    const key = 'k5';
    checkInventoryStable(key, 100, 60);
    expect(observe(key, 100, 60, 65_000).stable).toBe(true);
    // peek 여러 번 (getLiveStatus 폴링) — lastCheckedAt 안 건드림
    expect(peekInventoryStable(key, 60).stable).toBe(true);
    expect(peekInventoryStable(key, 60).stable).toBe(true);
    // 5s 뒤 실제 check는 여전히 stable (peek가 공백을 만들지 않았음)
    jest.advanceTimersByTime(5_000);
    expect(checkInventoryStable(key, 100, 60).stable).toBe(true);
  });

  it('peek: 관측 시작 전(맵 없음)이면 not stable, 비활성이면 stable', () => {
    expect(peekInventoryStable('never-seen', 60).stable).toBe(false);
    expect(peekInventoryStable('never-seen', 0).stable).toBe(true);
  });
});
