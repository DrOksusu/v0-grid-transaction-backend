import { BaseAgent } from './base-agent';
import { multiExchangeArbScannerService } from '../services/multi-exchange-arb-scanner.service';

/**
 * 멀티 거래소 차익거래 알림 에이전트 (spec 2026-09-14)
 * - 업비트·빗썸·바이낸스·MEXC·Gate.io 5개 거래소 공통 상장 코인 스캔
 * - 60초 폴링 (BaseAgent 순차 setTimeout 루프 — 사이클 겹침 없음)
 * - 알림 전용 (주문 실행 없음)
 */
export class MultiExchangeArbAgent extends BaseAgent {
  constructor() {
    super({
      id: 'multi-exchange-arb',
      name: 'MultiExchangeArbAgent',
      description: '멀티 거래소(업비트·빗썸·바이낸스·MEXC·Gate.io) 차익 기회 스캔 + 카카오톡 알림 (실행 없음)',
      cycleIntervalMs: 60000, // 60초 (spec §9)
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[MultiExchangeArbAgent] 시작 — 60초 주기 스캔');
  }

  protected async onStop(): Promise<void> {
    console.log('[MultiExchangeArbAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    // 에러는 BaseAgent 사이클 루프가 잡아 metrics.errors에 집계 (spec §9)
    await multiExchangeArbScannerService.scanOnce();
  }

  protected override getExtraInfo(): Record<string, any> {
    return { ...multiExchangeArbScannerService.getLastScanSummary() };
  }
}

export const multiExchangeArbAgent = new MultiExchangeArbAgent();
