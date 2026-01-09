import prisma from '../config/database';
import { TradingService } from './trading.service';
import { priceManager } from './upbit-price-manager';
import { socketService } from './socket.service';
import { roundToTickSize } from './grid.service';

class BotEngine {
  private isRunning: boolean = false;
  private interval: NodeJS.Timeout | null = null;
  private broadcastInterval: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL = 10000; // 10초마다 체크
  private readonly BROADCAST_INTERVAL = 5000; // 5초마다 봇 데이터 브로드캐스트

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

    // 봇 데이터 브로드캐스트 시작
    this.broadcastInterval = setInterval(async () => {
      await this.broadcastBotsToSubscribers();
    }, this.BROADCAST_INTERVAL);

    // 즉시 한 번 실행
    this.executeBots();
  }

  // PriceManager 초기화 및 실행 중인 봇 티커 구독
  private async initializePriceManager() {
    try {
      // WebSocket 연결
      priceManager.connect();

      // 대시보드 기본 종목 (항상 구독)
      const defaultTickers = ['KRW-BTC', 'KRW-ETH', 'KRW-USDT'];

      // 실행 중인 봇들의 티커 조회
      const runningBots = await prisma.bot.findMany({
        where: { status: 'running' },
        select: { ticker: true },
      });

      // 기본 종목 + 봇 종목 합쳐서 유니크하게 구독
      const allTickers = [...new Set([...defaultTickers, ...runningBots.map(bot => bot.ticker)])];
      console.log(`[BotEngine] Subscribing to ${allTickers.length} tickers via WebSocket (including dashboard defaults)`);

      for (const ticker of allTickers) {
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

    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
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

      // 실행 중인 봇 수는 주기적으로만 로깅 (10분마다)
      if (runningBots.length > 0 && Date.now() % 600000 < this.CHECK_INTERVAL) {
        console.log(`[BotEngine] ${runningBots.length}개 봇 실행 중`);
      }

      // 각 봇에 대해 거래 실행
      for (const bot of runningBots) {
        try {
          // 그리드 레벨이 없으면 스킵 (로그 없이)
          if (bot.gridLevels.length === 0) {
            continue;
          }

          // 거래 실행
          const result = await TradingService.executeTrade(bot.id);
          if (result.executed) {
            console.log(`[BotEngine] Bot ${bot.id} (${bot.ticker}): 거래 실행됨`);
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

  // 구독 중인 유저들에게 봇 데이터 브로드캐스트
  private async broadcastBotsToSubscribers() {
    try {
      // 구독 중인 모든 유저 ID 가져오기 (socketService에서)
      // 각 유저별로 봇 데이터 조회 후 전송
      const userIds = await this.getSubscribedUserIds();

      for (const userId of userIds) {
        if (!socketService.hasBotsSubscribers(userId)) continue;

        const bots = await prisma.bot.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
        });

        // 가격 정보 가져오기
        const priceMap = new Map<string, number>();
        for (const bot of bots) {
          if (bot.exchange === 'upbit') {
            const market = `KRW-${bot.ticker.replace('KRW-', '')}`;
            const cachedPrice = priceManager.getPrice(market);
            priceMap.set(market, cachedPrice || 0);
          }
        }

        const summary = {
          totalBots: bots.length,
          activeBots: bots.filter(b => b.status === 'running').length,
          totalProfit: bots.reduce((sum, b) => sum + b.currentProfit, 0),
          totalInvestment: bots.reduce((sum, b) => sum + b.investmentAmount, 0),
        };

        const botsData = bots.map(bot => {
          const buyPrices: number[] = [];
          const multiplier = 1 + bot.priceChangePercent / 100;
          let price = bot.lowerPrice;

          for (let i = 0; i < bot.gridCount; i++) {
            buyPrices.push(roundToTickSize(price));
            price *= multiplier;
          }

          let currentPrice = 0;
          if (bot.exchange === 'upbit') {
            const market = `KRW-${bot.ticker.replace('KRW-', '')}`;
            currentPrice = priceMap.get(market) || 0;
          }

          return {
            _id: bot.id.toString(),
            exchange: bot.exchange,
            ticker: bot.ticker,
            lowerPrice: bot.lowerPrice,
            upperPrice: bot.upperPrice,
            gridCount: bot.gridCount,
            priceChangePercent: bot.priceChangePercent,
            orderAmount: bot.orderAmount,
            stopAtMax: bot.stopAtMax,
            status: bot.status,
            currentProfit: bot.currentProfit,
            profitPercent: bot.investmentAmount > 0
              ? (bot.currentProfit / bot.investmentAmount) * 100
              : 0,
            totalTrades: bot.totalTrades,
            investmentAmount: bot.investmentAmount,
            buyPrices,
            currentPrice,
            createdAt: bot.createdAt,
          };
        });

        socketService.emitBotsList(userId, botsData, summary);
      }
    } catch (error: any) {
      // 에러 로깅은 자주 발생할 수 있으므로 최소화
      if (error.message !== 'No subscribers') {
        console.error('[BotEngine] Broadcast error:', error.message);
      }
    }
  }

  // 구독 중인 유저 ID 목록 가져오기
  private async getSubscribedUserIds(): Promise<number[]> {
    // 봇이 있는 모든 유저 ID 조회
    const users = await prisma.bot.groupBy({
      by: ['userId'],
    });
    return users.map(u => u.userId);
  }
}

// 싱글톤 인스턴스
export const botEngine = new BotEngine();
