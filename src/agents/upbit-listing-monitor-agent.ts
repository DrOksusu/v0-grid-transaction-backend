import { BaseAgent } from './base-agent';
import { upbitListingMonitorService } from '../services/upbit-listing-monitor.service';
import { listingAutoSellerService } from '../services/listing-auto-seller.service';

export class UpbitListingMonitorAgent extends BaseAgent {
  constructor() {
    super({
      id: 'upbit-listing-monitor',
      name: 'UpbitListingMonitorAgent',
      description: '업비트 신규 상장 공지 5초 감지 → 빗썸/바이낸스/바이빗/MEXC 가격 추적',
      cycleIntervalMs: 5_000,
    });
  }

  protected async onStart(): Promise<void> {
    await upbitListingMonitorService.initialize();
    console.log('[UpbitListingMonitorAgent] 시작 — 공지 폴링 5초');
  }

  protected async onCycle(): Promise<void> {
    // 트위터 + 공지 API + 마켓 목록 diff 병렬 감지
    // 우선순위: 트위터(수 시간 선행, 5분 간격) > 공지 API(차단됨) > 마켓 diff(상장 직후 감지)
    await Promise.all([
      upbitListingMonitorService.pollTwitterListings(),
      upbitListingMonitorService.pollAnnouncements(),
      upbitListingMonitorService.checkNewUpbitMarkets(),
    ]);
    // 매수 체결 주문에 대한 자동매도 조건 점검
    await listingAutoSellerService.checkAndSell();
  }

  protected async onStop(): Promise<void> {
    upbitListingMonitorService.cancelPendingSnapshots();
    console.log('[UpbitListingMonitorAgent] 종료');
  }

  protected override getExtraInfo(): Record<string, any> {
    return upbitListingMonitorService.getStats();
  }
}

export const upbitListingMonitorAgent = new UpbitListingMonitorAgent();
