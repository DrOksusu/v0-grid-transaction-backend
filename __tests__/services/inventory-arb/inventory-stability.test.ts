import { stableTradeableAmount, peekStableAmount } from '../../../src/services/inventory-arb/inventory-stability';

// 실제 에이전트는 5초마다 관측 → 연속 관측(공백<20s)을 시뮬레이션하는 헬퍼.
// step(ms)씩 시간을 전진하며 매 스텝 stableTradeableAmount 호출, 마지막 반환값을 돌려준다.
function observe(key: string, balance: number, stableSec: number, totalMs: number, stepMs = 5_000) {
  let last = 0;
  for (let e = 0; e < totalMs; e += stepMs) {
    jest.advanceTimersByTime(stepMs);
    last = stableTradeableAmount(key, balance, stableSec);
  }
  return last;
}

describe('inventory-stability (안정 거래가능량 = 창 내 최소 잔고)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-24T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('stableSec<=0 이면 현재 잔고 전부 (비활성)', () => {
    expect(stableTradeableAmount('k1', 100, 0)).toBe(100);
    expect(stableTradeableAmount('k1', 100, -5)).toBe(100);
    expect(peekStableAmount('k1', 0, 100)).toBe(100);
  });

  it('첫 관측은 0(관측 부족), 60초 연속 관측 후 min 반환', () => {
    const key = 'k2';
    expect(stableTradeableAmount(key, 100, 60)).toBe(0); // 관측 시작
    expect(observe(key, 100, 60, 50_000)).toBe(0); // 아직 60초 미만
    expect(observe(key, 100, 60, 25_000)).toBe(100); // 누적 >60초 → min=100
  });

  it('핵심: 50→51.5로 늘면 안정분은 50 (방금 채워진 1.5는 제외)', () => {
    const key = 'k3';
    expect(observe(key, 50, 60, 70_000)).toBe(50); // 60초 연속 50 관측 → 안정 50
    jest.advanceTimersByTime(5_000);
    // 그리드가 방금 1.5 채움 → 잔고 51.5. 창 내 최소는 여전히 50 → 50까지만 거래
    expect(stableTradeableAmount(key, 51.5, 60)).toBe(50);
    // 51.5가 60초 이상 유지되면(옛 50 관측이 창 밖으로) 안정분이 51.5로 상승
    expect(observe(key, 51.5, 60, 65_000)).toBe(51.5);
  });

  it('잔고가 줄면(그리드 매도) 창 내 최소도 즉시 하락', () => {
    const key = 'k4';
    expect(observe(key, 50, 60, 70_000)).toBe(50);
    jest.advanceTimersByTime(5_000);
    expect(stableTradeableAmount(key, 48, 60)).toBe(48); // min(50…, 48)=48
  });

  it('관측 공백(>20s)이면 커버리지 리셋 → 다시 0부터', () => {
    const key = 'k5';
    expect(observe(key, 100, 60, 70_000)).toBe(100);
    jest.advanceTimersByTime(25_000); // 20s 초과 공백
    expect(stableTradeableAmount(key, 100, 60)).toBe(0); // 공백으로 리셋
    expect(observe(key, 100, 60, 65_000)).toBe(100); // 재관측 60초 후 복구
  });

  it('peek는 맵을 갱신하지 않아 실행 추적(check)을 방해하지 않는다', () => {
    const key = 'k6';
    expect(observe(key, 100, 60, 70_000)).toBe(100);
    expect(peekStableAmount(key, 60, 100)).toBe(100);
    expect(peekStableAmount(key, 60, 100)).toBe(100); // 여러 번 폴링해도 무영향
    jest.advanceTimersByTime(5_000);
    expect(stableTradeableAmount(key, 100, 60)).toBe(100); // peek가 공백을 만들지 않음
  });

  it('peek: 관측 전이면 0, 현재 잔고보다 창 min이 낮으면 낮은 값', () => {
    expect(peekStableAmount('never-seen', 60, 100)).toBe(0);
    const key = 'k7';
    observe(key, 50, 60, 70_000);
    // 현재 잔고가 60이어도(방금 그리드가 채움) 창 min 50이 상한
    expect(peekStableAmount(key, 60, 60)).toBe(50);
  });
});
