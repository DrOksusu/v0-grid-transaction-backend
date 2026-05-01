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

/** 주문이 filled/cancelled/failed 등 종료 상태가 될 때까지 deadline 내에서 polling */
async function pollOrderUntilDone(
  client: ExchangeClient,
  orderId: string,
  maxMs: number,
  intervalMs: number,
): Promise<PlacedOrder> {
  const deadline = Date.now() + maxMs;
  let last = await client.getOrder(orderId);
  while (last.status === 'pending' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    last = await client.getOrder(orderId);
  }
  return last;
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
    legAFinal = await pollOrderUntilDone(legAClient, legAPlaced.orderId, pollMax, pollInt);
    if (legAFinal.status !== 'filled') {
      return {
        status: 'LEG_A_FAILED',
        failureReason: `LegA polling timeout (${legAFinal.status})`,
        shouldKillSwitch: false,
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
    legBFinal = await pollOrderUntilDone(legBClient, legBPlaced.orderId, pollMax, pollInt);
    if (legBFinal.status !== 'filled') {
      return {
        status: 'LEG_B_FAILED',
        legA: { ...legAFinal, exchange: legAClient.exchangeName, side: legASide },
        failureReason: `LegB polling timeout (${legBFinal.status})`,
        shouldKillSwitch: true,
      };
    }
  }

  // === P&L 계산 ===
  // 매수(legA): KRW 지출, 매도(legB): KRW 수령
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
