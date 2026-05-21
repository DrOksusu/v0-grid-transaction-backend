/**
 * 거래소 중립 주문 추상 인터페이스 (ExchangeLeg)
 *
 * maker-taker-live-executor 가 거래소 구현에 의존하지 않도록 하는 어댑터 레이어.
 * UpbitLeg / BithumbLeg 가 각 거래소의 응답 형식을 공통 구조로 변환.
 */

import type { UpbitService } from './upbit.service';
import type { BithumbClient } from './exchange/bithumb-client';
import type { CoinoneClient } from './exchange/coinone-client';

/** 거래소별 주문 수행 어댑터 */
export interface ExchangeLeg {
  /**
   * IOC 매도. 즉시 처리. null = 체결 없음.
   * @param priceHint 지정가 매도 지원 거래소(코인원)에서 사용할 ASK 가격(KRW). 미지정 시 마켓 매도.
   */
  sellIoc(
    symbol: string,
    quantity: number,
    priceHint?: number,
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

  /** 주문 현황 조회 (polling용). symbol: 코인원은 재시작 후 Map 복구용 */
  pollOrder(orderId: string, symbol?: string): Promise<{
    filled: boolean;
    filledQty: number;
    grossKrw: number;
    feeKrw: number;
  }>;

  /** 지정가 ASK(매도) 주문. TAKER_PENDING 단계에서 사용. null = 주문 실패 */
  placeMakerAsk(symbol: string, price: number, quantity: number): Promise<string | null>;

  /** 주문 취소. symbol: 코인원은 재시작 후 Map 복구용 */
  cancelOrder(orderId: string, symbol?: string): Promise<void>;
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
    _priceHint?: number,
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
    // 팔린 수량만큼 그대로 매수 — 버퍼 없이 quantity × priceHint KRW 전달
    const estimatedKrw = Math.ceil(quantity * priceHint);
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
    _symbol?: string,
  ): Promise<{ filled: boolean; filledQty: number; grossKrw: number; feeKrw: number }> {
    try {
      const status: any = await this.upbit.getOrder(orderId);
      const filledQty = parseFloat(status?.executed_volume || '0');
      const grossKrw = extractKrw(status);
      const feeKrw = parseFloat(status?.paid_fee || '0');
      // state === 'done' 일 때만 완전 체결로 판단 (state==='wait'은 부분체결 포함 미완료)
      const fullyFilled = status?.state === 'done' && filledQty > 0 && grossKrw > 0;
      return { filled: fullyFilled, filledQty, grossKrw, feeKrw };
    } catch (err: any) {
      // API 오류(404, 네트워크 등) → 미체결 처리. elapsed 체크가 만료를 담당.
      console.warn(`[UpbitLeg] pollOrder ${orderId} 실패 — 미체결로 처리:`, err.message);
      return { filled: false, filledQty: 0, grossKrw: 0, feeKrw: 0 };
    }
  }

  async placeMakerAsk(symbol: string, price: number, quantity: number): Promise<string | null> {
    const resp = await this.upbit.placeLimitOrder(`KRW-${symbol}`, 'ask', {
      price: String(price),
      volume: String(quantity),
      postOnly: false,
    });
    return resp.uuid || null;
  }

  async cancelOrder(orderId: string, _symbol?: string): Promise<void> {
    await this.upbit.cancelOrder(orderId);
  }
}

/** 빗썸 구현체 */
export class BithumbLeg implements ExchangeLeg {
  constructor(private readonly client: BithumbClient) {}

  async sellIoc(
    symbol: string,
    quantity: number,
    _priceHint?: number,
  ): Promise<{ filledQty: number; grossKrw: number; feeKrw: number } | null> {
    // 빗썸 최소 주문금액 5000 KRW 체크 — 미달 시 즉시 skip (400 under_min_total_ask 방지)
    const BITHUMB_MIN_ORDER_KRW = 5000;
    if (_priceHint && quantity * _priceHint < BITHUMB_MIN_ORDER_KRW) {
      console.log(`[BithumbLeg.sellIoc] ${symbol} qty=${quantity} est=${(quantity * _priceHint).toFixed(0)} KRW < ${BITHUMB_MIN_ORDER_KRW} 최소주문금액 — 호가 잔량 부족 skip`);
      return null;
    }
    const placed = await this.client.placeMarketOrder('sell', symbol, quantity);

    // 빗썸 시장가 매도는 거의 즉시 체결되나 polling 필요
    for (let i = 0; i < 6; i++) {
      const order = await this.client.getOrder(placed.orderId);
      console.log(`[BithumbLeg.sellIoc] poll[${i}] ${symbol} status=${order.status} filledQty=${order.filledQty}`);
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
    console.log(`[BithumbLeg.sellIoc] ${symbol} 6회 폴링 완료 후 미체결 — timeout null`);
    return null;
  }

  async buyIoc(
    symbol: string,
    quantity: number,
    priceHint: number,
    maxKrwBudget?: number,
  ): Promise<{ filledQty: number; grossKrw: number; feeKrw: number } | null> {
    // Bithumb 시장가 매수 = KRW 금액 기준 (Upbit와 동일 구조)
    // quantity × priceHint = 팔린 수량만큼 그대로 사기 위한 KRW 추정액
    // maxKrwBudget이 있으면 fee-aware 예산 상한으로 cap — 초과 지출 방지
    const estimatedKrw = Math.ceil(quantity * priceHint);
    const krwAmount = maxKrwBudget != null ? Math.min(estimatedKrw, maxKrwBudget) : estimatedKrw;
    if (krwAmount <= 0) return null;
    // 빗썸 최소 주문금액 5000 KRW 체크
    if (krwAmount < 5000) {
      console.log(`[BithumbLeg.buyIoc] ${symbol} krw=${krwAmount} < 5000 최소주문금액 — 호가 잔량 부족 skip`);
      return null;
    }
    const placed = await this.client.placeMarketBuyKrw(symbol, krwAmount);
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
    _symbol?: string,
  ): Promise<{ filled: boolean; filledQty: number; grossKrw: number; feeKrw: number }> {
    try {
      const order = await this.client.getOrder(orderId);
      const filled = order.status === 'filled' && order.filledQty > 0;
      return {
        filled,
        filledQty: order.filledQty,
        grossKrw: order.avgFillPrice * order.filledQty,
        feeKrw: order.totalFeeKrw,
      };
    } catch (err: any) {
      // API 오류 → 미체결 처리. elapsed 체크가 만료를 담당.
      console.warn(`[BithumbLeg] pollOrder ${orderId} 실패 — 미체결로 처리:`, err.message);
      return { filled: false, filledQty: 0, grossKrw: 0, feeKrw: 0 };
    }
  }

  async placeMakerAsk(symbol: string, price: number, quantity: number): Promise<string | null> {
    const resp = await this.client.sellLimit(`KRW-${symbol}`, price, quantity);
    return resp?.uuid ?? null;
  }

  async cancelOrder(orderId: string, _symbol?: string): Promise<void> {
    await this.client.cancelOrder(orderId);
  }
}

/** 코인원 구현체 — cancel/poll 시 symbol 필요해서 내부 Map으로 추적 */
export class CoinoneLeg implements ExchangeLeg {
  private readonly orderSymbolMap = new Map<string, string>();

  constructor(private readonly client: CoinoneClient) {}

  async sellIoc(
    symbol: string,
    quantity: number,
    priceHint?: number,
  ): Promise<{ filledQty: number; grossKrw: number; feeKrw: number } | null> {
    // 코인원은 시장가 매도(MARKET ASK) error 107 → 지정가 ASK (bid 가격)로 즉시 체결 처리
    if (!priceHint || priceHint <= 0) {
      console.error(`[CoinoneLeg] sellIoc: priceHint 없음 — ${symbol} 주문 불가`);
      return null;
    }
    const res = await this.client.sellLimit(symbol, priceHint, quantity);
    const orderId: string = res?.order_id ?? '';
    if (!orderId) return null;
    this.orderSymbolMap.set(orderId, symbol);

    for (let i = 0; i < 6; i++) {
      const order = await this.client.getOrder(orderId, symbol);
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
    // 3초 미체결 → 취소
    try {
      await this.client.cancelOrder(orderId, symbol);
    } catch (err: any) {
      console.warn(`[CoinoneLeg] sellIoc 취소 실패 ${symbol}:`, err.message);
    }
    return null;
  }

  async buyIoc(
    symbol: string,
    quantity: number,
    priceHint: number,
    maxKrwBudget?: number,
  ): Promise<{ filledQty: number; grossKrw: number; feeKrw: number } | null> {
    const estimatedKrw = Math.ceil(quantity * priceHint);
    const krwAmount = maxKrwBudget != null ? Math.min(estimatedKrw, maxKrwBudget) : estimatedKrw;
    if (krwAmount <= 0) return null;

    const placed = await this.client.placeMarketBuyKrw(symbol, krwAmount);
    if (!placed.orderId) return null;
    this.orderSymbolMap.set(placed.orderId, symbol);

    for (let i = 0; i < 6; i++) {
      const order = await this.client.getOrder(placed.orderId, symbol);
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
    const resp = await this.client.buyLimit(symbol, price, quantity);
    const orderId: string = resp?.order_id ?? null;
    if (orderId) this.orderSymbolMap.set(orderId, symbol);
    return orderId;
  }

  async pollOrder(
    orderId: string,
    symbol?: string,
  ): Promise<{ filled: boolean; filledQty: number; grossKrw: number; feeKrw: number }> {
    try {
      const sym = this.orderSymbolMap.get(orderId) ?? symbol;
      const order = await this.client.getOrder(orderId, sym);
      const filled = order.status === 'filled' && order.filledQty > 0;
      return {
        filled,
        filledQty: order.filledQty,
        grossKrw: order.avgFillPrice * order.filledQty,
        feeKrw: order.totalFeeKrw,
      };
    } catch (err: any) {
      console.warn(`[CoinoneLeg] pollOrder ${orderId} 실패 — 미체결로 처리:`, err.message);
      return { filled: false, filledQty: 0, grossKrw: 0, feeKrw: 0 };
    }
  }

  async placeMakerAsk(symbol: string, price: number, quantity: number): Promise<string | null> {
    const resp = await this.client.sellLimit(symbol, price, quantity);
    const orderId: string = resp?.order_id ?? null;
    if (orderId) this.orderSymbolMap.set(orderId, symbol);
    return orderId;
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<void> {
    const sym = this.orderSymbolMap.get(orderId) ?? symbol;
    await this.client.cancelOrder(orderId, sym);
    this.orderSymbolMap.delete(orderId);
  }
}
