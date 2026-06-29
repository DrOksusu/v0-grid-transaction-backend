import { calculateGridPrices, validateGridRange } from '../../src/services/korean-stock-grid.service';

describe('calculateGridPrices', () => {
  it('등분할 + 호가 단위 자동 보정', () => {
    const prices = calculateGridPrices({ lowerPrice: 70000, upperPrice: 80000, gridCount: 10 });
    expect(prices.length).toBe(11);
    expect(prices[0]).toBe(70000);
    expect(prices[10]).toBe(80000);
    for (const p of prices) {
      // 70000~80000 구간은 호가 단위 100원
      expect(p % 100).toBe(0);
    }
  });

  it('gridCount=2 최소 케이스', () => {
    const prices = calculateGridPrices({ lowerPrice: 10000, upperPrice: 12000, gridCount: 2 });
    expect(prices).toEqual([10000, 11000, 12000]);
  });

  it('호가 단위 경계 (49000 ~ 51000)', () => {
    const prices = calculateGridPrices({ lowerPrice: 49000, upperPrice: 51000, gridCount: 4 });
    expect(prices[0]).toBe(49000);
    expect(prices[4]).toBe(51000);
    expect(prices.length).toBe(5);
  });

  it('lowerPrice >= upperPrice → throw', () => {
    expect(() => calculateGridPrices({ lowerPrice: 80000, upperPrice: 70000, gridCount: 10 })).toThrow();
  });

  it('gridCount < 2 → throw', () => {
    expect(() => calculateGridPrices({ lowerPrice: 70000, upperPrice: 80000, gridCount: 1 })).toThrow();
  });
});

describe('validateGridRange', () => {
  it('상하한가(±30%) 안이면 OK', () => {
    const result = validateGridRange({ lowerPrice: 70000, upperPrice: 80000, prevClose: 75000 });
    expect(result.ok).toBe(true);
  });

  it('하한가 미만이면 에러 (52500 미만)', () => {
    const result = validateGridRange({ lowerPrice: 50000, upperPrice: 80000, prevClose: 75000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('하한가');
  });

  it('상한가 초과면 에러 (97500 초과)', () => {
    const result = validateGridRange({ lowerPrice: 70000, upperPrice: 100000, prevClose: 75000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('상한가');
  });

  it('lowerPrice >= upperPrice이면 에러', () => {
    const result = validateGridRange({ lowerPrice: 80000, upperPrice: 70000, prevClose: 75000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('lower');
  });
});
