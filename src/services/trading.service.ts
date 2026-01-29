import prisma, { withRetry } from '../config/database';
import { UpbitService } from './upbit.service';
import { GridService } from './grid.service';
import { decrypt } from '../utils/encryption';
import { socketService } from './socket.service';
import { priceManager } from './upbit-price-manager';
import { ProfitService } from './profit.service';

// 자격증명 캐시 (5분 TTL)
interface CachedCredential {
  apiKey: string;
  secretKey: string;
  expireAt: number;
}
const credentialCache = new Map<number, CachedCredential>(); // botId -> credential
const CREDENTIAL_CACHE_TTL = 5 * 60 * 1000; // 5분

// 봇 정보 캐시 (1분 TTL) - userId, ticker 등 자주 변하지 않는 정보
interface CachedBotInfo {
  userId: number;
  ticker: string;
  orderAmount: number;
  expireAt: number;
}
const botInfoCache = new Map<number, CachedBotInfo>();
const BOT_INFO_CACHE_TTL = 60 * 1000; // 1분

// 사용자별 자격증명 캐시 (중앙 집중식 조회용)
interface UserCredentialCache {
  apiKey: string;
  secretKey: string;
  expireAt: number;
}
const userCredentialCache = new Map<number, UserCredentialCache>(); // userId -> credential

export class TradingService {
  // 사용자별 자격증명 조회 (중앙 집중식 조회용)
  private static async getUserCredential(userId: number): Promise<{ apiKey: string; secretKey: string } | null> {
    const now = Date.now();
    const cached = userCredentialCache.get(userId);

    if (cached && cached.expireAt > now) {
      return { apiKey: cached.apiKey, secretKey: cached.secretKey };
    }

    // 캐시 미스 - DB에서 조회
    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: 'upbit' },
      select: { apiKey: true, secretKey: true },
    });

    if (!credential) return null;

    const apiKey = decrypt(credential.apiKey);
    const secretKey = decrypt(credential.secretKey);

    // 캐시 저장 (5분 TTL)
    userCredentialCache.set(userId, {
      apiKey,
      secretKey,
      expireAt: now + CREDENTIAL_CACHE_TTL,
    });

    return { apiKey, secretKey };
  }

  // 캐시된 자격증명 조회 (없으면 DB에서 가져와서 캐시)
  private static async getCachedCredential(botId: number): Promise<{ apiKey: string; secretKey: string; userId: number } | null> {
    const now = Date.now();
    const cached = credentialCache.get(botId);
    const cachedBot = botInfoCache.get(botId);

    if (cached && cached.expireAt > now && cachedBot && cachedBot.expireAt > now) {
      return { apiKey: cached.apiKey, secretKey: cached.secretKey, userId: cachedBot.userId };
    }

    // 캐시 미스 - DB에서 조회 (재시도 로직 포함)
    const bot = await withRetry(
      () => prisma.bot.findUnique({
        where: { id: botId },
        include: {
          user: {
            include: {
              credentials: {
                where: { exchange: 'upbit' },
                select: { apiKey: true, secretKey: true },
              },
            },
          },
        },
      }),
      { operationName: `getCachedCredential(botId=${botId})` }
    );

    if (!bot || !bot.user.credentials[0]) return null;

    const credential = bot.user.credentials[0];
    const apiKey = decrypt(credential.apiKey);
    const secretKey = decrypt(credential.secretKey);

    // 캐시 저장
    credentialCache.set(botId, {
      apiKey,
      secretKey,
      expireAt: now + CREDENTIAL_CACHE_TTL,
    });
    botInfoCache.set(botId, {
      userId: bot.userId,
      ticker: bot.ticker,
      orderAmount: bot.orderAmount,
      expireAt: now + BOT_INFO_CACHE_TTL,
    });

    return { apiKey, secretKey, userId: bot.userId };
  }

  // 캐시된 봇 정보 조회
  private static async getCachedBotInfo(botId: number): Promise<CachedBotInfo | null> {
    const now = Date.now();
    const cached = botInfoCache.get(botId);

    if (cached && cached.expireAt > now) {
      return cached;
    }

    const bot = await withRetry(
      () => prisma.bot.findUnique({
        where: { id: botId },
        select: { userId: true, ticker: true, orderAmount: true },
      }),
      { operationName: `getCachedBotInfo(botId=${botId})` }
    );

    if (!bot) return null;

    const botInfo: CachedBotInfo = {
      userId: bot.userId,
      ticker: bot.ticker,
      orderAmount: bot.orderAmount,
      expireAt: now + BOT_INFO_CACHE_TTL,
    };
    botInfoCache.set(botId, botInfo);
    return botInfo;
  }

  // 특정 봇에 대한 거래 실행
  static async executeTrade(botId: number) {
    try {
      // 봇 상태만 간단히 조회 (캐시된 정보는 별도, 재시도 로직 포함)
      const bot = await withRetry(
        () => prisma.bot.findUnique({
          where: { id: botId },
          select: { id: true, status: true, ticker: true, orderAmount: true, errorMessage: true },
        }),
        { operationName: `executeTrade.findBot(botId=${botId})` }
      );

      if (!bot || bot.status !== 'running') {
        return { success: false, message: '봇이 실행 중이 아닙니다' };
      }

      // 캐시된 자격증명 조회 (5분 TTL)
      const cachedCred = await this.getCachedCredential(botId);
      if (!cachedCred) {
        await prisma.bot.update({
          where: { id: botId },
          data: {
            status: 'error',
            errorMessage: 'API 인증 정보가 없습니다',
          },
        });
        return { success: false, message: 'API 인증 정보가 없습니다' };
      }

      const { apiKey, secretKey } = cachedCred;

      // Upbit 서비스 초기화
      const upbit = new UpbitService({
        accessKey: apiKey,
        secretKey: secretKey,
      });

      // 현재가 조회 (WebSocket 캐시 우선, 없으면 REST 폴백)
      const currentPrice = await priceManager.getPriceWithFallback(bot.ticker);

      // 현재가 조회 성공 시 기존 에러 메시지 제거 (일시적 에러 복구)
      if (bot.errorMessage) {
        await prisma.bot.update({
          where: { id: botId },
          data: { errorMessage: null },
        });
      }

      // 실행 가능한 그리드 찾기
      const executableGrids = await GridService.findExecutableGrids(botId, currentPrice);

      // 실행할 주문이 있을 때만 로깅
      if (executableGrids.buy || executableGrids.sell) {
        console.log(`[Trading] Bot ${botId} (${bot.ticker}): price=${currentPrice.toLocaleString()}, buy:${executableGrids.buy?.price || '-'}, sell:${executableGrids.sell?.price || '-'}`);
      }

      let executed = false;

      // 매수 주문 실행 (지정가 주문)
      if (executableGrids.buy) {
        try {
          // Race condition 방지: 상태가 여전히 available인 경우에만 pending으로 변경
          const updateResult = await prisma.gridLevel.updateMany({
            where: {
              id: executableGrids.buy.id,
              status: 'available',  // 아직 available 상태인 경우에만
            },
            data: {
              status: 'pending',
            },
          });

          // 이미 다른 프로세스가 처리 중이면 스킵
          if (updateResult.count === 0) {
            console.log(`[Trading] Bot ${botId}: 매수 그리드가 이미 처리 중입니다 (${executableGrids.buy.price}원)`);
          } else {
            console.log(`[Trading] Bot ${botId}: 지정가 매수 주문 - ${executableGrids.buy.price}원`);

            const volume = bot.orderAmount / executableGrids.buy.price;

            const order = await upbit.buyLimit(
              bot.ticker,
              executableGrids.buy.price,
              volume
            );

            // orderId 업데이트
            await prisma.gridLevel.update({
              where: { id: executableGrids.buy.id },
              data: { orderId: order.uuid },
            });

            const newTrade = await prisma.trade.create({
              data: {
                botId,
                gridLevelId: executableGrids.buy.id,
                type: 'buy',
                price: executableGrids.buy.price,
                amount: volume,
                total: bot.orderAmount,
                orderId: order.uuid,
              },
            });

            socketService.emitNewTrade(botId, {
              id: newTrade.id,
              type: 'buy',
              price: executableGrids.buy.price,
              amount: volume,
              total: bot.orderAmount,
              orderId: order.uuid,
              status: 'pending',
              createdAt: newTrade.createdAt,
            });

            console.log(`[Trading] Bot ${botId}: 지정가 매수 주문 완료 - ${executableGrids.buy.price.toLocaleString()}원`);

            executed = true;
          }
        } catch (error: any) {
          console.error(`매수 주문 실패 (Bot ${botId}):`, error.message);

          // 에러 메시지 저장
          await prisma.bot.update({
            where: { id: botId },
            data: { errorMessage: `매수 주문 실패: ${error.message}` },
          });

          // 소켓으로 에러 알림
          socketService.emitError(botId, {
            type: 'order_failed',
            message: `매수 주문 실패: ${error.message}`,
            details: `가격: ${executableGrids.buy.price.toLocaleString()}원`,
          });
        }
      }

      // 매도 주문 실행
      if (executableGrids.sell) {
        try {
          // Race condition 방지: 상태가 여전히 available인 경우에만 pending으로 변경
          const updateResult = await prisma.gridLevel.updateMany({
            where: {
              id: executableGrids.sell.id,
              status: 'available',  // 아직 available 상태인 경우에만
            },
            data: {
              status: 'pending',
            },
          });

          // 이미 다른 프로세스가 처리 중이면 스킵
          if (updateResult.count === 0) {
            console.log(`[Trading] Bot ${botId}: 매도 그리드가 이미 처리 중입니다 (${executableGrids.sell.price}원)`);
          } else {
            // 주문 수량 계산
            const volume = bot.orderAmount / executableGrids.sell.price;

            // 매도 주문
            const order = await upbit.sellLimit(
              bot.ticker,
              executableGrids.sell.price,
              volume
            );

            // orderId 업데이트
            await prisma.gridLevel.update({
              where: { id: executableGrids.sell.id },
              data: { orderId: order.uuid },
            });

            // 거래 기록 저장
            const newTrade = await prisma.trade.create({
              data: {
                botId,
                gridLevelId: executableGrids.sell.id,
                type: 'sell',
                price: executableGrids.sell.price,
                amount: volume,
                total: bot.orderAmount,
                orderId: order.uuid,
              },
            });

            // 소켓으로 새 거래 알림
            socketService.emitNewTrade(botId, {
              id: newTrade.id,
              type: 'sell',
              price: executableGrids.sell.price,
              amount: volume,
              total: bot.orderAmount,
              orderId: order.uuid,
              status: 'pending',
              createdAt: newTrade.createdAt,
            });

            executed = true;
          }
        } catch (error: any) {
          console.error(`매도 주문 실패 (Bot ${botId}):`, error.message);

          // 에러 메시지 저장
          await prisma.bot.update({
            where: { id: botId },
            data: { errorMessage: `매도 주문 실패: ${error.message}` },
          });

          // 소켓으로 에러 알림
          socketService.emitError(botId, {
            type: 'order_failed',
            message: `매도 주문 실패: ${error.message}`,
            details: `가격: ${executableGrids.sell.price.toLocaleString()}원`,
          });
        }
      }

      // 봇 마지막 실행 시간 업데이트
      if (executed) {
        await prisma.bot.update({
          where: { id: botId },
          data: {
            lastExecutedAt: new Date(),
          },
        });
      }

      return { success: true, executed };
    } catch (error: any) {
      console.error(`거래 실행 실패 (Bot ${botId}):`, error.message);

      // 일시적인 에러는 상태를 error로 변경하지 않음
      const isTemporaryError = error.message.includes('429') ||
                               error.message.includes('현재가 조회 실패') ||
                               error.message.includes('Too Many Requests') ||
                               error.message.includes('connection pool') ||
                               error.message.includes('Timed out fetching') ||
                               error.message.includes('P2024');

      if (isTemporaryError) {
        // 에러 메시지만 저장하고 상태는 유지
        await prisma.bot.update({
          where: { id: botId },
          data: { errorMessage: error.message },
        });
        console.log(`[Trading] Bot ${botId}: 일시적 에러, 상태 유지 (running)`);
      } else {
        // 에러 상태로 업데이트
        await prisma.bot.update({
          where: { id: botId },
          data: {
            status: 'error',
            errorMessage: error.message,
          },
        });
      }

      return { success: false, message: error.message };
    }
  }

  /**
   * 중앙 집중식 체결 주문 확인 (마켓별 state=done API 방식)
   * - 사용자별 + 마켓별로 체결된 주문 조회
   * - 마켓별 100건 보장으로 체결 누락 방지
   * - API 에러 시 봇 자동 중지 및 사용자 알림
   */
  static async checkAllFilledOrders(runningBotIds: number[]) {
    if (runningBotIds.length === 0) return;

    try {
      // 1. 모든 running 봇의 pending 그리드를 한 번에 조회
      const allPendingGrids = await prisma.gridLevel.findMany({
        where: {
          botId: { in: runningBotIds },
          status: 'pending',
          orderId: { not: null },
        },
        include: {
          bot: {
            select: { id: true, userId: true, ticker: true, orderAmount: true, status: true },
          },
        },
      });

      if (allPendingGrids.length === 0) return;

      // 2. 사용자별로 그리드 그룹화
      const gridsByUser = new Map<number, typeof allPendingGrids>();

      for (const grid of allPendingGrids) {
        const userId = grid.bot.userId;
        if (!gridsByUser.has(userId)) {
          gridsByUser.set(userId, []);
        }
        gridsByUser.get(userId)!.push(grid);
      }

      console.log(`[Trading] 체결 확인: ${allPendingGrids.length}개 pending 주문, ${gridsByUser.size}명 사용자`);

      // 3. 사용자별로 마켓별 체결 주문 조회
      for (const [userId, grids] of gridsByUser) {
        try {
          // 사용자 자격증명 조회
          const credential = await this.getUserCredential(userId);
          if (!credential) {
            console.log(`[Trading] User ${userId}: 자격증명 없음, 스킵`);
            continue;
          }

          const upbit = new UpbitService({
            accessKey: credential.apiKey,
            secretKey: credential.secretKey,
          });

          // 마켓별로 그리드 그룹화
          const gridsByMarket = new Map<string, typeof grids>();
          for (const grid of grids) {
            const market = grid.bot.ticker;
            if (!gridsByMarket.has(market)) {
              gridsByMarket.set(market, []);
            }
            gridsByMarket.get(market)!.push(grid);
          }

          let totalFilledCount = 0;
          const processedGridIds = new Set<number>();

          // ===== 1단계: 전체 마켓 최근 체결 100건 조회 (API 1회로 최적화) =====
          try {
            const gridByOrderId = new Map(grids.filter(g => g.orderId).map(g => [g.orderId, g]));
            const filledOrders = await upbit.getFilledOrders(undefined, 100); // 전체 마켓

            for (const order of filledOrders) {
              const grid = gridByOrderId.get(order.uuid);
              if (grid && order.state === 'done') {
                await this.processFilledOrder(grid, order, upbit, userId);
                processedGridIds.add(grid.id);
                totalFilledCount++;
              }
            }
          } catch (error: any) {
            console.error(`[Trading] User ${userId} 체결 조회 실패:`, error.message);
          }

          // ===== 2단계: 30분 이상 오래된 pending만 orderId로 직접 조회 (누락 방지) =====
          // API rate limit 방지를 위해 사용자당 최대 20개만 처리
          const STALE_THRESHOLD = 30 * 60 * 1000; // 30분
          const MAX_STALE_CHECK_PER_USER = 20;
          const now = Date.now();

          const staleGrids = grids
            .filter(g =>
              g.orderId &&
              !processedGridIds.has(g.id) &&
              (now - new Date(g.updatedAt).getTime()) > STALE_THRESHOLD
            )
            .slice(0, MAX_STALE_CHECK_PER_USER); // 최대 20개만

          if (staleGrids.length > 0) {
            console.log(`[Trading] User ${userId}: ${staleGrids.length}개 오래된 pending 주문 직접 확인 (30분+)`);

            const staleOrderIds = staleGrids.map(g => g.orderId!);

            try {
              const orders = await upbit.getOrdersByUuids(staleOrderIds);
              const orderMap = new Map(orders.map(o => [o.uuid, o]));

              for (const grid of staleGrids) {
                const order = orderMap.get(grid.orderId!);
                if (!order) continue;

                if (order.state === 'done') {
                  console.log(`[Trading] User ${userId}: 오래된 체결 감지 - ${grid.bot.ticker} ${grid.type} ${grid.price}원`);
                  await this.processFilledOrder(grid, order, upbit, userId);
                  totalFilledCount++;
                } else if (order.state === 'cancel') {
                  console.log(`[Trading] User ${userId}: 취소된 주문 감지 - ${grid.bot.ticker} ${grid.type} ${grid.price}원`);
                  await prisma.gridLevel.update({
                    where: { id: grid.id },
                    data: { status: 'available', orderId: null },
                  });
                } else if (order.state === 'wait') {
                  // wait 상태: updatedAt 갱신하여 다음 30분 동안 재조회 방지
                  await prisma.gridLevel.update({
                    where: { id: grid.id },
                    data: { updatedAt: new Date() },
                  });
                }
              }
            } catch (staleError: any) {
              console.error(`[Trading] User ${userId} 오래된 주문 조회 실패:`, staleError.message);
            }
          }

          if (totalFilledCount > 0) {
            console.log(`[Trading] User ${userId}: ${totalFilledCount}개 주문 체결 처리됨`);
          }

          // 다음 사용자 처리 전 대기
          await new Promise(resolve => setTimeout(resolve, 300));

        } catch (error: any) {
          // API 인증 에러 (401, 403) 시 봇 자동 중지 및 알림
          const isAuthError = error.response?.status === 401 || error.response?.status === 403 ||
                              error.message?.includes('401') || error.message?.includes('Unauthorized');

          if (isAuthError) {
            console.error(`[Trading] User ${userId} API 인증 실패 - 봇 자동 중지:`, error.message);

            // 해당 사용자의 모든 봇 중지
            const userBotIds = [...new Set(grids.map(g => g.bot.id))];
            for (const botId of userBotIds) {
              try {
                await prisma.bot.update({
                  where: { id: botId },
                  data: { status: 'stopped' },
                });

                // 소켓으로 에러 알림
                socketService.emitError(botId, {
                  type: 'api_error',
                  message: 'API 인증 실패로 봇이 자동 중지되었습니다.',
                  details: 'API 키를 확인하고 재설정해주세요.',
                });

                // 봇 상태 변경 알림
                socketService.emitBotUpdate(botId, { status: 'stopped' });

                console.log(`[Trading] Bot ${botId} 자동 중지됨 (API 인증 실패)`);
              } catch (stopError: any) {
                console.error(`[Trading] Bot ${botId} 중지 실패:`, stopError.message);
              }
            }
          } else {
            console.error(`[Trading] User ${userId} 체결 확인 실패:`, error.message);
          }
        }
      }
    } catch (error: any) {
      console.error('[Trading] 체결 확인 실패:', error.message);
    }
  }

  /**
   * 체결된 주문 처리 (checkAllFilledOrders에서 호출)
   */
  private static async processFilledOrder(
    grid: any,
    order: any,
    upbit: UpbitService,
    userId: number
  ) {
    const botId = grid.botId;
    const processStartTime = Date.now(); // 처리 시작 시간 기록

    // 중복 처리 방지: pending 상태인 경우에만 처리 (atomic update)
    const updateResult = await prisma.gridLevel.updateMany({
      where: {
        id: grid.id,
        status: 'pending',  // 아직 pending 상태인 경우에만
      },
      data: {
        status: 'filled',
      },
    });

    // 이미 처리된 그리드면 스킵
    if (updateResult.count === 0) {
      return;
    }

    // 업비트 실제 체결 시간 추출
    let actualFilledAt = new Date();
    if (order.trades && order.trades.length > 0) {
      const lastTrade = order.trades[order.trades.length - 1];
      if (lastTrade.created_at) {
        actualFilledAt = new Date(lastTrade.created_at);
      }
    }

    // 체결 감지 지연 시간 계산
    const detectionDelayMs = processStartTime - actualFilledAt.getTime();
    const detectionDelaySec = (detectionDelayMs / 1000).toFixed(1);
    console.log(`[Trading] Bot ${botId}: 체결 감지 - 지연 ${detectionDelaySec}초 (실제 체결: ${actualFilledAt.toLocaleTimeString('ko-KR')}, 감지: ${new Date(processStartTime).toLocaleTimeString('ko-KR')})`);

    // 처리 시작 시간을 grid 객체에 저장 (반대 주문 시간 측정용)
    grid._processStartTime = processStartTime;
    grid._actualFilledAt = actualFilledAt;

    // 그리드 레벨에 체결 시간 업데이트
    await prisma.gridLevel.update({
      where: { id: grid.id },
      data: {
        orderId: grid.orderId,
        filledAt: actualFilledAt,
      },
    });

    // 수익 계산 (매도 체결 시에만)
    let profit = 0;
    const UPBIT_FEE_RATE = 0.0005;

    if (grid.type === 'sell' && grid.buyPrice) {
      const buyPrice = grid.buyPrice;
      const sellPrice = parseFloat(order.price);
      const volume = parseFloat(order.executed_volume);

      const buyAmount = volume * buyPrice;
      const buyFee = buyAmount * UPBIT_FEE_RATE;
      const sellAmount = volume * sellPrice;
      const sellFee = sellAmount * UPBIT_FEE_RATE;

      profit = sellAmount - buyAmount - buyFee - sellFee;
      console.log(`[Trading] Bot ${botId}: 매도 체결 - 매수가 ${buyPrice}원, 매도가 ${sellPrice}원, 수익 ${profit.toFixed(2)}원`);
    }

    // 봇 통계 업데이트
    await prisma.bot.update({
      where: { id: botId },
      data: {
        totalTrades: { increment: 1 },
        currentProfit: { increment: profit },
      },
    });

    // 월별 수익 기록
    if (grid.type === 'sell' && profit !== 0) {
      await ProfitService.recordProfit(userId, 'upbit', profit);
    }

    // 실제 체결가 및 체결량 추출
    const filledPrice = parseFloat(order.price);
    const filledVolume = parseFloat(order.executed_volume);
    const filledTotal = filledPrice * filledVolume;

    // 거래 기록 업데이트
    const trade = await prisma.trade.findFirst({
      where: { orderId: grid.orderId! },
    });

    if (trade) {
      // 실제 체결가로 업데이트
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          status: 'filled',
          filledAt: actualFilledAt,
          price: filledPrice,
          amount: filledVolume,
          total: filledTotal,
          ...(grid.type === 'sell' && profit !== 0 ? { profit } : {}),
        },
      });

      socketService.emitTradeFilled(botId, {
        id: trade.id,
        type: grid.type as 'buy' | 'sell',
        price: filledPrice,
        amount: filledVolume,
        total: filledTotal,
        profit: profit !== 0 ? profit : undefined,
        status: 'filled',
        filledAt: actualFilledAt,
      });
    } else {
      // Trade 레코드가 없는 경우 - 경고 로그 및 새로 생성
      console.warn(`[Trading] Bot ${botId}: Trade 레코드 없음 (orderId: ${grid.orderId}), 새로 생성`);

      // Trade 레코드 생성
      const volume = parseFloat(order.executed_volume);
      const price = parseFloat(order.price);
      const newTrade = await prisma.trade.create({
        data: {
          botId,
          gridLevelId: grid.id,
          type: grid.type as 'buy' | 'sell',
          price: price,
          amount: volume,
          total: price * volume,
          orderId: grid.orderId!,
          status: 'filled',
          filledAt: actualFilledAt,
          ...(grid.type === 'sell' && profit !== 0 ? { profit } : {}),
        },
      });

      socketService.emitTradeFilled(botId, {
        id: newTrade.id,
        type: grid.type as 'buy' | 'sell',
        price: price,
        amount: volume,
        total: price * volume,
        profit: profit !== 0 ? profit : undefined,
        status: 'filled',
        filledAt: actualFilledAt,
      });
    }

    // 봇 상태 업데이트 알림 (재시도 로직 포함)
    const updatedBot = await withRetry(
      () => prisma.bot.findUnique({
        where: { id: botId },
      }),
      { operationName: `processFilled.findBot(botId=${botId})` }
    );

    if (updatedBot) {
      socketService.emitBotUpdate(botId, {
        totalTrades: updatedBot.totalTrades,
        currentProfit: updatedBot.currentProfit,
      });

      // 반대 주문 실행
      if (updatedBot.status === 'running') {
        const botInfo = await this.getCachedBotInfo(botId);
        if (botInfo) {
          console.log(`[Trading] Bot ${botId}: 체결 후 반대 주문 실행 시도 - grid type: ${grid.type}, sellPrice: ${grid.sellPrice}, buyPrice: ${grid.buyPrice}`);
          await this.executeOppositeOrder(upbit, {
            id: botId,
            ticker: botInfo.ticker,
            orderAmount: botInfo.orderAmount,
          }, grid);
        } else {
          console.log(`[Trading] Bot ${botId}: botInfo를 찾을 수 없어 반대 주문 실행 불가`);
        }
      } else {
        console.log(`[Trading] Bot ${botId}: 봇 상태가 running이 아님 (${updatedBot.status}), 반대 주문 미실행`);
      }
    } else {
      console.log(`[Trading] Bot ${botId}: updatedBot이 null, 반대 주문 미실행`);
    }
  }

  // 체결된 주문 확인 및 즉시 반대 주문 실행 (state=done API 사용) - 개별 봇용 (호환성 유지)
  static async checkFilledOrders(botId: number) {
    try {
      // pending 상태의 그리드 레벨 조회
      const pendingGrids = await prisma.gridLevel.findMany({
        where: {
          botId,
          status: 'pending',
        },
      });

      // pending 그리드가 없으면 조기 리턴
      if (pendingGrids.length === 0) return;

      // 캐시된 자격증명 조회 (5분 TTL) - 무거운 JOIN 쿼리 제거
      const cachedCred = await this.getCachedCredential(botId);
      if (!cachedCred) return;

      const { apiKey, secretKey, userId } = cachedCred;

      const upbit = new UpbitService({
        accessKey: apiKey,
        secretKey: secretKey,
      });

      // orderId가 있는 그리드들만 필터링
      const gridsWithOrderId = pendingGrids.filter(g => g.orderId);
      if (gridsWithOrderId.length === 0) return;

      // orderId로 빠른 조회를 위한 Map 생성
      const gridByOrderId = new Map(gridsWithOrderId.map(g => [g.orderId, g]));

      // 최근 체결 완료된 주문 조회 (API 1회, 최대 100건)
      let filledOrders: any[] = [];
      try {
        filledOrders = await upbit.getFilledOrders(undefined, 100);
      } catch (err: any) {
        console.error(`[Trading] Bot ${botId}: 체결 주문 조회 실패 - ${err.message}`);
        return;
      }

      // pending 그리드와 매칭하여 처리
      for (const order of filledOrders) {
        const grid = gridByOrderId.get(order.uuid);
        if (!grid || order.state !== 'done') continue;

        try {
          // 업비트 실제 체결 시간 추출 (trades 배열의 마지막 거래 시간 사용)
          let actualFilledAt = new Date();
          if (order.trades && order.trades.length > 0) {
            const lastTrade = order.trades[order.trades.length - 1];
            if (lastTrade.created_at) {
              actualFilledAt = new Date(lastTrade.created_at);
            }
          }

          // 그리드 레벨을 filled로 업데이트
          await GridService.updateGridLevel(
            grid.id,
            'filled',
            grid.orderId!,
            actualFilledAt
          );

          // 수익 계산 (매도 체결 시에만, 수수료 포함)
          let profit = 0;
          const UPBIT_FEE_RATE = 0.0005;

          if (grid.type === 'sell' && grid.buyPrice) {
            const buyPrice = grid.buyPrice;
            const sellPrice = parseFloat(order.price);
            const volume = parseFloat(order.executed_volume);

            const buyAmount = volume * buyPrice;
            const buyFee = buyAmount * UPBIT_FEE_RATE;
            const sellAmount = volume * sellPrice;
            const sellFee = sellAmount * UPBIT_FEE_RATE;

            profit = sellAmount - buyAmount - buyFee - sellFee;
            console.log(`[Trading] Bot ${botId}: 매도 체결 - 매수가 ${buyPrice}원, 매도가 ${sellPrice}원, 수량 ${volume}, 수익 ${profit.toFixed(2)}원`);
          }

          // 봇 통계 업데이트
          await prisma.bot.update({
            where: { id: botId },
            data: {
              totalTrades: { increment: 1 },
              currentProfit: { increment: profit },
            },
          });

          // 월별 수익 기록 (매도 체결 시에만)
          if (grid.type === 'sell' && profit !== 0) {
            await ProfitService.recordProfit(userId, 'upbit', profit);
          }

          // 실제 체결가 및 체결량 추출
          const filledPrice = parseFloat(order.price);
          const filledVolume = parseFloat(order.executed_volume);
          const filledTotal = filledPrice * filledVolume;

          // 거래 기록에 실제 체결가로 업데이트
          const trade = await prisma.trade.findFirst({
            where: { orderId: grid.orderId! },
          });

          if (trade) {
            await prisma.trade.update({
              where: { id: trade.id },
              data: {
                status: 'filled',
                filledAt: actualFilledAt,
                price: filledPrice,
                amount: filledVolume,
                total: filledTotal,
                ...(grid.type === 'sell' && profit !== 0 ? { profit } : {}),
              },
            });

            socketService.emitTradeFilled(botId, {
              id: trade.id,
              type: grid.type as 'buy' | 'sell',
              price: filledPrice,
              amount: filledVolume,
              total: filledTotal,
              profit: profit !== 0 ? profit : undefined,
              status: 'filled',
              filledAt: actualFilledAt,
            });
          }

          // 봇 상태 업데이트 알림 (재시도 로직 포함)
          const updatedBot = await withRetry(
            () => prisma.bot.findUnique({
              where: { id: botId },
            }),
            { operationName: `checkFilledOrders.findBot(botId=${botId})` }
          );

          if (updatedBot) {
            socketService.emitBotUpdate(botId, {
              totalTrades: updatedBot.totalTrades,
              currentProfit: updatedBot.currentProfit,
            });

            // 체결 즉시 반대 주문 실행
            if (updatedBot.status === 'running') {
              const botInfo = await this.getCachedBotInfo(botId);
              if (botInfo) {
                await this.executeOppositeOrder(upbit, {
                  id: botId,
                  ticker: botInfo.ticker,
                  orderAmount: botInfo.orderAmount,
                }, grid);
              }
            }
          }
        } catch (error: any) {
          console.error(`주문 처리 실패 (Grid ${grid.id}):`, error.message);
        }
      }
    } catch (error: any) {
      console.error(`체결 확인 실패 (Bot ${botId}):`, error.message);
    }
  }

  /**
   * 잔고 부족 시 원거리 매수 주문 정리
   * 현재가 기준 가까운 N개만 유지하고 나머지 취소
   */
  private static async trimBuyOrdersOnInsufficientBalance(
    upbit: UpbitService,
    botId: number,
    ticker: string,
    keepCount: number = 7
  ): Promise<{ cancelled: number; kept: number }> {
    try {
      console.log(`[Trading] Bot ${botId}: 잔고 부족으로 매수 주문 정리 시작 (유지할 주문: ${keepCount}개)`);

      // 1. 현재가 조회
      const market = `KRW-${ticker}`;
      const tickerData = await UpbitService.getCurrentPrice(market);
      const currentPrice = tickerData.trade_price;
      console.log(`[Trading] Bot ${botId}: 현재가 ${currentPrice.toLocaleString()}원`);

      // 2. 미체결 매수 주문 조회 (pending 상태, buy 타입, orderId 있는 것)
      const pendingBuyGrids = await prisma.gridLevel.findMany({
        where: {
          botId,
          type: 'buy',
          status: 'pending',
          orderId: { not: null },
        },
        orderBy: { price: 'desc' }, // 높은 가격(현재가에 가까운)부터 정렬
      });

      console.log(`[Trading] Bot ${botId}: 미체결 매수 주문 ${pendingBuyGrids.length}개 발견`);

      if (pendingBuyGrids.length <= keepCount) {
        console.log(`[Trading] Bot ${botId}: 주문 개수가 ${keepCount}개 이하, 정리 불필요`);
        return { cancelled: 0, kept: pendingBuyGrids.length };
      }

      // 3. 현재가와 가까운 순으로 정렬 (거리 기준)
      const sortedByDistance = pendingBuyGrids
        .map(grid => ({
          ...grid,
          distance: Math.abs(currentPrice - grid.price),
        }))
        .sort((a, b) => a.distance - b.distance);

      // 4. 유지할 주문과 취소할 주문 분리
      const toKeep = sortedByDistance.slice(0, keepCount);
      const toCancel = sortedByDistance.slice(keepCount);

      console.log(`[Trading] Bot ${botId}: 유지 ${toKeep.length}개, 취소 ${toCancel.length}개`);

      // 5. 원거리 주문 취소
      let cancelledCount = 0;
      for (const grid of toCancel) {
        try {
          if (grid.orderId) {
            await upbit.cancelOrder(grid.orderId);

            // 그리드 상태를 inactive로 변경 (다음에 다시 주문 가능)
            await prisma.gridLevel.update({
              where: { id: grid.id },
              data: {
                status: 'inactive',
                orderId: null,
              },
            });

            cancelledCount++;
            console.log(`[Trading] Bot ${botId}: 매수 주문 취소 완료 - ${grid.price.toLocaleString()}원 (현재가 대비 ${((grid.distance / currentPrice) * 100).toFixed(2)}%)`);
          }
        } catch (cancelError: any) {
          console.error(`[Trading] Bot ${botId}: 주문 취소 실패 (${grid.price}원) - ${cancelError.message}`);
        }
      }

      // 6. 에러 메시지 제거 (정리 완료 후 정상 동작)
      if (cancelledCount > 0) {
        await prisma.bot.update({
          where: { id: botId },
          data: { errorMessage: null },
        });

        // 소켓으로 알림 (시스템 에러 타입으로 정보 전달)
        socketService.emitError(botId, {
          type: 'system_error',
          message: `잔고 부족으로 원거리 매수 주문 ${cancelledCount}개 취소, ${toKeep.length}개 유지`,
        });
      }

      console.log(`[Trading] Bot ${botId}: 매수 주문 정리 완료 - 취소 ${cancelledCount}개, 유지 ${toKeep.length}개`);
      return { cancelled: cancelledCount, kept: toKeep.length };

    } catch (error: any) {
      console.error(`[Trading] Bot ${botId}: 매수 주문 정리 실패 - ${error.message}`);
      return { cancelled: 0, kept: 0 };
    }
  }

  // 체결 후 즉시 반대 주문 실행
  private static async executeOppositeOrder(
    upbit: UpbitService,
    bot: { id: number; ticker: string; orderAmount: number },
    filledGrid: { id: number; type: string; sellPrice: number | null; buyPrice: number | null; botId: number; _processStartTime?: number; _actualFilledAt?: Date },
    retryCount: number = 0
  ): Promise<void> {
    const MAX_RETRIES = 3;
    const oppositeOrderStartTime = Date.now();

    try {
      // 유효성 검사
      if (filledGrid.type === 'buy' && !filledGrid.sellPrice) {
        console.log(`[Trading] Bot ${bot.id}: 매수 그리드인데 sellPrice가 없음! grid id: ${filledGrid.id}`);
        return;
      }
      if (filledGrid.type === 'sell' && !filledGrid.buyPrice) {
        console.log(`[Trading] Bot ${bot.id}: 매도 그리드인데 buyPrice가 없음! grid id: ${filledGrid.id}`);
        return;
      }

      if (filledGrid.type === 'buy' && filledGrid.sellPrice) {
        // 매수 체결 → 즉시 매도 주문
        const sellPrice = filledGrid.sellPrice;
        const volume = bot.orderAmount / sellPrice;

        console.log(`[Trading] Bot ${bot.id}: 매수 체결 후 즉시 매도 주문 - ${sellPrice.toLocaleString()}원`);

        // 매도 그리드 레벨 찾기 (inactive 또는 filled 상태 - 사이클 완료 후 재사용)
        // 부동소수점 오차를 위해 범위 검색 (가격 기반 동적 범위 사용)
        // 저가 코인(PEPE 등)은 가격 차이가 매우 작으므로 범위를 좁게 설정
        const priceMargin = Math.max(sellPrice * 0.001, 0.000001); // 0.1% 또는 최소 0.000001
        const sellGrid = await prisma.gridLevel.findFirst({
          where: {
            botId: bot.id,
            price: {
              gte: sellPrice - priceMargin,
              lte: sellPrice + priceMargin,
            },
            type: 'sell',
            status: { in: ['inactive', 'filled'] },  // 첫 사이클 또는 완료된 사이클
          },
        });

        if (!sellGrid) {
          // 디버깅: 모든 매도 그리드 상태 확인
          const allSellGrids = await prisma.gridLevel.findMany({
            where: {
              botId: bot.id,
              type: 'sell',
            },
            select: { id: true, price: true, status: true, orderId: true },
            orderBy: { price: 'asc' },
          });
          console.log(`[Trading] Bot ${bot.id}: 매도 그리드 찾기 실패! sellPrice=${sellPrice}, margin=${priceMargin}, 모든 매도 그리드:`, allSellGrids.map(g => ({ id: g.id, price: g.price, status: g.status })));
          return;
        }

        console.log(`[Trading] Bot ${bot.id}: 매도 그리드 찾음 - id: ${sellGrid.id}, price: ${sellGrid.price}, status: ${sellGrid.status}`);

        // 매도 주문 실행
        const order = await upbit.sellLimit(bot.ticker, sellPrice, volume);

        // 그리드 레벨 상태 업데이트
        await GridService.updateGridLevel(sellGrid.id, 'pending', order.uuid);

        // 거래 기록 저장
        const newTrade = await prisma.trade.create({
          data: {
            botId: bot.id,
            gridLevelId: sellGrid.id,
            type: 'sell',
            price: sellPrice,
            amount: volume,
            total: bot.orderAmount,
            orderId: order.uuid,
          },
        });

        // 소켓으로 새 거래 알림
        socketService.emitNewTrade(bot.id, {
          id: newTrade.id,
          type: 'sell',
          price: sellPrice,
          amount: volume,
          total: bot.orderAmount,
          orderId: order.uuid,
          status: 'pending',
          createdAt: newTrade.createdAt,
        });

        // 타이밍 로그
        const oppositeOrderEndTime = Date.now();
        if (filledGrid._actualFilledAt) {
          const totalDelaySec = ((oppositeOrderEndTime - filledGrid._actualFilledAt.getTime()) / 1000).toFixed(1);
          const orderPlacementMs = oppositeOrderEndTime - oppositeOrderStartTime;
          console.log(`[Trading] Bot ${bot.id}: ⚡ 반대 주문 완료 - 매도 ${sellPrice.toLocaleString()}원 (체결→주문: ${totalDelaySec}초, 주문처리: ${orderPlacementMs}ms)`);
        } else {
          console.log(`[Trading] Bot ${bot.id}: 즉시 매도 주문 완료 - ${sellPrice.toLocaleString()}원`);
        }

      } else if (filledGrid.type === 'sell' && filledGrid.buyPrice) {
        // 매도 체결 → 즉시 매수 주문
        const buyPrice = filledGrid.buyPrice;
        const volume = bot.orderAmount / buyPrice;

        console.log(`[Trading] Bot ${bot.id}: 매도 체결 후 즉시 매수 주문 - ${buyPrice.toLocaleString()}원`);

        // 매수 그리드 레벨 찾기 (filled 상태만 - 이전 사이클에서 완료된 것)
        // 부동소수점 오차를 위해 범위 검색 (가격 기반 동적 범위 사용)
        // 저가 코인(PEPE 등)은 가격 차이가 매우 작으므로 범위를 좁게 설정
        const priceMargin = Math.max(buyPrice * 0.001, 0.000001); // 0.1% 또는 최소 0.000001
        const buyGrid = await prisma.gridLevel.findFirst({
          where: {
            botId: bot.id,
            price: {
              gte: buyPrice - priceMargin,
              lte: buyPrice + priceMargin,
            },
            type: 'buy',
            status: 'filled',  // 이전에 체결 완료된 그리드만
          },
        });

        if (!buyGrid) {
          // 디버깅: 모든 매수 그리드 상태 확인
          const allBuyGrids = await prisma.gridLevel.findMany({
            where: {
              botId: bot.id,
              type: 'buy',
            },
            select: { id: true, price: true, status: true, orderId: true },
            orderBy: { price: 'asc' },
          });
          console.log(`[Trading] Bot ${bot.id}: 매수 그리드 찾기 실패! buyPrice=${buyPrice}, margin=${priceMargin}, 모든 매수 그리드:`, allBuyGrids.map(g => ({ id: g.id, price: g.price, status: g.status })));
          return;
        }

        console.log(`[Trading] Bot ${bot.id}: 매수 그리드 찾음 - id: ${buyGrid.id}, price: ${buyGrid.price}, status: ${buyGrid.status}`);

        // 매수 주문 실행
        const order = await upbit.buyLimit(bot.ticker, buyPrice, volume);

        // 그리드 레벨 상태 업데이트
        await GridService.updateGridLevel(buyGrid.id, 'pending', order.uuid);

        // 거래 기록 저장
        const newTrade = await prisma.trade.create({
          data: {
            botId: bot.id,
            gridLevelId: buyGrid.id,
            type: 'buy',
            price: buyPrice,
            amount: volume,
            total: bot.orderAmount,
            orderId: order.uuid,
          },
        });

        // 소켓으로 새 거래 알림
        socketService.emitNewTrade(bot.id, {
          id: newTrade.id,
          type: 'buy',
          price: buyPrice,
          amount: volume,
          total: bot.orderAmount,
          orderId: order.uuid,
          status: 'pending',
          createdAt: newTrade.createdAt,
        });

        // 타이밍 로그
        const oppositeOrderEndTime = Date.now();
        if (filledGrid._actualFilledAt) {
          const totalDelaySec = ((oppositeOrderEndTime - filledGrid._actualFilledAt.getTime()) / 1000).toFixed(1);
          const orderPlacementMs = oppositeOrderEndTime - oppositeOrderStartTime;
          console.log(`[Trading] Bot ${bot.id}: ⚡ 반대 주문 완료 - 매수 ${buyPrice.toLocaleString()}원 (체결→주문: ${totalDelaySec}초, 주문처리: ${orderPlacementMs}ms)`);
        } else {
          console.log(`[Trading] Bot ${bot.id}: 즉시 매수 주문 완료 - ${buyPrice.toLocaleString()}원`);
        }
      }
    } catch (error: any) {
      console.error(`[Trading] Bot ${bot.id}: 반대 주문 실행 실패 - ${error.message}`);

      // 잔고 부족 에러는 재시도해도 해결되지 않음
      const isBalanceError = error.message.includes('부족') ||
                             error.message.includes('insufficient') ||
                             error.message.includes('balance');

      // 재시도 가능한 에러이고 재시도 횟수가 남아있으면 재시도
      if (!isBalanceError && retryCount < MAX_RETRIES) {
        const delay = 5000 * (retryCount + 1); // 점진적 대기: 5초, 10초, 15초
        console.log(`[Trading] Bot ${bot.id}: ${delay/1000}초 후 반대 주문 재시도 (${retryCount + 1}/${MAX_RETRIES})...`);

        await new Promise(resolve => setTimeout(resolve, delay));
        return this.executeOppositeOrder(upbit, bot, filledGrid, retryCount + 1);
      }

      // 잔고 부족 에러: 원거리 매수 주문 정리 후 재시도
      if (isBalanceError && filledGrid.type === 'sell') {
        console.log(`[Trading] Bot ${bot.id}: 잔고 부족 - 원거리 매수 주문 정리 시작`);

        const result = await this.trimBuyOrdersOnInsufficientBalance(
          upbit,
          bot.id,
          bot.ticker,
          7 // 현재가 기준 7개만 유지
        );

        // 주문 정리 후 재시도 (한 번만)
        if (result.cancelled > 0 && retryCount === 0) {
          console.log(`[Trading] Bot ${bot.id}: 주문 정리 완료, 매수 주문 재시도`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2초 대기
          return this.executeOppositeOrder(upbit, bot, filledGrid, retryCount + 1);
        }

        // 정리해도 실패하면 에러 저장
        if (result.cancelled === 0) {
          await prisma.bot.update({
            where: { id: bot.id },
            data: { errorMessage: `반대 주문 실패: ${error.message} (정리할 주문 없음)` },
          });
        }
        return;
      }

      // 그 외 에러: 에러 메시지 저장
      await prisma.bot.update({
        where: { id: bot.id },
        data: { errorMessage: `반대 주문 실패: ${error.message}` },
      });

      // 소켓으로 에러 알림
      socketService.emitError(bot.id, {
        type: 'order_failed',
        message: `반대 주문 실패: ${error.message}`,
        details: filledGrid.type === 'buy'
          ? `매도 가격: ${filledGrid.sellPrice?.toLocaleString()}원`
          : `매수 가격: ${filledGrid.buyPrice?.toLocaleString()}원`,
      });
    }
  }
}
