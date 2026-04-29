/**
 * Maker placement 직전 잔고 사전 검증 (순수 함수).
 *
 * Maker leg(저유동성 코인 매수)와 Taker leg(고유동성 코인 매도) 양쪽에
 * 필요한 자산을 모두 갖췄는지 검증. BalanceCache 결과(5초 TTL)를 입력으로 받음.
 *
 * - Taker leg 사전 예약: takerCoin 잔고 ≥ quantity
 * - Maker leg 자금: KRW 잔고 ≥ makerOrderPrice × quantity × (1 + makerFeeBps/10000)
 *
 * 검증 순서: takerCoin → KRW (taker 자산 부족이 더 치명적이므로 먼저 차단).
 *
 * 주의: BalanceCache TTL 5초이므로 best-effort. 동시 인출 race는
 * minTakerBalance 자동 일시정지(maker-taker-min-balance-guard)로 보완.
 */

export interface BalancePrecheckArgs {
  takerCoin: string;
  quantity: number;
  makerOrderPrice: number;
  makerFeeBps: number;
  balances: Record<string, number>;
}

export interface BalancePrecheckResult {
  ok: boolean;
  reason?: string;
}

export function checkMakerPlacementBalance(
  args: BalancePrecheckArgs,
): BalancePrecheckResult {
  const { takerCoin, quantity, makerOrderPrice, makerFeeBps, balances } = args;

  // 1. Taker leg 자산 (사전 예약)
  const takerBalance = balances[takerCoin] ?? 0;
  if (takerBalance < quantity) {
    return {
      ok: false,
      reason: `${takerCoin} balance ${takerBalance} < required ${quantity} (taker leg reservation)`,
    };
  }

  // 2. Maker leg 자금 (수수료 포함)
  const krwBalance = balances.KRW ?? 0;
  const requiredKrw = makerOrderPrice * quantity * (1 + makerFeeBps / 10000);
  if (krwBalance < requiredKrw) {
    return {
      ok: false,
      reason: `KRW balance ${krwBalance.toFixed(0)} < required ${requiredKrw.toFixed(0)} (maker leg with fee)`,
    };
  }

  return { ok: true };
}
