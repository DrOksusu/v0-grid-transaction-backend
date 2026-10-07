import axios from 'axios';
import { mexcGridPriceManager } from '../../src/services/mexc-grid-price-manager';

describe('mexcGridPriceManager', () => {
  afterEach(() => jest.restoreAllMocks());
  it('ticker/price 응답을 숫자로 반환', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({ data: { price: '63123.45' } });
    const p = await mexcGridPriceManager.getPriceWithFallback('BTCUSDT');
    expect(p).toBeCloseTo(63123.45, 2);
  });
  it('2초 내 재조회는 캐시 사용(axios 1회만)', async () => {
    const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: { price: '100' } });
    await mexcGridPriceManager.getPriceWithFallback('ETHUSDT');
    await mexcGridPriceManager.getPriceWithFallback('ETHUSDT');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
