import { roundToStep, roundToTick, meetsMinNotional } from '../../src/services/exchange/mexc-grid-client';

describe('MexcGridClient 정밀도 유틸', () => {
  it('stepSize로 수량 내림(floor)', () => {
    expect(roundToStep(0.123456789, 0.000001)).toBeCloseTo(0.123456, 9);
    expect(roundToStep(1.9999, 0.001)).toBeCloseTo(1.999, 9);
  });
  it('tickSize로 가격 내림(floor)', () => {
    expect(roundToTick(63123.47, 0.01)).toBeCloseTo(63123.47, 6);
    expect(roundToTick(63123.479, 0.1)).toBeCloseTo(63123.4, 6);
  });
  it('minNotional 미만이면 false', () => {
    expect(meetsMinNotional(0.0001, 63000, 5)).toBe(true);
    expect(meetsMinNotional(0.00001, 63000, 5)).toBe(false);
  });
});
