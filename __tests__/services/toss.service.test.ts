import { TossService } from '../../src/services/toss.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

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
    const token = await service.getAccessToken('client_id_x', 'client_secret_y');
    expect(token).toBe('tok_abc');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/oauth2/token'),
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      }),
    );
    // 호출 body가 URL-encoded grant_type=client_credentials 포함
    const callArgs = mockedAxios.post.mock.calls[0];
    expect(callArgs[1]).toContain('grant_type=client_credentials');
    expect(callArgs[1]).toContain('client_id=client_id_x');
    expect(callArgs[1]).toContain('client_secret=client_secret_y');
  });

  it('같은 client_id 두 번 호출 시 캐시된 토큰 반환 (API 1회만)', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { access_token: 'tok_cached', expires_in: 3600 },
    });
    const t1 = await service.getAccessToken('client_id_x', 'client_secret_y');
    const t2 = await service.getAccessToken('client_id_x', 'client_secret_y');
    expect(t1).toBe(t2);
    expect(t1).toBe('tok_cached');
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('토큰 만료 5분 전 자동 재발급', async () => {
    jest.useFakeTimers();
    mockedAxios.post
      .mockResolvedValueOnce({ data: { access_token: 'tok_old', expires_in: 3600 } })
      .mockResolvedValueOnce({ data: { access_token: 'tok_new', expires_in: 3600 } });
    const t1 = await service.getAccessToken('client_id_x', 'client_secret_y');
    expect(t1).toBe('tok_old');
    // 55분 후 (만료 5분 전)
    jest.advanceTimersByTime(55 * 60 * 1000);
    const t2 = await service.getAccessToken('client_id_x', 'client_secret_y');
    expect(t2).toBe('tok_new');
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('OAuth 응답 에러 시 throw', async () => {
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 401, data: { error: 'invalid_client' } },
      message: 'Request failed',
    });
    await expect(service.getAccessToken('bad_id', 'bad_secret')).rejects.toThrow(/OAuth/);
  });
});

describe('TossService.getQuote', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
  });

  it('시세 조회 (Authorization Bearer 헤더)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.get.mockResolvedValueOnce({ data: { code: '005930', price: 75000, timestamp: '2026-06-29T09:00:00+09:00' } });
    const quote = await service.getQuote('client_id', 'client_secret', '005930');
    expect(quote.price).toBe(75000);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/market/quote/005930'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
  });
});

describe('TossService.getAccountBalance', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
  });

  it('계좌 잔액 조회 (X-Tossinvest-Account 헤더)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.get.mockResolvedValueOnce({ data: { krwBalance: 1000000, holdings: [] } });
    const balance = await service.getAccountBalance('client_id', 'client_secret', 'acc_seq_x');
    expect(balance.krwBalance).toBe(1000000);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Tossinvest-Account': 'acc_seq_x' }) }),
    );
  });
});

describe('TossService.placeOrder', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
  });

  it('매수 주문 (BUY, 지정가)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.post.mockResolvedValueOnce({ data: { orderId: 'ord_001', status: 'pending' } });
    const result = await service.placeOrder('client_id', 'client_secret', 'acc_seq', {
      code: '005930', side: 'BUY', quantity: 1, price: 75000, orderType: 'LIMIT',
    });
    expect(result.orderId).toBe('ord_001');
  });
});

describe('TossService.cancelOrder', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
  });

  it('주문 취소 (DELETE)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.delete.mockResolvedValueOnce({ data: { orderId: 'ord_001', status: 'cancelled' } });
    const result = await service.cancelOrder('client_id', 'client_secret', 'acc_seq', 'ord_001');
    expect(result.status).toBe('cancelled');
  });
});

describe('TossService.getSymbolMaster', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
  });

  it('전체 종목 마스터 조회', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.get.mockResolvedValueOnce({
      data: { symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI' }] },
    });
    const symbols = await service.getSymbolMaster('client_id', 'client_secret');
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols[0].code).toBe('005930');
  });
});

describe('TossService.getMarketCalendar', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
  });

  it('연도 단위 휴장일 조회', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.get.mockResolvedValueOnce({
      data: { holidays: [{ date: '2026-01-01', reason: '신정' }] },
    });
    const calendar = await service.getMarketCalendar('client_id', 'client_secret', 2026);
    expect(calendar.holidays.length).toBeGreaterThan(0);
  });
});
