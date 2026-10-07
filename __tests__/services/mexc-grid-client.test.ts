import axios from 'axios';
import * as signer from '../../src/services/exchange/exchange-signer';
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

describe('round 회귀 방지(올림 금지)', () => {
  it('대수치 정확 배수는 올림되지 않고 제자리', () => {
    expect(roundToStep(1e7, 0.01)).toBeCloseTo(1e7, 3);
    expect(roundToStep(1e9, 0.01)).toBeCloseTo(1e9, 0);
    expect(roundToStep(1e7, 0.01)).toBeLessThanOrEqual(1e7);
  });
  it('서브스텝 값은 내림(올림 금지)', () => {
    expect(roundToStep(0.29999999999, 0.1)).toBeCloseTo(0.2, 9);
    expect(roundToStep(0.29999999999, 0.1)).toBeLessThanOrEqual(0.29999999999);
  });
  it('비10진 step(0.25) 정확 배수 유지', () => {
    expect(roundToStep(0.75, 0.25)).toBeCloseTo(0.75, 9);
    expect(String(roundToStep(0.75, 0.25))).toBe('0.75');
  });
  it('극단적 대비율에서도 올림되지 않음(floor 보장)', () => {
    expect(roundToStep(2000000.000000006, 1e-8)).toBeLessThanOrEqual(2000000.000000006);
    expect(roundToTick(2000000.000000006, 1e-8)).toBeLessThanOrEqual(2000000.000000006);
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

  it('정밀도 필드가 전부 누락이면 warn + 기본값, 캐시하지 않음', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: { symbols: [{ symbol: 'EMPTYUSDT' }] } });
    const c = new MexcGridClient({ apiKey: 'k', secretKey: 's' });
    const f = await c.getFilters('EMPTYUSDT');
    expect(f).toEqual({ tickSize: 0.01, stepSize: 1, minNotional: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMPTYUSDT'));
    await c.getFilters('EMPTYUSDT');
    expect(spy).toHaveBeenCalledTimes(2);
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

describe('MexcGridClient 주문', () => {
  const client = new MexcGridClient({ apiKey: 'k', secretKey: 's' });
  beforeEach(() => {
    jest.spyOn(client, 'getFilters').mockResolvedValue({ tickSize: 0.01, stepSize: 0.000001, minNotional: 1 });
  });
  afterEach(() => jest.restoreAllMocks());

  it('buyLimit: GTC 지정가 파라미터로 mexcPost 호출하고 {uuid} 반환', async () => {
    const spy = jest.spyOn(signer, 'mexcPost').mockResolvedValue({ orderId: 123456 });
    const r = await client.buyLimit('BTCUSDT', 63123.479, 0.0012345678);
    expect(r).toEqual({ uuid: '123456' });
    const [, , endpoint, params] = spy.mock.calls[0] as any;
    expect(endpoint).toBe('/api/v3/order');
    expect(params.symbol).toBe('BTCUSDT');
    expect(params.side).toBe('BUY');
    expect(params.type).toBe('LIMIT');
    expect(params.timeInForce).toBe('GTC');
    expect(params.price).toBe('63123.47'); // tick 0.01 floor
    expect(params.quantity).toBe('0.001234'); // step 0.000001 floor
  });

  it('sellLimit: side SELL', async () => {
    const spy = jest.spyOn(signer, 'mexcPost').mockResolvedValue({ orderId: 999 });
    const r = await client.sellLimit('BTCUSDT', 64000, 0.002);
    expect(r).toEqual({ uuid: '999' });
    expect((spy.mock.calls[0] as any)[3].side).toBe('SELL');
  });

  it('minNotional 미만이면 주문 안 하고 throw (floor→0, 그리고 q>0 저액)', async () => {
    const spy = jest.spyOn(signer, 'mexcPost').mockResolvedValue({ orderId: 1 });
    // floor→0: step 1e-6에서 0.0000001 → q=0
    await expect(client.buyLimit('BTCUSDT', 1, 0.0000001)).rejects.toThrow(/minNotional|최소/);
    // q>0 저액: minNotional 1인데 0.5*1=0.5 < 1
    await expect(client.buyLimit('BTCUSDT', 1, 0.5)).rejects.toThrow(/minNotional|최소/);
    expect(spy).not.toHaveBeenCalled(); // 핵심: minNotional 미달이면 실제 주문 안 나감
  });

  it('MEXC 응답에 orderId 없으면 throw (상태오염 방지)', async () => {
    jest.spyOn(signer, 'mexcPost').mockResolvedValue({ code: 200, msg: 'ok' }); // orderId 없음
    await expect(client.buyLimit('BTCUSDT', 63000, 0.001)).rejects.toThrow(/orderId/);
  });
});

describe('MexcGridClient getFilledOrders 정규화', () => {
  const client = new MexcGridClient({ apiKey: 'k', secretKey: 's' });
  afterEach(() => jest.restoreAllMocks());

  it('FILLED 주문을 {uuid,state:done,avgFillPrice,filledQty}로 정규화', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue([
      { orderId: 1, status: 'FILLED', executedQty: '0.002', cummulativeQuoteQty: '126.0', price: '63000', updateTime: 1730000000000 },
      { orderId: 2, status: 'NEW', executedQty: '0', cummulativeQuoteQty: '0', price: '62000' },
    ]);
    const r = await client.getFilledOrders('BTCUSDT', 100);
    expect(r).toHaveLength(1);
    expect(r[0].uuid).toBe('1');
    expect(r[0].state).toBe('done');
    expect(r[0].filledQty).toBeCloseTo(0.002, 9);
    expect(r[0].avgFillPrice).toBeCloseTo(63000, 6); // 126.0/0.002
    expect(r[0].trades[0].created_at).toBeTruthy();
  });

  it('executedQty 0인 FILLED는 avg를 price로 폴백', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue([
      { orderId: 3, status: 'FILLED', executedQty: '0', cummulativeQuoteQty: '0', price: '61000', updateTime: 1730000000000 },
    ]);
    const r = await client.getFilledOrders('BTCUSDT', 100);
    expect(r[0].avgFillPrice).toBeCloseTo(61000, 6);
    expect(r[0].filledQty).toBe(0);
  });
  it('비배열 응답은 빈 배열로 방어', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue({ code: 700002, msg: 'signature invalid' } as any);
    const r = await client.getFilledOrders('BTCUSDT', 100);
    expect(r).toEqual([]);
  });
  it('PARTIALLY_FILLED는 제외', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue([
      { orderId: 4, status: 'PARTIALLY_FILLED', executedQty: '0.001', cummulativeQuoteQty: '63', price: '63000' },
    ]);
    const r = await client.getFilledOrders('BTCUSDT', 100);
    expect(r).toEqual([]);
  });
  it('가비지 cummulativeQuoteQty면 avg는 NaN 대신 0', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue([
      { orderId: 5, status: 'FILLED', executedQty: '0.001', cummulativeQuoteQty: 'garbage', price: '63000' },
    ]);
    const r = await client.getFilledOrders('BTCUSDT', 100);
    expect(r[0].avgFillPrice).toBe(0);
  });

  it('market 없으면 빈 배열(MEXC allOrders는 symbol 필수)', async () => {
    const spy = jest.spyOn(signer, 'signedGet');
    const r = await client.getFilledOrders(undefined, 100);
    expect(r).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('MexcGridClient getOrder/cancelOrder', () => {
  const client = new MexcGridClient({ apiKey: 'k', secretKey: 's' });
  afterEach(() => jest.restoreAllMocks());

  it('getOrder: FILLED→status filled + avgFillPrice/filledQty', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue({ orderId: 7, status: 'FILLED', executedQty: '0.001', cummulativeQuoteQty: '63.0', price: '63000' });
    const o = await client.getOrder('7', 'BTCUSDT');
    expect(o.status).toBe('filled');
    expect(o.filledQty).toBeCloseTo(0.001, 9);
    expect(o.avgFillPrice).toBeCloseTo(63000, 6);
  });

  it('getOrder: CANCELED→status cancelled', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue({ orderId: 8, status: 'CANCELED', executedQty: '0', cummulativeQuoteQty: '0' });
    const o = await client.getOrder('8', 'BTCUSDT');
    expect(o.status).toBe('cancelled');
  });

  it('getOrder: NEW→status pending', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue({ orderId: 9, status: 'NEW', executedQty: '0', cummulativeQuoteQty: '0', price: '62000' });
    const o = await client.getOrder('9', 'BTCUSDT');
    expect(o.status).toBe('pending');
  });

  it('cancelOrder: 실패해도 throw 안 함(이미 종료 가능)', async () => {
    jest.spyOn(axios, 'delete').mockRejectedValue(new Error('order not found'));
    await expect(client.cancelOrder('10', 'BTCUSDT')).resolves.toBeUndefined();
  });

  it('cancelOrder: symbol 없으면 아무것도 안 함', async () => {
    const spy = jest.spyOn(axios, 'delete');
    await client.cancelOrder('11');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('MexcGridClient getUsdtBalance', () => {
  const client = new MexcGridClient({ apiKey: 'k', secretKey: 's' });
  afterEach(() => jest.restoreAllMocks());
  it('account의 USDT free를 숫자로', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue({ balances: [{ asset: 'USDT', free: '123.45', locked: '0' }, { asset: 'BTC', free: '0.01' }] });
    expect(await client.getUsdtBalance()).toBeCloseTo(123.45, 6);
  });
  it('USDT 없으면 0', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue({ balances: [{ asset: 'BTC', free: '0.01' }] });
    expect(await client.getUsdtBalance()).toBe(0);
  });
});
