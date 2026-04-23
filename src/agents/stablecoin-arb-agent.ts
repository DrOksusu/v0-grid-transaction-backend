import { BaseAgent } from './base-agent';
import {
  subscribeStablecoinOrderbooks,
  unsubscribeStablecoinOrderbooks,
  getAllStablecoinOrderbooks,
  onStablecoinOrderbookUpdate,
} from '../services/upbit-price-manager';
import { findBestOpportunity } from '../services/stablecoin-arb-detector';
import * as arbService from '../services/stablecoin-arb.service';
import prisma from '../config/database';

/**
 * M2 단계 detection-only 에이전트.
 *
 * 호가 업데이트마다 활성 봇별 기회를 감지해 DB에 기록만 하고
 * 실제 주문은 수행하지 않는다. M3에서 executor와 연결되어 실거래로 전환된다.
 */
export class StablecoinArbAgent extends BaseAgent {
  // 구독 해제 함수 (onStart에서 설정, onStop에서 호출)
  private unsubscribe: (() => void) | null = null;
  // 동시 evaluate 진입 방지 플래그
  private evaluateInFlight = false;

  constructor() {
    super({
      id: 'stablecoin-arb',
      name: 'StablecoinArbAgent',
      description: 'Upbit 스테이블코인 간 아비트리지 봇 (M2: detection-only)',
      cycleIntervalMs: 0, // 이벤트 드리븐 — 사이클 루프 불필요
    });
  }

  /** 에이전트 시작: 호가 WebSocket 구독 및 업데이트 리스너 등록 */
  protected async onStart(): Promise<void> {
    subscribeStablecoinOrderbooks();
    this.unsubscribe = onStablecoinOrderbookUpdate(() => {
      // 동기 콜백이므로 async evaluate는 fire-and-forget. 내부에서 에러 격리됨.
      this.evaluate().catch((err: Error) => {
        console.error('[StablecoinArbAgent] evaluate unhandled:', err.message);
      });
    });
    console.log('[StablecoinArbAgent] detection-only 모드로 시작');
  }

  /** 에이전트 정지: 리스너 제거 후 WebSocket 구독 해제 */
  protected async onStop(): Promise<void> {
    // 리스너 제거를 먼저 수행해야 unsubscribeStablecoinOrderbooks() 이후 이벤트가 콜백에 도달하지 않음
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    unsubscribeStablecoinOrderbooks();
    console.log('[StablecoinArbAgent] 정지');
  }

  /** 이벤트 드리븐 에이전트 — 주기적 사이클은 사용하지 않음 */
  protected async onCycle(): Promise<void> {
    // intentionally empty
  }

  /**
   * 호가 업데이트 시 모든 활성 봇에 대해 기회 감지.
   * 동시 evaluate 호출 방지를 위해 evaluateInFlight 플래그 체크.
   */
  private async evaluate(): Promise<void> {
    // 이전 evaluate 아직 진행 중 → 이번 틱은 스킵
    if (this.evaluateInFlight) return;
    this.evaluateInFlight = true;

    try {
      // enabled=true이고 킬스위치가 꺼진 활성 봇만 조회
      const bots = await prisma.stablecoinArbBot.findMany({
        where: { enabled: true, killSwitch: false },
      });
      if (bots.length === 0) return;

      const books = getAllStablecoinOrderbooks();

      for (const bot of bots) {
        const coinsEnabled = (bot.coinsEnabled as string[]) || [];
        // 비교에 최소 2종 코인 필요
        if (coinsEnabled.length < 2) continue;

        const opp = findBestOpportunity(books, coinsEnabled, bot.entryThresholdBps);
        if (!opp) continue;

        try {
          // M2: 감지 결과만 DB에 기록. 실제 주문 없음.
          await arbService.logOpportunity({
            botId: bot.id,
            detectedAt: new Date(opp.detectedAt),
            soldCoin: opp.soldCoin,
            boughtCoin: opp.boughtCoin,
            bidSoldKrw: opp.bidSoldKrw,
            askBoughtKrw: opp.askBoughtKrw,
            spreadBps: opp.spreadBps,
            executed: false,
            skipReason: 'detection_only_mode',
          });
        } catch (err: any) {
          // DB 쓰기 실패는 로그만 남기고 다음 봇 계속 처리
          console.error(`[StablecoinArbAgent] bot ${bot.id} logOpportunity 실패:`, err.message);
        }
      }
    } catch (err: any) {
      // 예상치 못한 에러는 메트릭에 기록
      this.metrics.errors++;
      this.metrics.lastError = err.message;
      console.error('[StablecoinArbAgent] evaluate error:', err.message);
    } finally {
      this.evaluateInFlight = false;
    }
  }
}
