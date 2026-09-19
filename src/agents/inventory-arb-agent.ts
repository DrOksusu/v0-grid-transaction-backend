import { BaseAgent } from './base-agent';
import { inventoryArbService } from '../services/inventory-arb.service';

/**
 * 재고형 아비트리지 에이전트 (spec 2026-09-19)
 * - 업비트↔빗썸 크로스 스프레드 감지 → 완전자동 실행 or 반자동 알림
 * - REST 폴링 5초 주기 (BaseAgent 순차 setTimeout 루프)
 * - ⚠️ 실거래 자동 주문. 기본 OFF(enabled=false) + canary.
 */
export class InventoryArbAgent extends BaseAgent {
  constructor() {
    super({
      id: 'inventory-arb',
      name: 'InventoryArbAgent',
      description: '재고형 아비트리지 (업비트↔빗썸 크로스 스프레드, 완전자동/반자동)',
      cycleIntervalMs: 5000,
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[InventoryArbAgent] 시작 — 5초 주기 폴링 (기본 봇 OFF)');
  }

  protected async onStop(): Promise<void> {
    console.log('[InventoryArbAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    await inventoryArbService.scanOnce();
  }
}

export const inventoryArbAgent = new InventoryArbAgent();
