/**
 * 직접 아비트리지 봇용 자동 kill switch 트리거.
 *
 * spec §7 #1 (3회 연속 leg-2 실패) + #2 (일일 손실 한도) 만 PR C 범위.
 * #3 (재고 reconcile) #4 (Upbit 5xx 5회) 는 PR D/C-followup.
 *
 * 호출 위치: StablecoinArbAgent.processLiveBot()이 executor 결과 받은 직후.
 * 트리거 시 agent가 arbService.setKillSwitch(userId, true) + Socket.IO emit.
 *
 * 카운터는 process-local in-memory (Map<botId, number>).
 * 컨테이너 재시작 시 reset되는 것은 의도적 — 재시작이 곧 kill switch trial 리셋 역할.
 */

const MAX_CONSECUTIVE_LEG2_FAILURES = 3;

// botId → 연속 leg-2 실패 횟수 (process-local in-memory)
const consecutiveLeg2Failures = new Map<number, number>();

export type KillSwitchInput = {
  botId: number;
  todayNetProfitKrw: number;
  dailyLossLimitKrw: number;
};

export type KillSwitchResult =
  | {
      trigger: true;
      reason: 'daily_loss_limit' | 'leg2_consecutive_failures';
      detail: string;
    }
  | { trigger: false };

/**
 * trigger 조건 검사. 우선순위: daily_loss_limit > leg2_consecutive_failures.
 *
 * 일일 손실은 strict less-than(`<`)으로 판정 — 한도와 정확히 같을 때는 trigger=false.
 */
export function shouldTriggerKillSwitch(input: KillSwitchInput): KillSwitchResult {
  // #2 일일 손실 (우선순위 1)
  if (input.todayNetProfitKrw < -input.dailyLossLimitKrw) {
    return {
      trigger: true,
      reason: 'daily_loss_limit',
      detail: `오늘 누적 손실 ${input.todayNetProfitKrw}원 ≥ 한도 ${input.dailyLossLimitKrw}원`,
    };
  }

  // #1 leg-2 연속 실패 (우선순위 2)
  const fails = consecutiveLeg2Failures.get(input.botId) ?? 0;
  if (fails >= MAX_CONSECUTIVE_LEG2_FAILURES) {
    return {
      trigger: true,
      reason: 'leg2_consecutive_failures',
      detail: `직접 아비트리지 leg-2 실패 ${fails}회 연속`,
    };
  }

  return { trigger: false };
}

/**
 * leg-2 실패 (rolled back 또는 zero fill) 시 호출.
 * 해당 봇의 연속 실패 카운터를 +1 한다.
 */
export function recordLeg2Failure(botId: number): void {
  const cur = consecutiveLeg2Failures.get(botId) ?? 0;
  consecutiveLeg2Failures.set(botId, cur + 1);
}

/**
 * leg-2 성공 시 호출. 해당 봇 카운터만 0으로 reset (다른 봇 카운터는 영향 없음).
 * delete가 아닌 set(0)을 사용 — getCounters()에서 명시적으로 0임을 확인 가능.
 */
export function recordLeg2Success(botId: number): void {
  consecutiveLeg2Failures.set(botId, 0);
}

/**
 * 테스트/관리자용. 모든 카운터 초기화.
 */
export function resetCounters(): void {
  consecutiveLeg2Failures.clear();
}

/**
 * 테스트/디버깅용. 현재 카운터 snapshot 반환 (Map 사본 아님 — 직접 수정 금지).
 */
export function getCounters(): ReadonlyMap<number, number> {
  return consecutiveLeg2Failures;
}
