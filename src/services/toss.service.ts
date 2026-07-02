// 토스증권 Open API 클라이언트
// 공식 spec: https://openapi.tossinvest.com/openapi-docs/latest/openapi.json (로컬 캐시: docs/toss-openapi/openapi.json)
// 자세한 사양: docs/superpowers/specs/2026-06-29-korean-stock-grid-design.md § 4

import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { randomUUID } from 'crypto';

// 기본 base URL — env로 override 가능하지만 sandbox 없음 (§ 4 참조)
const TOSS_BASE_URL = process.env.TOSS_API_URL || 'https://openapi.tossinvest.com';

// 토큰 만료 5분 전 자동 갱신
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// 429/5xx backoff 정책
const MAX_RETRY_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;

// 자격증명. accountSeq는 spec 상 int64이지만 우리는 numeric-only string으로 보관 → 헤더로 그대로 전달
export interface TossCredentials {
  clientId: string;
  clientSecret: string;
  accountSeq?: string;
}

// 공식 에러 envelope 파싱 결과
export class TossApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number,
    public requestId?: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'TossApiError';
  }
}

// ===== Endpoint 응답 타입 (envelope unwrap 후) =====

export interface TossPrice {
  symbol: string;
  lastPrice: string; // decimal string
  currency: 'KRW' | 'USD';
  timestamp?: string | null;
}

export interface TossStockInfo {
  symbol: string;
  name: string;
  englishName: string;
  isinCode: string;
  market: 'KOSPI' | 'KOSDAQ' | 'NYSE' | 'NASDAQ' | 'AMEX' | 'KR_ETC' | 'US_ETC';
  securityType: string;
  isCommonShare: boolean;
  status: 'SCHEDULED' | 'ACTIVE' | 'DELISTED';
  currency: 'KRW' | 'USD';
  listDate?: string | null;
  delistDate?: string | null;
  sharesOutstanding: string;
  leverageFactor?: string | null;
}

export interface TossAccount {
  accountNo: string;
  accountSeq: number;
  accountType: 'BROKERAGE' | 'OVERSEAS_DERIVATIVES' | 'PENSION_SAVINGS' | 'RESHORING_INVESTMENT';
}

export interface TossHoldingItem {
  symbol: string;
  name: string;
  marketCountry: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  quantity: string;
  lastPrice: string;
  averagePurchasePrice: string;
}

export interface TossHoldings {
  totalPurchaseAmount: { krw: string; usd?: string | null };
  items: TossHoldingItem[];
  // 그 외 marketValue, profitLoss, dailyProfitLoss 는 v1 스코프 외
}

export interface TossBuyingPower {
  currency: 'KRW' | 'USD';
  cashBuyingPower: string; // decimal string
}

export interface TossMarketSession {
  openAt?: string; // ISO datetime
  closeAt?: string;
}
export interface TossMarketDay {
  date: string; // YYYY-MM-DD
  integrated: null | {
    preMarket?: unknown;
    regularMarket?: unknown;
    afterMarket?: unknown;
  };
}
export interface TossMarketCalendarKR {
  today: TossMarketDay;
  previousBusinessDay: TossMarketDay;
  nextBusinessDay: TossMarketDay;
}

export type TossOrderSide = 'BUY' | 'SELL';
export type TossOrderType = 'LIMIT' | 'MARKET';
export type TossTimeInForce = 'DAY' | 'CLS';

export interface TossPlaceOrderParams {
  symbol: string;
  side: TossOrderSide;
  orderType: TossOrderType;
  quantity: string; // decimal string
  price?: string; // decimal string (LIMIT 필수)
  timeInForce?: TossTimeInForce;
  clientOrderId?: string; // 미지정 시 자동 생성
  confirmHighValueOrder?: boolean;
}

export interface TossPlaceOrderResult {
  orderId: string;
  clientOrderId?: string | null;
}

export interface TossCancelOrderResult {
  orderId: string;
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

export class TossService {
  private tokenCache: Map<string, TokenCacheEntry> = new Map();

  // ---------- OAuth ----------

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
          timeout: REQUEST_TIMEOUT_MS,
        },
      );
      const { access_token, expires_in } = res.data;
      this.tokenCache.set(clientId, {
        token: access_token,
        expiresAt: Date.now() + expires_in * 1000,
      });
      return access_token;
    } catch (e) {
      throw this.wrapAxiosError(e as AxiosError, 'oauth2/token');
    }
  }

  private async authHeaders(
    cred: TossCredentials,
    requireAccount: boolean,
  ): Promise<Record<string, string>> {
    const token = await this.getAccessToken(cred.clientId, cred.clientSecret);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (requireAccount) {
      if (!cred.accountSeq) {
        throw new TossApiError(
          'account-header-required',
          'accountSeq가 credentials에 저장되어 있지 않습니다',
          400,
        );
      }
      headers['X-Tossinvest-Account'] = cred.accountSeq;
    }
    return headers;
  }

  // ---------- 공통 호출 래퍼: envelope unwrap + 429/5xx backoff + 에러 파싱 ----------

  private async call<T>(
    cred: TossCredentials,
    config: AxiosRequestConfig,
    requireAccount: boolean,
    attempt = 0,
  ): Promise<T> {
    let res: AxiosResponse;
    try {
      const headers = await this.authHeaders(cred, requireAccount);
      res = await axios.request({
        baseURL: TOSS_BASE_URL,
        timeout: REQUEST_TIMEOUT_MS,
        ...config,
        headers: { ...headers, ...(config.headers || {}) },
      });
    } catch (e) {
      const err = this.wrapAxiosError(e as AxiosError, String(config.url || ''));

      // 401 expired-token → 캐시 무효화 + 1회 재시도
      if (err.code === 'expired-token' && attempt === 0) {
        this.tokenCache.delete(cred.clientId);
        return this.call(cred, config, requireAccount, attempt + 1);
      }

      // 429 → Retry-After 대기 후 재시도
      if (err.httpStatus === 429 && attempt < MAX_RETRY_ATTEMPTS) {
        const retryAfterSec = this.retryAfterFrom(e as AxiosError);
        const jitter = Math.random() * 0.4 - 0.2; // ±20%
        const waitMs = Math.max(
          (retryAfterSec ?? Math.pow(2, attempt)) * 1000 * (1 + jitter),
          BASE_BACKOFF_MS,
        );
        await this.sleep(waitMs);
        return this.call(cred, config, requireAccount, attempt + 1);
      }

      // 5xx → 지수 backoff 재시도
      if (err.httpStatus >= 500 && attempt < MAX_RETRY_ATTEMPTS) {
        const waitMs = BASE_BACKOFF_MS * Math.pow(2, attempt) * (1 + (Math.random() * 0.4 - 0.2));
        await this.sleep(waitMs);
        return this.call(cred, config, requireAccount, attempt + 1);
      }

      throw err;
    }

    // envelope: { result: <payload> }
    const body = res.data;
    if (body && typeof body === 'object' && 'result' in body) {
      return body.result as T;
    }
    // envelope 없이 오는 예외 케이스 (있을 리 없지만 방어)
    return body as T;
  }

  private retryAfterFrom(err: AxiosError): number | null {
    const raw = err.response?.headers?.['retry-after'];
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 공식 에러 envelope { error: { code, message, requestId, data } } 파싱
  private wrapAxiosError(err: AxiosError, context: string): TossApiError {
    const status = err.response?.status ?? 0;
    const respData = err.response?.data as
      | { error?: { code?: string; message?: string; requestId?: string; data?: unknown } }
      | undefined;
    const errObj = respData?.error;
    if (errObj?.code) {
      return new TossApiError(
        errObj.code,
        errObj.message || err.message,
        status,
        errObj.requestId,
        errObj.data,
      );
    }
    // 서버 응답 없거나 envelope 없음
    const fallbackCode =
      status === 0 ? 'network-error' :
      status >= 500 ? 'internal-error' :
      'unknown-error';
    return new TossApiError(
      fallbackCode,
      `${context} 실패 (HTTP ${status}): ${err.message}`,
      status,
    );
  }

  // ---------- Market Data ----------

  async getPrices(cred: TossCredentials, symbols: string[]): Promise<TossPrice[]> {
    if (symbols.length === 0) return [];
    return this.call<TossPrice[]>(
      cred,
      { method: 'GET', url: '/api/v1/prices', params: { symbols: symbols.join(',') } },
      false,
    );
  }

  // ---------- Stock Info ----------

  async getStocks(cred: TossCredentials, symbols: string[]): Promise<TossStockInfo[]> {
    if (symbols.length === 0) return [];
    return this.call<TossStockInfo[]>(
      cred,
      { method: 'GET', url: '/api/v1/stocks', params: { symbols: symbols.join(',') } },
      false,
    );
  }

  // ---------- Market Info ----------

  async getMarketCalendarKR(
    cred: TossCredentials,
    date?: string,
  ): Promise<TossMarketCalendarKR> {
    return this.call<TossMarketCalendarKR>(
      cred,
      { method: 'GET', url: '/api/v1/market-calendar/KR', params: date ? { date } : {} },
      false,
    );
  }

  // ---------- Account ----------

  async getAccounts(cred: TossCredentials): Promise<TossAccount[]> {
    return this.call<TossAccount[]>(
      cred,
      { method: 'GET', url: '/api/v1/accounts' },
      false,
    );
  }

  // ---------- Asset ----------

  async getHoldings(cred: TossCredentials, symbol?: string): Promise<TossHoldings> {
    return this.call<TossHoldings>(
      cred,
      { method: 'GET', url: '/api/v1/holdings', params: symbol ? { symbol } : {} },
      true,
    );
  }

  // ---------- Order Info ----------

  async getBuyingPower(
    cred: TossCredentials,
    currency: 'KRW' | 'USD' = 'KRW',
  ): Promise<TossBuyingPower> {
    return this.call<TossBuyingPower>(
      cred,
      { method: 'GET', url: '/api/v1/buying-power', params: { currency } },
      true,
    );
  }

  // ---------- Order ----------

  async placeOrder(
    cred: TossCredentials,
    params: TossPlaceOrderParams,
  ): Promise<TossPlaceOrderResult & { clientOrderId: string }> {
    const clientOrderId = params.clientOrderId || randomUUID();
    const body: Record<string, unknown> = {
      clientOrderId,
      symbol: params.symbol,
      side: params.side,
      orderType: params.orderType,
      quantity: params.quantity,
    };
    if (params.orderType === 'LIMIT') {
      if (!params.price) {
        throw new TossApiError('invalid-request', 'LIMIT 주문에 price 필수', 400);
      }
      body.price = params.price;
      if (params.timeInForce) body.timeInForce = params.timeInForce;
    }
    if (params.confirmHighValueOrder) body.confirmHighValueOrder = true;

    const result = await this.call<TossPlaceOrderResult>(
      cred,
      { method: 'POST', url: '/api/v1/orders', data: body },
      true,
    );
    return { ...result, clientOrderId };
  }

  async cancelOrder(
    cred: TossCredentials,
    orderId: string,
  ): Promise<TossCancelOrderResult> {
    return this.call<TossCancelOrderResult>(
      cred,
      { method: 'POST', url: `/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, data: {} },
      true,
    );
  }

  // ---------- 테스트 지원 ----------

  _resetCacheForTests(): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('_resetCacheForTests is test-only');
    }
    this.tokenCache.clear();
  }
}

export const tossService = new TossService();
