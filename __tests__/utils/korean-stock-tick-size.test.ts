import { getTickSize, snapToTickSize } from '../../src/utils/korean-stock-tick-size';

describe('getTickSize (KOSPI 기준 2026)', () => {
  it.each([
    [1500, 1],
    [3000, 5],
    [10000, 10],
    [30000, 50],
    [75000, 100],
    [300000, 500],
    [700000, 1000],
  ])('가격 %d원 → 호가 단위 %d원', (price, expected) => {
    expect(getTickSize(price)).toBe(expected);
  });

  it('경계값 5000원 → 10원 (5000 미만은 5원)', () => {
    expect(getTickSize(4999)).toBe(5);
    expect(getTickSize(5000)).toBe(10);
  });
});

describe('snapToTickSize', () => {
  it.each([
    [75123, 75100],   // 100원 단위 내림
    [75150, 75200],   // 반올림 (정확히 1/2 위)
    [3007, 3005],     // 5원 단위 내림
    [4999, 5000],     // 5원 단위 반올림
    [199999, 200000], // 100원 단위 → 200000
    [200001, 200000], // 500원 단위로 진입했지만 정확히 200000은 그대로
  ])('가격 %d → 보정 %d', (input, expected) => {
    expect(snapToTickSize(input)).toBe(expected);
  });
});
