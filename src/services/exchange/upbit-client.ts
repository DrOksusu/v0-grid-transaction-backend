// src/services/exchange/upbit-client.ts
//
// Cross-exchange arb (Task 3): UpbitService 를 ExchangeClient interface 에 맞게 wrapping.
//
// 주의:
// - exchange-client.ts 의 OrderbookTop (number 4개 + timestamp) 사용. UpbitPriceManager
//   의 동명 type (OrderbookLevel 객체) 과 충돌 주의 — 명시적으로 './exchange-client' 에서 import.
// - getOrderbookTop 은 axios 직접 호출 (UpbitPriceManager 캐시는 maker-taker 가 점유).
// - placeBestIoc: bid 는 KRW 금액(price), ask 는 코인 수량(volume) 필요. IOC 라 미체결분 자동 취소됨.
// - mapStatus: IOC 가 부분체결돼도 state='cancel' 로 반환됨 — 호출자가 executed_volume 으로 실 체결 확인.
import axios from 'axios';
import { UpbitService } from '../upbit.service';
import {
  ExchangeClient, OrderbookTop, PlacedOrder, BalanceEntry, OrderStatus,
} from './exchange-client';

export interface UpbitClientCreds {
  accessKey: string;
  secretKey: string;
}

const UPBIT_PUBLIC_URL = 'https://api.upbit.com/v1';
const ORDERBOOK_TIMEOUT_MS = 5000;
const SLIPPAGE_BUFFER = 1.05; // 시장가 매수 KRW 금액에 5% 버퍼 (IOC 라 실제 체결분만 사용)

export class UpbitClient implements ExchangeClient {
  exchangeName: 'upbit' = 'upbit';
  private service: UpbitService;

  constructor(creds: UpbitClientCreds) {
    this.service = new UpbitService(creds);
  }

  /**
   * 단일 코인 최우선 호가 + 수량 조회. 실패 시 null.
   * Public API (인증 불필요) — UpbitPriceManager 캐시 의존 없이 매 cycle 신선한 호가 보장.
   */
  async getOrderbookTop(symbol: string): Promise<OrderbookTop | null> {
    const market = `KRW-${symbol}`;
    try {
      const res = await axios.get(`${UPBIT_PUBLIC_URL}/orderbook`, {
        params: { markets: market },
        timeout: ORDERBOOK_TIMEOUT_MS,
      });
      const data = res.data?.[0];
      if (!data || !data.orderbook_units?.length) return null;
      const top = data.orderbook_units[0];
      return {
        bid: parseFloat(top.bid_price),
        ask: parseFloat(top.ask_price),
        bidQty: parseFloat(top.bid_size),
        askQty: parseFloat(top.ask_size),
        timestamp: data.timestamp ?? Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** 모든 코인 잔고. KEY 는 코인 심볼 (KRW, USDT, USDS 등). */
  async getBalances(): Promise<Record<string, BalanceEntry>> {
    const accounts = await this.service.getAccounts();
    const out: Record<string, BalanceEntry> = {};
    for (const a of accounts) {
      out[a.currency] = {
        available: parseFloat(a.balance ?? '0'),
        locked: parseFloat(a.locked ?? '0'),
      };
    }
    return out;
  }

  /**
   * 시장가 매수/매도. placeBestIoc 사용 — IOC 라 미체결분 자동 취소.
   *
   * - 매수: orderbook ask price * quantity * 1.05 (5% slippage 버퍼) 로 KRW 금액 추정.
   *   IOC 라 실제 체결분만큼만 차감되므로 안전.
   *   orderbook 조회 실패 시 throw.
   * - 매도: volume(코인 수량) 그대로 placeBestIoc 호출.
   */
  async placeMarketOrder(
    side: 'buy' | 'sell', symbol: string, quantity: number,
  ): Promise<PlacedOrder> {
    const market = `KRW-${symbol}`;

    let result;
    if (side === 'buy') {
      const ob = await this.getOrderbookTop(symbol);
      if (!ob) throw new Error(`Upbit ${symbol} orderbook 조회 실패 — 매수 진행 불가`);
      // IOC 이므로 실제 체결가 만큼만 사용됨. 슬리피지 버퍼는 안전마진.
      const totalKrw = Math.ceil(ob.ask * quantity * SLIPPAGE_BUFFER);
      result = await this.service.placeBestIoc(market, 'bid', {
        price: totalKrw.toString(),
      });
    } else {
      result = await this.service.placeBestIoc(market, 'ask', {
        volume: quantity.toString(),
      });
    }

    return {
      orderId: result.uuid,
      status: this.mapStatus(result.state),
      filledQty: parseFloat(result.executed_volume ?? '0'),
      avgFillPrice: this.calcAvgPrice(result),
      totalFeeKrw: parseFloat(result.paid_fee ?? '0'),
    };
  }

  /** 주문 상세 조회 (polling 용). */
  async getOrder(orderId: string): Promise<PlacedOrder> {
    const order = await this.service.getOrder(orderId);
    return {
      orderId,
      status: this.mapStatus(order.state),
      filledQty: parseFloat(order.executed_volume ?? '0'),
      avgFillPrice: this.calcAvgPrice(order),
      totalFeeKrw: parseFloat(order.paid_fee ?? '0'),
    };
  }

  /**
   * 평균 체결가 계산.
   * - executed_funds 가 있으면 funds/volume 으로 우선 계산 (Upbit 응답에 포함됨).
   * - 없으면 trades 배열의 funds 합산 fallback (getOrder 응답에서 자주 등장).
   * - 둘 다 없거나 executed_volume=0 이면 0 반환.
   */
  private calcAvgPrice(order: any): number {
    const execVol = parseFloat(order.executed_volume ?? '0');
    if (execVol === 0) return 0;

    const execFunds = parseFloat(order.executed_funds ?? '0');
    if (execFunds > 0) return execFunds / execVol;

    const tradesFunds = (order.trades ?? []).reduce(
      (s: number, t: any) => s + parseFloat(t.funds ?? '0'), 0,
    );
    if (tradesFunds > 0) return tradesFunds / execVol;

    return 0;
  }

  /**
   * Upbit raw state -> OrderStatus 매핑 (소문자 컨벤션).
   * - done/completed: filled
   * - wait/watch: pending
   * - cancel/cancelled: cancelled (IOC 부분체결 케이스 — executed_volume 으로 실 체결 확인 필요)
   * - 기타: failed
   */
  private mapStatus(state: string): OrderStatus {
    if (state === 'done' || state === 'completed') return 'filled';
    if (state === 'wait' || state === 'watch') return 'pending';
    if (state === 'cancel' || state === 'cancelled') return 'cancelled';
    return 'failed';
  }
}
