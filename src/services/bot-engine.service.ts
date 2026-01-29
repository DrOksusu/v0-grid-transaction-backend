import prisma, { withRetry } from '../config/database';
import { TradingService } from './trading.service';
import { priceManager } from './upbit-price-manager';
import { socketService } from './socket.service';
import { roundToTickSize } from './grid.service';

class BotEngine {
  private isRunning: boolean = false;
  private interval: NodeJS.Timeout | null = null;
  private broadcastInterval: NodeJS.Timeout | null = null;
  private orderCheckInterval: NodeJS.Timeout | null = null;
  private readonly BASE_INTERVAL = 3000; // 기본 체크 주기 3초 (가장 빠른 봇 기준)
  private readonly BROADCAST_INTERVAL = 10000; // 10초마다 봇 데이터 브로드캐스트
  private readonly ORDER_CHECK_INTERVAL = 10000; // 체결 확인 10초 (API 호출량 최적화)
  private readonly BOT_EXECUTION_DELAY = 300; // 봇 간 실행 딜레이 (ms) - 429 에러 방지

  // 봇별 마지막 실행 시간 추적
  private lastExecutionTime: Map<number, number> = new Map();

  // 동시 실행 방지 락
  private isExecutingBots: boolean = false;
  private isBroadcasting: boolean = false;
  private isCheckingOrders: boolean = false;

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

    // 주기적으로 봇 실행 (동적 간격 - 기본 3초마다 체크)
    this.interval = setInterval(async () => {
      await this.executeBots();
    }, this.BASE_INTERVAL);

    // 봇 데이터 브로드캐스트 시작
    this.broadcastInterval = setInterval(async () => {
      await this.broadcastBotsToSubscribers();
    }, this.BROADCAST_INTERVAL);

    // 체결 확인 (state=done API - 3초마다)
    // API 호출 수: 사용자 수 × 1 (마켓 수와 무관)
    this.orderCheckInterval = setInterval(async () => {
      await this.checkFilledOrders();
    }, this.ORDER_CHECK_INTERVAL);

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
      const runningBots = await withRetry(
        () => prisma.bot.findMany({
          where: { status: 'running' },
          select: { ticker: true },
        }),
        { operationName: 'BotEngine.initializePriceManager' }
      );

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

  // 체결 확인 (UUID 배치 조회 - 마켓 수와 무관하게 사용자당 1회 API 호출)
  private async checkFilledOrders() {
    // 동시 실행 방지
    if (this.isCheckingOrders) {
      console.log('[BotEngine] checkFilledOrders 이미 실행 중 - 스킵');
      return;
    }

    this.isCheckingOrders = true;
    try {
      const runningBots = await withRetry(
        () => prisma.bot.findMany({
          where: { status: 'running' },
          select: { id: true },
        }),
        { operationName: 'BotEngine.checkFilledOrders' }
      );

      if (runningBots.length === 0) return;

      const allRunningBotIds = runningBots.map(b => b.id);
      await TradingService.checkAllFilledOrders(allRunningBotIds);
    } catch (error: any) {
      console.error('[BotEngine] Order check failed:', error.message);
    } finally {
      this.isCheckingOrders = false;
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

    if (this.orderCheckInterval) {
      clearInterval(this.orderCheckInterval);
      this.orderCheckInterval = null;
    }

    // PriceManager WebSocket 연결 종료
    priceManager.disconnect();

    this.isRunning = false;
    console.log('Bot engine stopped');
  }

  // 봇 시작 시 티커 구독
  async onBotStarted(botId: number, userId: number, ticker: string) {
    priceManager.subscribe(ticker);
    console.log(`[BotEngine] Bot ${botId} started - subscribed to ${ticker}`);
  }

  // 봇 종료 시 티커 구독 해제
  async onBotStopped(botId: number, userId: number, ticker: string) {
    // 해당 티커를 사용하는 다른 running 봇이 있는지 확인
    const otherBots = await withRetry(
      () => prisma.bot.count({
        where: {
          ticker,
          status: 'running',
          id: { not: botId },
        },
      }),
      { operationName: 'BotEngine.onBotStopped' }
    );

    // 다른 봇이 없으면 구독 해제
    if (otherBots === 0) {
      priceManager.unsubscribe(ticker);
    }

    console.log(`[BotEngine] Bot ${botId} stopped`);
  }

  // 봇 시작 시 티커 구독 (하위 호환성)
  subscribeTicker(ticker: string) {
    priceManager.subscribe(ticker);
  }

  // 봇 종료 시 티커 구독 해제 (하위 호환성)
  async unsubscribeTicker(ticker: string) {
    // 해당 티커를 사용하는 다른 running 봇이 있는지 확인
    const otherBots = await withRetry(
      () => prisma.bot.count({
        where: {
          ticker,
          status: 'running',
        },
      }),
      { operationName: 'BotEngine.unsubscribeTicker' }
    );

    // 다른 봇이 없으면 구독 해제
    if (otherBots === 0) {
      priceManager.unsubscribe(ticker);
    }
  }

  // PriceManager 상태 조회
  getPriceManagerStatus() {
    return priceManager.getConnectionStatus();
  }

  // 모든 실행 중인 봇 처리 (동적 간격 적용)
  private async executeBots() {
    // 동시 실행 방지
    if (this.isExecutingBots) {
      return; // 조용히 스킵 (너무 자주 발생할 수 있음)
    }

    this.isExecutingBots = true;
    try {
      const now = Date.now();

      // 실행 중인 봇 ID + 티커만 조회 (gridLevels include 제거로 성능 개선)
      const runningBots = await withRetry(
        () => prisma.bot.findMany({
          where: { status: 'running' },
          select: { id: true, ticker: true },
        }),
        { operationName: 'BotEngine.executeBots.findRunningBots' }
      );

      // 실행 중인 봇 수는 주기적으로만 로깅 (10분마다)
      if (runningBots.length > 0 && now % 600000 < this.BASE_INTERVAL) {
        // 변동성 정보도 함께 로깅
        const volatilityInfo = runningBots.map(b => {
          const vol = priceManager.getVolatility(b.ticker);
          const interval = priceManager.getRecommendedInterval(b.ticker);
          return `${b.ticker.replace('KRW-', '')}:${vol.toFixed(1)}%/${interval/1000}s`;
        }).join(', ');
        console.log(`[BotEngine] ${runningBots.length}개 봇 실행 중 (변동성: ${volatilityInfo})`);
      }

      if (runningBots.length === 0) return;

      // 실행 대상 봇 필터링 (변동성 기반 간격 체크)
      const botsToExecute = runningBots.filter(bot => {
        const lastExec = this.lastExecutionTime.get(bot.id) || 0;
        const recommendedInterval = priceManager.getRecommendedInterval(bot.ticker);
        return (now - lastExec) >= recommendedInterval;
      });

      if (botsToExecute.length === 0) return;

      // available 그리드가 있는 봇 ID들을 한 번에 조회
      const botsWithAvailableGrids = await withRetry(
        () => prisma.gridLevel.groupBy({
          by: ['botId'],
          where: {
            botId: { in: botsToExecute.map(b => b.id) },
            status: 'available',
          },
        }),
        { operationName: 'BotEngine.executeBots.findAvailableGrids' }
      );
      const botsWithGridsSet = new Set(botsWithAvailableGrids.map(g => g.botId));

      // 각 봇에 대해 거래 실행 (429 에러 방지를 위해 순차 실행 + 딜레이)
      for (let i = 0; i < botsToExecute.length; i++) {
        const bot = botsToExecute[i];
        try {
          // 실행 시간 기록 (그리드 유무와 관계없이)
          this.lastExecutionTime.set(bot.id, now);

          // 그리드 레벨이 없으면 스킵 (로그 없이)
          if (!botsWithGridsSet.has(bot.id)) {
            continue;
          }

          // 거래 실행
          const result = await TradingService.executeTrade(bot.id);
          if (result.executed) {
            const volatility = priceManager.getVolatility(bot.ticker);
            console.log(`[BotEngine] Bot ${bot.id} (${bot.ticker}): 거래 실행됨 (변동성: ${volatility.toFixed(2)}%)`);
          }

          // 다음 봇 실행 전 딜레이 (마지막 봇이 아닌 경우만)
          if (i < botsToExecute.length - 1) {
            await new Promise(resolve => setTimeout(resolve, this.BOT_EXECUTION_DELAY));
          }
        } catch (error: any) {
          console.error(`[BotEngine] Error executing bot ${bot.id}:`, error.message);
        }
      }

      // 체결 확인은 WebSocket으로 실시간 처리 (orderManager)
      // REST 폴백은 별도 interval에서 60초마다 실행

    } catch (error: any) {
      console.error('[BotEngine] Error in bot engine:', error.message);
    } finally {
      this.isExecutingBots = false;
    }
  }

  // 상태 확인
  getStatus() {
    return {
      isRunning: this.isRunning,
      baseInterval: this.BASE_INTERVAL,
      dynamicIntervals: '3s(5%+) / 5s(3-5%) / 10s(1-3%) / 15s(<1%)',
    };
  }

  // 구독 중인 유저들에게 봇 데이터 브로드캐스트
  private async broadcastBotsToSubscribers() {
    // 동시 실행 방지
    if (this.isBroadcasting) {
      return;
    }

    this.isBroadcasting = true;
    try {
      // socketService에서 구독 중인 유저 ID 직접 가져오기 (DB 조회 없음)
      const subscribedUserIds = socketService.getSubscribedUserIds();
      if (subscribedUserIds.length === 0) return;

      // 구독 중인 유저들의 봇을 한 번에 조회 (N+1 문제 해결)
      const allBots = await withRetry(
        () => prisma.bot.findMany({
          where: { userId: { in: subscribedUserIds } },
          orderBy: { createdAt: 'desc' },
        }),
        { operationName: 'BotEngine.broadcastBotsToSubscribers' }
      );

      // 유저별로 그룹화
      const botsByUser = new Map<number, typeof allBots>();
      for (const bot of allBots) {
        if (!botsByUser.has(bot.userId)) {
          botsByUser.set(bot.userId, []);
        }
        botsByUser.get(bot.userId)!.push(bot);
      }

      // 각 유저에게 브로드캐스트
      for (const userId of subscribedUserIds) {
        if (!socketService.hasBotsSubscribers(userId)) continue;

        const bots = botsByUser.get(userId) || [];

        // 가격 정보 가져오기 (메모리 캐시에서)
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
    } finally {
      this.isBroadcasting = false;
    }
  }
}

// 싱글톤 인스턴스
export const botEngine = new BotEngine();
