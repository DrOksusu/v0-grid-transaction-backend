// src/services/toss.service.ts
import axios from 'axios';

// 토스증권 Open API base URL (env로 override 가능)
const TOSS_BASE_URL = process.env.TOSS_API_URL || 'https://wts-openapi.tossinvest.com';

// 토큰 만료 5분 전 자동 갱신
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface TokenCacheEntry {
  token: string;
  expiresAt: number; // epoch ms
}

export class TossService {
  // 사용자별 토큰 캐시 (key: clientId)
  private tokenCache: Map<string, TokenCacheEntry> = new Map();

  /**
   * OAuth 2.0 Client Credentials Grant로 access token 발급
   * - 캐시된 토큰이 만료 5분 전이면 그대로 반환
   * - 그렇지 않으면 토스 API 호출 후 캐시에 저장
   */
  async getAccessToken(clientId: string, clientSecret: string): Promise<string> {
    const cached = this.tokenCache.get(clientId);
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
      return cached.token;
    }

    try {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString();

      const res = await axios.post(
        `${TOSS_BASE_URL}/oauth2/token`,
        body,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10_000,
        },
      );

      const { access_token, expires_in } = res.data;
      this.tokenCache.set(clientId, {
        token: access_token,
        expiresAt: Date.now() + (expires_in * 1000),
      });
      return access_token;
    } catch (e: any) {
      const status = e?.response?.status;
      const err = e?.response?.data?.error || e?.message || 'unknown';
      throw new Error(`OAuth 토큰 발급 실패 (HTTP ${status ?? '?'}): ${err}`);
    }
  }

  /**
   * 테스트 전용 — production 호출 금지
   */
  _resetCacheForTests(): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('_resetCacheForTests is test-only');
    }
    this.tokenCache.clear();
  }
}

export const tossService = new TossService();
