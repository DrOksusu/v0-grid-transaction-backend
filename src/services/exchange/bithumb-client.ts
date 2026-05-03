// src/services/exchange/bithumb-client.ts
//
// Cross-exchange arb: Bithumb private API 클라이언트 (HMAC 서명 + 잔고/주문 조회/시장가 주문).
//
// Bithumb HMAC 서명 형식: endpoint + chr(0) + body + chr(0) + nonce 를 secretKey 로
// HMAC-SHA512 후 base64 인코딩. (https://apidocs.bithumb.com/ private API 인증 명세)
//
// 주의:
// - getOrderbookTop 은 public API (인증 불필요).
// - getBalances 는 currency=ALL 로 모든 코인 잔고를 한 번에 조회.
//   응답 형식: { available_KRW, total_KRW, in_use_KRW, available_BTC, ... }
// - placeMarketOrder (Task 5): market_buy 는 KRW amount 기준 — Stage 1 단순화로
//   quantity * 1500 KRW 가정. Stage 2 에서 호가 기반 동적 산정 추가 검토.
// - getOrder (Task 5): order_status (Completed/Pending/...) → mapStatus 매핑.

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
  mode: 'hex-base64' | 'binary-base64' = 'hex-base64',
): string {
  const data = endpoint + String.fromCharCode(0) + body + String.fromCharCode(0) + nonce;
  if (mode === 'binary-base64') {
    // 방식 2: raw binary → base64 (digest('base64'))
    return crypto.createHmac('sha512', secretKey).update(data).digest('base64');
  }
  // 방식 1 (기본): hex digest → base64 (PHP: base64_encode(hash_hmac('sha512', data, key, false)))
  const hexDigest = crypto.createHmac('sha512', secretKey).update(data).digest('hex');
  return Buffer.from(hexDigest).toString('base64');
}

export class BithumbClient implements ExchangeClient {
  exchangeName: 'bithumb' = 'bithumb';
  signMode: 'hex-base64' | 'binary-base64' = 'hex-base64';

  constructor(private creds: BithumbCreds, signMode?: 'hex-base64' | 'binary-base64') {
    if (signMode) this.signMode = signMode;
  }

  /**
   * Bithumb private API 호출 (POST + HMAC).
   * 응답의 status 가 '0000' 이 아니면 에러 throw.
   * Task 4 followup (I-2): try/catch 로 axios 네트워크/타임아웃 에러에 endpoint 컨텍스트 추가.
   * Bithumb 비즈니스 에러 (status != '0000') 는 그대로 전파 (메시지 prefix 'Bithumb error' 로 식별).
   */
  private async privatePost(
    endpoint: string, params: Record<string, string | number>,
  ): Promise<any> {
    const nonce = String(Date.now());
    // type-safe URLSearchParams 인자: 모든 value 를 string 으로 변환 (M-1 fix)
    const bodyStr = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    ).toString();
    // 서명 방식 1: hex→base64, 방식 2: binary→base64 — 두 길이 진단
    const sign1 = signRequest(endpoint, bodyStr, nonce, this.creds.secretKey, 'hex-base64');
    const sign2 = signRequest(endpoint, bodyStr, nonce, this.creds.secretKey, 'binary-base64');
    console.log('[BithumbSign] hex-base64 len:', sign1.length, 'binary-base64 len:', sign2.length);
    const sign = this.signMode === 'binary-base64' ? sign2 : sign1;
    try {
      console.log('[BithumbReq]', { endpoint, body: bodyStr, nonceLen: nonce.length, signLen: sign.length });
      const response = await axios.post(`${BITHUMB_API_URL}${endpoint}`, bodyStr, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Api-Key': this.creds.accessKey,
          'Api-Nonce': nonce,
          'Api-Sign': sign,
          'Api-Client-Type': '0',
        },
        timeout: TIMEOUT_MS,
      });
      if (response.data?.status !== '0000') {
        throw new Error(
          `Bithumb error ${response.data?.status}: ${response.data?.message ?? 'unknown'}`,
        );
      }
      return response.data;
    } catch (err: any) {
      // status '0000' 검증 throw 는 그대로 전파 (Bithumb 비즈니스 에러 메시지 보존)
      if (err?.message?.startsWith('Bithumb error')) throw err;
      // 그 외 axios 네트워크/타임아웃 에러는 endpoint + status 컨텍스트 추가
      const status = err?.response?.status;
      const respData = err?.response?.data;
      console.error(`[BithumbClient] privatePost ${endpoint} 전체 응답:`, JSON.stringify(respData));
      const respMsg = respData?.message ?? respData?.msg;
      throw new Error(
        `Bithumb privatePost ${endpoint} 실패 (status=${status}): ${respMsg ?? err.message}`,
      );
    }
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
   * Task 4 followup (I-1): regex /i flag 로 case-insensitive (Bithumb 응답이 소문자/대문자 혼용 가능성).
   */
  async getBalances(): Promise<Record<string, BalanceEntry>> {
    const data = await this.privatePost('/info/balance', { currency: 'ALL' });
    const out: Record<string, BalanceEntry> = {};
    for (const key of Object.keys(data.data ?? {})) {
      // available_<SYMBOL> 키만 대상으로 잔고 entry 구성 (case-insensitive)
      const m = key.match(/^available_(.+)$/i);
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

  /**
   * 시장가 매수/매도 주문.
   * - 매도: units (코인 수량) 기준
   * - 매수: amount (KRW 금액) 기준 — Stage 1 캐너리 단순화로 quantity * 1500 KRW 가정
   *         (Stage 2 에서 호가 기반 동적 산정을 별도 메서드로 추가 검토)
   * Bithumb 시장가 주문은 즉시 체결 보장이 아니므로 status='pending' 으로 반환,
   * 호출자(executor) 가 별도 getOrder polling 으로 fill 확인.
   */
  async placeMarketOrder(
    side: 'buy' | 'sell', symbol: string, quantity: number, krwPerUnit?: number,
  ): Promise<PlacedOrder> {
    const endpoint = side === 'buy' ? '/trade/market_buy' : '/trade/market_sell';
    const params: Record<string, string | number> = {
      order_currency: symbol.toUpperCase(),
      payment_currency: 'KRW',
      units: side === 'sell' ? quantity : 0,
    };
    if (side === 'buy') {
      // market_buy 는 KRW amount 기준. 슬리피지 마진 2% 포함.
      // krwPerUnit(호가) 미제공 시 1500 KRW fallback.
      const pricePerUnit = krwPerUnit ?? 1500;
      params.amount = Math.ceil(quantity * pricePerUnit * 1.02);
      delete params.units;
    }
    const response = await this.privatePost(endpoint, params);
    return {
      orderId: response.order_id ?? response.data?.order_id ?? '',
      status: 'pending', // 빗썸 시장가 결과 비동기 — getOrder polling 필요
      filledQty: 0,
      avgFillPrice: 0,
      totalFeeKrw: 0,
    };
  }

  /**
   * 주문 상세 조회 (polling 용).
   * Bithumb /info/order_detail 응답의 order_status (Completed/Pending/Cancelled 등) 를
   * lowercase 변환 후 mapStatus 로 OrderStatus 에 매핑.
   */
  async getOrder(orderId: string): Promise<PlacedOrder> {
    const response = await this.privatePost('/info/order_detail', { order_id: orderId });
    const d = response.data;
    return {
      orderId,
      status: this.mapStatus((d?.order_status ?? '').toLowerCase()),
      filledQty: parseFloat(d?.order_qty ?? '0'),
      avgFillPrice: parseFloat(d?.order_price ?? '0'),
      totalFeeKrw: parseFloat(d?.fee ?? '0'),
    };
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
