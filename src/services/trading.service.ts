import prisma from '../config/database';
import { UpbitService } from './upbit.service';
import { GridService } from './grid.service';
import { decrypt } from '../utils/encryption';
import { socketService } from './socket.service';

export class TradingService {
  // 특정 봇에 대한 거래 실행
  static async executeTrade(botId: number) {
    try {
      // 봇 정보 조회
      const bot = await prisma.bot.findUnique({
        where: { id: botId },
        include: {
          user: {
            include: {
              credentials: {
                where: { exchange: 'upbit' },
              },
            },
          },
        },
      });

      if (!bot || bot.status !== 'running') {
        return { success: false, message: '봇이 실행 중이 아닙니다' };
      }

      // API 키 확인
      const credential = bot.user.credentials[0];
      if (!credential) {
        await prisma.bot.update({
          where: { id: botId },
          data: {
            status: 'error',
            errorMessage: 'API 인증 정보가 없습니다',
          },
        });
        return { success: false, message: 'API 인증 정보가 없습니다' };
      }

      // API 키 복호화
      const apiKey = decrypt(credential.apiKey);
      const secretKey = decrypt(credential.secretKey);

      // Upbit 서비스 초기화
      const upbit = new UpbitService({
        accessKey: apiKey,
        secretKey: secretKey,
      });

      // 현재가 조회
      const priceData = await UpbitService.getCurrentPrice(bot.ticker);
      const currentPrice = priceData.trade_price;

      console.log(`[Trading] Bot ${botId} (${bot.ticker}): currentPrice=${currentPrice.toLocaleString()}`);

      // 실행 가능한 그리드 찾기
      const executableGrids = await GridService.findExecutableGrids(botId, currentPrice);

      console.log(`[Trading] Bot ${botId}: executableGrids = buy:${executableGrids.buy?.price || 'none'}, sell:${executableGrids.sell?.price || 'none'}`);

      let executed = false;

      // 매수 주문 실행 (지정가 주문)
      if (executableGrids.buy) {
        try {
          console.log(`[Trading] Bot ${botId}: 지정가 매수 주문 - ${executableGrids.buy.price}원`);

          const volume = bot.orderAmount / executableGrids.buy.price;

          const order = await upbit.buyLimit(
            bot.ticker,
            executableGrids.buy.price,
            volume
          );

          await GridService.updateGridLevel(
            executableGrids.buy.id,
            'pending',
            order.uuid
          );

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
          // 주문 수량 계산
          const volume = bot.orderAmount / executableGrids.sell.price;

          // 매도 주문
          const order = await upbit.sellLimit(
            bot.ticker,
            executableGrids.sell.price,
            volume
          );

          // 그리드 레벨 상태 업데이트
          await GridService.updateGridLevel(
            executableGrids.sell.id,
            'pending',
            order.uuid
          );

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

      // 에러 상태로 업데이트
      await prisma.bot.update({
        where: { id: botId },
        data: {
          status: 'error',
          errorMessage: error.message,
        },
      });

      return { success: false, message: error.message };
    }
  }

  // 체결된 주문 확인 및 즉시 반대 주문 실행
  static async checkFilledOrders(botId: number) {
    try {
      // pending 상태의 그리드 레벨 조회
      const pendingGrids = await prisma.gridLevel.findMany({
        where: {
          botId,
          status: 'pending',
        },
      });

      const bot = await prisma.bot.findUnique({
        where: { id: botId },
        include: {
          user: {
            include: {
              credentials: {
                where: { exchange: 'upbit' },
              },
            },
          },
        },
      });

      if (!bot || !bot.user.credentials[0]) return;

      const credential = bot.user.credentials[0];
      const apiKey = decrypt(credential.apiKey);
      const secretKey = decrypt(credential.secretKey);

      const upbit = new UpbitService({
        accessKey: apiKey,
        secretKey: secretKey,
      });

      for (const grid of pendingGrids) {
        if (!grid.orderId) continue;

        try {
          // 주문 상태 확인
          const order = await upbit.getOrder(grid.orderId);

          // 체결 완료 확인
          if (order.state === 'done') {
            // 그리드 레벨을 filled로 업데이트
            await GridService.updateGridLevel(
              grid.id,
              'filled',
              grid.orderId,
              new Date()
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

            // 거래 기록에 수익 업데이트
            const trade = await prisma.trade.findFirst({
              where: { orderId: grid.orderId },
            });

            if (trade) {
              // Trade 상태를 filled로 업데이트 (+ 매도 시 수익 저장)
              const filledAt = new Date();
              await prisma.trade.update({
                where: { id: trade.id },
                data: {
                  status: 'filled',
                  filledAt,
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
                filledAt,
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
            if (bot.status === 'running') {
              await this.executeOppositeOrder(upbit, bot, grid);
            }
          }
        } catch (error: any) {
          console.error(`주문 확인 실패 (Grid ${grid.id}):`, error.message);
        }
      }
    } catch (error: any) {
      console.error(`체결 확인 실패 (Bot ${botId}):`, error.message);
    }
  }

  // 체결 후 즉시 반대 주문 실행
  private static async executeOppositeOrder(
    upbit: UpbitService,
    bot: { id: number; ticker: string; orderAmount: number },
    filledGrid: { id: number; type: string; sellPrice: number | null; buyPrice: number | null; botId: number }
  ) {
    try {
      if (filledGrid.type === 'buy' && filledGrid.sellPrice) {
        // 매수 체결 → 즉시 매도 주문
        const sellPrice = filledGrid.sellPrice;
        const volume = bot.orderAmount / sellPrice;

        console.log(`[Trading] Bot ${bot.id}: 매수 체결 후 즉시 매도 주문 - ${sellPrice.toLocaleString()}원`);

        // 매도 그리드 레벨 찾기
        const sellGrid = await prisma.gridLevel.findFirst({
          where: {
            botId: bot.id,
            price: sellPrice,
            type: 'sell',
          },
        });

        if (!sellGrid) {
          console.error(`[Trading] Bot ${bot.id}: 매도 그리드 레벨을 찾을 수 없습니다 (${sellPrice}원)`);
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

        // 매수 그리드 레벨 찾기
        const buyGrid = await prisma.gridLevel.findFirst({
          where: {
            botId: bot.id,
            price: buyPrice,
            type: 'buy',
          },
        });

        if (!buyGrid) {
          console.error(`[Trading] Bot ${bot.id}: 매수 그리드 레벨을 찾을 수 없습니다 (${buyPrice}원)`);
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

      // 에러 메시지 저장
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
