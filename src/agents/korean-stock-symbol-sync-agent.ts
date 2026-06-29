import { BaseAgent } from './base-agent';
import { koreanStockSymbolSyncService } from '../services/korean-stock-symbol-sync.service';

const ONE_HOUR_MS = 60 * 60 * 1000;
const SYNC_HOUR_KST = 16; // KST 16:00 (장 마감 후)

export class KoreanStockSymbolSyncAgent extends BaseAgent {
  private lastSyncDate: string | null = null;

  constructor() {
    super({
      id: 'korean-stock-symbol-sync',
      name: 'KoreanStockSymbolSyncAgent',
      description: '한국주식 종목 마스터 일일 sync (KST 16:00)',
      cycleIntervalMs: ONE_HOUR_MS,
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[KoreanStockSymbolSyncAgent] 시작');
  }

  protected async onCycle(): Promise<void> {
    // KST = UTC + 9시간
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const kstHour = kst.getUTCHours();
    const dateOnly = kst.toISOString().slice(0, 10);

    // KST 16시대가 아니거나, 오늘 이미 sync 했으면 skip
    if (kstHour !== SYNC_HOUR_KST) return;
    if (this.lastSyncDate === dateOnly) return;

    try {
      const result = await koreanStockSymbolSyncService.syncAll();
      this.lastSyncDate = dateOnly;
      console.log(`[KoreanStockSymbolSyncAgent] sync 완료: ${JSON.stringify(result)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[KoreanStockSymbolSyncAgent] sync 실패:', msg);
    }
  }

  protected async onStop(): Promise<void> {
    // no-op
  }
}

export const koreanStockSymbolSyncAgent = new KoreanStockSymbolSyncAgent();
