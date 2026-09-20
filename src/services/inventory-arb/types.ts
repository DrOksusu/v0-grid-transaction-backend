// 재고형 아비트리지 봇 공통 타입
import type { WalletInfo } from './wallet-info';
export type { WalletInfo };

/** 호가 한 단계 */
export interface BookLevel {
  price: number;
  qty: number;
}

/**
 * 거래소 호가.
 * bid/ask/bidQty/askQty = 최우선 호가(하위호환·스프레드 판정용).
 * bids/asks = 다단계 호가(있으면 depth-aware 사이징에 사용, 없으면 최우선 1단계로 폴백).
 *   bids: 매수호가 내림차순, asks: 매도호가 오름차순.
 */
export interface BookTop {
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  bids?: BookLevel[];
  asks?: BookLevel[];
}

export type ExchangeName = 'upbit' | 'bithumb';

/** 실행 방향: 어디서 사서 어디서 파는가 */
export type ArbDirection = 'buy_upbit_sell_bithumb' | 'buy_bithumb_sell_upbit';

/** SpreadDetector 결과 — 수익 가능한 크로스 스프레드 1건 */
export interface SpreadOpportunity {
  direction: ArbDirection;
  buyExchange: ExchangeName;
  sellExchange: ExchangeName;
  buyPrice: number; // 매수 priceHint: 소비한 최악(최고) ask 레벨가 — IOC 예산이 다단계 체결을 커버하도록 보수적
  sellPrice: number; // 매도 priceHint: 소비한 최악(최저) bid 레벨가
  spreadBps: number; // 최우선호가 기준 (bestSellBid / bestBuyAsk - 1) * 10000 (진입 신호)
  maxQtyByDepth: number; // depth-aware: 마진 스프레드 ≥ minSpreadBps 인 레벨까지 누적 수량 (레벨 없으면 최우선 1단계 min)
}

/** 후보 스캐너 결과 — 지금 실행 가능한 재고형 아비 후보 1건 */
export interface InventoryArbCandidate {
  symbol: string;
  direction: ArbDirection;
  buyExchange: ExchangeName;
  sellExchange: ExchangeName;
  spreadBps: number;
  buyPrice: number;
  sellPrice: number;
  executableQty: number; // min(depth, 매도측 코인, 매수측 KRW/가격)
  executableKrw: number; // executableQty * buyPrice
  type: 'bidirectional' | 'one_way_drain'; // 양방향(양쪽 코인 보유) / 단방향 드레인(EGLD형)
  sellCoinBalance: number; // 매도 거래소 코인 보유
  buyKrwBalance: number; // 매수 거래소 KRW 보유
  buyWallet?: WalletInfo; // 매수 거래소 입출금 상태
  sellWallet?: WalletInfo; // 매도 거래소 입출금 상태
  estimatedGrossKrw: number; // 규모 × (매도가 − 매수가), 수수료 전
  estimatedFeeKrw: number; // 양쪽 거래 수수료 추정
  estimatedNetKrw: number; // gross − fee (추정 순이익)
  netProfitable: boolean; // 추정 순이익 > 0
  realizable: boolean; // 지금 재고로 실제 실행 가능한가 (KRW 후보는 재고 보유 시 true)
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
