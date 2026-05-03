import { BaseAgent } from './base-agent';
import { priceManager } from '../services/upbit-price-manager';
import { bithumbPriceManager } from '../services/bithumb-grid-price-manager';
import { generalArbScannerService } from '../services/general-arb-scanner.service';
import { socketService } from '../services/socket.service';

/**
 * 업비트-빗썸 일반 종목 아비트리지 스캐너 에이전트
 * - 실행(주문) 없이 모니터링 전용
 * - 이벤트 드리븐: 가격 업데이트 시 스냅샷 갱신 + Socket.IO 브로드캐스트
 */
export class GeneralArbScannerAgent extends BaseAgent {
  // 현재 등록된 가격 핸들러 (제거 시 동일 참조 필요)
  private priceHandler: ((ticker: string, price: number) => void) | null = null;
  // Socket.IO emit 디바운스 타이머 (연속 가격 업데이트 병합)
  private emitDebounceTimer: NodeJS.Timeout | null = null;
  // 현재 구독 중인 티커 목록 (KRW-BTC 형식)
  private subscribedTickers: Set<string> = new Set();

  constructor() {
    super({
      id: 'general-arb-scanner',
      name: 'GeneralArbScannerAgent',
      description: '업비트-빗썸 일반 종목 아비트리지 기회 탐색 (실행 없음, 모니터링 전용)',
      cycleIntervalMs: 0, // 이벤트 드리븐 — 주기 루프 불필요
    });
  }

  protected async onStart(): Promise<void> {
    await this.restartSubscriptions();
    console.log('[GeneralArbScannerAgent] 시작');
  }

  protected async onStop(): Promise<void> {
    // 가격 이벤트 리스너 제거
    if (this.priceHandler) {
      priceManager.removeOnPrice(this.priceHandler);
      bithumbPriceManager.removeOnPrice(this.priceHandler);
      this.priceHandler = null;
    }

    // 모든 티커 구독 해제
    for (const ticker of this.subscribedTickers) {
      priceManager.unsubscribe(ticker);
      bithumbPriceManager.unsubscribe(ticker);
    }
    this.subscribedTickers.clear();

    // 디바운스 타이머 정리
    if (this.emitDebounceTimer) {
      clearTimeout(this.emitDebounceTimer);
      this.emitDebounceTimer = null;
    }

    console.log('[GeneralArbScannerAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    // 이벤트 드리븐 — 사이클 루프 불필요
  }

  /**
   * 심볼 추가/제거 후 구독 재설정
   * - API 엔드포인트에서 심볼 변경 시 호출
   */
  async restartSubscriptions(): Promise<void> {
    // 기존 리스너 제거
    if (this.priceHandler) {
      priceManager.removeOnPrice(this.priceHandler);
      bithumbPriceManager.removeOnPrice(this.priceHandler);
      this.priceHandler = null;
    }

    // 기존 구독 해제
    for (const ticker of this.subscribedTickers) {
      priceManager.unsubscribe(ticker);
      bithumbPriceManager.unsubscribe(ticker);
    }
    this.subscribedTickers.clear();

    // DB에서 활성 심볼 로드 후 구독
    const symbols = await generalArbScannerService.getActiveSymbols();
    for (const symbol of symbols) {
      const ticker = `KRW-${symbol}`;
      priceManager.subscribe(ticker);
      bithumbPriceManager.subscribe(ticker);
      this.subscribedTickers.add(ticker);
    }

    // 새 가격 핸들러 등록 (bind로 this 컨텍스트 보존)
    this.priceHandler = this.handlePriceUpdate.bind(this);
    priceManager.onPrice(this.priceHandler);
    bithumbPriceManager.onPrice(this.priceHandler);

    console.log(`[GeneralArbScannerAgent] ${symbols.length}개 심볼 구독: ${symbols.join(', ')}`);
  }

  /**
   * 가격 업데이트 핸들러
   * - 양쪽 거래소 가격 모두 수신된 경우에만 처리
   * - 임계값 초과 시 기회 기록 (비동기, 에러 격리)
   * - 500ms 디바운스로 Socket.IO emit (연속 업데이트 병합)
   */
  private handlePriceUpdate(ticker: string, _price: number): void {
    // "KRW-BTC" → "BTC" 변환
    if (!ticker.startsWith('KRW-')) return;
    const symbol = ticker.slice(4);

    // 양쪽 거래소 현재 가격 조회
    const upbitPrice = priceManager.getPrice(ticker);
    const bithumbPrice = bithumbPriceManager.getPrice(ticker);

    // 어느 쪽이든 가격 미수신 시 스킵
    if (upbitPrice === null || bithumbPrice === null) return;

    // 인메모리 스냅샷 업데이트
    generalArbScannerService.updateSnapshot(symbol, upbitPrice, bithumbPrice);

    // 임계값 초과 시 DB에 기회 기록 (비동기, 에러 격리)
    generalArbScannerService
      .getConfig()
      .then(config => {
        if (!config.isEnabled) return;

        // 절대 스프레드 % 계산
        const spreadPct = Math.abs(((bithumbPrice - upbitPrice) / upbitPrice) * 100);

        if (spreadPct >= config.thresholdPct) {
          // 부호 있는 스프레드 값으로 기록
          const signedSpreadPct = ((bithumbPrice - upbitPrice) / upbitPrice) * 100;
          generalArbScannerService
            .maybeLogOpportunity(symbol, signedSpreadPct, config.thresholdPct)
            .catch(err =>
              console.error('[GeneralArbScannerAgent] logOpportunity 실패:', err.message),
            );
        }
      })
      .catch(err => console.error('[GeneralArbScannerAgent] getConfig 실패:', err.message));

    // Socket.IO emit — 500ms 디바운스 (연속 가격 업데이트 병합)
    if (this.emitDebounceTimer) clearTimeout(this.emitDebounceTimer);
    this.emitDebounceTimer = setTimeout(() => {
      const snapshots = generalArbScannerService.getSnapshots();
      socketService.emitGeneralArbUpdate(snapshots);
    }, 500);
  }

  protected override getExtraInfo(): Record<string, any> {
    return {
      subscribedTickers: Array.from(this.subscribedTickers),
      snapshotCount: generalArbScannerService.getSnapshots().length,
    };
  }
}

export const generalArbScannerAgent = new GeneralArbScannerAgent();
