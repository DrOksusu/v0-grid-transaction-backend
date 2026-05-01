// src/services/exchange/exchange-client.ts

export interface OrderbookTop {
  bid: number;       // 최우선 매수호가 (KRW)
  ask: number;       // 최우선 매도호가
  bidQty: number;    // 매수 수량 (코인)
  askQty: number;    // 매도 수량 (코인)
  timestamp: number; // ms
}

export type OrderStatus = 'pending' | 'filled' | 'partial' | 'cancelled' | 'failed';

export interface PlacedOrder {
  orderId: string;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  totalFeeKrw: number;
}

export interface BalanceEntry {
  available: number;
  locked: number;
}

export interface ExchangeClient {
  exchangeName: 'upbit' | 'bithumb';

  /** 단일 코인 최우선 호가 + 수량 조회. 실패 시 null */
  getOrderbookTop(symbol: string): Promise<OrderbookTop | null>;

  /** 모든 코인 잔고. KEY 는 코인 심볼 (KRW, USDT, USDE 등) */
  getBalances(): Promise<Record<string, BalanceEntry>>;

  /** 시장가 매수/매도 주문. 즉시 placement 결과 반환 (FILLED 까지 polling 은 호출자) */
  placeMarketOrder(side: 'buy' | 'sell', symbol: string, quantity: number): Promise<PlacedOrder>;

  /** 주문 상세 조회 (polling 용) */
  getOrder(orderId: string): Promise<PlacedOrder>;
}
