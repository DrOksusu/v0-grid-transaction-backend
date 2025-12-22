import prisma from '../config/database';
import { KisService } from './kis.service';
import { decrypt, encrypt } from '../utils/encryption';
import { InfiniteBuyStatus, InfiniteBuyStrategy, SchedulerLogType, SchedulerLogStatus } from '@prisma/client';
import { getNextLOCExecutionTime } from '../utils/us-market-holidays';
import { PushService } from './push.service';

// 로그 저장 헬퍼 함수
async function saveLog(params: {
  type: SchedulerLogType;
  status: SchedulerLogStatus;
  message: string;
  stockId?: number;
  ticker?: string;
  details?: object;
  errorMessage?: string;
}) {
  try {
    await prisma.schedulerLog.create({
      data: {
        type: params.type,
        status: params.status,
        message: params.message,
        stockId: params.stockId,
        ticker: params.ticker,
        details: params.details ? JSON.stringify(params.details) : null,
        errorMessage: params.errorMessage,
      },
    });
  } catch (logError) {
    console.error('[InfiniteBuy] 로그 저장 실패:', logError);
  }
}

interface CreateStockParams {
  userId: number;
  ticker: string;
  name: string;
  exchange?: string;
  buyAmount: number;
  totalRounds?: number;
  targetProfit?: number;
  autoEnabled?: boolean;
  buyTime?: string;
  buyCondition?: string;
  autoStart?: boolean;
  strategy?: InfiniteBuyStrategy;  // 전략 선택 (basic | strategy1)
}

interface UpdateStockParams {
  buyAmount?: number;
  totalRounds?: number;
  targetProfit?: number;
  autoEnabled?: boolean;
  buyTime?: string;
  buyCondition?: string;
}

export class InfiniteBuyService {
  // KIS 서비스 인스턴스 가져오기
  private async getKisService(userId: number): Promise<KisService> {
    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: 'kis' },
    });

    if (!credential) {
      throw new Error('한국투자증권 API 설정을 찾을 수 없습니다');
    }

    if (!credential.apiKey || !credential.secretKey) {
      throw new Error('API Key 또는 Secret Key가 없습니다');
    }

    const appKey = decrypt(credential.apiKey);
    const appSecret = decrypt(credential.secretKey);

    const kisService = new KisService({
      appKey,
      appSecret,
      accountNo: credential.accountNo || '',
      isPaper: credential.isPaper ?? true,
    });

    // 토큰 유효성 확인
    let isTokenValid = false;
    if (credential.accessToken && credential.tokenExpireAt) {
      const now = new Date();
      const bufferTime = 10 * 60 * 1000; // 10분
      isTokenValid = credential.tokenExpireAt.getTime() - bufferTime > now.getTime();
    }

    if (isTokenValid && credential.accessToken) {
      // 유효한 토큰 설정
      kisService.setAccessToken(
        decrypt(credential.accessToken),
        credential.tokenExpireAt!
      );
    } else {
      // 토큰이 만료되었거나 없으면 새로 발급
      try {
        const tokenInfo = await kisService.getAccessToken();

        // DB에 새 토큰 저장
        await prisma.credential.update({
          where: { id: credential.id },
          data: {
            accessToken: encrypt(tokenInfo.accessToken),
            tokenExpireAt: tokenInfo.tokenExpireAt,
            lastValidatedAt: new Date(),
          },
        });

        console.log(`[KIS] 토큰 갱신 완료 (userId: ${userId})`);
      } catch (error: any) {
        throw new Error(`KIS 토큰 발급 실패: ${error.message}`);
      }
    }

    // 토큰 재발급 콜백 설정 (withTokenRefresh에서 자동 재발급 시 DB 저장용)
    kisService.setTokenRefreshCallback(async (newToken: string, newExpireAt: Date) => {
      try {
        await prisma.credential.update({
          where: { id: credential.id },
          data: {
            accessToken: encrypt(newToken),
            tokenExpireAt: newExpireAt,
          },
        });
        console.log(`[KIS] 토큰 자동 갱신 및 DB 저장 완료 (userId: ${userId})`);
      } catch (err: any) {
        console.error(`[KIS] 토큰 DB 저장 실패:`, err.message);
      }
    });

    return kisService;
  }

  // 종목 생성
  async createStock(params: CreateStockParams) {
    const {
      userId,
      ticker,
      name,
      exchange = 'NAS',
      buyAmount,
      totalRounds = 40,
      targetProfit = 10,
      autoEnabled = true,
      buyTime,
      buyCondition = 'daily',
      autoStart = false,
      strategy = 'basic',  // 기본값: basic 전략
    } = params;

    // 종목 생성 (중복 허용)
    const stock = await prisma.infiniteBuyStock.create({
      data: {
        userId,
        ticker: ticker.toUpperCase(),
        name,
        exchange,
        buyAmount,
        totalRounds,
        targetProfit,
        autoEnabled,
        buyTime,
        buyCondition,
        strategy,  // 전략 추가
        status: autoStart ? 'buying' : 'stopped',
      },
    });

    return stock;
  }

  // 전체 종목 조회 (현재가 포함)
  async getStocks(userId: number, status?: InfiniteBuyStatus) {
    const whereClause: any = { userId };
    if (status) {
      whereClause.status = status;
    }

    const stocks = await prisma.infiniteBuyStock.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
    });

    // 현재가 조회를 위한 KIS 서비스
    let kisService: KisService | null = null;
    try {
      kisService = await this.getKisService(userId);
    } catch (error: any) {
      console.error(`[InfiniteBuy] KIS 서비스 초기화 실패:`, error.message);
    }

    // 현재가 포함한 종목 정보 생성
    const stocksWithPrice = await Promise.all(
      stocks.map(async (stock) => {
        let currentPrice = 0;
        let priceChangePercent = 0;

        if (kisService) {
          try {
            const priceData = await kisService.getUSStockPrice(stock.ticker, stock.exchange);
            currentPrice = priceData.currentPrice;
            priceChangePercent = priceData.changePercent;
          } catch {
            // 가격 조회 실패 시 0으로
          }
        }

        const currentValue = currentPrice * stock.totalQuantity;
        const profitLoss = currentValue - stock.totalInvested;
        const profitLossPercent = stock.totalInvested > 0
          ? (profitLoss / stock.totalInvested) * 100
          : 0;

        // 목표가 계산 (평균단가 * (1 + 목표수익률/100))
        const targetPrice = stock.avgPrice > 0
          ? stock.avgPrice * (1 + stock.targetProfit / 100)
          : 0;

        return {
          id: stock.id.toString(),
          ticker: stock.ticker,
          name: stock.name,
          exchange: stock.exchange,
          status: stock.status,
          strategy: stock.strategy,  // 전략 추가
          buyAmount: stock.buyAmount,
          totalRounds: stock.totalRounds,
          targetProfit: stock.targetProfit,
          currentRound: stock.currentRound,
          totalInvested: stock.totalInvested,
          totalQuantity: stock.totalQuantity,
          avgPrice: stock.avgPrice,
          targetPrice,
          currentPrice,
          currentValue,
          profitLoss,
          profitLossPercent,
          priceChangePercent,
          autoEnabled: stock.autoEnabled,
          buyTime: stock.buyTime,
          buyCondition: stock.buyCondition,
          createdAt: stock.createdAt.toISOString(),
          updatedAt: stock.updatedAt.toISOString(),
          completedAt: stock.completedAt?.toISOString(),
        };
      })
    );

    // 요약 정보 계산
    const summary = {
      totalStocks: stocks.length,
      buyingCount: stocks.filter((s) => s.status === 'buying').length,
      completedCount: stocks.filter((s) => s.status === 'completed').length,
      stoppedCount: stocks.filter((s) => s.status === 'stopped').length,
      totalInvested: stocksWithPrice.reduce((sum, s) => sum + s.totalInvested, 0),
      totalValue: stocksWithPrice.reduce((sum, s) => sum + s.currentValue, 0),
      totalProfitLoss: stocksWithPrice.reduce((sum, s) => sum + s.profitLoss, 0),
      totalProfitLossPercent: 0,
    };

    summary.totalProfitLossPercent = summary.totalInvested > 0
      ? (summary.totalProfitLoss / summary.totalInvested) * 100
      : 0;

    return { stocks: stocksWithPrice, summary };
  }

  // 종목 상세 조회
  async getStock(userId: number, stockId: number) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    // 현재가 조회
    let currentPrice = 0;
    let priceChangePercent = 0;
    let priceError: string | null = null;

    try {
      const kisService = await this.getKisService(userId);
      const priceData = await kisService.getUSStockPrice(stock.ticker, stock.exchange);
      currentPrice = priceData.currentPrice;
      priceChangePercent = priceData.changePercent;
    } catch (error: any) {
      priceError = error.message;
      console.error(`[InfiniteBuy] ${stock.ticker} 현재가 조회 실패:`, error.message);
      // 진단용 로그 저장
      await saveLog({
        type: 'price_check',
        status: 'error',
        message: `[현재가조회] ${stock.ticker}: 가격 조회 실패`,
        stockId: stock.id,
        ticker: stock.ticker,
        errorMessage: error.message,
      });
    }

    // 현재가가 0이면 손익 계산하지 않음 (null로 표시)
    const currentValue = currentPrice > 0 ? currentPrice * stock.totalQuantity : null;
    const profitLoss = currentValue !== null ? currentValue - stock.totalInvested : null;
    const profitLossPercent = (profitLoss !== null && stock.totalInvested > 0)
      ? (profitLoss / stock.totalInvested) * 100
      : null;

    const targetPrice = stock.avgPrice > 0
      ? stock.avgPrice * (1 + stock.targetProfit / 100)
      : 0;

    // 다음 거래일 및 체결 예정 시간
    const nextExecution = getNextLOCExecutionTime();

    return {
      id: stock.id.toString(),
      ticker: stock.ticker,
      name: stock.name,
      exchange: stock.exchange,
      status: stock.status,
      strategy: stock.strategy,  // 전략 추가
      buyAmount: stock.buyAmount,
      totalRounds: stock.totalRounds,
      targetProfit: stock.targetProfit,
      currentRound: stock.currentRound,
      totalInvested: stock.totalInvested,
      totalQuantity: stock.totalQuantity,
      avgPrice: stock.avgPrice,
      targetPrice,
      currentPrice: currentPrice || null,  // 0이면 null
      currentValue,
      profitLoss,
      profitLossPercent,
      priceChangePercent: currentPrice > 0 ? priceChangePercent : null,
      priceError,  // 에러 메시지 전달
      autoEnabled: stock.autoEnabled,
      buyTime: stock.buyTime,
      buyCondition: stock.buyCondition,
      createdAt: stock.createdAt.toISOString(),
      updatedAt: stock.updatedAt.toISOString(),
      completedAt: stock.completedAt?.toISOString(),
      nextExecution: {
        dateStr: nextExecution.dateStr,
        dayOfWeek: nextExecution.dayOfWeek,
        isToday: nextExecution.isToday,
        daysUntil: nextExecution.daysUntil,
        executionTimeKST: nextExecution.executionTimeKST,
        executionTimeET: nextExecution.executionTimeET,
      },
    };
  }

  // 종목 설정 수정
  async updateStock(userId: number, stockId: number, params: UpdateStockParams) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    const updated = await prisma.infiniteBuyStock.update({
      where: { id: stockId },
      data: params,
    });

    return updated;
  }

  // 종목 삭제
  async deleteStock(userId: number, stockId: number) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    await prisma.infiniteBuyStock.delete({
      where: { id: stockId },
    });

    return true;
  }

  // 수동 매수 실행
  async executeBuy(userId: number, stockId: number, amount?: number) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      await saveLog({
        type: 'auto_buy',
        status: 'error',
        message: `[수동매수] 종목을 찾을 수 없습니다 (stockId: ${stockId})`,
        stockId,
        errorMessage: '종목을 찾을 수 없습니다',
      });
      throw new Error('종목을 찾을 수 없습니다');
    }

    if (stock.status === 'completed') {
      await saveLog({
        type: 'auto_buy',
        status: 'skipped',
        message: `[수동매수] ${stock.ticker}: 이미 익절 완료된 종목`,
        stockId,
        ticker: stock.ticker,
      });
      throw new Error('이미 익절 완료된 종목입니다');
    }

    if (stock.currentRound >= stock.totalRounds) {
      await saveLog({
        type: 'auto_buy',
        status: 'skipped',
        message: `[수동매수] ${stock.ticker}: 최대 분할 횟수 도달`,
        stockId,
        ticker: stock.ticker,
        details: { currentRound: stock.currentRound, totalRounds: stock.totalRounds },
      });
      throw new Error('최대 분할 횟수에 도달했습니다');
    }

    const buyAmount = amount || stock.buyAmount;

    // KIS 서비스 초기화
    let kisService: KisService;
    try {
      kisService = await this.getKisService(userId);
    } catch (error: any) {
      await saveLog({
        type: 'auto_buy',
        status: 'error',
        message: `[수동매수] ${stock.ticker}: KIS 서비스 초기화 실패`,
        stockId,
        ticker: stock.ticker,
        errorMessage: error.message,
      });
      throw error;
    }

    // 현재가 조회
    let currentPrice: number;
    try {
      const priceData = await kisService.getUSStockPrice(stock.ticker, stock.exchange);
      currentPrice = priceData.currentPrice;
    } catch (error: any) {
      await saveLog({
        type: 'auto_buy',
        status: 'error',
        message: `[수동매수] ${stock.ticker}: 현재가 조회 실패`,
        stockId,
        ticker: stock.ticker,
        errorMessage: error.message,
      });
      throw new Error(`현재가 조회 실패: ${error.message}`);
    }

    // 매수 수량 계산 (미국 주식은 정수 수량만 가능)
    const quantity = Math.floor(buyAmount / currentPrice);
    const nextRound = stock.currentRound + 1;

    // 수량이 0이면 매수 불가
    if (quantity < 1) {
      await saveLog({
        type: 'auto_buy',
        status: 'error',
        message: `[수동매수] ${stock.ticker}: 매수 수량 부족`,
        stockId,
        ticker: stock.ticker,
        details: { buyAmount, currentPrice, calculatedQuantity: quantity },
        errorMessage: `매수 금액(${buyAmount}달러)이 1주 가격(${currentPrice}달러)보다 적습니다`,
      });
      throw new Error(`매수 금액(${buyAmount}달러)이 1주 가격(${currentPrice}달러)보다 적습니다`);
    }

    // 실제 매수 주문 실행 (모의투자에서도 동작)
    let orderId: string | null = null;
    try {
      // 거래소 코드 변환 (NAS -> NASD)
      const exchangeCode = stock.exchange === 'NAS' ? 'NASD' :
                          stock.exchange === 'NYS' ? 'NYSE' : 'AMEX';
      const orderResult = await kisService.buyUSStock(
        stock.ticker,
        quantity,
        currentPrice,
        exchangeCode
      );
      orderId = orderResult.orderId;
    } catch (error: any) {
      await saveLog({
        type: 'auto_buy',
        status: 'error',
        message: `[수동매수] ${stock.ticker}: KIS 매수 주문 실패`,
        stockId,
        ticker: stock.ticker,
        details: { quantity, price: currentPrice, buyAmount },
        errorMessage: error.message,
      });
      console.error("KIS 매수 주문 오류:", error.message);
      throw new Error(`매수 주문 실패: ${error.message}`);
    }

    // 새 평균단가 계산 (실제 매수 금액 사용)
    const actualBuyAmount = quantity * currentPrice;  // 실제 매수 금액 (정수 수량 * 현재가)
    const newTotalInvested = stock.totalInvested + actualBuyAmount;
    const newTotalQuantity = stock.totalQuantity + quantity;
    const newAvgPrice = newTotalQuantity > 0 ? newTotalInvested / newTotalQuantity : 0;

    // DB 업데이트
    try {
      const [updatedStock, record] = await prisma.$transaction([
        prisma.infiniteBuyStock.update({
          where: { id: stockId },
          data: {
            currentRound: nextRound,
            totalInvested: newTotalInvested,
            totalQuantity: newTotalQuantity,
            avgPrice: newAvgPrice,
            status: 'buying',
          },
        }),
        prisma.infiniteBuyRecord.create({
          data: {
            stockId,
            type: 'buy',
            round: nextRound,
            price: currentPrice,
            quantity,
            amount: actualBuyAmount,  // 실제 매수 금액 저장
            orderId,
            orderStatus: orderId ? 'filled' : 'pending',
          },
        }),
      ]);

      // 성공 로그
      await saveLog({
        type: 'auto_buy',
        status: 'completed',
        message: `[수동매수] ${stock.ticker}: 매수 성공 (${nextRound}회차)`,
        stockId,
        ticker: stock.ticker,
        details: {
          round: nextRound,
          quantity,
          price: currentPrice,
          amount: actualBuyAmount,  // 실제 매수 금액 기록
          orderId,
        },
      });

      // 푸시 알림 전송
      try {
        await PushService.sendOrderFilledNotification(
          userId,
          stock.ticker,
          'buy',
          currentPrice,
          quantity
        );
      } catch (pushError) {
        console.error('[InfiniteBuy] 푸시 알림 전송 실패:', pushError);
      }

      return {
        record: {
          id: record.id.toString(),
          type: record.type,
          round: record.round,
          price: record.price,
          quantity: record.quantity,
          amount: record.amount,
          executedAt: record.executedAt.toISOString(),
        },
        stock: {
          currentRound: updatedStock.currentRound,
          totalInvested: updatedStock.totalInvested,
          totalQuantity: updatedStock.totalQuantity,
          avgPrice: updatedStock.avgPrice,
        },
      };
    } catch (error: any) {
      await saveLog({
        type: 'auto_buy',
        status: 'error',
        message: `[수동매수] ${stock.ticker}: DB 업데이트 실패`,
        stockId,
        ticker: stock.ticker,
        errorMessage: error.message,
      });
      throw new Error(`DB 업데이트 실패: ${error.message}`);
    }
  }

  // 익절 (전량 매도)
  async executeSell(userId: number, stockId: number, quantity?: number) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      await saveLog({
        type: 'price_check',
        status: 'error',
        message: `[수동매도] 종목을 찾을 수 없습니다 (stockId: ${stockId})`,
        stockId,
        errorMessage: '종목을 찾을 수 없습니다',
      });
      throw new Error('종목을 찾을 수 없습니다');
    }

    if (stock.status === 'completed') {
      await saveLog({
        type: 'price_check',
        status: 'skipped',
        message: `[수동매도] ${stock.ticker}: 이미 익절 완료된 종목`,
        stockId,
        ticker: stock.ticker,
      });
      throw new Error('이미 익절 완료된 종목입니다');
    }

    if (stock.totalQuantity <= 0) {
      await saveLog({
        type: 'price_check',
        status: 'skipped',
        message: `[수동매도] ${stock.ticker}: 매도할 수량이 없습니다`,
        stockId,
        ticker: stock.ticker,
      });
      throw new Error('매도할 수량이 없습니다');
    }

    const sellQuantity = quantity || stock.totalQuantity;

    // KIS 서비스 초기화
    let kisService: KisService;
    try {
      kisService = await this.getKisService(userId);
    } catch (error: any) {
      await saveLog({
        type: 'price_check',
        status: 'error',
        message: `[수동매도] ${stock.ticker}: KIS 서비스 초기화 실패`,
        stockId,
        ticker: stock.ticker,
        errorMessage: error.message,
      });
      throw error;
    }

    // 현재가 조회
    let currentPrice: number;
    try {
      const priceData = await kisService.getUSStockPrice(stock.ticker, stock.exchange);
      currentPrice = priceData.currentPrice;
    } catch (error: any) {
      await saveLog({
        type: 'price_check',
        status: 'error',
        message: `[수동매도] ${stock.ticker}: 현재가 조회 실패`,
        stockId,
        ticker: stock.ticker,
        errorMessage: error.message,
      });
      throw new Error(`현재가 조회 실패: ${error.message}`);
    }

    // 매도 금액 및 수익 계산
    const sellAmount = currentPrice * sellQuantity;
    const costBasis = stock.avgPrice * sellQuantity;
    const profit = sellAmount - costBasis;
    const profitPercent = costBasis > 0 ? (profit / costBasis) * 100 : 0;

    // 실제 매도 주문 실행
    let orderId: string | null = null;
    try {
      const exchangeCode = stock.exchange === 'NAS' ? 'NASD' :
                          stock.exchange === 'NYS' ? 'NYSE' : 'AMEX';
      const orderResult = await kisService.sellUSStock(
        stock.ticker,
        sellQuantity,
        currentPrice,
        exchangeCode
      );
      orderId = orderResult.orderId;
    } catch (error: any) {
      await saveLog({
        type: 'price_check',
        status: 'error',
        message: `[수동매도] ${stock.ticker}: KIS 매도 주문 실패`,
        stockId,
        ticker: stock.ticker,
        details: { sellQuantity, price: currentPrice },
        errorMessage: error.message,
      });
      console.error("KIS 매도 주문 오류:", error.message);
      throw new Error(`매도 주문 실패: ${error.message}`);
    }

    // 전량 매도인지 확인
    const isFullSell = sellQuantity >= stock.totalQuantity;
    const newTotalQuantity = isFullSell ? 0 : stock.totalQuantity - sellQuantity;
    const newTotalInvested = isFullSell ? 0 : stock.totalInvested - costBasis;

    // DB 업데이트
    try {
      const [updatedStock, record] = await prisma.$transaction([
        prisma.infiniteBuyStock.update({
          where: { id: stockId },
          data: {
            totalQuantity: newTotalQuantity,
            totalInvested: newTotalInvested,
            status: isFullSell ? 'completed' : 'buying',
            completedAt: isFullSell ? new Date() : null,
          },
        }),
        prisma.infiniteBuyRecord.create({
          data: {
            stockId,
            type: 'sell',
            price: currentPrice,
            quantity: sellQuantity,
            amount: sellAmount,
            profit,
            profitPercent,
            orderId,
            orderStatus: orderId ? 'filled' : 'pending',
          },
        }),
      ]);

      // 성공 로그
      await saveLog({
        type: 'price_check',
        status: 'completed',
        message: `[수동매도] ${stock.ticker}: 매도 성공 (${isFullSell ? '전량' : '일부'})`,
        stockId,
        ticker: stock.ticker,
        details: {
          sellQuantity,
          price: currentPrice,
          sellAmount,
          profit,
          profitPercent,
          isFullSell,
          orderId,
        },
      });

      // 푸시 알림 전송
      try {
        await PushService.sendOrderFilledNotification(
          userId,
          stock.ticker,
          'sell',
          currentPrice,
          sellQuantity
        );
      } catch (pushError) {
        console.error('[InfiniteBuy] 푸시 알림 전송 실패:', pushError);
      }

      return {
        record: {
          id: record.id.toString(),
          type: record.type,
          price: record.price,
          quantity: record.quantity,
          amount: record.amount,
          profit: record.profit,
          profitPercent: record.profitPercent,
          executedAt: record.executedAt.toISOString(),
        },
        stock: {
          status: updatedStock.status,
          completedAt: updatedStock.completedAt?.toISOString(),
        },
      };
    } catch (error: any) {
      await saveLog({
        type: 'price_check',
        status: 'error',
        message: `[수동매도] ${stock.ticker}: DB 업데이트 실패`,
        stockId,
        ticker: stock.ticker,
        errorMessage: error.message,
      });
      throw new Error(`DB 업데이트 실패: ${error.message}`);
    }
  }

  // 종목 중단
  async stopStock(userId: number, stockId: number) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    if (stock.status === 'completed') {
      throw new Error('이미 익절 완료된 종목입니다');
    }

    if (stock.status === 'stopped') {
      throw new Error('이미 중단된 종목입니다');
    }

    const updated = await prisma.infiniteBuyStock.update({
      where: { id: stockId },
      data: { status: 'stopped' },
    });

    return { status: updated.status };
  }

  // 종목 재개
  async resumeStock(userId: number, stockId: number) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    if (stock.status === 'completed') {
      throw new Error('익절 완료된 종목은 재개할 수 없습니다');
    }

    if (stock.status === 'buying') {
      throw new Error('이미 진행중인 종목입니다');
    }

    const updated = await prisma.infiniteBuyStock.update({
      where: { id: stockId },
      data: { status: 'buying' },
    });

    return { status: updated.status };
  }

  // 종목별 매수 기록 조회
  // filledOnly: true면 체결된 것만, false면 모든 주문
  // 무한매수1 전략(LOC)은 체결 대기(pending) 상태도 포함해야 함
  async getRecords(userId: number, stockId: number, type?: string, limit: number = 50, filledOnly: boolean = false) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    const whereClause: any = { stockId };
    if (type) {
      whereClause.type = type;
    }

    // filledOnly가 true인 경우에만 체결된 것만 조회
    // 기본 전략의 경우 즉시 체결되므로 filled만 표시해도 됨
    // 무한매수1 전략(LOC)은 pending 상태도 있으므로 모두 표시
    if (filledOnly && stock.strategy !== 'strategy1') {
      whereClause.orderStatus = 'filled';
    }

    const records = await prisma.infiniteBuyRecord.findMany({
      where: whereClause,
      orderBy: { executedAt: 'desc' },
      take: limit,
    });

    // 누적 투자금 계산
    let cumulative = 0;
    const recordsWithCumulative = records.reverse().map((record) => {
      if (record.type === 'buy') {
        cumulative += record.amount;
      }
      return {
        id: record.id.toString(),
        type: record.type,
        round: record.round,
        price: record.price,
        quantity: record.quantity,
        amount: record.amount,
        profit: record.profit,
        profitPercent: record.profitPercent,
        orderStatus: record.orderStatus,
        orderType: record.orderType,        // LOC/시장가 등
        targetPrice: record.targetPrice,    // 목표 체결가
        orderSubType: record.orderSubType,  // LOC 세부 유형
        cumulative,
        executedAt: record.executedAt.toISOString(),
      };
    }).reverse();

    return {
      records: recordsWithCumulative,
      total: records.length,
    };
  }

  // 전체 히스토리 조회
  async getHistory(
    userId: number,
    params: {
      ticker?: string;
      type?: string;
      startDate?: string;
      endDate?: string;
      limit?: number;
      offset?: number;
    }
  ) {
    const { ticker, type, startDate, endDate, limit = 100, offset = 0 } = params;

    // 사용자의 종목 ID 목록
    const userStocks = await prisma.infiniteBuyStock.findMany({
      where: { userId, ...(ticker && { ticker: ticker.toUpperCase() }) },
      select: { id: true, ticker: true, name: true },
    });

    const stockIds = userStocks.map((s) => s.id);
    const stockMap = new Map(userStocks.map((s) => [s.id, s]));

    if (stockIds.length === 0) {
      return { records: [], total: 0, summary: null };
    }

    const whereClause: any = { stockId: { in: stockIds } };
    if (type) {
      whereClause.type = type;
    }
    if (startDate || endDate) {
      whereClause.executedAt = {};
      if (startDate) {
        whereClause.executedAt.gte = new Date(startDate);
      }
      if (endDate) {
        whereClause.executedAt.lte = new Date(endDate + 'T23:59:59.999Z');
      }
    }

    const [records, total] = await Promise.all([
      prisma.infiniteBuyRecord.findMany({
        where: whereClause,
        orderBy: { executedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.infiniteBuyRecord.count({ where: whereClause }),
    ]);

    const recordsWithStock = records.map((record) => {
      const stock = stockMap.get(record.stockId);
      return {
        id: record.id.toString(),
        stockId: record.stockId.toString(),
        ticker: stock?.ticker,
        name: stock?.name,
        type: record.type,
        round: record.round,
        price: record.price,
        quantity: record.quantity,
        amount: record.amount,
        profit: record.profit,
        profitPercent: record.profitPercent,
        executedAt: record.executedAt.toISOString(),
      };
    });

    // 요약 통계 계산
    const allRecords = await prisma.infiniteBuyRecord.findMany({
      where: { stockId: { in: stockIds } },
    });

    const summary = {
      totalBuys: allRecords.filter((r) => r.type === 'buy').length,
      totalSells: allRecords.filter((r) => r.type === 'sell').length,
      totalBuyAmount: allRecords
        .filter((r) => r.type === 'buy')
        .reduce((sum, r) => sum + r.amount, 0),
      totalSellAmount: allRecords
        .filter((r) => r.type === 'sell')
        .reduce((sum, r) => sum + r.amount, 0),
      realizedProfit: allRecords
        .filter((r) => r.type === 'sell' && r.profit)
        .reduce((sum, r) => sum + (r.profit || 0), 0),
    };

    return { records: recordsWithStock, total, summary };
  }

  // 오늘의 매수 예정 조회
  async getTodaySchedule(userId: number) {
    // 자동매수가 활성화되고 buying 상태인 종목들
    const stocks = await prisma.infiniteBuyStock.findMany({
      where: {
        userId,
        status: 'buying',
        autoEnabled: true,
      },
    });

    const scheduledBuys = stocks
      .filter((stock) => stock.currentRound < stock.totalRounds)
      .map((stock) => ({
        stockId: stock.id.toString(),
        ticker: stock.ticker,
        name: stock.name,
        nextRound: stock.currentRound + 1,
        amount: stock.buyAmount,
        scheduledTime: stock.buyTime || '09:30',
        condition: stock.buyCondition,
      }));

    const totalAmount = scheduledBuys.reduce((sum, buy) => sum + buy.amount, 0);

    return { scheduledBuys, totalAmount };
  }

  // 대시보드 요약 정보
  async getSummary(userId: number) {
    const stocksData = await this.getStocks(userId);
    const todayData = await this.getTodaySchedule(userId);

    // 실현 수익 계산
    const userStocks = await prisma.infiniteBuyStock.findMany({
      where: { userId },
      select: { id: true },
    });

    const stockIds = userStocks.map((s) => s.id);

    const sellRecords = await prisma.infiniteBuyRecord.findMany({
      where: {
        stockId: { in: stockIds },
        type: 'sell',
      },
    });

    const realizedProfit = sellRecords.reduce((sum, r) => sum + (r.profit || 0), 0);

    return {
      totalStocks: stocksData.summary.totalStocks,
      buyingCount: stocksData.summary.buyingCount,
      completedCount: stocksData.summary.completedCount,
      stoppedCount: stocksData.summary.stoppedCount,
      totalInvested: stocksData.summary.totalInvested,
      totalValue: stocksData.summary.totalValue,
      totalProfitLoss: stocksData.summary.totalProfitLoss,
      totalProfitLossPercent: stocksData.summary.totalProfitLossPercent,
      realizedProfit,
      todayScheduledBuys: todayData.scheduledBuys.length,
      todayScheduledAmount: todayData.totalAmount,
    };
  }
}

export const infiniteBuyService = new InfiniteBuyService();
