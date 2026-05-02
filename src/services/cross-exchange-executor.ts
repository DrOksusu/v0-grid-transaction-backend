// src/services/cross-exchange-executor.ts
// Cross-exchange arbitrage executor (Sequential + No Fallback 패턴, PR E2 maker-taker 패턴 차용)
// LegA 매수 → 체결 대기 → 성공 시 LegB 매도 → 체결 대기 순서.
// LegA 실패 시 LegB 호출 안 함. LegB 실패 시 LegA 재고 노출 → shouldKillSwitch=true.

import { ExchangeClient, PlacedOrder } from './exchange/exchange-client';

export interface ExecutorArgs {
  botId: number;
  direction: 'UB' | 'BU';
  coin: string;
  quantity: number;
  spreadBps: number;
  upbit: ExchangeClient;
  bithumb: ExchangeClient;
  pollingMaxMs?: number;
  pollingIntervalMs?: number;
}

export interface ExecutorLegInfo extends PlacedOrder {
  exchange: 'upbit' | 'bithumb';
  side: 'buy' | 'sell';
}

export interface ExecutorResult {
  status: 'FILLED' | 'LEG_A_FAILED' | 'LEG_B_FAILED';
  legA?: ExecutorLegInfo;
  legB?: ExecutorLegInfo;
  profitKrw?: number;
  failureReason?: string;
  shouldKillSwitch: boolean;
}

/**
 * 주문이 filled/cancelled/failed 등 종료 상태가 될 때까지 deadline 내에서 polling.
 * getOrder 가 throw 하면 order=null + pollError 로 반환 (라이브 머니 경로에서 unhandled
 * rejection 으로 빠지면 재고 노출 위험 → 호출자가 명시적으로 처리).
 */
async function pollOrderUntilDone(
  client: ExchangeClient,
  orderId: string,
  maxMs: number,
  intervalMs: number,
): Promise<{ order: PlacedOrder | null; pollError?: string }> {
  const deadline = Date.now() + maxMs;
  try {
    let last = await client.getOrder(orderId);
    while (last.status === 'pending' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, intervalMs));
      last = await client.getOrder(orderId);
    }
    return { order: last };
  } catch (err: any) {
    return { order: null, pollError: err?.message ?? String(err) };
  }
}

/**
 * 양다리 주문 실행 (Sequential + No Fallback).
 * - LegA 실패 → LegB 절대 호출 안 함
 * - LegB 실패 → shouldKillSwitch=true (LegA 재고 노출 위험)
 * - 양쪽 체결 → P&L = legB금액 - legA금액 - 수수료A - 수수료B
 *
 * DB 기록/로깅은 호출자(agent, Task 11)가 담당.
 */
export async function execute(args: ExecutorArgs): Promise<ExecutorResult> {
  const pollMax = args.pollingMaxMs ?? 5000;
  const pollInt = args.pollingIntervalMs ?? 100;

  // 방향 결정: UB = Upbit 매수 + Bithumb 매도, BU = Bithumb 매수 + Upbit 매도
  const isUB = args.direction === 'UB';
  const legAClient = isUB ? args.upbit : args.bithumb;
  const legBClient = isUB ? args.bithumb : args.upbit;
  const legASide: 'buy' | 'sell' = 'buy';
  const legBSide: 'buy' | 'sell' = 'sell';

  // === LegA: placement ===
  let legAPlaced: PlacedOrder;
  try {
    legAPlaced = await legAClient.placeMarketOrder(legASide, args.coin, args.quantity);
  } catch (err: any) {
    return {
      status: 'LEG_A_FAILED',
      failureReason: `LegA placement: ${err?.message ?? err}`,
      shouldKillSwitch: false,
    };
  }

  // === LegA: polling until filled or deadline ===
  let legAFinal: PlacedOrder;
  if (legAPlaced.status === 'filled') {
    legAFinal = legAPlaced;
  } else {
    const polled = await pollOrderUntilDone(legAClient, legAPlaced.orderId, pollMax, pollInt);
    if (polled.order === null) {
      // 폴링 도중 throw → 주문 최종 상태 알 수 없음 → 재고 노출 가능 → kill switch
      return {
        status: 'LEG_A_FAILED',
        failureReason: `LegA polling error: ${polled.pollError}`,
        shouldKillSwitch: true,
      };
    }
    legAFinal = polled.order;
    if (legAFinal.status !== 'filled') {
      // partial / cancelled with executed_volume>0 → 재고 노출 → kill switch
      // pending(timeout) / cancelled with 0 fill → 재고 없음 → kill switch 불필요
      const inventoryExposed = legAFinal.filledQty > 0;
      return {
        status: 'LEG_A_FAILED',
        legA: inventoryExposed
          ? { ...legAFinal, exchange: legAClient.exchangeName, side: legASide }
          : undefined,
        failureReason: `LegA not filled: status=${legAFinal.status}, filledQty=${legAFinal.filledQty}`,
        shouldKillSwitch: inventoryExposed,
      };
    }
  }

  // === LegB: placement (LegA가 filled 확정된 후에만) ===
  let legBPlaced: PlacedOrder;
  try {
    legBPlaced = await legBClient.placeMarketOrder(legBSide, args.coin, args.quantity);
  } catch (err: any) {
    return {
      status: 'LEG_B_FAILED',
      legA: { ...legAFinal, exchange: legAClient.exchangeName, side: legASide },
      failureReason: `LegB placement: ${err?.message ?? err}`,
      shouldKillSwitch: true,
    };
  }

  // === LegB: polling ===
  let legBFinal: PlacedOrder;
  if (legBPlaced.status === 'filled') {
    legBFinal = legBPlaced;
  } else {
    const polled = await pollOrderUntilDone(legBClient, legBPlaced.orderId, pollMax, pollInt);
    if (polled.order === null) {
      // LegB 폴링 throw → LegA 재고 무조건 노출 → kill switch
      return {
        status: 'LEG_B_FAILED',
        legA: { ...legAFinal, exchange: legAClient.exchangeName, side: legASide },
        failureReason: `LegB polling error: ${polled.pollError}`,
        shouldKillSwitch: true,
      };
    }
    legBFinal = polled.order;
    if (legBFinal.status !== 'filled') {
      // LegB partial / pending / cancelled — LegA 재고 노출 + LegB 일부 체결 가능 → 무조건 kill switch
      // legB 정보도 result 에 포함해 reconcile 가능하게 함
      return {
        status: 'LEG_B_FAILED',
        legA: { ...legAFinal, exchange: legAClient.exchangeName, side: legASide },
        legB: { ...legBFinal, exchange: legBClient.exchangeName, side: legBSide },
        failureReason: `LegB not filled: status=${legBFinal.status}, filledQty=${legBFinal.filledQty}`,
        shouldKillSwitch: true,
      };
    }
  }

  // === Quantity mismatch 가드 ===
  // 양쪽 모두 'filled' 라도 수량이 다르면 lopsided position. canary 5건에서도 안 잡힐 수 있으므로
  // P&L 계산하지 말고 reconcile 대상으로 분류.
  if (legAFinal.filledQty !== legBFinal.filledQty) {
    return {
      status: 'LEG_B_FAILED',
      legA: { ...legAFinal, exchange: legAClient.exchangeName, side: legASide },
      legB: { ...legBFinal, exchange: legBClient.exchangeName, side: legBSide },
      failureReason: `quantity mismatch: legA ${legAFinal.filledQty} != legB ${legBFinal.filledQty}`,
      shouldKillSwitch: true,
    };
  }

  // === P&L 계산 ===
  // P&L semantics: avgFillPrice 가 fee 를 제외한 raw price 라고 가정. Upbit executed_funds = price*qty 이고
  // paid_fee 는 별도. 이 가정이 틀리면 totalFeeKrw 가 이중 차감되어 profit 이 실제보다 낮게 나옴.
  // Stage 1 canary 첫 FILLED row 에서 검증: profitKrw vs (Upbit 거래내역 net + Bithumb 거래내역 net).
  // 불일치 시 즉시 공식 재검토.
  const legAKrw = legAFinal.filledQty * legAFinal.avgFillPrice;
  const legBKrw = legBFinal.filledQty * legBFinal.avgFillPrice;
  const profitKrw = legBKrw - legAKrw - legAFinal.totalFeeKrw - legBFinal.totalFeeKrw;

  return {
    status: 'FILLED',
    legA: { ...legAFinal, exchange: legAClient.exchangeName, side: legASide },
    legB: { ...legBFinal, exchange: legBClient.exchangeName, side: legBSide },
    profitKrw,
    shouldKillSwitch: false,
  };
}
