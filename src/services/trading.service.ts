import prisma from '../config/database';
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

export class TradingService {
  // 캐시된 자격증명 조회 (없으면 DB에서 가져와서 캐시)
  private static async getCachedCredential(botId: number): Promise<{ apiKey: string; secretKey: string; userId: number } | null> {
    const now = Date.now();
    const cached = credentialCache.get(botId);
    const cachedBot = botInfoCache.get(botId);

    if (cached && cached.expireAt > now && cachedBot && cachedBot.expireAt > now) {
      return { apiKey: cached.apiKey, secretKey: cached.secretKey, userId: cachedBot.userId };
    }

    // 캐시 미스 - DB에서 조회
    const bot = await prisma.bot.findUnique({
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
    });

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

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: { userId: true, ticker: true, orderAmount: true },
    });

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
      // 봇 상태만 간단히 조회 (캐시된 정보는 별도)
      const bot = await prisma.bot.findUnique({
        where: { id: botId },
        select: { id: true, status: true, ticker: true, orderAmount: true, errorMessage: true },
      });

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

      // 429 에러나 현재가 조회 실패는 일시적인 문제이므로 상태를 error로 변경하지 않음
      const isTemporaryError = error.message.includes('429') ||
                               error.message.includes('현재가 조회 실패') ||
                               error.message.includes('Too Many Requests');

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

  // 체결된 주문 확인 및 즉시 반대 주문 실행 (배치 조회로 429 에러 방지)
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

      // 배치 조회로 모든 주문 상태를 한 번에 가져옴 (API 호출 1회)
      const orderIds = gridsWithOrderId.map(g => g.orderId as string);
      let orders: any[] = [];

      try {
        orders = await upbit.getOrdersByUuids(orderIds);
        // 배치 조회 로그는 체결된 주문이 있을 때만 출력 (아래에서 처리)
      } catch (err: any) {
        // 배치 조회 실패 시 개별 조회로 폴백 (호환성)
        console.log(`[Trading] Bot ${botId}: 배치 조회 실패, 개별 조회로 폴백 - ${err.message}`);
        for (const grid of gridsWithOrderId) {
          try {
            await new Promise(resolve => setTimeout(resolve, 200));
            const order = await upbit.getOrder(grid.orderId as string);
            if (order) orders.push(order);
          } catch (e: any) {
            console.error(`주문 확인 실패 (Grid ${grid.id}):`, e.message);
          }
        }
      }

      // orderId로 빠른 조회를 위한 Map 생성
      const orderMap = new Map(orders.map(o => [o.uuid, o]));

      // 각 그리드에 대해 체결 상태 확인
      for (const grid of gridsWithOrderId) {
        try {
          const order = orderMap.get(grid.orderId);
          if (!order) continue;

          // 체결 완료 확인
          if (order.state === 'done') {
            // 업비트 실제 체결 시간 추출 (trades 배열의 마지막 거래 시간 사용)
            let actualFilledAt = new Date();
            if (order.trades && order.trades.length > 0) {
              // trades 배열의 마지막 거래가 최종 체결 시간
              const lastTrade = order.trades[order.trades.length - 1];
              if (lastTrade.created_at) {
                actualFilledAt = new Date(lastTrade.created_at);
              }
            }

            // 그리드 레벨을 filled로 업데이트
            await GridService.updateGridLevel(
              grid.id,
              'filled',
              grid.orderId!,  // orderId는 위에서 필터링됨
              actualFilledAt
            );

            // 수익 계산 (매도 체결 시에만, 수수료 포함)
            let profit = 0;
            const UPBIT_FEE_RATE = 0.0005; // 업비트 수수료 0.05%

            if (grid.type === 'sell' && grid.buyPrice) {
              const buyPrice = grid.buyPrice;
              const sellPrice = parseFloat(order.price);
              const volume = parseFloat(order.executed_volume);

              // 매수 금액 및 수수료
              const buyAmount = volume * buyPrice;
              const buyFee = buyAmount * UPBIT_FEE_RATE;

              // 매도 금액 및 수수료
              const sellAmount = volume * sellPrice;
              const sellFee = sellAmount * UPBIT_FEE_RATE;

              // 순수익 = 매도금액 - 매수금액 - 매수수수료 - 매도수수료
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

            // 거래 기록에 수익 업데이트
            const trade = await prisma.trade.findFirst({
              where: { orderId: grid.orderId! },  // orderId는 위에서 필터링됨
            });

            if (trade) {
              // Trade 상태를 filled로 업데이트 (+ 매도 시 수익 저장)
              // actualFilledAt은 위에서 업비트 API에서 가져온 실제 체결 시간
              await prisma.trade.update({
                where: { id: trade.id },
                data: {
                  status: 'filled',
                  filledAt: actualFilledAt,
                  ...(grid.type === 'sell' && profit !== 0 ? { profit } : {}),
                },
              });

              // 소켓으로 체결 완료 알림
              socketService.emitTradeFilled(botId, {
                id: trade.id,
                type: grid.type as 'buy' | 'sell',
                price: trade.price,
                amount: trade.amount,
                total: trade.total,
                profit: profit !== 0 ? profit : undefined,
                status: 'filled',
                filledAt: actualFilledAt,
              });
            }

            // 봇 상태 업데이트 알림
            const updatedBot = await prisma.bot.findUnique({
              where: { id: botId },
            });

            if (updatedBot) {
              socketService.emitBotUpdate(botId, {
                totalTrades: updatedBot.totalTrades,
                currentProfit: updatedBot.currentProfit,
              });
            }

            // ========== 체결 즉시 반대 주문 실행 ==========
            // 봇이 여전히 running 상태인지 확인
            if (updatedBot && updatedBot.status === 'running') {
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
    filledGrid: { id: number; type: string; sellPrice: number | null; buyPrice: number | null; botId: number },
    retryCount: number = 0
  ): Promise<void> {
    const MAX_RETRIES = 3;
    try {
      if (filledGrid.type === 'buy' && filledGrid.sellPrice) {
        // 매수 체결 → 즉시 매도 주문
        const sellPrice = filledGrid.sellPrice;
        const volume = bot.orderAmount / sellPrice;

        console.log(`[Trading] Bot ${bot.id}: 매수 체결 후 즉시 매도 주문 - ${sellPrice.toLocaleString()}원`);

        // 매도 그리드 레벨 찾기 (inactive 또는 filled 상태 - 사이클 완료 후 재사용)
        const sellGrid = await prisma.gridLevel.findFirst({
          where: {
            botId: bot.id,
            price: sellPrice,
            type: 'sell',
            status: { in: ['inactive', 'filled'] },  // 첫 사이클 또는 완료된 사이클
          },
        });

        if (!sellGrid) {
          console.log(`[Trading] Bot ${bot.id}: 매도 그리드 레벨을 찾을 수 없거나 이미 주문 중입니다 (${sellPrice}원, status: pending)`);
          return;
        }

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

        console.log(`[Trading] Bot ${bot.id}: 즉시 매도 주문 완료 - ${sellPrice.toLocaleString()}원`);

      } else if (filledGrid.type === 'sell' && filledGrid.buyPrice) {
        // 매도 체결 → 즉시 매수 주문
        const buyPrice = filledGrid.buyPrice;
        const volume = bot.orderAmount / buyPrice;

        console.log(`[Trading] Bot ${bot.id}: 매도 체결 후 즉시 매수 주문 - ${buyPrice.toLocaleString()}원`);

        // 매수 그리드 레벨 찾기 (filled 상태만 - 이전 사이클에서 완료된 것)
        const buyGrid = await prisma.gridLevel.findFirst({
          where: {
            botId: bot.id,
            price: buyPrice,
            type: 'buy',
            status: 'filled',  // 이전에 체결 완료된 그리드만
          },
        });

        if (!buyGrid) {
          console.log(`[Trading] Bot ${bot.id}: 재매수할 그리드 레벨을 찾을 수 없거나 이미 주문 중입니다 (${buyPrice}원)`);
          return;
        }

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

        console.log(`[Trading] Bot ${bot.id}: 즉시 매수 주문 완료 - ${buyPrice.toLocaleString()}원`);
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
