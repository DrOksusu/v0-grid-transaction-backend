// Task 4: BithumbClient unit tests
// HMAC 서명 결정성 + base64 형식 + 입력 변경 시 서명 변경 검증 + exchangeName 라이터럴 확인.
// Task 5: placeMarketOrder + getOrder 매핑 검증 (axios 모킹).
// 통합 테스트(실제 Bithumb API 호출)는 추후 task 에서 진행.

import axios from 'axios';
import { BithumbClient, signRequest } from '../../../src/services/exchange/bithumb-client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('BithumbClient — HMAC signing', () => {
  it('서명 결과가 결정적이다 (동일 입력 = 동일 서명)', () => {
    const sig1 = signRequest('/info/balance', 'currency=USDE', '1700000000000', 'TEST_SECRET');
    const sig2 = signRequest('/info/balance', 'currency=USDE', '1700000000000', 'TEST_SECRET');
    expect(sig1).toBe(sig2);
  });

  it('서명 결과는 base64 형식이다', () => {
    const sig = signRequest('/info/balance', 'currency=USDE', '1700000000000', 'TEST_SECRET');
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('다른 입력은 다른 서명을 만든다', () => {
    const sig1 = signRequest('/info/balance', 'currency=USDE', '1700000000000', 'TEST_SECRET');
    const sig2 = signRequest('/info/balance', 'currency=USDT', '1700000000000', 'TEST_SECRET');
    expect(sig1).not.toBe(sig2);
  });
});

describe('BithumbClient — exchangeName', () => {
  it('exchangeName 이 bithumb 이다', () => {
    const c = new BithumbClient({ accessKey: 'k', secretKey: 's' });
    expect(c.exchangeName).toBe('bithumb');
  });
});

describe('BithumbClient — placeMarketOrder', () => {
  beforeEach(() => {
    mockedAxios.post.mockClear();
  });

  it('성공 응답을 PlacedOrder 로 매핑한다', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        status: '0000',
        order_id: 'C-1234567890',
        data: { order_id: 'C-1234567890' },
      },
    });
    const c = new BithumbClient({ accessKey: 'k', secretKey: 's' });
    const result = await c.placeMarketOrder('buy', 'USDE', 10);
    expect(result.orderId).toBe('C-1234567890');
    expect(result.status).toBe('pending'); // 빗썸 시장가 주문은 즉시 fill 안 보장
  });

  it('Bithumb 5500 (잔고부족) 시 throw', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { status: '5500', message: '잔고가 부족합니다' },
    });
    const c = new BithumbClient({ accessKey: 'k', secretKey: 's' });
    await expect(c.placeMarketOrder('buy', 'USDE', 10)).rejects.toThrow(/5500/);
  });
});

describe('BithumbClient — getOrder', () => {
  beforeEach(() => {
    mockedAxios.post.mockClear();
  });

  it('completed 응답을 filled 로 매핑한다', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        status: '0000',
        data: {
          order_status: 'Completed',
          order_qty: '10',
          order_price: '1500',
          fee: '7.5',
        },
      },
    });
    const c = new BithumbClient({ accessKey: 'k', secretKey: 's' });
    const result = await c.getOrder('C-1234567890');
    expect(result.status).toBe('filled');
    expect(result.filledQty).toBe(10);
    expect(result.avgFillPrice).toBe(1500);
    expect(result.totalFeeKrw).toBe(7.5);
  });
});
