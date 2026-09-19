// 재고형 아비트리지 봇 공통 타입

/** 거래소 최우선 호가 (getOrderbookTop 결과와 동일 구조) */
export interface BookTop {
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
}

export type ExchangeName = 'upbit' | 'bithumb';

/** 실행 방향: 어디서 사서 어디서 파는가 */
export type ArbDirection = 'buy_upbit_sell_bithumb' | 'buy_bithumb_sell_upbit';

/** SpreadDetector 결과 — 수익 가능한 크로스 스프레드 1건 */
export interface SpreadOpportunity {
  direction: ArbDirection;
  buyExchange: ExchangeName;
  sellExchange: ExchangeName;
  buyPrice: number; // 매수 거래소 ask (즉시 매수 체결가)
  sellPrice: number; // 매도 거래소 bid (즉시 매도 체결가)
  spreadBps: number; // (sellPrice / buyPrice - 1) * 10000
  maxQtyByDepth: number; // min(매수측 askQty, 매도측 bidQty)
}

/** FeasibilityGate 입력 */
export interface FeasibilityInput {
  opp: SpreadOpportunity;
  minSpreadBps: number;
  anomalyMaxBps: number;
  maxOrderKrw: number;
  dailyMaxKrw: number | null;
  dailyMaxCount: number | null;
  todayNotionalKrw: number; // 오늘 이미 집행한 notional 합
  todayCount: number; // 오늘 이미 집행한 건수
  sellCoinBalance: number; // 매도 거래소의 해당 코인 가용 잔고
  buyKrwBalance: number; // 매수 거래소의 KRW 가용 잔고
  buyFeeBps: number;
}

/** FeasibilityGate 결과 */
export interface FeasibilityResult {
  ok: boolean;
  qty: number; // 확정 주문 수량 (ok=false면 0)
  notionalKrw: number; // qty * buyPrice
  reason?: string;
}

/** Executor 결과 유니온 */
export type ExecutorResult =
  | {
      kind: 'filled';
      buyQty: number;
      sellQty: number;
      buyGrossKrw: number;
      sellGrossKrw: number;
      feeKrw: number;
      netKrw: number;
      note: string;
    }
  | {
      kind: 'partial_flattened';
      buyQty: number;
      sellQty: number;
      flattenSide: 'sell' | 'buy';
      flattenQty: number;
      buyGrossKrw: number;
      sellGrossKrw: number;
      feeKrw: number;
      netKrw: number;
      note: string;
    }
  | { kind: 'partial_hold'; imbalanceQty: number; note: string }
  | { kind: 'flatten_failed'; imbalanceQty: number; note: string } // 터미널 → killSwitch
  | { kind: 'failed'; reason: string };
