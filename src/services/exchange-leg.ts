/**
 * 거래소 중립 주문 추상 인터페이스 (ExchangeLeg)
 *
 * maker-taker-live-executor 가 거래소 구현에 의존하지 않도록 하는 어댑터 레이어.
 * UpbitLeg / BithumbLeg 가 각 거래소의 응답 형식을 공통 구조로 변환.
 */

import type { UpbitService } from './upbit.service';
import type { BithumbClient } from './exchange/bithumb-client';

/** 거래소별 주문 수행 어댑터 */
export interface ExchangeLeg {
  /** IOC 시장가 매도. 즉시 처리. null = 체결 없음 */
  sellIoc(
    symbol: string,
    quantity: number,
  ): Promise<{ filledQty: number; grossKrw: number; feeKrw: number } | null>;

  /**
   * IOC 시장가 매수. 즉시 처리. null = 체결 없음.
   * @param priceHint 예상 단가(KRW) — 예산 계산 기준
   * @param maxKrwBudget 지불 KRW 상한. 지정하면 priceHint 기반 추정액과 min 취함.
   *   매도 순수익(grossKrw - feeKrw)을 fee-adjusted 값으로 전달하면 gross P&L ≥ 0 보장.
   */
  buyIoc(
    symbol: string,
    quantity: number,
    priceHint: number,
    maxKrwBudget?: number,
  ): Promise<{ filledQty: number; grossKrw: number; feeKrw: number } | null>;

  /** 지정가 maker BID 주문. null = 주문 실패 */
  placeMakerBid(symbol: string, price: number, quantity: number): Promise<string | null>;

  /** 주문 현황 조회 (polling용) */
  pollOrder(orderId: string): Promise<{
    filled: boolean;
    filledQty: number;
    grossKrw: number;
    feeKrw: number;
  }>;

  /** 지정가 ASK(매도) 주문. TAKER_PENDING 단계에서 사용. null = 주문 실패 */
  placeMakerAsk(symbol: string, price: number, quantity: number): Promise<string | null>;

  /** 주문 취소 */
  cancelOrder(orderId: string): Promise<void>;
}

/** Upbit 응답에서 KRW 금액 추출 (executed_funds 우선, trades fallback) */
function extractKrw(resp: any): number {
  if (resp?.executed_funds) return parseFloat(resp.executed_funds);
  if (Array.isArray(resp?.trades)) {
    return resp.trades.reduce((s: number, t: any) => s + parseFloat(t.funds || '0'), 0);
  }
  return 0;
}

/** 업비트 구현체 */
export class UpbitLeg implements ExchangeLeg {
  constructor(private readonly upbit: UpbitService) {}

  async sellIoc(
    symbol: string,
    quantity: number,
  ): Promise<{ filledQty: number; grossKrw: number; feeKrw: number } | null> {
    const resp = await this.upbit.placeBestIoc(`KRW-${symbol}`, 'ask', {
      volume: String(quantity),
    });
    let filledQty = parseFloat(resp.executed_volume || '0');
    let effectiveResp: any = resp;

    // Leg-2 IOC false positive 방어 (PR D 사례)
    if (filledQty === 0 && resp.uuid) {
      await new Promise((r) => setTimeout(r, 1500));
      const recheck = await this.upbit.getOrder(resp.uuid);
      const recheckQty = parseFloat(recheck?.executed_volume || '0');
      if (recheckQty > 0) {
        filledQty = recheckQty;
        effectiveResp = recheck;
      }
    }

    if (filledQty === 0) return null;
    return {
      filledQty,
      grossKrw: extractKrw(effectiveResp),
      feeKrw: parseFloat(effectiveResp?.paid_fee || '0'),
    };
  }

  async buyIoc(
    symbol: string,
    quantity: number,
    priceHint: number,
    maxKrwBudget?: number,
  ): Promise<{ filledQty: number; grossKrw: number; feeKrw: number } | null> {
    // Upbit 시장가 매수는 KRW 금액 기준 (price 파라미터)
    // maxKrwBudget: fee-adjusted 상한 — 초과 지출 시 net P&L < 0 되는 것 방지
    const estimatedKrw = Math.ceil(quantity * priceHint * 1.01);
    const krwAmount = maxKrwBudget != null ? Math.min(estimatedKrw, maxKrwBudget) : estimatedKrw;
    const resp = await this.upbit.placeBestIoc(`KRW-${symbol}`, 'bid', {
      price: String(krwAmount),
    });
    let filledQty = parseFloat(resp.executed_volume || '0');
    let effectiveResp: any = resp;

    // IOC false positive 방어
    if (filledQty === 0 && resp.uuid) {
      await new Promise((r) => setTimeout(r, 1500));
      const recheck = await this.upbit.getOrder(resp.uuid);
      const recheckQty = parseFloat(recheck?.executed_volume || '0');
      if (recheckQty > 0) {
        filledQty = recheckQty;
        effectiveResp = recheck;
      }
    }

    if (filledQty === 0) return null;
    return {
      filledQty,
      grossKrw: extractKrw(effectiveResp),
      feeKrw: parseFloat(effectiveResp?.paid_fee || '0'),
    };
  }

  async placeMakerBid(symbol: string, price: number, quantity: number): Promise<string | null> {
    const resp = await this.upbit.placeLimitOrder(`KRW-${symbol}`, 'bid', {
      price: String(price),
      volume: String(quantity),
      postOnly: true,
    });
    return resp.uuid || null;
  }

  async pollOrder(
    orderId: string,
  ): Promise<{ filled: boolean; filledQty: number; grossKrw: number; feeKrw: number }> {
    const status: any = await this.upbit.getOrder(orderId);
    const filledQty = parseFloat(status?.executed_volume || '0');
    const grossKrw = extractKrw(status);
    const feeKrw = parseFloat(status?.paid_fee || '0');
    // state === 'done' 일 때만 완전 체결로 판단 (state==='wait'은 부분체결 포함 미완료)
    const fullyFilled = status?.state === 'done' && filledQty > 0 && grossKrw > 0;
    return { filled: fullyFilled, filledQty, grossKrw, feeKrw };
  }

  async placeMakerAsk(symbol: string, price: number, quantity: number): Promise<string | null> {
    const resp = await this.upbit.placeLimitOrder(`KRW-${symbol}`, 'ask', {
      price: String(price),
      volume: String(quantity),
      postOnly: false,
    });
    return resp.uuid || null;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.upbit.cancelOrder(orderId);
  }
}

/** 빗썸 구현체 */
export class BithumbLeg implements ExchangeLeg {
  constructor(private readonly client: BithumbClient) {}

  async sellIoc(
    symbol: string,
    quantity: number,
  ): Promise<{ filledQty: number; grossKrw: number; feeKrw: number } | null> {
    const placed = await this.client.placeMarketOrder('sell', symbol, quantity);
    if (!placed.orderId) return null;

    // 빗썸 시장가 매도는 거의 즉시 체결되나 polling 필요
    for (let i = 0; i < 6; i++) {
      const order = await this.client.getOrder(placed.orderId);
      if (order.status === 'filled' && order.filledQty > 0) {
        return {
          filledQty: order.filledQty,
          grossKrw: order.avgFillPrice * order.filledQty,
          feeKrw: order.totalFeeKrw,
        };
      }
      if (order.status === 'cancelled' || order.status === 'failed') return null;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  async buyIoc(
    symbol: string,
    quantity: number,
    priceHint: number,
    maxKrwBudget?: number,
  ): Promise<{ filledQty: number; grossKrw: number; feeKrw: number } | null> {
    // Bithumb 시장가 매수는 수량(unit) 기반 — 예산 상한을 최대 구매 가능 수량으로 환산
    // priceHint × 1.02 버퍼: 스냅샷과 실제 체결가 사이 최대 2% 슬리피지 허용
    let effectiveQty = quantity;
    if (maxKrwBudget != null && priceHint > 0) {
      const maxAffordableQty = Math.floor(maxKrwBudget / (priceHint * 1.02));
      effectiveQty = Math.min(quantity, maxAffordableQty);
      if (effectiveQty <= 0) return null;
    }
    const placed = await this.client.placeMarketOrder('buy', symbol, effectiveQty, priceHint);
    if (!placed.orderId) return null;

    for (let i = 0; i < 6; i++) {
      const order = await this.client.getOrder(placed.orderId);
      if (order.status === 'filled' && order.filledQty > 0) {
        return {
          filledQty: order.filledQty,
          grossKrw: order.avgFillPrice * order.filledQty,
          feeKrw: order.totalFeeKrw,
        };
      }
      if (order.status === 'cancelled' || order.status === 'failed') return null;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  async placeMakerBid(symbol: string, price: number, quantity: number): Promise<string | null> {
    const resp = await this.client.buyLimit(`KRW-${symbol}`, price, quantity);
    return resp?.uuid ?? null;
  }

  async pollOrder(
    orderId: string,
  ): Promise<{ filled: boolean; filledQty: number; grossKrw: number; feeKrw: number }> {
    const order = await this.client.getOrder(orderId);
    const filled = order.status === 'filled' && order.filledQty > 0;
    return {
      filled,
      filledQty: order.filledQty,
      grossKrw: order.avgFillPrice * order.filledQty,
      feeKrw: order.totalFeeKrw,
    };
  }

  async placeMakerAsk(symbol: string, price: number, quantity: number): Promise<string | null> {
    const resp = await this.client.sellLimit(`KRW-${symbol}`, price, quantity);
    return resp?.uuid ?? null;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId);
  }
}
