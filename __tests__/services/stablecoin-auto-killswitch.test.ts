import {
  shouldTriggerKillSwitch,
  recordLeg2Failure,
  recordLeg2Success,
  resetCounters,
  getCounters,
} from '../../src/services/stablecoin-auto-killswitch';

describe('stablecoin-auto-killswitch', () => {
  beforeEach(() => {
    // 각 테스트 전 카운터 초기화 (테스트 간 격리)
    resetCounters();
  });

  it('일일 손실 한도 도달 → trigger=true reason="daily_loss_limit"', () => {
    const result = shouldTriggerKillSwitch({
      botId: 1,
      todayNetProfitKrw: -10001,
      dailyLossLimitKrw: 10000,
    });
    expect(result).toEqual({
      trigger: true,
      reason: 'daily_loss_limit',
      detail: '오늘 누적 손실 -10001원 ≥ 한도 10000원',
    });
  });

  it('일일 손실 한도 정확히 같을 때 trigger=false (이하만 통과)', () => {
    const result = shouldTriggerKillSwitch({
      botId: 1,
      todayNetProfitKrw: -10000,
      dailyLossLimitKrw: 10000,
    });
    expect(result.trigger).toBe(false);
  });

  it('leg-2 실패 3회 누적 → 3회째에 trigger=true', () => {
    recordLeg2Failure(1);
    recordLeg2Failure(1);
    expect(getCounters().get(1)).toBe(2);

    recordLeg2Failure(1);
    const result = shouldTriggerKillSwitch({
      botId: 1,
      todayNetProfitKrw: 0,
      dailyLossLimitKrw: 10000,
    });
    expect(result).toEqual({
      trigger: true,
      reason: 'leg2_consecutive_failures',
      detail: '직접 아비트리지 leg-2 실패 3회 연속',
    });
  });

  it('leg-2 성공 시 카운터 reset (다른 봇 카운터 영향 없음)', () => {
    recordLeg2Failure(1);
    recordLeg2Failure(1);
    recordLeg2Failure(2);
    recordLeg2Success(1);
    expect(getCounters().get(1)).toBe(0);
    expect(getCounters().get(2)).toBe(1);
  });

  it('일일 손실 우선 (둘 다 도달 시 daily_loss_limit 먼저)', () => {
    recordLeg2Failure(1);
    recordLeg2Failure(1);
    recordLeg2Failure(1);
    const result = shouldTriggerKillSwitch({
      botId: 1,
      todayNetProfitKrw: -20000,
      dailyLossLimitKrw: 10000,
    });
    expect(result.trigger).toBe(true);
    if (result.trigger) {
      expect(result.reason).toBe('daily_loss_limit');
    }
  });
});
