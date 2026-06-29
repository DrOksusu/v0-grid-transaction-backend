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
