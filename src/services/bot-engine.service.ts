import prisma, { withRetry } from '../config/database';
import { TradingService } from './trading.service';
import { priceManager } from './upbit-price-manager';
import { socketService } from './socket.service';
import { calculateBuyPrices } from './grid.service';

class BotEngine {
  private isRunning: boolean = false;
  private interval: NodeJS.Timeout | null = null;
  private broadcastInterval: NodeJS.Timeout | null = null;
  private orderCheckInterval: NodeJS.Timeout | null = null;
  private readonly BASE_INTERVAL = 3000; // 기본 체크 주기 3초 (가장 빠른 봇 기준)
  private readonly BROADCAST_INTERVAL = 10000; // 10초마다 봇 데이터 브로드캐스트
  private readonly ORDER_CHECK_INTERVAL = 30000; // 체결 확인 30초 (안전망 역할, 가격 크로스 감지가 주력)
  private readonly BOT_EXECUTION_DELAY = 300; // 봇 간 실행 딜레이 (ms) - 429 에러 방지

  // 봇별 마지막 실행 시간 추적
  private lastExecutionTime: Map<number, number> = new Map();

  // 동시 실행 방지 락
  private isExecutingBots: boolean = false;
  private isBroadcasting: boolean = false;
  private isCheckingOrders: boolean = false;

  // 가격 크로스 감지용
  private pendingGridCache: Map<string, Array<{ gridId: number; botId: number; type: string; price: number }>> = new Map();
  private crossCheckCooldown: Map<number, number> = new Map(); // gridId -> 마지막 확인 시간
  private pendingCacheRefreshInterval: NodeJS.Timeout | null = null;
  private isCheckingCross: boolean = false;
  private readonly CROSS_COOLDOWN_MS = 3000; // gridId별 쿨다운 3초
  private readonly PENDING_CACHE_REFRESH_MS = 5000; // 캐시 갱신 5초

  // 가격 리스너 (바인딩된 참조를 유지해야 해제 가능)
  private boundOnPriceUpdate = this.onPriceUpdate.bind(this);

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

    // 가격 크로스 감지: 리스너 등록 + 캐시 갱신 타이머
    priceManager.onPrice(this.boundOnPriceUpdate);
    this.refreshPendingGridCache(); // 즉시 1회
    this.pendingCacheRefreshInterval = setInterval(() => {
      this.refreshPendingGridCache();
    }, this.PENDING_CACHE_REFRESH_MS);

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

      // 실행 중인 봇들의 티커 조회 (Soft delete 제외)
      const runningBots = await withRetry(
        () => prisma.bot.findMany({
          where: { status: 'running', deletedAt: null },
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
          where: { status: 'running', deletedAt: null },
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

    // 가격 크로스 감지: 리스너 해제 + 캐시 갱신 타이머 정리
    priceManager.removeOnPrice(this.boundOnPriceUpdate);
    if (this.pendingCacheRefreshInterval) {
      clearInterval(this.pendingCacheRefreshInterval);
      this.pendingCacheRefreshInterval = null;
    }
    this.pendingGridCache.clear();
    this.crossCheckCooldown.clear();

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

  // pending 그리드 캐시 갱신 (티커별로 정리)
  private async refreshPendingGridCache() {
    try {
      const runningBots = await withRetry(
        () => prisma.bot.findMany({
          where: { status: 'running', deletedAt: null },
          select: { id: true, ticker: true },
        }),
        { operationName: 'BotEngine.refreshPendingGridCache' }
      );

      if (runningBots.length === 0) {
        this.pendingGridCache.clear();
        return;
      }

      const botIds = runningBots.map(b => b.id);
      const botTickerMap = new Map(runningBots.map(b => [b.id, b.ticker]));

      const pendingGrids = await withRetry(
        () => prisma.gridLevel.findMany({
          where: {
            botId: { in: botIds },
            status: 'pending',
            orderId: { not: null },
          },
          select: { id: true, botId: true, type: true, price: true },
        }),
        { operationName: 'BotEngine.refreshPendingGridCache.grids' }
      );

      // 티커별로 그룹화
      const newCache = new Map<string, Array<{ gridId: number; botId: number; type: string; price: number }>>();
      for (const grid of pendingGrids) {
        const ticker = botTickerMap.get(grid.botId);
        if (!ticker) continue;

        if (!newCache.has(ticker)) {
          newCache.set(ticker, []);
        }
        newCache.get(ticker)!.push({
          gridId: grid.id,
          botId: grid.botId,
          type: grid.type,
          price: grid.price,
        });
      }

      this.pendingGridCache = newCache;

      // 오래된 쿨다운 정리 (10초 이상 된 항목)
      const now = Date.now();
      for (const [gridId, lastCheck] of this.crossCheckCooldown) {
        if (now - lastCheck > 10000) {
          this.crossCheckCooldown.delete(gridId);
        }
      }
    } catch (error: any) {
      console.error('[BotEngine] pending 캐시 갱신 실패:', error.message);
    }
  }

  // 가격 수신 시 크로스 감지 (WebSocket 리스너)
  private onPriceUpdate(ticker: string, price: number): void {
    if (!this.isRunning) return;

    const pendingGrids = this.pendingGridCache.get(ticker);
    if (!pendingGrids || pendingGrids.length === 0) return;

    const now = Date.now();

    // 가격 크로스된 그리드 필터링
    const crossedGrids = pendingGrids.filter(grid => {
      // 크로스 판정: buy pending이면 현재가 ≤ 주문가, sell pending이면 현재가 ≥ 주문가
      const isCrossed = (grid.type === 'buy' && price <= grid.price) ||
                         (grid.type === 'sell' && price >= grid.price);
      if (!isCrossed) return false;

      // 쿨다운 확인 (동일 gridId를 3초 내 재확인 방지)
      const lastCheck = this.crossCheckCooldown.get(grid.gridId) || 0;
      return (now - lastCheck) >= this.CROSS_COOLDOWN_MS;
    });

    if (crossedGrids.length === 0) return;

    // 쿨다운 등록
    for (const grid of crossedGrids) {
      this.crossCheckCooldown.set(grid.gridId, now);
    }

    console.log(`[BotEngine] 가격 크로스 감지: ${ticker} ${price.toLocaleString()}원 → ${crossedGrids.length}개 주문 확인`);

    // 비동기 실행 (fire-and-forget, 가격 리스너 블로킹 방지)
    this.checkCrossedOrders(crossedGrids).catch(err => {
      console.error('[BotEngine] 크로스 체결 확인 실패:', err.message);
    });
  }

  // 크로스된 주문들의 체결 여부 즉시 확인
  private async checkCrossedOrders(grids: Array<{ gridId: number; botId: number; type: string; price: number }>) {
    // 동시 실행 방지
    if (this.isCheckingCross) return;
    this.isCheckingCross = true;

    try {
      for (const grid of grids) {
        try {
          const filled = await TradingService.checkAndProcessSingleOrder(grid.gridId);
          if (filled) {
            console.log(`[BotEngine] ⚡ 크로스 체결 확인 성공: gridId=${grid.gridId}, ${grid.type} ${grid.price.toLocaleString()}원`);
            // 캐시에서 해당 그리드 제거 (이미 처리됨)
            for (const [ticker, grids] of this.pendingGridCache) {
              const idx = grids.findIndex(g => g.gridId === grid.gridId);
              if (idx !== -1) {
                grids.splice(idx, 1);
                break;
              }
            }
          }
        } catch (error: any) {
          console.error(`[BotEngine] 크로스 체결 확인 실패 (gridId=${grid.gridId}):`, error.message);
        }
      }
    } finally {
      this.isCheckingCross = false;
    }
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

      // 실행 중인 봇 ID + 티커만 조회 (gridLevels include 제거로 성능 개선, Soft delete 제외)
      const runningBots = await withRetry(
        () => prisma.bot.findMany({
          where: { status: 'running', deletedAt: null },
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

      // 구독 중인 유저들의 봇을 한 번에 조회 (N+1 문제 해결, Soft delete 제외)
      const allBots = await withRetry(
        () => prisma.bot.findMany({
          where: { userId: { in: subscribedUserIds }, deletedAt: null },
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
          // 매수 가격 배열 계산 (공통 유틸리티 함수 사용)
          const buyPrices = calculateBuyPrices(bot.lowerPrice, bot.upperPrice, bot.priceChangePercent);

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
