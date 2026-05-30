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

        // 매수가 == 매도가면 수수료만 손실되는 무한반복 발생 → 스킵
        if (buyPrice === sellPrice) {
          console.log(`[GridService] Bot ${botId}: 매수가=매도가(${buyPrice}) 스킵 (틱사이즈보다 그리드 간격이 작음)`);
          continue;
        }

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

  // 현재가 기준으로 실행할 그리드 레벨 찾기 (하이브리드 방식, 병렬 쿼리)
  // 1. 크로싱 감지: 이전 가격→현재 가격 사이를 지나간 그리드 레벨 (상승/하락 모두 대응)
  // 2. 하방 매수 대기: 현재가 아래의 가장 가까운 available 매수 레벨 (하락 대비 지정가 매수)
  // 3. 매도: 현재가 이상의 가장 가까운 available 매도 레벨
  // 봇당 하방 대기 매수 주문 최대 개수 (trimBuyOrdersOnInsufficientBalance의 keepCount와 동기화)
  static readonly MAX_PENDING_BUY_ORDERS = 7;

  static async findExecutableGrids(botId: number, currentPrice: number, previousPrice?: number) {
    // 매수 + 매도 쿼리를 병렬 실행 (3쿼리 동시)
    const upperPriceBound = previousPrice !== undefined
      ? Math.max(currentPrice, previousPrice)
      : currentPrice;

    const [allAvailableBuys, sellLevels, pendingBuyCount] = await Promise.all([
      // 매수 후보: 크로싱 범위 + 하방 대기 모두 포함하는 단일 쿼리
      prisma.gridLevel.findMany({
        where: {
          botId,
          type: 'buy',
          status: 'available',
          price: { lte: upperPriceBound },
        },
        orderBy: { price: 'asc' },
      }),
      // 매도: 현재가 이상의 가장 가까운 available 매도 레벨
      prisma.gridLevel.findMany({
        where: {
          botId,
          type: 'sell',
          status: 'available',
          price: { gte: currentPrice },
        },
        orderBy: { price: 'asc' },
        take: 1,
      }),
      // pending 매수 주문 수 (하방 대기 상한 체크용)
      prisma.gridLevel.count({
        where: { botId, type: 'buy', status: 'pending' },
      }),
    ]);

    // JS에서 크로싱 + 하방 매수 분류 (DB 쿼리 대신 메모리 필터링)
    let buyLevels: any[] = [];

    // 1단계: 크로싱 감지
    if (previousPrice !== undefined && previousPrice !== currentPrice) {
      const lowerBound = Math.min(previousPrice, currentPrice);
      const upperBound = Math.max(previousPrice, currentPrice);

      buyLevels = allAvailableBuys.filter((b: any) => b.price > lowerBound && b.price <= upperBound);

      if (buyLevels.length > 0) {
        console.log(`[GridService] Bot ${botId}: 가격 크로싱 감지 (${previousPrice.toLocaleString()} → ${currentPrice.toLocaleString()}), ${buyLevels.length}개 매수 레벨 발견: [${buyLevels.map((b: any) => b.price).join(', ')}]`);
      }
    }

    // 2단계: 하방 매수 대기 (현재가 이하에서 가장 높은 1개)
    // pending 매수가 MAX_PENDING_BUY_ORDERS 미만인 경우에만 추가
    // (잔고 고갈→trim→재주문 반복 사이클 방지)
    const belowBuys = allAvailableBuys.filter((b: any) => b.price <= currentPrice);
    const belowBuy = belowBuys.length > 0 ? belowBuys[belowBuys.length - 1] : null;

    if (belowBuy && !buyLevels.some((b: any) => b.id === belowBuy.id)) {
      const totalPendingAfterCrossing = pendingBuyCount + buyLevels.length;
      if (totalPendingAfterCrossing < GridService.MAX_PENDING_BUY_ORDERS) {
        buyLevels.push(belowBuy);
        console.log(`[GridService] Bot ${botId}: 하방 매수 대기 - ${belowBuy.price.toLocaleString()}원 (pending: ${totalPendingAfterCrossing + 1}/${GridService.MAX_PENDING_BUY_ORDERS})`);
      }
    }

    return {
      buy: buyLevels[0] || null,
      buys: buyLevels,
      sell: sellLevels[0] || null,
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
        // pending/available 전환 시 이전 사이클의 filledAt 잔존 방지
        filledAt: filledAt ?? (status === 'pending' || status === 'available' ? null : undefined),
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
