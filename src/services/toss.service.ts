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
   * 인증 헤더 생성 (Bearer + 선택적 X-Tossinvest-Account)
   * 모든 API 호출 메서드가 공유.
   */
  private async authHeaders(
    clientId: string,
    clientSecret: string,
    accountSeq?: string,
  ): Promise<Record<string, string>> {
    const token = await this.getAccessToken(clientId, clientSecret);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (accountSeq) headers['X-Tossinvest-Account'] = accountSeq;
    return headers;
  }

  /**
   * 종목 시세 조회 (단일 종목)
   * endpoint path는 토스 공식 문서로 보정 필요 (현재는 추정값)
   */
  async getQuote(
    clientId: string,
    clientSecret: string,
    code: string,
  ): Promise<{ code: string; price: number; timestamp: string }> {
    const headers = await this.authHeaders(clientId, clientSecret);
    const res = await axios.get(`${TOSS_BASE_URL}/v1/market/quote/${code}`, { headers, timeout: 10_000 });
    return res.data;
  }

  /**
   * 계좌 잔액 + 보유 주식 조회
   */
  async getAccountBalance(
    clientId: string,
    clientSecret: string,
    accountSeq: string,
  ): Promise<{ krwBalance: number; holdings: Array<{ code: string; quantity: number; avgPrice: number }> }> {
    const headers = await this.authHeaders(clientId, clientSecret, accountSeq);
    const res = await axios.get(`${TOSS_BASE_URL}/v1/account/balance`, { headers, timeout: 10_000 });
    return res.data;
  }

  /**
   * 주문 생성 (매수/매도, 지정가/시장가)
   */
  async placeOrder(
    clientId: string,
    clientSecret: string,
    accountSeq: string,
    order: { code: string; side: 'BUY' | 'SELL'; quantity: number; price: number; orderType: 'LIMIT' | 'MARKET' },
  ): Promise<{ orderId: string; status: string }> {
    const headers = await this.authHeaders(clientId, clientSecret, accountSeq);
    const res = await axios.post(`${TOSS_BASE_URL}/v1/order`, order, { headers, timeout: 10_000 });
    return res.data;
  }

  /**
   * 주문 취소
   */
  async cancelOrder(
    clientId: string,
    clientSecret: string,
    accountSeq: string,
    orderId: string,
  ): Promise<{ orderId: string; status: string }> {
    const headers = await this.authHeaders(clientId, clientSecret, accountSeq);
    const res = await axios.delete(`${TOSS_BASE_URL}/v1/order/${orderId}`, { headers, timeout: 10_000 });
    return res.data;
  }

  /**
   * 전체 종목 마스터 조회 (KOSPI + KOSDAQ)
   * 일일 sync 에이전트가 사용
   */
  async getSymbolMaster(
    clientId: string,
    clientSecret: string,
  ): Promise<Array<{ code: string; name: string; market: string }>> {
    const headers = await this.authHeaders(clientId, clientSecret);
    const res = await axios.get(`${TOSS_BASE_URL}/v1/market/symbols`, { headers, timeout: 30_000 });
    return res.data.symbols;
  }

  /**
   * 연도 단위 휴장일 캘린더 조회
   */
  async getMarketCalendar(
    clientId: string,
    clientSecret: string,
    year: number,
  ): Promise<{ holidays: Array<{ date: string; reason: string }> }> {
    const headers = await this.authHeaders(clientId, clientSecret);
    const res = await axios.get(`${TOSS_BASE_URL}/v1/market/calendar?year=${year}`, { headers, timeout: 10_000 });
    return res.data;
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
