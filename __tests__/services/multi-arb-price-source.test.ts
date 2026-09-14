// 배치 시세 응답 파싱 테스트 (axios 모킹)
import axios from 'axios';
import { multiArbPriceSource } from '../../src/services/multi-arb-price-source.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('multiArbPriceSource', () => {
  beforeEach(() => jest.resetAllMocks());

  it('fetchUpbit: 청크 조회 후 base 심볼 → 가격 맵을 만든다', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', trade_price: 100000000 },
        { market: 'KRW-LSK', trade_price: 533 },
      ],
    });
    const map = await multiArbPriceSource.fetchUpbit(['BTC', 'LSK']);
    expect(map.get('BTC')).toBe(100000000);
    expect(map.get('LSK')).toBe(533);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/ticker?markets=KRW-BTC,KRW-LSK'),
      expect.anything(),
    );
  });

  it('fetchBithumb: ALL_KRW 응답에서 date 키를 제외하고 맵을 만든다', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        status: '0000',
        data: {
          BTC: { closing_price: '100000000' },
          LSK: { closing_price: '1322' },
          date: '1726300000000',
        },
      },
    });
    const map = await multiArbPriceSource.fetchBithumb();
    expect(map.get('BTC')).toBe(100000000);
    expect(map.get('LSK')).toBe(1322);
    expect(map.has('DATE')).toBe(false);
  });

  it('fetchBinance: USDT 페어만 base 심볼로 변환한다', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        { symbol: 'BTCUSDT', price: '65000' },
        { symbol: 'ETHBTC', price: '0.05' },
        { symbol: 'LSKUSDT', price: '0.72' },
      ],
    });
    const map = await multiArbPriceSource.fetchBinance();
    expect(map.get('BTC')).toBe(65000);
    expect(map.get('LSK')).toBe(0.72);
    expect(map.has('ETH')).toBe(false); // ETHBTC는 USDT 페어 아님
  });

  it('fetchGateio: currency_pair에서 _USDT 페어만 파싱한다', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        { currency_pair: 'BTC_USDT', last: '65010' },
        { currency_pair: 'BTC_ETH', last: '20' },
      ],
    });
    const map = await multiArbPriceSource.fetchGateio();
    expect(map.get('BTC')).toBe(65010);
    expect(map.size).toBe(1);
  });

  it('fetchAllPrices: 한 거래소 실패해도 나머지는 반환한다 (spec §9)', async () => {
    mockedAxios.get.mockImplementation(((url: string) => {
      if (url.includes('api.upbit.com/v1/ticker')) return Promise.reject(new Error('upbit down'));
      if (url.includes('api.bithumb.com')) {
        return Promise.resolve({ data: { status: '0000', data: { BTC: { closing_price: '100000000' }, date: '1' } } });
      }
      if (url.includes('api.binance.com')) return Promise.resolve({ data: [{ symbol: 'BTCUSDT', price: '65000' }] });
      if (url.includes('api.mexc.com')) return Promise.resolve({ data: [{ symbol: 'BTCUSDT', price: '64990' }] });
      if (url.includes('api.gateio.ws')) return Promise.resolve({ data: [{ currency_pair: 'BTC_USDT', last: '65010' }] });
      return Promise.reject(new Error('unexpected url: ' + url));
    }) as any);
    const prices = await multiArbPriceSource.fetchAllPrices(['BTC']);
    expect(prices.upbit).toBeUndefined();
    expect(prices.bithumb!.get('BTC')).toBe(100000000);
    expect(prices.binance!.get('BTC')).toBe(65000);
    expect(prices.mexc!.get('BTC')).toBe(64990);
    expect(prices.gateio!.get('BTC')).toBe(65010);
  });

  it('getKrwPerUsdt: 업비트 KRW-USDT 시세를 반환하고 실패 시 null', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [{ market: 'KRW-USDT', trade_price: 1385 }] });
    expect(await multiArbPriceSource.getKrwPerUsdt()).toBe(1385);
    mockedAxios.get.mockRejectedValueOnce(new Error('down'));
    expect(await multiArbPriceSource.getKrwPerUsdt()).toBeNull();
  });
});
