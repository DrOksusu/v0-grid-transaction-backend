import prisma from '../config/database';

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

      const prices: number[] = [];

      // 등비수열로 가격 계산
      if (priceChangePercent && priceChangePercent > 0) {
        const changeRatio = 1 + priceChangePercent / 100;
        let currentPrice = lowerPrice;

        while (currentPrice <= upperPrice) {
          prices.push(currentPrice);
          currentPrice = currentPrice * changeRatio;
        }
        // 마지막 매도가를 위해 upperPrice 초과 가격도 추가
        if (prices[prices.length - 1] < upperPrice * changeRatio) {
          prices.push(prices[prices.length - 1] * changeRatio);
        }
      } else {
        // 폴백: 등차수열
        const priceRange = upperPrice - lowerPrice;
        const gridSpacing = priceRange / gridCount;

        for (let i = 0; i <= gridCount + 1; i++) {
          prices.push(lowerPrice + (gridSpacing * i));
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
