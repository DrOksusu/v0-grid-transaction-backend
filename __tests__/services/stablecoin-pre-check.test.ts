import {
  checkKillSwitch,
  checkDailyTradeLimit,
  checkDailyLossLimit,
  checkDepeg,
  checkDepthAndBalance,
  runAll,
  type PreCheckBot,
  type PreCheckOpp,
} from '../../src/services/stablecoin-pre-check';
import type { OrderbookTop } from '../../src/services/upbit-price-manager';

const baseBot: PreCheckBot = {
  id: 1,
  killSwitch: false,
  maxDailyTrades: 30,
  dailyLossLimitKrw: 50000,
  depegBps: 200,
};

const baseOpp: PreCheckOpp = {
  soldCoin: 'USDT',
  boughtCoin: 'USDC',
  bidSoldKrw: 1486,
  askBoughtKrw: 1485,
  bidSoldSize: 100,
  askBoughtSize: 100,
};

const makeBook = (
  bid: number,
  ask: number,
  bidSize = 100,
  askSize = 100,
): OrderbookTop => ({
  market: 'KRW-X',
  bid: { price: bid, size: bidSize },
  ask: { price: ask, size: askSize },
  timestamp: Date.now(),
});

const fiveBooks = new Map<string, OrderbookTop>([
  ['KRW-USDT', makeBook(1486, 1487)],
  ['KRW-USDC', makeBook(1485, 1486)],
  ['KRW-USD1', makeBook(1485, 1487)],
  ['KRW-USDS', makeBook(1483, 1488)],
  ['KRW-USDE', makeBook(1484, 1489)],
]);

describe('checkKillSwitch', () => {
  it('killSwitch=false → ok', () => {
    expect(checkKillSwitch(baseBot)).toEqual({ ok: true });
  });
  it('killSwitch=true → abort', () => {
    expect(checkKillSwitch({ ...baseBot, killSwitch: true })).toEqual({
      ok: false,
      reason: 'killswitch',
    });
  });
});

describe('checkDailyTradeLimit', () => {
  it('count < limit → ok', () => {
    expect(checkDailyTradeLimit(baseBot, 5)).toEqual({ ok: true });
  });
  it('count >= limit → abort', () => {
    expect(checkDailyTradeLimit(baseBot, 30)).toEqual({
      ok: false,
      reason: 'daily_limit',
    });
  });
});

describe('checkDailyLossLimit', () => {
  it('todayNetProfitKrw > -limit → ok', () => {
    expect(checkDailyLossLimit(baseBot, -1000)).toEqual({ ok: true });
  });
  it('todayNetProfitKrw <= -limit → abort', () => {
    expect(checkDailyLossLimit(baseBot, -50000)).toEqual({
      ok: false,
      reason: 'daily_loss_limit',
    });
  });
});

describe('checkDepeg', () => {
  it('X와 Y가 5종 mid 중간값 ±200bp 안 → ok', () => {
    // 모든 코인 mid가 1485~1486.5 범위 → 중간값 ~1486. depeg 0bp 근처
    expect(checkDepeg(fiveBooks, 'USDT', 'USDC', 200)).toEqual({ ok: true });
  });
  it('X가 mid 중간값 대비 ±200bp 벗어남 → abort', () => {
    // USDT mid를 1700으로 왜곡 (median 1485 대비 +14% = 1448bp)
    const skewed = new Map(fiveBooks);
    skewed.set('KRW-USDT', makeBook(1699, 1701));
    expect(checkDepeg(skewed, 'USDT', 'USDC', 200)).toEqual({
      ok: false,
      reason: 'depeg',
    });
  });
});

describe('checkDepthAndBalance', () => {
  it('depth+balance 모두 충분 → ok', () => {
    const balance = { USDT: 100 };
    expect(checkDepthAndBalance(baseOpp, 50, balance)).toEqual({ ok: true });
  });
  it('balance 부족 → abort', () => {
    const balance = { USDT: 10 };
    expect(checkDepthAndBalance(baseOpp, 50, balance)).toEqual({
      ok: false,
      reason: 'insufficient',
    });
  });
});

describe('runAll', () => {
  it('모든 검사 pass → ok', () => {
    const balance = { USDT: 100 };
    const result = runAll(
      baseBot,
      baseOpp,
      fiveBooks,
      balance,
      { todayTradeCount: 5, todayNetProfitKrw: -1000 },
      50,
    );
    expect(result).toEqual({ ok: true });
  });
});
