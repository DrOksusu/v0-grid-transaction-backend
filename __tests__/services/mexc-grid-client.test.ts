import axios from 'axios';
import { roundToStep, roundToTick, meetsMinNotional, MexcGridClient } from '../../src/services/exchange/mexc-grid-client';

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

describe('round 경계값(정확한 배수 유지 + 잔여값 없음)', () => {
  it('정확한 배수는 제자리', () => {
    expect(roundToStep(0.3, 0.1)).toBeCloseTo(0.3, 9);
    expect(roundToStep(0.7, 0.1)).toBeCloseTo(0.7, 9);
    expect(roundToTick(63123.47, 0.01)).toBeCloseTo(63123.47, 6);
  });
  it('결과 문자열에 부동소수 잔여값 없음', () => {
    expect(String(roundToStep(0.35, 0.1))).toBe('0.3');
    expect(String(roundToStep(0.3, 0.1))).toBe('0.3');
  });
});

describe('getFilters: MEXC 실제 응답 shape 파싱', () => {
  afterEach(() => jest.restoreAllMocks());

  const mockSymbol = (sym: object) =>
    jest.spyOn(axios, 'get').mockResolvedValue({ data: { symbols: [sym] } });

  it('quotePrecision/baseSizePrecision/quoteAmountPrecision로 필터 산출', async () => {
    mockSymbol({
      symbol: 'BTCUSDT', quotePrecision: 2, baseAssetPrecision: 8,
      baseSizePrecision: '0.000001', quoteAmountPrecision: '1',
      filters: [{ filterType: 'PERCENT_PRICE_BY_SIDE' }],
    });
    const f = await new MexcGridClient({ apiKey: 'k', secretKey: 's' }).getFilters('BTCUSDT');
    expect(f.tickSize).toBeCloseTo(0.01, 9);
    expect(f.stepSize).toBeCloseTo(0.000001, 12);
    expect(f.minNotional).toBeCloseTo(1, 9);
  });

  it('baseSizePrecision이 "0"이면 baseAssetPrecision으로 stepSize 산출', async () => {
    mockSymbol({ symbol: 'ONDOUSDT', quotePrecision: 5, baseAssetPrecision: 2, baseSizePrecision: '0', quoteAmountPrecision: '1' });
    const f = await new MexcGridClient({ apiKey: 'k', secretKey: 's' }).getFilters('ONDOUSDT');
    expect(f.tickSize).toBeCloseTo(0.00001, 12);
    expect(f.stepSize).toBeCloseTo(0.01, 12);
  });

  it('baseSizePrecision/baseAssetPrecision 모두 없으면 stepSize 1', async () => {
    mockSymbol({ symbol: 'XUSDT', quotePrecision: 4, baseSizePrecision: '0', quoteAmountPrecision: '1' });
    const f = await new MexcGridClient({ apiKey: 'k', secretKey: 's' }).getFilters('XUSDT');
    expect(f.stepSize).toBe(1);
  });

  it('성공 응답은 캐시되어 두 번째 호출에서 재조회하지 않음', async () => {
    const spy = mockSymbol({ symbol: 'XLMUSDT', quotePrecision: 4, baseSizePrecision: '0.1', quoteAmountPrecision: '1' });
    const c = new MexcGridClient({ apiKey: 'k', secretKey: 's' });
    await c.getFilters('XLMUSDT');
    await c.getFilters('XLMUSDT');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('symbols[0] 없으면 warn + 기본값, 캐시하지 않음', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: { symbols: [] } });
    const c = new MexcGridClient({ apiKey: 'k', secretKey: 's' });
    const f = await c.getFilters('NOPEUSDT');
    expect(f).toEqual({ tickSize: 0.01, stepSize: 0.000001, minNotional: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOPEUSDT'));
    await c.getFilters('NOPEUSDT');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
