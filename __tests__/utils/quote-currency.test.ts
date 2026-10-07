import { isUsdtQuote, splitByQuote } from '../../src/utils/quote-currency';

describe('quote-currency', () => {
  it('mexc는 USDT quote', () => {
    expect(isUsdtQuote('mexc')).toBe(true);
    expect(isUsdtQuote('upbit')).toBe(false);
    expect(isUsdtQuote('bithumb')).toBe(false);
  });
  it('splitByQuote: krw/usdt 분리 합계', () => {
    const bots = [
      { exchange: 'upbit', currentProfit: 1000 },
      { exchange: 'bithumb', currentProfit: 500 },
      { exchange: 'mexc', currentProfit: 12.5 },
    ];
    const r = splitByQuote(bots);
    expect(r.krwProfit).toBe(1500);
    expect(r.usdtProfit).toBeCloseTo(12.5, 6);
  });
  it('빈 배열/누락 필드 방어', () => {
    const r = splitByQuote([{ exchange: 'mexc' } as any]);
    expect(r.usdtProfit).toBe(0);
    expect(r.krwProfit).toBe(0);
  });
});
