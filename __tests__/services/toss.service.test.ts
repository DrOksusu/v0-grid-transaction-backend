import { TossService, TossApiError, TossCredentials } from '../../src/services/toss.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// envelope helper
const envelope = (result: unknown) => ({ data: { result } });
const errEnvelope = (
  status: number,
  code: string,
  message = 'err',
  requestId = 'req-1',
  data?: unknown,
) => {
  const err: any = new Error(message);
  err.isAxiosError = true;
  err.response = {
    status,
    data: { error: { code, message, requestId, data } },
    headers: {},
  };
  return err;
};

const cred: TossCredentials = {
  clientId: 'cid',
  clientSecret: 'csecret',
  accountSeq: '1',
};

describe('TossService.getAccessToken', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
  });

  it('OAuth Client Credentials Grant로 토큰 발급', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { access_token: 'tok_abc', token_type: 'Bearer', expires_in: 3600 },
    });
    const token = await service.getAccessToken('cid', 'csecret');
    expect(token).toBe('tok_abc');
    const [url, body, cfg] = mockedAxios.post.mock.calls[0];
    expect(String(url)).toContain('/oauth2/token');
    expect(String(body)).toContain('grant_type=client_credentials');
    expect(String(body)).toContain('client_id=cid');
    expect(String(body)).toContain('client_secret=csecret');
    expect(cfg?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('같은 client_id 두 번 호출 시 캐시된 토큰 반환 (API 1회만)', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { access_token: 'tok_cached', expires_in: 3600 },
    });
    const t1 = await service.getAccessToken('cid', 'csecret');
    const t2 = await service.getAccessToken('cid', 'csecret');
    expect(t1).toBe(t2);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});

describe('TossService — envelope unwrap + endpoint 경로', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
    // getAccessToken → 캐시된 토큰 반환 흉내 (매 테스트 초기화)
    mockedAxios.post.mockResolvedValue({
      data: { access_token: 'tok_1', expires_in: 3600 },
    });
  });

  it('getPrices: GET /api/v1/prices, symbols CSV, result 배열 반환', async () => {
    mockedAxios.request.mockResolvedValueOnce(
      envelope([{ symbol: '005930', lastPrice: '70100', currency: 'KRW' }]),
    );
    const prices = await service.getPrices(cred, ['005930', '000660']);
    expect(prices).toEqual([{ symbol: '005930', lastPrice: '70100', currency: 'KRW' }]);
    const cfg = mockedAxios.request.mock.calls[0][0];
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toBe('/api/v1/prices');
    expect(cfg.params).toEqual({ symbols: '005930,000660' });
    // 헤더에 Bearer 있고 X-Tossinvest-Account는 없음 (public endpoint)
    expect(cfg.headers?.Authorization).toBe('Bearer tok_1');
    expect(cfg.headers?.['X-Tossinvest-Account']).toBeUndefined();
  });

  it('getStocks: GET /api/v1/stocks 로 심볼별 정보', async () => {
    mockedAxios.request.mockResolvedValueOnce(
      envelope([
        {
          symbol: '005930',
          name: '삼성전자',
          englishName: 'Samsung Electronics',
          isinCode: 'KR7005930003',
          market: 'KOSPI',
          securityType: 'STOCK',
          isCommonShare: true,
          status: 'ACTIVE',
          currency: 'KRW',
          sharesOutstanding: '5969782550',
        },
      ]),
    );
    const list = await service.getStocks(cred, ['005930']);
    expect(list[0].name).toBe('삼성전자');
    expect(list[0].status).toBe('ACTIVE');
    expect(mockedAxios.request.mock.calls[0][0].url).toBe('/api/v1/stocks');
  });

  it('getMarketCalendarKR: GET /api/v1/market-calendar/KR (date 옵션)', async () => {
    mockedAxios.request.mockResolvedValueOnce(
      envelope({
        today: { date: '2026-07-01', integrated: { regularMarket: {} } },
        previousBusinessDay: { date: '2026-06-30', integrated: null },
        nextBusinessDay: { date: '2026-07-02', integrated: null },
      }),
    );
    const cal = await service.getMarketCalendarKR(cred, '2026-07-01');
    expect(cal.today.date).toBe('2026-07-01');
    const cfg = mockedAxios.request.mock.calls[0][0];
    expect(cfg.url).toBe('/api/v1/market-calendar/KR');
    expect(cfg.params).toEqual({ date: '2026-07-01' });
  });

  it('getAccounts: 계좌 목록 반환', async () => {
    mockedAxios.request.mockResolvedValueOnce(
      envelope([{ accountNo: '123-456', accountSeq: 1, accountType: 'BROKERAGE' }]),
    );
    const list = await service.getAccounts({ clientId: 'cid', clientSecret: 'csecret' });
    expect(list[0].accountSeq).toBe(1);
    expect(mockedAxios.request.mock.calls[0][0].url).toBe('/api/v1/accounts');
  });

  it('getHoldings: X-Tossinvest-Account 헤더 포함', async () => {
    mockedAxios.request.mockResolvedValueOnce(
      envelope({ totalPurchaseAmount: { krw: '0' }, items: [] }),
    );
    await service.getHoldings(cred);
    const cfg = mockedAxios.request.mock.calls[0][0];
    expect(cfg.headers?.['X-Tossinvest-Account']).toBe('1');
  });

  it('getBuyingPower: KRW query 기본값', async () => {
    mockedAxios.request.mockResolvedValueOnce(
      envelope({ currency: 'KRW', cashBuyingPower: '1000000' }),
    );
    const bp = await service.getBuyingPower(cred);
    expect(bp.cashBuyingPower).toBe('1000000');
    expect(mockedAxios.request.mock.calls[0][0].params).toEqual({ currency: 'KRW' });
  });
});

describe('TossService.placeOrder', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
    mockedAxios.post.mockResolvedValue({
      data: { access_token: 'tok_1', expires_in: 3600 },
    });
  });

  it('LIMIT 주문: clientOrderId 자동 생성 + decimal string 전달', async () => {
    mockedAxios.request.mockResolvedValueOnce(
      envelope({ orderId: 'ord_1', clientOrderId: 'client_1' }),
    );
    const result = await service.placeOrder(cred, {
      symbol: '005930',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: '10',
      price: '70100',
    });
    expect(result.orderId).toBe('ord_1');
    // 서비스가 발행한 clientOrderId가 반환값에 실림
    expect(typeof result.clientOrderId).toBe('string');
    expect(result.clientOrderId.length).toBeGreaterThan(10);
    const cfg = mockedAxios.request.mock.calls[0][0];
    expect(cfg.method).toBe('POST');
    expect(cfg.url).toBe('/api/v1/orders');
    const body = cfg.data as Record<string, unknown>;
    expect(body.symbol).toBe('005930');
    expect(body.side).toBe('BUY');
    expect(body.orderType).toBe('LIMIT');
    expect(body.quantity).toBe('10');
    expect(body.price).toBe('70100');
    expect(body.clientOrderId).toBeDefined();
    // 헤더에 X-Tossinvest-Account 포함
    expect(cfg.headers?.['X-Tossinvest-Account']).toBe('1');
  });

  it('LIMIT 주문에 price 누락 시 즉시 에러 (네트워크 호출 없음)', async () => {
    await expect(
      service.placeOrder(cred, {
        symbol: '005930',
        side: 'BUY',
        orderType: 'LIMIT',
        quantity: '10',
      }),
    ).rejects.toBeInstanceOf(TossApiError);
    expect(mockedAxios.request).not.toHaveBeenCalled();
  });

  it('사용자가 전달한 clientOrderId 를 그대로 사용', async () => {
    mockedAxios.request.mockResolvedValueOnce(envelope({ orderId: 'ord_2' }));
    const result = await service.placeOrder(cred, {
      symbol: '005930',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: '1',
      price: '70000',
      clientOrderId: 'user-provided-uuid',
    });
    expect(result.clientOrderId).toBe('user-provided-uuid');
    const body = mockedAxios.request.mock.calls[0][0].data as Record<string, unknown>;
    expect(body.clientOrderId).toBe('user-provided-uuid');
  });
});

describe('TossService.cancelOrder', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
    mockedAxios.post.mockResolvedValue({
      data: { access_token: 'tok_1', expires_in: 3600 },
    });
  });

  it('POST /api/v1/orders/{orderId}/cancel + body {}', async () => {
    mockedAxios.request.mockResolvedValueOnce(envelope({ orderId: 'ord_x' }));
    const r = await service.cancelOrder(cred, 'ord_x');
    expect(r.orderId).toBe('ord_x');
    const cfg = mockedAxios.request.mock.calls[0][0];
    expect(cfg.method).toBe('POST');
    expect(cfg.url).toBe('/api/v1/orders/ord_x/cancel');
    expect(cfg.data).toEqual({});
  });
});

describe('TossService — 에러 envelope 파싱', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
    mockedAxios.post.mockResolvedValue({
      data: { access_token: 'tok_1', expires_in: 3600 },
    });
  });

  it('공식 에러 code 를 TossApiError.code 로 노출', async () => {
    mockedAxios.request.mockRejectedValueOnce(errEnvelope(422, 'insufficient-buying-power', '잔액 부족'));
    try {
      await service.getPrices(cred, ['005930']);
      fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TossApiError);
      const err = e as TossApiError;
      expect(err.code).toBe('insufficient-buying-power');
      expect(err.httpStatus).toBe(422);
      expect(err.message).toBe('잔액 부족');
      expect(err.requestId).toBe('req-1');
    }
  });

  it('expired-token 시 캐시 무효화 후 1회 재시도', async () => {
    // 첫 호출은 expired-token, 두번째는 성공. axios.post는 새 토큰 발급용.
    mockedAxios.request
      .mockRejectedValueOnce(errEnvelope(401, 'expired-token'))
      .mockResolvedValueOnce(envelope([{ symbol: '005930', lastPrice: '70000', currency: 'KRW' }]));
    // 재발급된 토큰
    mockedAxios.post.mockResolvedValueOnce({
      data: { access_token: 'tok_new', expires_in: 3600 },
    });
    const prices = await service.getPrices(cred, ['005930']);
    expect(prices[0].symbol).toBe('005930');
    // request는 2번 (원 호출 + 재시도) 호출됨
    expect(mockedAxios.request).toHaveBeenCalledTimes(2);
  });

  it('네트워크 실패 시 network-error code로 fallback', async () => {
    const err: any = new Error('ENOTFOUND');
    err.isAxiosError = true;
    err.response = undefined;
    mockedAxios.request.mockRejectedValueOnce(err);
    try {
      await service.getPrices(cred, ['005930']);
      fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TossApiError);
      expect((e as TossApiError).code).toBe('network-error');
    }
  });
});
