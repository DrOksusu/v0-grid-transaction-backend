import prisma from '../config/database';
import { TradingService } from './trading.service';
import { priceManager } from './upbit-price-manager';

class BotEngine {
  private isRunning: boolean = false;
  private interval: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL = 10000; // 10초마다 체크

  // 엔진 시작
  async start() {
    if (this.isRunning) {
      console.log('Bot engine is already running');
      return;
    }

    this.isRunning = true;
    console.log('Bot engine started');

    // WebSocket PriceManager 시작 및 실행 중인 봇 티커 구독
    await this.initializePriceManager();

    // 주기적으로 봇 실행
    this.interval = setInterval(async () => {
      await this.executeBots();
    }, this.CHECK_INTERVAL);

    // 즉시 한 번 실행
    this.executeBots();
  }

  // PriceManager 초기화 및 실행 중인 봇 티커 구독
  private async initializePriceManager() {
    try {
      // WebSocket 연결
      priceManager.connect();

      // 실행 중인 봇들의 티커 조회
      const runningBots = await prisma.bot.findMany({
        where: { status: 'running' },
        select: { ticker: true },
      });

      // 유니크 티커들 구독
      const uniqueTickers = [...new Set(runningBots.map(bot => bot.ticker))];
      console.log(`[BotEngine] Subscribing to ${uniqueTickers.length} tickers via WebSocket`);

      for (const ticker of uniqueTickers) {
        priceManager.subscribe(ticker);
      }
    } catch (error: any) {
      console.error('[BotEngine] Failed to initialize PriceManager:', error.message);
    }
  }

  // 엔진 중지
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // PriceManager WebSocket 연결 종료
    priceManager.disconnect();

    this.isRunning = false;
    console.log('Bot engine stopped');
  }

  // 봇 시작 시 티커 구독
  subscribeTicker(ticker: string) {
    priceManager.subscribe(ticker);
  }

  // 봇 종료 시 티커 구독 해제 (다른 봇이 사용 중이면 유지)
  async unsubscribeTicker(ticker: string) {
    // 해당 티커를 사용하는 다른 running 봇이 있는지 확인
    const otherBots = await prisma.bot.count({
      where: {
        ticker,
        status: 'running',
      },
    });

    // 다른 봇이 없으면 구독 해제
    if (otherBots === 0) {
      priceManager.unsubscribe(ticker);
    }
  }

  // PriceManager 상태 조회
  getPriceManagerStatus() {
    return priceManager.getConnectionStatus();
  }

  // 모든 실행 중인 봇 처리
  private async executeBots() {
    try {
      // 실행 중인 모든 봇 조회
      const runningBots = await prisma.bot.findMany({
        where: {
          status: 'running',
        },
        include: {
          gridLevels: {
            where: { status: 'available' },
            take: 1,
          },
        },
      });

      if (runningBots.length > 0) {
        console.log(`[BotEngine] Checking ${runningBots.length} running bot(s)...`);

        for (const bot of runningBots) {
          const hasGridLevels = bot.gridLevels.length > 0;
          console.log(`[BotEngine] Bot ${bot.id} (${bot.ticker}): gridLevels=${hasGridLevels ? 'YES' : 'NO'}`);
        }
      }

      // 각 봇에 대해 거래 실행
      for (const bot of runningBots) {
        try {
          // 그리드 레벨이 없으면 스킵
          if (bot.gridLevels.length === 0) {
            console.log(`[BotEngine] Bot ${bot.id}: No grid levels, skipping...`);
            continue;
          }

          // 거래 실행
          const result = await TradingService.executeTrade(bot.id);
          if (result.executed) {
            console.log(`[BotEngine] Bot ${bot.id}: Trade executed!`);
          }

          // 체결된 주문 확인
          await TradingService.checkFilledOrders(bot.id);
        } catch (error: any) {
          console.error(`[BotEngine] Error executing bot ${bot.id}:`, error.message);
        }
      }
    } catch (error: any) {
      console.error('[BotEngine] Error in bot engine:', error.message);
    }
  }

  // 상태 확인
  getStatus() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.CHECK_INTERVAL,
    };
  }
}

// 싱글톤 인스턴스
export const botEngine = new BotEngine();
