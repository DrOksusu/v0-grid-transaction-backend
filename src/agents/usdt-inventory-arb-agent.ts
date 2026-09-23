import { BaseAgent } from './base-agent';
import mainPrisma from '../config/database';
import { usdtInventoryService } from '../services/inventory-arb/usdt-inventory.service';

/**
 * USDT권 재고형 아비트리지 에이전트 (Gate↔MEXC, spec 2026-09-23)
 * - Gate에서 ALEO 매수 + MEXC에서 ALEO 매도(동시, 재고 배치상 단방향). 전송 없음.
 * - REST 폴링 5초 주기 (BaseAgent 순차 setTimeout 루프)
 * - ⚠️ 실거래 자동 주문. 기본 OFF(enabled=false) + canary.
 */
export class UsdtInventoryArbAgent extends BaseAgent {
  constructor() {
    super({
      id: 'usdt-inventory-arb',
      name: 'UsdtInventoryArbAgent',
      description: 'USDT권 재고형 아비트리지 (Gate↔MEXC, 완전자동/반자동)',
      cycleIntervalMs: 5000,
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[UsdtInventoryArbAgent] 시작 — 5초 주기 폴링 (기본 봇 OFF)');
  }

  protected async onStop(): Promise<void> {
    console.log('[UsdtInventoryArbAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    const bots = await mainPrisma.usdtInventoryArbBot.findMany({ where: { enabled: true } });
    for (const bot of bots) {
      try {
        await usdtInventoryService.runOnce(bot);
      } catch (err: any) {
        console.error(`[UsdtInventoryArbAgent] bot ${bot.id} 처리 실패:`, err.message);
      }
    }
  }
}

export const usdtInventoryArbAgent = new UsdtInventoryArbAgent();
