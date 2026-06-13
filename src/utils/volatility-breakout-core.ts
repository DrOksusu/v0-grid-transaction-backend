/**
 * 변동성 돌파(래리 윌리엄스) 순수 함수 모음.
 * 봇 사이클과 백테스트가 공유한다. DB/네트워크 의존 없음 — 단위 테스트 대상.
 *
 * 시간 규칙: 하루 사이클 = KST 09:00 ~ 다음날 09:00 (업비트 일봉 갱신 시각).
 * KST 09:00 == UTC 00:00 이므로 거래일 = UTC 날짜 문자열.
 */

export type ExitReason = 'STOP' | 'CLOSE';

/** 매수 목표가 = 당일 시가 + (전일 고가 - 전일 저가) × k */
export function calcTargetPrice(
  todayOpen: number,
  prevHigh: number,
  prevLow: number,
  k: number,
): number {
  return todayOpen + (prevHigh - prevLow) * k;
}

/** KST 09:00 경계 기준 거래일 — UTC 날짜와 일치 */
export function getTradeDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 강제 청산 창: KST 08:55~09:00 == UTC 23:55~24:00 */
export function isForceCloseWindow(now: Date): boolean {
  return now.getUTCHours() === 23 && now.getUTCMinutes() >= 55;
}

/** 손절선 = 진입가 × (1 - stopLossPct/100) */
export function calcStopLossPrice(entryPrice: number, stopLossPct: number): number {
  return entryPrice * (1 - stopLossPct / 100);
}

/**
 * HOLDING 포지션의 청산 판단.
 * STOP이 CLOSE보다 우선 (손절선 도달 시 즉시 매도).
 * 거래일 변경 감지 = 서버 다운으로 강제 청산을 놓친 경우 → 즉시 CLOSE.
 */
export function evaluateExit(params: {
  now: Date;
  currentPrice: number;
  entryPrice: number;
  stopLossPct: number;
  entryTradeDate: string;
}): ExitReason | null {
  const { now, currentPrice, entryPrice, stopLossPct, entryTradeDate } = params;
  if (currentPrice <= calcStopLossPrice(entryPrice, stopLossPct)) return 'STOP';
  if (isForceCloseWindow(now)) return 'CLOSE';
  if (getTradeDate(now) !== entryTradeDate) return 'CLOSE';
  return null;
}

export interface DailyCandle {
  date: string; // "2026-06-13" (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BacktestOptions {
  k: number;
  stopLossPct: number;
  feeRoundTripPct: number; // 왕복 수수료 % (업비트 0.05×2 = 0.1)
  startCapital: number;
}

export interface BacktestResult {
  n: number;
  winRate: number;
  avgNetPct: number;
  finalCapital: number;
  maxDdPct: number;
  worstPct: number;
  yearly: Array<{ year: number; pnlPct: number }>; // 연도별 손익 합산 (복리 아닌 단순 합산, 참고용)
  buyHoldFinal: number;
}

/**
 * 변동성 돌파 백테스트 (일봉, 롱 온리, 하루 1회, 복리).
 * - 진입: high ≥ 목표가 → 목표가 체결 가정
 * - 손절: low ≤ 손절선 → 손절가 체결 (보수적 — 종가 청산보다 먼저 가정)
 * - 그 외: 당일 종가 청산
 * 한계: 일봉 기반이라 장중 돌파→손절 순서는 근사치. 슬리피지 미반영.
 */
export function simulateBreakout(daily: DailyCandle[], opts: BacktestOptions): BacktestResult {
  let equity = opts.startCapital;
  let peak = equity;
  let maxDd = 0;
  let n = 0;
  let wins = 0;
  let sumNet = 0;
  let worst = 0;
  const yearlyMap = new Map<number, number>();

  for (let i = 1; i < daily.length; i++) {
    const today = daily[i];
    const prev = daily[i - 1];
    const target = calcTargetPrice(today.open, prev.high, prev.low, opts.k);
    if (today.high < target) continue;

    const stopPrice = calcStopLossPrice(target, opts.stopLossPct);
    const exitPrice = today.low <= stopPrice ? stopPrice : today.close;
    const pnlPct = (exitPrice / target - 1) * 100 - opts.feeRoundTripPct;

    n++;
    sumNet += pnlPct;
    if (pnlPct > 0) wins++;
    worst = n === 1 ? pnlPct : Math.min(worst, pnlPct);

    equity *= 1 + pnlPct / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (1 - equity / peak) * 100);

    const year = Number(today.date.slice(0, 4));
    yearlyMap.set(year, (yearlyMap.get(year) ?? 0) + pnlPct);
  }

  const buyHoldFinal =
    daily.length >= 2
      ? opts.startCapital * (daily[daily.length - 1].close / daily[0].close)
      : opts.startCapital;

  return {
    n,
    winRate: n > 0 ? (wins / n) * 100 : 0,
    avgNetPct: n > 0 ? sumNet / n : 0,
    finalCapital: equity,
    maxDdPct: maxDd,
    worstPct: worst,
    yearly: [...yearlyMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, pnlPct]) => ({ year, pnlPct })),
    buyHoldFinal,
  };
}
