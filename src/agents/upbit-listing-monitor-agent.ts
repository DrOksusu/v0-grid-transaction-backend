import { BaseAgent } from './base-agent';
import { upbitListingMonitorService } from '../services/upbit-listing-monitor.service';

/**
 * 업비트 신규 상장 공지 모니터링 에이전트
 * - 30초마다 업비트 공지 폴링 → 신규 상장 감지
 * - 10초마다 업비트 마켓 목록 확인 → 실제 상장 시점 감지
 * - 공지 감지 시 바이낸스/바이빗/MEXC/빗썸 가격 즉시 스냅샷
 * - +1h, +4h, +24h 후 추가 스냅샷 자동 스케줄
 */
export class UpbitListingMonitorAgent extends BaseAgent {
  // 공지 폴링 주기 카운터 (30s = 3 * 10s)
  private announcePollCounter = 0;

  constructor() {
    super({
      id: 'upbit-listing-monitor',
      name: 'UpbitListingMonitorAgent',
      description: '업비트 신규 상장 공지 감지 + 멀티거래소 가격 추적',
      cycleIntervalMs: 10_000, // 10초마다 tick
    });
  }

  protected async onStart(): Promise<void> {
    await upbitListingMonitorService.initialize();
    console.log('[UpbitListingMonitorAgent] 시작 — 공지 폴링 30s, 마켓 체크 10s');
  }

  protected async onCycle(): Promise<void> {
    // 매 tick: 업비트 마켓 목록 확인 (상장 시점 감지)
    await upbitListingMonitorService.checkNewUpbitMarkets();

    // 3 tick(30s)마다 공지 폴링
    this.announcePollCounter++;
    if (this.announcePollCounter >= 3) {
      this.announcePollCounter = 0;
      await upbitListingMonitorService.pollAnnouncements();
    }
  }

  protected async onStop(): Promise<void> {
    console.log('[UpbitListingMonitorAgent] 종료');
  }
}

export const upbitListingMonitorAgent = new UpbitListingMonitorAgent();
