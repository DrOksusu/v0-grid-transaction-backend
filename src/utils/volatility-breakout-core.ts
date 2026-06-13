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
