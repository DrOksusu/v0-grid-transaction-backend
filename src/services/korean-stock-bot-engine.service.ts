import prisma from '../config/database';
import { tossService, TossCredentials, TossApiError } from './toss.service';
import {
  isMarketOpen,
  shouldCancelPendingOrders,
} from './korean-stock-market-hours.service';
import { snapToTickSize } from '../utils/korean-stock-tick-size';
import { decrypt } from '../utils/encryption';

/**
 * 한국 주식 그리드 봇 전용 엔진.
 *
 * 자세한 사양: docs/superpowers/specs/2026-06-29-korean-stock-grid-design.md
 * - 코인 bot-engine.service.ts는 절대 건드리지 않는다 (별도 엔진).
 * - 5초마다 1 cycle 실행 (KoreanStockGridAgent가 호출):
 *   1) 장 시간 외이고 shouldCancelPendingOrders=true면 미체결 일괄 취소 후 return
 *   2) 장 시간 외이고 shouldCancel=false면 즉시 return
 *   3) 장 시간이면 KOREAN_STOCK 마켓 + running 봇 모두 처리
 * - 각 봇의 gridLevel.status='available' 중
 *   - BUY: currentPrice <= level.price → 매수 주문
 *   - SELL: currentPrice >= level.price → 매도 주문
 *   - 주문 성공 시 status='pending' + orderId + clientOrderId 저장
 * - 체결 감지/SELL level 생성은 본 task 범위 밖 (후속 task).
 */
export class KoreanStockBotEngine {
  /**
   * 1 cycle 실행. KoreanStockGridAgent.tick()에서 호출.
   */
  async runCycle(): Promise<void> {
    // 장 시간 외 분기 — shouldCancel 윈도우(15:30~15:30:59)일 때만 일괄 취소
    if (!(await isMarketOpen())) {
      if (await shouldCancelPendingOrders()) {
        await this.cancelAllPendingOrders();
      }
      return;
    }

    // 장 시간: 한국주식 봇 전체 순회
    const bots = await (prisma as any).bot.findMany({
      where: { market: 'KOREAN_STOCK', status: 'running', deletedAt: null },
      include: { gridLevels: true },
    });

    for (const bot of bots) {
      try {
        await this.processBot(bot);
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        console.error(`[KoreanStockBotEngine] bot ${bot.id} 오류:`, msg);
        await (prisma as any).bot.update({
          where: { id: bot.id },
          data: { errorMessage: msg },
        });
      }
    }
  }

  /**
   * 봇 1개 처리: credential 로드 → 시세 조회 → grid level별 매수/매도 판단.
   */
  private async processBot(bot: any): Promise<void> {
    const cred = await this.loadTossCredentials(bot.userId);
    // credential 없거나 accountSeq 비어있으면 skip
    if (!cred) return;

    const prices = await tossService.getPrices(cred, [bot.ticker]);
    const priceEntry = prices.find((p) => p.symbol === bot.ticker);
    if (!priceEntry) return;
    const currentPrice = Number(priceEntry.lastPrice);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

    for (const level of bot.gridLevels) {
      if (level.status !== 'available') continue;

      if (level.type === 'buy' && currentPrice <= level.price) {
        // 매수 수량 = floor(주문금액 / level 가격)
        const qty = Math.floor(bot.orderAmount / level.price);
        if (qty < 1) continue;
        const snapped = snapToTickSize(level.price);

        const order = await tossService.placeOrder(cred, {
          symbol: bot.ticker,
          side: 'BUY',
          orderType: 'LIMIT',
          quantity: String(qty),
          price: String(snapped),
        });
        await (prisma as any).gridLevel.update({
          where: { id: level.id },
          data: {
            status: 'pending',
            orderId: order.orderId,
            clientOrderId: order.clientOrderId,
          },
        });
      } else if (level.type === 'sell' && currentPrice >= level.price) {
        // 매도 수량 산정에는 매수 시점 단가(buyPrice) 우선
        const referencePrice = level.buyPrice ?? level.price;
        const qty = Math.floor(bot.orderAmount / referencePrice);
        if (qty < 1) continue;
        const snapped = snapToTickSize(level.price);

        const order = await tossService.placeOrder(cred, {
          symbol: bot.ticker,
          side: 'SELL',
          orderType: 'LIMIT',
          quantity: String(qty),
          price: String(snapped),
        });
        await (prisma as any).gridLevel.update({
          where: { id: level.id },
          data: {
            status: 'pending',
            orderId: order.orderId,
            clientOrderId: order.clientOrderId,
          },
        });
      }
    }
  }

  /**
   * 장 마감 직후 윈도우(shouldCancelPendingOrders=true)에서만 호출.
   * 한국주식 + running 봇의 pending+orderId 채워진 모든 level 일괄 취소.
   * 개별 취소 실패는 다른 level에 영향 주지 않음 (try-catch 격리).
   */
  private async cancelAllPendingOrders(): Promise<void> {
    const pendingLevels = await (prisma as any).gridLevel.findMany({
      where: {
        bot: { market: 'KOREAN_STOCK', status: 'running', deletedAt: null },
        status: 'pending',
        orderId: { not: null },
      },
      include: { bot: true },
    });

    for (const level of pendingLevels) {
      try {
        const cred = await this.loadTossCredentials(level.bot.userId);
        if (!cred) continue;

        try {
          await tossService.cancelOrder(cred, level.orderId!);
        } catch (e) {
          // already-filled/canceled/modified/rejected는 서버 상태로 확정된 것 → 로컬 상태 재동기화
          if (
            e instanceof TossApiError &&
            (e.code === 'already-filled' ||
              e.code === 'already-canceled' ||
              e.code === 'already-modified' ||
              e.code === 'already-rejected' ||
              e.code === 'order-not-found')
          ) {
            // 로그만 남기고 GridLevel은 아래에서 정리
          } else {
            throw e;
          }
        }

        await (prisma as any).gridLevel.update({
          where: { id: level.id },
          data: { status: 'available', orderId: null, clientOrderId: null },
        });
      } catch (e: any) {
        console.error(
          `[KoreanStockBotEngine] 취소 실패 (level ${level.id}):`,
          e?.message ?? e,
        );
      }
    }
  }

  /**
   * userId로 토스 credential 로드 후 { clientId, clientSecret, accountSeq } 반환.
   * accountSeq 미등록 시 null.
   */
  private async loadTossCredentials(userId: number): Promise<TossCredentials | null> {
    const cred = await (prisma as any).credential.findFirst({
      where: { userId, exchange: 'toss', purpose: 'default' },
    });
    if (!cred || !cred.accountSeq) return null;
    return {
      clientId: decrypt(cred.apiKey),
      clientSecret: decrypt(cred.secretKey),
      accountSeq: cred.accountSeq,
    };
  }
}

export const koreanStockBotEngine = new KoreanStockBotEngine();
