import type { OrderbookTop } from './upbit-price-manager';

/** 사전 검사 결과 */
export type PreCheckResult = { ok: true } | { ok: false; reason: string };

/** 사전 검사에 필요한 봇 필드만 추림 (실제 StablecoinArbBot 일부) */
export interface PreCheckBot {
  id: number;
  killSwitch: boolean;
  maxDailyTrades: number;
  dailyLossLimitKrw: number;
  depegBps: number;
}

/** 사전 검사에 필요한 기회 필드만 추림 (실제 ArbOpportunity 일부) */
export interface PreCheckOpp {
  soldCoin: string;
  boughtCoin: string;
  bidSoldKrw: number;
  askBoughtKrw: number;
  bidSoldSize: number;
  askBoughtSize: number;
}

/** 1단계: kill switch */
export function checkKillSwitch(bot: PreCheckBot): PreCheckResult {
  if (bot.killSwitch) return { ok: false, reason: 'killswitch' };
  return { ok: true };
}

/** 2단계: 일일 거래 한도 */
export function checkDailyTradeLimit(
  bot: PreCheckBot,
  todayTradeCount: number,
): PreCheckResult {
  if (todayTradeCount >= bot.maxDailyTrades) {
    return { ok: false, reason: 'daily_limit' };
  }
  return { ok: true };
}

/** 3단계: 일일 손실 한도 (도달 시 auto kill switch 후속 trigger 가능) */
export function checkDailyLossLimit(
  bot: PreCheckBot,
  todayNetProfitKrw: number,
): PreCheckResult {
  if (todayNetProfitKrw <= -bot.dailyLossLimitKrw) {
    return { ok: false, reason: 'daily_loss_limit' };
  }
  return { ok: true };
}

/** 4단계: 디페그 (X와 Y가 5종 mid 중간값 ±depegBps 안) */
export function checkDepeg(
  books: ReadonlyMap<string, OrderbookTop>,
  coinX: string,
  coinY: string,
  depegBps: number,
): PreCheckResult {
  // 5종 모든 코인의 mid-price 수집
  const mids: number[] = [];
  for (const [, book] of books) {
    const mid = (book.bid.price + book.ask.price) / 2;
    if (mid > 0) mids.push(mid);
  }
  if (mids.length === 0) return { ok: false, reason: 'depeg' };

  // 중간값(median)
  const sorted = [...mids].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // X, Y mid가 median 대비 depegBps 안인지
  const checkOne = (coin: string): boolean => {
    const book = books.get(`KRW-${coin}`);
    if (!book) return false;
    const mid = (book.bid.price + book.ask.price) / 2;
    const diffBps = Math.abs((mid / median - 1) * 10000);
    return diffBps <= depegBps;
  };

  if (!checkOne(coinX) || !checkOne(coinY)) {
    return { ok: false, reason: 'depeg' };
  }
  return { ok: true };
}

/** 5단계: 호가 깊이 + 잔고 */
export function checkDepthAndBalance(
  opp: PreCheckOpp,
  qty: number,
  balance: Record<string, number>,
): PreCheckResult {
  if (opp.bidSoldSize < qty || opp.askBoughtSize < qty) {
    return { ok: false, reason: 'insufficient' };
  }
  const balX = balance[opp.soldCoin] ?? 0;
  if (balX < qty) {
    return { ok: false, reason: 'insufficient' };
  }
  return { ok: true };
}

/** 통합 — 5단계 순차 실행 (앞 단계 abort면 즉시 return) */
export function runAll(
  bot: PreCheckBot,
  opp: PreCheckOpp,
  books: ReadonlyMap<string, OrderbookTop>,
  balance: Record<string, number>,
  todayStats: { todayTradeCount: number; todayNetProfitKrw: number },
  qty: number,
): PreCheckResult {
  const r1 = checkKillSwitch(bot);
  if (!r1.ok) return r1;

  const r2 = checkDailyTradeLimit(bot, todayStats.todayTradeCount);
  if (!r2.ok) return r2;

  const r3 = checkDailyLossLimit(bot, todayStats.todayNetProfitKrw);
  if (!r3.ok) return r3;

  const r4 = checkDepeg(books, opp.soldCoin, opp.boughtCoin, bot.depegBps);
  if (!r4.ok) return r4;

  const r5 = checkDepthAndBalance(opp, qty, balance);
  if (!r5.ok) return r5;

  return { ok: true };
}
