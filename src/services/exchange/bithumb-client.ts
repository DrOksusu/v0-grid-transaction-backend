// src/services/exchange/bithumb-client.ts
//
// Bithumb REST API v1 클라이언트 (JWT HS256 인증).
//
// 인증 방식: access_key + secret_key 로 JWT HS256 생성 → Authorization: Bearer {jwt}
// JWT Payload: { access_key, nonce: UUID, timestamp: ms_unix, [query_hash, query_hash_alg] }
// query_hash: 파라미터가 있는 요청 시 쿼리스트링/바디를 SHA-512 해시 (hex)
//
// 참조: https://apidocs.bithumb.com/docs/빠른-시작-가이드

import axios from 'axios';
import crypto from 'crypto';
import {
  ExchangeClient, OrderbookTop, PlacedOrder, BalanceEntry, OrderStatus,
} from './exchange-client';

const BITHUMB_API_URL = 'https://api.bithumb.com';
const TIMEOUT_MS = 5000;

export interface BithumbCreds {
  accessKey: string;
  secretKey: string;
}

/**
 * Bithumb JWT HS256 토큰 생성.
 * query 파라미터가 있을 때는 SHA-512 query_hash 를 payload 에 추가.
 */
function generateJwt(accessKey: string, secretKey: string, queryString?: string): string {
  const b64url = (input: string) =>
    Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const header = JSON.stringify({ alg: 'HS256', typ: 'JWT' });
  const payloadObj: Record<string, unknown> = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
    timestamp: Date.now(),
  };
  if (queryString) {
    payloadObj.query_hash = crypto.createHash('sha512').update(queryString, 'utf-8').digest('hex');
    payloadObj.query_hash_alg = 'SHA512';
  }

  const data = `${b64url(header)}.${b64url(JSON.stringify(payloadObj))}`;
  const sig = crypto.createHmac('sha256', secretKey).update(data).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${data}.${sig}`;
}

export class BithumbClient implements ExchangeClient {
  exchangeName: 'bithumb' = 'bithumb';

  constructor(private creds: BithumbCreds) {}

  private authHeader(queryString?: string): string {
    return `Bearer ${generateJwt(this.creds.accessKey, this.creds.secretKey, queryString)}`;
  }

  /**
   * Bithumb v1 GET API 호출 (JWT 인증).
   */
  private async apiGet<T = any>(endpoint: string, params?: Record<string, string>): Promise<T> {
    const queryString = params ? new URLSearchParams(params).toString() : undefined;
    const url = `${BITHUMB_API_URL}${endpoint}${queryString ? '?' + queryString : ''}`;
    try {
      const response = await axios.get<T>(url, {
        headers: { Authorization: this.authHeader(queryString) },
        timeout: TIMEOUT_MS,
      });
      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const errName = err?.response?.data?.error?.name ?? err?.response?.data?.status;
      const errMsg = err?.response?.data?.error?.message ?? err?.response?.data?.message;
      throw new Error(`Bithumb GET ${endpoint} 실패 (${status} ${errName}): ${errMsg ?? err.message}`);
    }
  }

  /**
   * Bithumb v1 POST API 호출 (JSON 바디, JWT 인증).
   * query_hash 는 바디 파라미터를 URL-encoded 형식으로 직렬화한 값으로 계산.
   */
  private async apiPost<T = any>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const queryString = new URLSearchParams(
      Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])),
    ).toString();
    try {
      const response = await axios.post<T>(`${BITHUMB_API_URL}${endpoint}`, body, {
        headers: {
          Authorization: this.authHeader(queryString),
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
      });
      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const errName = err?.response?.data?.error?.name ?? err?.response?.data?.status;
      const errMsg = err?.response?.data?.error?.message ?? err?.response?.data?.message;
      throw new Error(`Bithumb POST ${endpoint} 실패 (${status} ${errName}): ${errMsg ?? err.message}`);
    }
  }

  /**
   * Bithumb v1 DELETE API 호출 (JWT 인증).
   * query_hash 는 쿼리스트링으로 계산.
   */
  private async apiDelete<T = any>(endpoint: string, params: Record<string, string>): Promise<T> {
    const queryString = new URLSearchParams(params).toString();
    const url = `${BITHUMB_API_URL}${endpoint}?${queryString}`;
    try {
      const response = await axios.delete<T>(url, {
        headers: { Authorization: this.authHeader(queryString) },
        timeout: TIMEOUT_MS,
      });
      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const errName = err?.response?.data?.error?.name ?? err?.response?.data?.status;
      const errMsg = err?.response?.data?.error?.message ?? err?.response?.data?.message;
      throw new Error(`Bithumb DELETE ${endpoint} 실패 (${status} ${errName}): ${errMsg ?? err.message}`);
    }
  }

  /**
   * 단일 코인 최우선 호가 + 수량 조회. Public API (인증 불필요). 실패 시 null.
   * GET /v1/orderbook?markets=KRW-{symbol}
   */
  async getOrderbookTop(symbol: string): Promise<OrderbookTop | null> {
    try {
      const response = await axios.get(
        `${BITHUMB_API_URL}/v1/orderbook`,
        {
          params: { markets: `KRW-${symbol.toUpperCase()}` },
          timeout: TIMEOUT_MS,
        },
      );
      const data = Array.isArray(response.data) ? response.data[0] : null;
      if (!data) return null;
      const topBid = data.bid_levels?.[0];
      const topAsk = data.ask_levels?.[0];
      if (!topBid || !topAsk) return null;
      return {
        bid: parseFloat(topBid.price),
        ask: parseFloat(topAsk.price),
        bidQty: parseFloat(topBid.size),
        askQty: parseFloat(topAsk.size),
        timestamp: Date.now(),
      };
    } catch (err: any) {
      console.error(`[Bithumb] orderbook ${symbol} 조회 실패:`, err?.response?.status, err.message);
      return null;
    }
  }

  /**
   * 모든 코인 잔고. KEY 는 코인 심볼 (KRW, USDT 등).
   * GET /v1/accounts → [{ currency, balance, locked, ... }]
   */
  async getBalances(): Promise<Record<string, BalanceEntry>> {
    const accounts = await this.apiGet<Array<{ currency: string; balance: string; locked: string }>>('/v1/accounts');
    const out: Record<string, BalanceEntry> = {};
    for (const acc of accounts) {
      out[acc.currency.toUpperCase()] = {
        available: parseFloat(acc.balance ?? '0'),
        locked: parseFloat(acc.locked ?? '0'),
      };
    }
    return out;
  }

  /**
   * 시장가 매수/매도 주문.
   * POST /v1/orders
   * - 매도(ask): ord_type=market, volume=coin_qty
   * - 매수(bid): ord_type=price, price=krw_amount (시장가 매수는 KRW 금액 기준)
   */
  async placeMarketOrder(
    side: 'buy' | 'sell', symbol: string, quantity: number, krwPerUnit?: number,
  ): Promise<PlacedOrder> {
    const market = `KRW-${symbol.toUpperCase()}`;
    const body: Record<string, unknown> = {
      market,
      side: side === 'buy' ? 'bid' : 'ask',
    };

    if (side === 'sell') {
      body.ord_type = 'market';
      body.volume = String(quantity);
    } else {
      const pricePerUnit = krwPerUnit ?? 1500;
      body.ord_type = 'price';
      body.price = String(Math.ceil(quantity * pricePerUnit * 1.02));
    }

    const response = await this.apiPost<{ uuid: string }>('/v1/orders', body);
    return {
      orderId: response.uuid ?? '',
      status: 'pending',
      filledQty: 0,
      avgFillPrice: 0,
      totalFeeKrw: 0,
    };
  }

  /**
   * 주문 상세 조회 (polling 용).
   * GET /v1/order?uuid={uuid}
   */
  async getOrder(orderId: string): Promise<PlacedOrder> {
    const d = await this.apiGet<any>('/v1/order', { uuid: orderId });
    const filledQty = parseFloat(d?.executed_volume ?? '0');

    // Bithumb avg_price 필드는 종종 "0"으로 오므로 trades 배열로 가중평균 계산
    let avgFillPrice = parseFloat(d?.avg_price ?? '0');
    if (avgFillPrice === 0 && Array.isArray(d?.trades) && d.trades.length > 0) {
      const totalFunds = d.trades.reduce(
        (s: number, t: any) => s + parseFloat(t.funds ?? '0'), 0,
      );
      const totalVol = d.trades.reduce(
        (s: number, t: any) => s + parseFloat(t.volume ?? '0'), 0,
      );
      avgFillPrice = totalVol > 0 ? totalFunds / totalVol : 0;
    }

    return {
      orderId,
      status: this.mapStatus((d?.state ?? '').toLowerCase()),
      filledQty,
      avgFillPrice,
      totalFeeKrw: parseFloat(d?.paid_fee ?? '0'),
    };
  }

  protected mapStatus(state: string): OrderStatus {
    if (state === 'done') return 'filled';
    if (state === 'wait' || state === 'watch') return 'pending';
    if (state === 'cancel') return 'cancelled';
    return 'failed';
  }

  /**
   * 지정가 매수 주문.
   * POST /v1/orders { market, side:'bid', ord_type:'limit', price, volume }
   */
  async buyLimit(market: string, price: number, volume: number): Promise<any> {
    return this.apiPost('/v1/orders', {
      market,
      side: 'bid',
      ord_type: 'limit',
      price: String(Math.round(price)),
      volume: String(volume),
    });
  }

  /**
   * 지정가 매도 주문.
   * POST /v1/orders { market, side:'ask', ord_type:'limit', price, volume }
   */
  async sellLimit(market: string, price: number, volume: number): Promise<any> {
    return this.apiPost('/v1/orders', {
      market,
      side: 'ask',
      ord_type: 'limit',
      price: String(Math.round(price)),
      volume: String(volume),
    });
  }

  /**
   * 주문 취소.
   * DELETE /v1/order?uuid={orderId}
   */
  async cancelOrder(uuid: string): Promise<any> {
    return this.apiDelete('/v1/order', { uuid });
  }

  /**
   * 체결 완료 주문 목록 조회 (state=done).
   * GET /v1/orders?state=done[&market=...][&limit=...]
   */
  async getFilledOrders(market?: string, limit: number = 100): Promise<any[]> {
    const params: Record<string, string> = {
      state: 'done',
      limit: String(Math.min(limit, 100)),
      order_by: 'desc',
    };
    if (market) params.market = market;
    return this.apiGet('/v1/orders', params);
  }
}
