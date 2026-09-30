import { BaseAgent } from './base-agent';
import { reclaimService } from '../services/reclaim/reclaim.service';

/**
 * 재고 되돌림 리컨실러 에이전트.
 * - 빗썸에 묶인 전송 비싼 재고를 되돌림(빗썸 매도+업비트 매수) 순차익≥임계 시 자동 체결 → 업비트 재장전
 * - 30초 주기 폴링 (BaseAgent 순차 setTimeout 루프)
 * - ⚠️ 실거래 자동 주문. 기본 OFF(enabled=false) + canary + 관리자 전용.
 */
export class ReclaimAgent extends BaseAgent {
  constructor() {
    super({
      id: 'reclaim',
      name: 'ReclaimAgent',
      description: '재고 되돌림 리컨실러 (빗썸→업비트 재장전)',
      cycleIntervalMs: 30000, // 30초
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[ReclaimAgent] 시작 — 30초 주기 (기본 OFF)');
  }

  protected async onStop(): Promise<void> {
    console.log('[ReclaimAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    await reclaimService.scanOnce();
  }
}

export const reclaimAgent = new ReclaimAgent();
