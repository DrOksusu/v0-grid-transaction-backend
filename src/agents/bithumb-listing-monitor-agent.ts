import { BaseAgent } from './base-agent';
import { bithumbListingMonitorService } from '../services/bithumb-listing-monitor.service';
import { listingAutoSellerService } from '../services/listing-auto-seller.service';

export class BithumbListingMonitorAgent extends BaseAgent {
  constructor() {
    super({
      id: 'bithumb-listing-monitor',
      name: 'BithumbListingMonitorAgent',
      description: '빗썸 신규 상장 5초 감지 (텔레그램 + 마켓 diff)',
      cycleIntervalMs: 5_000,
    });
  }

  protected async onStart(): Promise<void> {
    await bithumbListingMonitorService.initialize();
    console.log('[BithumbListingMonitorAgent] 시작 — 텔레그램 + 마켓 diff 5초');
  }

  protected async onCycle(): Promise<void> {
    // 텔레그램 + 마켓 목록 diff 병렬 감지
    await Promise.allSettled([
      bithumbListingMonitorService.pollBithumbTelegram(),
      bithumbListingMonitorService.checkNewBithumbMarkets(),
    ]);
    // 매수 체결 주문에 대한 자동매도 조건 점검 (source 분기로 빗썸 주문도 처리됨)
    await listingAutoSellerService.checkAndSell();
  }

  protected async onStop(): Promise<void> {
    console.log('[BithumbListingMonitorAgent] 종료');
  }

  protected override getExtraInfo(): Record<string, any> {
    return bithumbListingMonitorService.getStats();
  }
}

export const bithumbListingMonitorAgent = new BithumbListingMonitorAgent();
