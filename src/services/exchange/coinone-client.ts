// src/services/exchange/coinone-client.ts
//
// 코인원 REST API V2.1 클라이언트.
//
// 인증 (CCXT 기준):
//   payload = base64(JSON body)
//   X-COINONE-PAYLOAD = payload
//   X-COINONE-SIGNATURE = HMAC-SHA512(payload, upper(secretKey)) lowercase hex
//   request body = payload (base64 문자열, raw JSON 아님)

import axios from 'axios';
import crypto from 'crypto';
import { ExchangeClient, OrderbookTop, PlacedOrder, BalanceEntry, OrderStatus } from './exchange-client';

const COINONE_BASE_URL = 'https://api.coinone.co.kr';
const TIMEOUT_MS = 5000;

export interface CoinoneCreds {
  accessKey: string; // access_token
  secretKey: string; // HMAC 서명 키
}

export class CoinoneClient implements ExchangeClient {
  exchangeName: 'coinone' = 'coinone';

  constructor(private creds: CoinoneCreds) {}

  private buildBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      access_token: this.creds.accessKey,
      nonce: crypto.randomUUID(),
      ...extra,
    };
  }

  private async apiPost<T = any>(endpoint: string, extra: Record<string, unknown> = {}): Promise<T> {
    const body = this.buildBody(extra);
    const bodyStr = JSON.stringify(body);
    const payload = Buffer.from(bodyStr).toString('base64');
    const signature = crypto
      .createHmac('sha512', this.creds.secretKey)
      .update(payload)
      .digest('hex')
      .toUpperCase();

    // 디버그: 실제 전송 값 확인 (키는 마스킹)
    const accessKeyMasked = this.creds.accessKey.slice(0, 6) + '...' + this.creds.accessKey.slice(-4);
    const secretKeyMasked = this.creds.secretKey.slice(0, 4) + '...' + this.creds.secretKey.slice(-4);
    console.log(`[CoinoneDebug] endpoint=${endpoint}`);
    console.log(`[CoinoneDebug] accessKey=${accessKeyMasked} len=${this.creds.accessKey.length}`);
    console.log(`[CoinoneDebug] secretKey=${secretKeyMasked} len=${this.creds.secretKey.length}`);
    console.log(`[CoinoneDebug] bodyStr=${bodyStr}`);
    console.log(`[CoinoneDebug] payload(base64)=${payload.slice(0, 30)}...`);
    console.log(`[CoinoneDebug] signature=${signature.slice(0, 20)}...`);

    try {
      const res = await axios.post<T>(`${COINONE_BASE_URL}${endpoint}`, payload, {
        headers: {
          'X-COINONE-PAYLOAD': payload,
          'X-COINONE-SIGNATURE': signature,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
      });
      const d = res.data as any;
      if (d?.result === 'error') {
        throw new Error(`Coinone ${endpoint} 오류 (${d.error_code}): ${d.error_msg ?? ''}`);
      }
      return d;
    } catch (err: any) {
      const d = err?.response?.data;
      if (d?.result === 'error') {
        throw new Error(`Coinone ${endpoint} 오류 (${d.error_code}): ${d.error_msg ?? ''}`);
      }
      throw new Error(`Coinone ${endpoint} 실패: ${err.message}`);
    }
  }

  /** 단일 코인 최우선 호가. Public REST. */
  async getOrderbookTop(symbol: string): Promise<OrderbookTop | null> {
    try {
      const res = await axios.get(
        `${COINONE_BASE_URL}/public/v2/orderbook/KRW/${symbol.toUpperCase()}`,
        { params: { size: 1 }, timeout: TIMEOUT_MS },
      );
      const d = res.data;
      if (d?.result !== 'success') return null;
      const topBid = d.bids?.[0];
      const topAsk = d.asks?.[0];
      if (!topBid || !topAsk) return null;
      return {
        bid: parseFloat(topBid.price),
        ask: parseFloat(topAsk.price),
        bidQty: parseFloat(topBid.qty),
        askQty: parseFloat(topAsk.qty),
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** 전체 잔고. POST /v2.1/account/balance */
  async getBalances(): Promise<Record<string, BalanceEntry>> {
    const res = await this.apiPost<any>('/v2.1/account/balance');
    const out: Record<string, BalanceEntry> = {};
    for (const item of res.balances ?? []) {
      const sym = String(item.currency ?? item.target_currency ?? '').toUpperCase();
      if (!sym) continue;
      out[sym] = {
        available: parseFloat(item.available_qty ?? item.available ?? '0'),
        locked: parseFloat(item.limit_qty ?? item.limit ?? '0'),
      };
    }
    return out;
  }

  /**
   * 시장가 매수/매도.
   * - 매도: qty(수량) 기준
   * - 매수: amount(KRW 금액) 기준
   */
  async placeMarketOrder(
    side: 'buy' | 'sell', symbol: string, quantity: number, krwPerUnit?: number,
  ): Promise<PlacedOrder> {
    const extra: Record<string, unknown> = {
      quote_currency: 'KRW',
      target_currency: symbol.toUpperCase(),
      type: 'MARKET',
      side: side === 'buy' ? 'BID' : 'ASK',
    };
    if (side === 'sell') {
      extra.qty = String(quantity);
    } else {
      extra.amount = String(Math.ceil(quantity * (krwPerUnit ?? 1500) * 1.02));
    }
    const res = await this.apiPost<any>('/v2.1/order', extra);
    return { orderId: res.order_id ?? '', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 };
  }

  /** 시장가 매수 — KRW 금액 직접 지정 */
  async placeMarketBuyKrw(symbol: string, krwAmount: number): Promise<PlacedOrder> {
    const res = await this.apiPost<any>('/v2.1/order', {
      quote_currency: 'KRW',
      target_currency: symbol.toUpperCase(),
      type: 'MARKET',
      side: 'BID',
      amount: String(Math.round(krwAmount)),
    });
    return { orderId: res.order_id ?? '', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 };
  }

  /** 주문 상세 조회 (polling용). POST /v2.1/order/detail */
  async getOrder(orderId: string, symbol?: string): Promise<PlacedOrder> {
    const extra: Record<string, unknown> = { order_id: orderId };
    if (symbol) {
      extra.quote_currency = 'KRW';
      extra.target_currency = symbol.toUpperCase();
    }
    const res = await this.apiPost<any>('/v2.1/order/detail', extra);
    const o = res.order ?? res;

    const statusRaw = String(o.status ?? '').toLowerCase();
    let status: OrderStatus;
    if (statusRaw === 'done' || statusRaw === 'trade_done') status = 'filled';
    else if (statusRaw === 'wait') status = 'pending';
    else if (statusRaw === 'cancel' || statusRaw === 'cancel_post_only') status = 'cancelled';
    else if (statusRaw === 'trade') status = 'partial';
    else status = 'failed';

    const filledQty = parseFloat(o.executed_qty ?? o.filled_qty ?? '0');
    const avgFillPrice = parseFloat(o.executed_price ?? o.avg_price ?? '0');
    const feeKrw = parseFloat(o.fee ?? o.executed_fee ?? '0');

    return { orderId, status, filledQty, avgFillPrice, totalFeeKrw: feeKrw };
  }

  /** 주문 취소. POST /v2.1/order/cancel */
  async cancelOrder(orderId: string, symbol?: string): Promise<void> {
    const extra: Record<string, unknown> = { order_id: orderId };
    if (symbol) {
      extra.quote_currency = 'KRW';
      extra.target_currency = symbol.toUpperCase();
    }
    await this.apiPost('/v2.1/order/cancel', extra);
  }

  /** 지정가 매수 */
  async buyLimit(symbol: string, price: number, qty: number): Promise<any> {
    return this.apiPost('/v2.1/order', {
      quote_currency: 'KRW',
      target_currency: symbol.toUpperCase(),
      type: 'LIMIT',
      side: 'BID',
      price: String(Math.round(price)),
      qty: String(qty),
    });
  }

  /** 지정가 매도 */
  async sellLimit(symbol: string, price: number, qty: number): Promise<any> {
    return this.apiPost('/v2.1/order', {
      quote_currency: 'KRW',
      target_currency: symbol.toUpperCase(),
      type: 'LIMIT',
      side: 'ASK',
      price: String(Math.round(price)),
      qty: String(qty),
    });
  }
}
