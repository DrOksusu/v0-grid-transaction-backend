// src/services/exchange/bithumb-client.ts
//
// Cross-exchange arb (Task 4): Bithumb private API 클라이언트 (HMAC 서명 + 잔고 조회).
//
// Bithumb HMAC 서명 형식: endpoint + chr(0) + body + chr(0) + nonce 를 secretKey 로
// HMAC-SHA512 후 base64 인코딩. (https://apidocs.bithumb.com/ private API 인증 명세)
//
// 주의:
// - placeMarketOrder / getOrder 는 Task 5 영역. 이번 Task 에서는 throw stub.
// - getOrderbookTop 은 public API (인증 불필요).
// - getBalances 는 currency=ALL 로 모든 코인 잔고를 한 번에 조회.
//   응답 형식: { available_KRW, total_KRW, in_use_KRW, available_BTC, ... }

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
 * Bithumb private API HMAC SHA512 서명.
 * endpoint + chr(0) + body + chr(0) + nonce 를 secretKey 로 서명 후 base64 인코딩.
 */
export function signRequest(
  endpoint: string, body: string, nonce: string, secretKey: string,
): string {
  const data = endpoint + String.fromCharCode(0) + body + String.fromCharCode(0) + nonce;
  return crypto.createHmac('sha512', secretKey).update(data).digest('base64');
}

export class BithumbClient implements ExchangeClient {
  exchangeName: 'bithumb' = 'bithumb';

  constructor(private creds: BithumbCreds) {}

  /**
   * Bithumb private API 호출 (POST + HMAC).
   * 응답의 status 가 '0000' 이 아니면 에러 throw.
   */
  private async privatePost(
    endpoint: string, params: Record<string, string | number>,
  ): Promise<any> {
    const nonce = String(Date.now());
    const bodyStr = new URLSearchParams(params as any).toString();
    const sign = signRequest(endpoint, bodyStr, nonce, this.creds.secretKey);
    const response = await axios.post(`${BITHUMB_API_URL}${endpoint}`, bodyStr, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Api-Key': this.creds.accessKey,
        'Api-Nonce': nonce,
        'Api-Sign': sign,
      },
      timeout: TIMEOUT_MS,
    });
    if (response.data?.status !== '0000') {
      throw new Error(
        `Bithumb error ${response.data?.status}: ${response.data?.message ?? 'unknown'}`,
      );
    }
    return response.data;
  }

  /**
   * 단일 코인 최우선 호가 + 수량 조회. Public API (인증 불필요). 실패 시 null.
   */
  async getOrderbookTop(symbol: string): Promise<OrderbookTop | null> {
    try {
      const response = await axios.get(
        `${BITHUMB_API_URL}/public/orderbook/${symbol}_KRW`,
        { timeout: TIMEOUT_MS },
      );
      const data = response.data;
      if (data?.status !== '0000' || !data.data) return null;
      const topBid = data.data.bids?.[0];
      const topAsk = data.data.asks?.[0];
      if (!topBid || !topAsk) return null;
      return {
        bid: parseFloat(topBid.price),
        ask: parseFloat(topAsk.price),
        bidQty: parseFloat(topBid.quantity),
        askQty: parseFloat(topAsk.quantity),
        timestamp: Date.now(),
      };
    } catch (err: any) {
      console.error(
        `[Bithumb] orderbook ${symbol} 조회 실패:`,
        err?.response?.status, err.message,
      );
      return null;
    }
  }

  /**
   * 모든 코인 잔고. KEY 는 코인 심볼 (KRW, USDT, USDE 등).
   * Bithumb 응답: { available_KRW, total_KRW, in_use_KRW, available_BTC, ... }
   */
  async getBalances(): Promise<Record<string, BalanceEntry>> {
    const data = await this.privatePost('/info/balance', { currency: 'ALL' });
    const out: Record<string, BalanceEntry> = {};
    for (const [key, _value] of Object.entries(data.data ?? {})) {
      // available_<SYMBOL> 키만 대상으로 잔고 entry 구성
      const m = key.match(/^available_(.+)$/);
      if (!m) continue;
      const sym = m[1].toUpperCase();
      const inUseKey = `in_use_${m[1]}`;
      out[sym] = {
        available: parseFloat((data.data as any)[key] ?? '0'),
        locked: parseFloat((data.data as any)[inUseKey] ?? '0'),
      };
    }
    return out;
  }

  async placeMarketOrder(
    _side: 'buy' | 'sell', _symbol: string, _quantity: number,
  ): Promise<PlacedOrder> {
    throw new Error('placeMarketOrder: implemented in Task 5');
  }

  async getOrder(_orderId: string): Promise<PlacedOrder> {
    throw new Error('getOrder: implemented in Task 5');
  }

  /**
   * Bithumb raw state -> OrderStatus 매핑 (Task 5 에서 확장).
   * 이번 Task 에서는 minimal stub.
   */
  protected mapStatus(state: string): OrderStatus {
    if (state === 'completed') return 'filled';
    if (state === 'pending') return 'pending';
    return 'failed';
  }
}
