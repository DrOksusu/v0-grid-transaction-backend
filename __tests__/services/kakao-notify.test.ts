// 카카오 API 실패 시 던지는 오류에 client_secret·토큰이 남지 않는지 검증 (2026-10-27 로그 노출 대응)
import axios, { AxiosError, AxiosHeaders } from 'axios';
import prisma from '../../__mocks__/database';
import { kakaoNotifyService, toSafeKakaoError } from '../../src/services/kakao-notify.service';

const db = prisma as any;
const SECRET = 'client-secret-should-not-leak';
const REFRESH = 'refresh-token-should-not-leak';

function kakaoAxiosError(): AxiosError {
  const config = {
    url: 'https://kauth.kakao.com/oauth/token',
    data: `grant_type=refresh_token&refresh_token=${REFRESH}&client_secret=${SECRET}`,
    headers: new AxiosHeaders({ Authorization: `Bearer ${REFRESH}` }),
  };
  return new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', config as any, {}, {
    status: 401,
    statusText: 'Unauthorized',
    headers: {},
    config: config as any,
    data: { error: 'invalid_grant', error_description: 'expired_or_invalid_refresh_token', error_code: 'KOE322' },
  });
}

function leaks(err: unknown): boolean {
  const e = err as Error;
  const dump = [e.message, e.stack, JSON.stringify(e), Object.values(e).map(String).join(' ')].join('\n');
  return dump.includes(SECRET) || dump.includes(REFRESH);
}

describe('toSafeKakaoError', () => {
  it('카카오 응답 코드·설명만 남기고 요청 본문·헤더는 버린다', () => {
    const err = toSafeKakaoError(kakaoAxiosError(), '토큰 갱신');
    expect(err.message).toBe('카카오 토큰 갱신 실패: 401 KOE322 invalid_grant expired_or_invalid_refresh_token');
    expect(axios.isAxiosError(err)).toBe(false);
    expect(leaks(err)).toBe(false);
  });

  it('axios 오류가 아니면 그대로 돌려준다', () => {
    const original = new Error('카카오 토큰 없음');
    expect(toSafeKakaoError(original, '메시지 발송')).toBe(original);
  });
});

describe('kakaoNotifyService.sendToMe', () => {
  afterEach(() => jest.restoreAllMocks());

  it('토큰 갱신이 실패해도 던진 오류에 비밀값이 없다', async () => {
    db.kakaoToken = {
      findUnique: jest.fn().mockResolvedValue({ accessToken: 'old', refreshToken: REFRESH, expiresAt: new Date(0) }),
      upsert: jest.fn(),
    };
    jest.spyOn(axios, 'post').mockRejectedValue(kakaoAxiosError());

    const err = await kakaoNotifyService.sendToMe('test').catch((e) => e);
    expect(err.message).toContain('KOE322');
    expect(leaks(err)).toBe(false);
    expect(db.kakaoToken.upsert).not.toHaveBeenCalled();
  });
});
