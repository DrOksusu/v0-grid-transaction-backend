/**
 * Taker leg 자산 잔고 < minTakerBalance 시 자동 일시정지 신호 (순수 함수).
 *
 * 봇 운영 중 USDT 재고가 일정 수준 이하로 떨어지면 자동 enabled=false 처리하여
 * 의도치 않은 거래 누적을 차단. 호출자(agent)가 결과를 받아 DB 업데이트.
 *
 * minTakerBalance가 null/undefined면 기능 비활성 (legacy 봇 호환).
 * 정확히 minTakerBalance와 같으면 noop (경계값은 안전한 쪽으로 판정).
 */

export interface MinBalanceGuardArgs {
  takerCoin: string;
  takerBalance: number;
  minTakerBalance: number | null | undefined;
}

export interface MinBalanceGuardResult {
  autoPause: boolean;
  reason?: string;
}

export function shouldAutoPauseForMinBalance(
  args: MinBalanceGuardArgs,
): MinBalanceGuardResult {
  const { takerCoin, takerBalance, minTakerBalance } = args;

  if (minTakerBalance === null || minTakerBalance === undefined) {
    return { autoPause: false };
  }

  if (takerBalance < minTakerBalance) {
    return {
      autoPause: true,
      reason: `${takerCoin} balance ${takerBalance} < minTakerBalance ${minTakerBalance}`,
    };
  }

  return { autoPause: false };
}
