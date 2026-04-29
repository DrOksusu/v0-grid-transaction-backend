import { shouldAutoPauseForMinBalance } from '../../src/services/maker-taker-min-balance-guard';

describe('shouldAutoPauseForMinBalance', () => {
  it('minTakerBalance null → 자동 일시정지 비활성', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 0,
      minTakerBalance: null,
    });
    expect(r.autoPause).toBe(false);
  });

  it('잔고 ≥ minTakerBalance → noop', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 50,
      minTakerBalance: 30,
    });
    expect(r.autoPause).toBe(false);
  });

  it('잔고 == minTakerBalance → noop (경계값 통과)', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 30,
      minTakerBalance: 30,
    });
    expect(r.autoPause).toBe(false);
  });

  it('잔고 < minTakerBalance → autoPause + reason', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 10,
      minTakerBalance: 30,
    });
    expect(r.autoPause).toBe(true);
    expect(r.reason).toContain('USDT balance 10');
    expect(r.reason).toContain('minTakerBalance 30');
  });

  it('잔고 0 + minTakerBalance 양수 → autoPause', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 0,
      minTakerBalance: 5,
    });
    expect(r.autoPause).toBe(true);
  });

  it('minTakerBalance 0 → 모든 잔고에서 noop (의도된 비활성)', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 0,
      minTakerBalance: 0,
    });
    // 잔고 0 < 0은 false이므로 noop
    expect(r.autoPause).toBe(false);
  });
});
