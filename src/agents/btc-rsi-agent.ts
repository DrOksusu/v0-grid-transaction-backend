// BTC RSI 상승 다이버전스 감지 에이전트 — 15분 주기
import { BaseAgent } from './base-agent';
import { btcRsiMonitorService } from '../services/btc-rsi-monitor.service';

export class BtcRsiAgent extends BaseAgent {
  constructor() {
    super({
      id: 'btc-rsi',
      name: 'BtcRsiAgent',
      description: 'BTC 4시간봉 RSI 상승 다이버전스 감지 → 카카오톡 알림',
      cycleIntervalMs: 15 * 60 * 1000, // 15분
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[BtcRsiAgent] 시작 — 15분 주기로 RSI 다이버전스 모니터링');
  }

  protected async onStop(): Promise<void> {
    console.log('[BtcRsiAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    await btcRsiMonitorService.check();
  }

  protected getExtraInfo(): Record<string, any> {
    return {
      interval: '4h 캔들 기준 RSI 상승 다이버전스',
      cooldown: '8시간',
    };
  }
}
