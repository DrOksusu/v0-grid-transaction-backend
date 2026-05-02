import { BaseAgent } from './base-agent';
import { pairScannerService } from '../services/pair-scanner.service';

export class PairScannerAgent extends BaseAgent {
  constructor() {
    super({
      id: 'pair-scanner',
      name: 'PairScannerAgent',
      description: 'Upbit 다중 페어 실시간 spread 모니터링 및 break-even 통계',
      cycleIntervalMs: 0,
    });
  }

  protected async onStart(): Promise<void> {
    pairScannerService.start();
  }

  protected async onStop(): Promise<void> {
    pairScannerService.stop();
  }

  protected async onCycle(): Promise<void> {
    // 이벤트 드리븐 — 사이클 루프 불필요
  }

  protected override getExtraInfo(): Record<string, any> {
    const snapshot = pairScannerService.getSnapshot();
    return {
      pairs: snapshot.pairs.length,
      wsConnected: snapshot.wsConnected,
      stats: snapshot.stats,
    };
  }
}
