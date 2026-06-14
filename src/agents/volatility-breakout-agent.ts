import { BaseAgent } from './base-agent';
import { runCycle } from '../services/volatility-breakout.service';

/**
 * 변동성 돌파(래리 윌리엄스) 자동매매 에이전트.
 * 30초 주기로 enabled 봇의 돌파 진입 + HOLDING 포지션 청산 조건을 평가한다.
 * 실제 로직은 volatility-breakout.service.ts에 위임.
 */
export class VolatilityBreakoutAgent extends BaseAgent {
  constructor() {
    super({
      id: 'volatility-breakout',
      name: 'VolatilityBreakoutAgent',
      description: '변동성 돌파(래리 윌리엄스) 자동매매 봇 — KST 09:00 사이클, 하루 1회 진입',
      cycleIntervalMs: 30_000,
    });
  }

  protected async onStart(): Promise<void> {
    // HOLDING 포지션은 DB row 기반이라 별도 복구 작업 불필요 — 첫 사이클에서 자동 감시 재개
  }

  protected async onStop(): Promise<void> {}

  protected async onCycle(): Promise<void> {
    await runCycle();
  }
}
