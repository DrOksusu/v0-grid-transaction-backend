import {
  calcTargetPrice,
  getTradeDate,
  isForceCloseWindow,
  calcStopLossPrice,
  evaluateExit,
  simulateBreakout,
  type DailyCandle,
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

describe('simulateBreakout', () => {
  const opts = { k: 0.5, stopLossPct: 3, feeRoundTripPct: 0.1, startCapital: 1_000_000 };

  // 전일(인덱스 0)은 변동폭 산출용 — 거래는 인덱스 1부터
  const prevDay: DailyCandle = { date: '2026-01-01', open: 100, high: 110, low: 90, close: 105 };
  // 전일 변동폭 20, k=0.5 → 목표가 = 당일시가 100 + 10 = 110

  it('고가가 목표가 미달이면 진입 없음', () => {
    const r = simulateBreakout(
      [prevDay, { date: '2026-01-02', open: 100, high: 109, low: 95, close: 108 }],
      opts,
    );
    expect(r.n).toBe(0);
    expect(r.finalCapital).toBe(1_000_000);
  });

  it('돌파 시 목표가 체결 → 종가 청산, 수수료 차감', () => {
    const r = simulateBreakout(
      [prevDay, { date: '2026-01-02', open: 100, high: 120, low: 108, close: 115 }],
      opts,
    );
    expect(r.n).toBe(1);
    // (115/110 - 1)*100 - 0.1 = 4.4545... - 0.1
    expect(r.avgNetPct).toBeCloseTo((115 / 110 - 1) * 100 - 0.1, 5);
    expect(r.winRate).toBe(100);
  });

  it('저가가 손절선 이하면 손절 체결이 우선 (보수적 가정)', () => {
    // 손절선 = 110 × 0.97 = 106.7, 저가 99 ≤ 106.7 → STOP
    const r = simulateBreakout(
      [prevDay, { date: '2026-01-02', open: 100, high: 120, low: 99, close: 115 }],
      opts,
    );
    expect(r.n).toBe(1);
    expect(r.avgNetPct).toBeCloseTo(-3 - 0.1, 5); // -stopLossPct - 수수료
    expect(r.worstPct).toBeCloseTo(-3.1, 5);
    expect(r.maxDdPct).toBeCloseTo(3.1, 5);
  });

  it('빈 배열이면 무거래 — 시작자본 유지', () => {
    const r = simulateBreakout([], opts);
    expect(r.n).toBe(0);
    expect(r.finalCapital).toBe(1_000_000);
    expect(r.buyHoldFinal).toBe(1_000_000);
  });

  it('캔들 1개면 무거래 — 시작자본 유지', () => {
    const r = simulateBreakout([prevDay], opts);
    expect(r.n).toBe(0);
    expect(r.finalCapital).toBe(1_000_000);
    expect(r.buyHoldFinal).toBe(1_000_000);
  });

  it('복리 누적: 2거래 수익률이 곱으로 반영', () => {
    const day2: DailyCandle = { date: '2026-01-02', open: 100, high: 120, low: 108, close: 115 };
    // day2 변동폭 12 → day3 목표가 = 110 + 6 = 116
    const day3: DailyCandle = { date: '2026-01-03', open: 110, high: 130, low: 114, close: 120 };
    const r = simulateBreakout([prevDay, day2, day3], opts);
    expect(r.n).toBe(2);
    const pnl1 = (115 / 110 - 1) * 100 - 0.1;
    const pnl2 = (120 / 116 - 1) * 100 - 0.1;
    expect(r.finalCapital).toBeCloseTo(1_000_000 * (1 + pnl1 / 100) * (1 + pnl2 / 100), 2);
  });

  it('연도별 손익 집계', () => {
    const r = simulateBreakout(
      [prevDay, { date: '2026-01-02', open: 100, high: 120, low: 108, close: 115 }],
      opts,
    );
    expect(r.yearly).toEqual([{ year: 2026, pnlPct: expect.closeTo((115 / 110 - 1) * 100 - 0.1, 5) }]);
  });

  it('단순 보유 최종자본 = 첫 종가 대비 마지막 종가 배율', () => {
    const r = simulateBreakout(
      [prevDay, { date: '2026-01-02', open: 100, high: 109, low: 95, close: 210 }],
      opts,
    );
    expect(r.buyHoldFinal).toBeCloseTo(1_000_000 * (210 / 105), 2);
  });
});
