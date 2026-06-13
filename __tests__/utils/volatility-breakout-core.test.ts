import {
  calcTargetPrice,
  getTradeDate,
  isForceCloseWindow,
  calcStopLossPrice,
  evaluateExit,
} from '../../src/utils/volatility-breakout-core';

describe('calcTargetPrice', () => {
  it('당일 시가 + 전일 변동폭 × k', () => {
    // 시가 100, 전일 고가 110/저가 90 → 변동폭 20, k=0.65 → 100 + 13 = 113
    expect(calcTargetPrice(100, 110, 90, 0.65)).toBeCloseTo(113);
  });

  it('k=0이면 시가 그대로', () => {
    expect(calcTargetPrice(100, 110, 90, 0)).toBe(100);
  });
});

describe('getTradeDate (KST 09:00 경계 = UTC 00:00)', () => {
  it('KST 08:59는 전일 거래일', () => {
    expect(getTradeDate(new Date('2026-06-13T08:59:00+09:00'))).toBe('2026-06-12');
  });

  it('KST 09:01은 당일 거래일', () => {
    expect(getTradeDate(new Date('2026-06-13T09:01:00+09:00'))).toBe('2026-06-13');
  });
});

describe('isForceCloseWindow (KST 08:55~09:00 = UTC 23:55~24:00)', () => {
  it('UTC 23:54 → false', () => {
    expect(isForceCloseWindow(new Date('2026-06-12T23:54:59Z'))).toBe(false);
  });
  it('UTC 23:55 → true', () => {
    expect(isForceCloseWindow(new Date('2026-06-12T23:55:00Z'))).toBe(true);
  });
  it('UTC 23:59 → true', () => {
    expect(isForceCloseWindow(new Date('2026-06-12T23:59:59Z'))).toBe(true);
  });
  it('UTC 00:00 → false (새 거래일)', () => {
    expect(isForceCloseWindow(new Date('2026-06-13T00:00:00Z'))).toBe(false);
  });
});

describe('calcStopLossPrice', () => {
  it('진입가 × (1 - 손절%/100)', () => {
    expect(calcStopLossPrice(100000, 3)).toBeCloseTo(97000);
  });
});

describe('evaluateExit', () => {
  const base = {
    now: new Date('2026-06-13T05:00:00Z'), // 거래일 2026-06-13, 강제청산 창 아님
    entryPrice: 100000,
    stopLossPct: 3,
    entryTradeDate: '2026-06-13',
  };

  it('현재가가 손절선 이하면 STOP', () => {
    expect(evaluateExit({ ...base, currentPrice: 96999 })).toBe('STOP');
  });

  it('손절선 정확히 도달도 STOP', () => {
    expect(evaluateExit({ ...base, currentPrice: 97000 })).toBe('STOP');
  });

  it('강제 청산 창이면 CLOSE', () => {
    expect(
      evaluateExit({ ...base, now: new Date('2026-06-13T23:56:00Z'), currentPrice: 105000 }),
    ).toBe('CLOSE');
  });

  it('거래일이 바뀌었는데 HOLDING이면 CLOSE (서버 다운 청산 누락)', () => {
    expect(
      evaluateExit({ ...base, now: new Date('2026-06-14T01:00:00Z'), currentPrice: 105000 }),
    ).toBe('CLOSE');
  });

  it('손절 조건이 강제 청산보다 우선', () => {
    expect(
      evaluateExit({ ...base, now: new Date('2026-06-13T23:56:00Z'), currentPrice: 90000 }),
    ).toBe('STOP');
  });

  it('아무 조건도 아니면 null (보유 유지)', () => {
    expect(evaluateExit({ ...base, currentPrice: 105000 })).toBeNull();
  });
});
