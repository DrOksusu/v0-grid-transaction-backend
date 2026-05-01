import { runAll, PrecheckArgs } from '../../src/services/cross-exchange-precheck';

const baseArgs: PrecheckArgs = {
  snapshot: { upbitBid: 1010, upbitAsk: 1011, bithumbBid: 999, bithumbAsk: 1000 },
  direction: 'UB',
  bot: {
    coin: 'USDE',
    quantity: 10,
    minSpreadBps: 50,
    depegMinKrw: 1380,
    depegMaxKrw: 1420,
    liquidityMultiplier: 1.5,
    dailyCountLimit: 5,
    dailyLossLimitKrw: 50000,
  },
  liquidity: { upbitBidQty: 100, upbitAskQty: 100, bithumbBidQty: 100, bithumbAskQty: 100 },
  balances: { upbit: { KRW: 1000000, USDE: 50 }, bithumb: { KRW: 1000000, USDE: 50 } },
  todayCount: 0,
  todayLossKrw: 0,
};

describe('cross-exchange precheck — runAll', () => {
  it('정상 케이스 → ok', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, depegMinKrw: 990, depegMaxKrw: 1020 },
    });
    expect(result.ok).toBe(true);
  });

  it('1단계 spread 미달 → spread reason', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, minSpreadBps: 200, depegMinKrw: 990, depegMaxKrw: 1020 },
    });
    expect(result.ok).toBe(false);
    expect(result.abortReason).toMatch(/spread/);
  });

  it('2단계 depeg → depeg reason', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, depegMinKrw: 1380, depegMaxKrw: 1420 },
    });
    expect(result.ok).toBe(false);
    expect(result.abortReason).toMatch(/depeg/i);
  });

  it('3단계 liquidity 부족 → liquidity reason', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, depegMinKrw: 990, depegMaxKrw: 1020 },
      liquidity: { upbitBidQty: 5, upbitAskQty: 5, bithumbBidQty: 5, bithumbAskQty: 5 },
    });
    expect(result.ok).toBe(false);
    expect(result.abortReason).toMatch(/liquidity/i);
  });

  it('4단계 잔고 부족 → balance reason', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, depegMinKrw: 990, depegMaxKrw: 1020 },
      balances: { upbit: { KRW: 100, USDE: 50 }, bithumb: { KRW: 1000000, USDE: 50 } },
    });
    expect(result.ok).toBe(false);
    expect(result.abortReason).toMatch(/balance|잔고/i);
  });

  it('5단계 daily limit 초과 → limit reason', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, depegMinKrw: 990, depegMaxKrw: 1020 },
      todayCount: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.abortReason).toMatch(/limit|한도/i);
  });
});
