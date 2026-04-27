// Upbit placeLimitOrder (post_only) 테스트
// note: Upbit POST /v1/orders — post_only는 time_in_force 필드의 값(ioc/fok/post_only)임.
//       별도 boolean 필드 아님. https://docs.upbit.com/kr/reference/new-order (2026-04-27 검증)

import axios from 'axios';

// 모듈 레벨 axios.create()를 mocking 하기 위해 axios 자체를 mock
jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockPost = jest.fn();
const mockGet = jest.fn();
const mockDelete = jest.fn();

// UpbitService를 require하기 전에 axios.create를 가로채야 함
(mockedAxios.create as jest.Mock) = jest.fn().mockReturnValue({
  post: mockPost,
  get: mockGet,
  delete: mockDelete,
});

// axios.create가 mock 된 후 import
import { UpbitService } from '../../src/services/upbit.service';

describe('UpbitService.placeLimitOrder', () => {
  let svc: UpbitService;

  beforeEach(() => {
    jest.clearAllMocks();
    // beforeEach마다 mock을 다시 세팅
    (mockedAxios.create as jest.Mock).mockReturnValue({
      post: mockPost,
      get: mockGet,
      delete: mockDelete,
    });
    svc = new UpbitService({
      accessKey: 'test-access-key',
      secretKey: 'test-secret-key',
    });
  });

  it('postOnly=true → POST body에 ord_type=limit, price, volume, time_in_force=post_only 포함', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        uuid: 'test-uuid-1',
        side: 'bid',
        ord_type: 'limit',
        state: 'wait',
        market: 'KRW-USDT',
        created_at: '2026-04-27T00:00:00+09:00',
      },
    });

    const result = await svc.placeLimitOrder('KRW-USDT', 'bid', {
      price: '1450',
      volume: '10',
      postOnly: true,
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [, body] = mockPost.mock.calls[0];
    expect(body).toMatchObject({
      market: 'KRW-USDT',
      side: 'bid',
      ord_type: 'limit',
      price: '1450',
      volume: '10',
      time_in_force: 'post_only',
    });
    expect(result.uuid).toBe('test-uuid-1');
  });

  it('postOnly=false (기본/생략) → POST body에 ord_type=limit 포함, time_in_force 필드 없음', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        uuid: 'test-uuid-2',
        side: 'bid',
        ord_type: 'limit',
        state: 'wait',
        market: 'KRW-USDT',
        created_at: '2026-04-27T00:00:00+09:00',
      },
    });

    await svc.placeLimitOrder('KRW-USDT', 'bid', {
      price: '1450',
      volume: '10',
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [, body] = mockPost.mock.calls[0];
    expect(body).toMatchObject({
      market: 'KRW-USDT',
      side: 'bid',
      ord_type: 'limit',
      price: '1450',
      volume: '10',
    });
    expect(body.time_in_force).toBeUndefined();
    expect(body.post_only).toBeUndefined();
  });

  it('side=bid + price 없음(volume만 있음) → /price/ 메시지로 throw', async () => {
    await expect(
      svc.placeLimitOrder('KRW-USDT', 'bid', { volume: '10', postOnly: true })
    ).rejects.toThrow(/price/);
  });

  it('side=ask + volume 없음(price만 있음) → /volume/ 메시지로 throw', async () => {
    await expect(
      svc.placeLimitOrder('KRW-USDT', 'ask', { price: '1450', postOnly: true })
    ).rejects.toThrow(/volume/);
  });

  it('side=bid + volume 없음(price만 있음) → /volume/ 메시지로 throw (limit는 둘 다 필수)', async () => {
    await expect(
      svc.placeLimitOrder('KRW-USDT', 'bid', { price: '1450', postOnly: true })
    ).rejects.toThrow(/volume/);
  });

  it('side=ask + price 없음(volume만 있음) → /price/ 메시지로 throw (limit는 둘 다 필수)', async () => {
    await expect(
      svc.placeLimitOrder('KRW-USDT', 'ask', { volume: '10', postOnly: true })
    ).rejects.toThrow(/price/);
  });
});
