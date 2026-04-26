import type { ArbOpportunity } from './stablecoin-arb-detector';
import type { OrderbookTop } from './upbit-price-manager';

/** UpbitService.placeBestIoc 시그니처를 mock 가능하게 분리 */
export interface IocClient {
  placeBestIoc(
    market: string,
    side: 'bid' | 'ask',
    params: { price?: string; volume?: string },
  ): Promise<UpbitOrderResp>;
}

/** Upbit best+ioc 주문 응답 (M1 검증으로 확정된 필드만 추림).
 *  executed_volume은 일부 응답에서 누락될 수 있어 optional. parseFloat 시 '0' fallback. */
export interface UpbitOrderResp {
  uuid: string;
  state?: string;
  executed_volume?: string;
  trades?: Array<{ funds: string }>;
  paid_fee?: string;
}

/** 단일 leg 결과 */
export interface LegResult {
  uuid: string;
  filledVol: number;
  filledKrw: number;
  feeKrw: number;
}

/** executor 결과 — discriminated union */
export type ExecutorResult =
  | {
      ok: true;
      markToMarketNet: number;
      krwFlowNet: number;
      realizedSpreadBps: number;
      totalFeeKrw: number;
      legA: LegResult;
      legB: LegResult;
    }
  | {
      ok: false;
      reason: string;
      rolledBack?: boolean;
      legA?: LegResult;
      legB?: LegResult;
    };

const MIN_QTY = 0.0001;

/**
 * 직접 아비트리지 실행 (Leg-1 매도 X → Leg-2 매수 Y).
 *
 * 사전 조건 (호출자가 보장):
 *  - tradingLock 점유 상태
 *  - preCheck.runAll 통과
 *
 * P&L 두 값 추적:
 *  - markToMarketNet (주): 자산 변환 가치 포함 (mid-price 기준)
 *  - krwFlowNet (보조): KRW 입출력 차 (자산 변환 무시)
 *
 * @param opp findBestOpportunity 결과
 * @param bot StablecoinArbBot의 일부 (id, tradeSizeKrw)
 * @param balance 현재 잔고 (코인별 수량)
 * @param books 호가 스냅샷 (mark-to-market 계산용)
 * @param upbit IOC 클라이언트 (의존성 주입 — 테스트 mock 가능)
 */
export async function executeArbitrage(
  opp: ArbOpportunity,
  bot: { id: number; tradeSizeKrw: number },
  balance: Record<string, number>,
  books: ReadonlyMap<string, OrderbookTop>,
  upbit: IocClient,
): Promise<ExecutorResult> {
  // 1. 거래량 결정
  const qtyByDepth = Math.min(opp.bidSoldSize, opp.askBoughtSize);
  const qtyByBudget = bot.tradeSizeKrw / opp.askBoughtKrw;
  const qtyByBalance = balance[opp.soldCoin] ?? 0;
  const qty = Math.min(qtyByDepth, qtyByBudget, qtyByBalance);
  if (qty < MIN_QTY) {
    return { ok: false, reason: 'qty too small' };
  }

  // 2. Leg-1: best+ioc 매도 X
  const leg1Resp = await upbit.placeBestIoc(
    `KRW-${opp.soldCoin}`,
    'ask',
    { volume: qty.toFixed(8) },
  );
  const filledQtyL1 = parseFloat(leg1Resp.executed_volume || '0');
  const filledKrwL1 = (leg1Resp.trades || []).reduce(
    (s, t) => s + parseFloat(t.funds),
    0,
  );
  const paidFeeL1 = parseFloat(leg1Resp.paid_fee || '0');
  const legA: LegResult = {
    uuid: leg1Resp.uuid,
    filledVol: filledQtyL1,
    filledKrw: filledKrwL1,
    feeKrw: paidFeeL1,
  };

  if (filledQtyL1 === 0) {
    return { ok: false, reason: 'leg-1 zero fill', legA };
  }

  // 3. Leg-2: 받은 KRW로 best+ioc 매수 Y (부분 체결 시 buyKrw가 작아지므로 자동 비례 축소)
  const buyKrw = filledKrwL1 - paidFeeL1;
  const leg2Resp = await upbit.placeBestIoc(
    `KRW-${opp.boughtCoin}`,
    'bid',
    { price: buyKrw.toFixed(2) },
  );
  const filledQtyL2 = parseFloat(leg2Resp.executed_volume || '0');
  const filledKrwL2 = (leg2Resp.trades || []).reduce(
    (s, t) => s + parseFloat(t.funds),
    0,
  );
  const paidFeeL2 = parseFloat(leg2Resp.paid_fee || '0');
  const legB: LegResult = {
    uuid: leg2Resp.uuid,
    filledVol: filledQtyL2,
    filledKrw: filledKrwL2,
    feeKrw: paidFeeL2,
  };

  if (filledQtyL2 === 0) {
    // 4. Fallback: 받은 KRW로 X 재매수 (원위치 복구)
    await upbit.placeBestIoc(
      `KRW-${opp.soldCoin}`,
      'bid',
      { price: buyKrw.toFixed(2) },
    );
    return {
      ok: false,
      reason: 'leg-2 zero fill, recovered to X',
      rolledBack: true,
      legA,
      legB,
    };
  }

  // 5. P&L 계산
  const totalFeeKrw = paidFeeL1 + paidFeeL2;
  const krwFlowNet = filledKrwL1 - filledKrwL2 - totalFeeKrw;

  const bookX = books.get(`KRW-${opp.soldCoin}`);
  const bookY = books.get(`KRW-${opp.boughtCoin}`);
  const midX = bookX
    ? (bookX.bid.price + bookX.ask.price) / 2
    : opp.bidSoldKrw;
  const midY = bookY
    ? (bookY.bid.price + bookY.ask.price) / 2
    : opp.askBoughtKrw;
  const markToMarketNet =
    filledQtyL2 * midY - filledQtyL1 * midX - totalFeeKrw;

  const realizedSpreadBps = Math.floor(
    (opp.bidSoldKrw / opp.askBoughtKrw - 1) * 10000,
  );

  return {
    ok: true,
    markToMarketNet,
    krwFlowNet,
    realizedSpreadBps,
    totalFeeKrw,
    legA,
    legB,
  };
}
