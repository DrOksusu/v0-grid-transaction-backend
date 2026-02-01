import prisma from '../config/database';

/**
 * 매수 가격 배열 계산 (등비수열, 중복 제거)
 * 모든 곳에서 이 함수를 사용하여 일관성 유지
 */
export function calculateBuyPrices(
  lowerPrice: number,
  upperPrice: number,
  priceChangePercent: number
): number[] {
  const prices: number[] = [];
  const multiplier = 1 + priceChangePercent / 100;
  let price = lowerPrice;

  while (price <= upperPrice) {
    const roundedPrice = roundToTickSize(price);
    // 중복 가격 방지: 이전 가격과 같으면 스킵
    if (prices.length === 0 || roundedPrice > prices[prices.length - 1]) {
      prices.push(roundedPrice);
    }
    price *= multiplier;
  }

  return prices;
}

/**
 * Upbit KRW 마켓 주문가격 단위 (호가 단위)
 * 가격대별 틱 사이즈에 맞게 가격을 반올림
 * https://docs.upbit.com/kr/docs/krw-market-info
 */
export function roundToTickSize(price: number): number {
  let tickSize: number;

  if (price >= 2000000) {
    tickSize = 1000;      // 2,000,000원 이상
  } else if (price >= 1000000) {
    tickSize = 1000;      // 1,000,000 ~ 2,000,000원
  } else if (price >= 500000) {
    tickSize = 500;       // 500,000 ~ 1,000,000원
  } else if (price >= 100000) {
    tickSize = 100;       // 100,000 ~ 500,000원
  } else if (price >= 50000) {
    tickSize = 50;        // 50,000 ~ 100,000원
  } else if (price >= 10000) {
    tickSize = 10;        // 10,000 ~ 50,000원
  } else if (price >= 5000) {
    tickSize = 5;         // 5,000 ~ 10,000원
  } else if (price >= 1000) {
    tickSize = 1;         // 1,000 ~ 5,000원
  } else if (price >= 100) {
    tickSize = 1;         // 100 ~ 1,000원
  } else if (price >= 10) {
    tickSize = 0.1;       // 10 ~ 100원
  } else if (price >= 1) {
    tickSize = 0.01;      // 1 ~ 10원
  } else if (price >= 0.1) {
    tickSize = 0.001;     // 0.1 ~ 1원
  } else if (price >= 0.01) {
    tickSize = 0.0001;    // 0.01 ~ 0.1원
  } else {
    tickSize = 0.00001;   // 0.01원 미만
  }

  // 부동소수점 오차 방지를 위해 정수 연산 후 다시 나누기
  const multiplier = 1 / tickSize;
  return Math.round(price * multiplier) / multiplier;
}

export class GridService {
  // 그리드 레벨 생성 (등비수열 방식)
  // 각 그리드는 buyPrice에 매수하고 sellPrice에 매도하는 구조
  static async createGridLevels(
    botId: number,
    lowerPrice: number,
    upperPrice: number,
    gridCount: number,
    priceChangePercent?: number
  ) {
    try {
      // 기존 그리드 레벨 삭제
      await prisma.gridLevel.deleteMany({
        where: { botId },
      });

      // 공통 유틸리티 함수로 매수 가격 계산 (등비수열, 중복 제거)
      let prices: number[];

      if (priceChangePercent && priceChangePercent > 0) {
        prices = calculateBuyPrices(lowerPrice, upperPrice, priceChangePercent);
        // 마지막 매도가를 위해 upperPrice 초과 가격도 추가
        const multiplier = 1 + priceChangePercent / 100;
        const lastSellPrice = roundToTickSize(prices[prices.length - 1] * multiplier);
        if (lastSellPrice > prices[prices.length - 1]) {
          prices.push(lastSellPrice);
        }
      } else {
        // 폴백: 등차수열
        prices = [];
        const priceRange = upperPrice - lowerPrice;
        const gridSpacing = priceRange / gridCount;

        for (let i = 0; i <= gridCount + 1; i++) {
          prices.push(roundToTickSize(lowerPrice + (gridSpacing * i)));
        }
      }

      console.log(`[GridService] Calculated ${prices.length} price levels for bot ${botId}:`, prices.map(p => Math.round(p)));

      const gridLevels = [];

      // 그리드 레벨 생성
      // 각 레벨은 buyPrice와 sellPrice를 가짐 (sellPrice = 다음 레벨 가격)
      for (let i = 0; i < prices.length - 1; i++) {
        const buyPrice = prices[i];
        const sellPrice = prices[i + 1];

        // 매수 레벨 - 활성화
        gridLevels.push({
          botId,
          price: buyPrice,
          sellPrice: sellPrice,  // 이 매수가 체결되면 매도할 가격
          type: 'buy' as const,
          status: 'available' as const,
        });

        // 매도 레벨 - 비활성화 (매수 체결 후 활성화됨)
        gridLevels.push({
          botId,
          price: sellPrice,
          buyPrice: buyPrice,  // 이 매도가 체결되면 다시 매수할 가격
          type: 'sell' as const,
          status: 'inactive' as const,
        });
      }

      // DB에 저장
      await prisma.gridLevel.createMany({
        data: gridLevels,
      });

      console.log(`[GridService] Created ${gridLevels.length} grid levels for bot ${botId}`);
      console.log(`[GridService] Buy levels: ${gridLevels.filter(g => g.type === 'buy').length}, Sell levels: ${gridLevels.filter(g => g.type === 'sell').length}`);

      return gridLevels;
    } catch (error) {
      throw new Error(`그리드 레벨 생성 실패: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // 특정 봇의 모든 그리드 레벨 조회
  static async getGridLevels(botId: number) {
    return await prisma.gridLevel.findMany({
      where: { botId },
      orderBy: { price: 'asc' },
    });
  }

  // 현재가 기준으로 실행할 그리드 레벨 찾기
  static async findExecutableGrids(botId: number, currentPrice: number) {
    // 현재가보다 낮거나 같은 가격의 available 매수 레벨 찾기 (가장 높은 것)
    const buyLevels = await prisma.gridLevel.findMany({
      where: {
        botId,
        type: 'buy',
        status: 'available',
        price: {
          lte: currentPrice,
        },
      },
      orderBy: { price: 'desc' },
      take: 1,
    });

    // 현재가보다 높거나 같은 가격의 available 매도 레벨 찾기 (가장 낮은 것)
    const sellLevels = await prisma.gridLevel.findMany({
      where: {
        botId,
        type: 'sell',
        status: 'available',
        price: {
          gte: currentPrice,
        },
      },
      orderBy: { price: 'asc' },
      take: 1,
    });

    return {
      buy: buyLevels[0],
      sell: sellLevels[0],
    };
  }

  // 그리드 레벨 상태 업데이트
  static async updateGridLevel(
    gridLevelId: number,
    status: 'available' | 'pending' | 'filled' | 'inactive',
    orderId?: string,
    filledAt?: Date
  ) {
    return await prisma.gridLevel.update({
      where: { id: gridLevelId },
      data: {
        status,
        orderId,
        filledAt,
      },
    });
  }

  // 체결된 그리드 레벨의 반대편 레벨 활성화
  static async activateOppositeLevel(gridLevelId: number) {
    const gridLevel = await prisma.gridLevel.findUnique({
      where: { id: gridLevelId },
    });

    if (!gridLevel) return null;

    // 매수가 체결되면 → 해당 매수의 sellPrice에 해당하는 매도 레벨 활성화
    // 매도가 체결되면 → 해당 매도의 buyPrice에 해당하는 매수 레벨 활성화
    if (gridLevel.type === 'buy' && gridLevel.sellPrice) {
      // 매수 체결 → sellPrice의 매도 레벨 활성화
      const result = await prisma.gridLevel.updateMany({
        where: {
          botId: gridLevel.botId,
          price: gridLevel.sellPrice,
          type: 'sell',
        },
        data: {
          status: 'available',
        },
      });
      console.log(`[GridService] Activated sell level at ${gridLevel.sellPrice} for bot ${gridLevel.botId}`);
      return result;
    } else if (gridLevel.type === 'sell' && gridLevel.buyPrice) {
      // 매도 체결 → buyPrice의 매수 레벨 활성화
      const result = await prisma.gridLevel.updateMany({
        where: {
          botId: gridLevel.botId,
          price: gridLevel.buyPrice,
          type: 'buy',
        },
        data: {
          status: 'available',
        },
      });
      console.log(`[GridService] Activated buy level at ${gridLevel.buyPrice} for bot ${gridLevel.botId}`);
      return result;
    }

    return null;
  }
}
