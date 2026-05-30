import prisma from '../config/database';

const STABLECOIN_TICKERS = ['KRW-USDS', 'KRW-USDE', 'KRW-USD1', 'KRW-USDC', 'KRW-USDT'];

export interface ManualTradeDto {
  id: number;
  ticker: string;
  type: string;
  price: number;
  quantity: number;
  note: string | null;
  tradedAt: string;
}

export interface TickerCostBasis {
  ticker: string;
  avgCostBasis: number;      // 평균 취득단가 (KRW)
  totalBoughtQty: number;    // 총 매수 수량
  totalSoldQty: number;      // 총 매도 수량
  currentHolding: number;    // 현재 보유량 (= 매수 - 매도)
  totalKrwSpent: number;     // 총 투입 KRW
  botBuyCount: number;
  botSellCount: number;
  manualBuyCount: number;
  manualSellCount: number;
  manualTrades: ManualTradeDto[];
}

export class CostBasisService {
  async getTickerCostBasis(userId: number, ticker: string): Promise<TickerCostBasis> {
    // 해당 유저의 해당 티커 봇들 조회
    const bots = await prisma.bot.findMany({
      where: { userId, ticker, deletedAt: null },
      select: { id: true, orderAmount: true },
    });
    const botIds = bots.map(b => b.id);
    const orderAmountMap = new Map(bots.map(b => [b.id, Number(b.orderAmount)]));

    // 봇 매수/매도 체결 레코드
    const [botBuyFills, botSellFills] = await Promise.all([
      botIds.length > 0
        ? prisma.gridLevel.findMany({
            where: { botId: { in: botIds }, type: 'buy', status: 'filled' },
            select: { botId: true, price: true },
          })
        : [],
      botIds.length > 0
        ? prisma.gridLevel.findMany({
            where: { botId: { in: botIds }, type: 'sell', status: 'filled' },
            select: { botId: true, price: true },
          })
        : [],
    ]);

    // 수동 거래 레코드
    const manualTradesRaw = await (prisma as any).manualTrade.findMany({
      where: { userId, ticker },
      orderBy: { tradedAt: 'desc' },
    });

    const manualBuys = manualTradesRaw.filter((t: any) => t.type === 'buy');
    const manualSells = manualTradesRaw.filter((t: any) => t.type === 'sell');

    // 매수 집계 (봇) — orderAmount는 KRW 금액, qty = orderAmount / price
    let totalKrwSpent = 0;
    let totalBoughtQty = 0;
    for (const fill of botBuyFills) {
      const orderAmount = orderAmountMap.get(fill.botId) ?? 0;
      const price = Number(fill.price);
      if (price <= 0) continue;
      const qty = orderAmount / price;
      totalKrwSpent += orderAmount;
      totalBoughtQty += qty;
    }

    // 매수 집계 (수동)
    for (const trade of manualBuys) {
      const price = Number(trade.price);
      const qty = Number(trade.quantity);
      totalKrwSpent += price * qty;
      totalBoughtQty += qty;
    }

    // 매도 집계 (봇)
    let totalSoldQty = 0;
    for (const fill of botSellFills) {
      const orderAmount = orderAmountMap.get(fill.botId) ?? 0;
      const price = Number(fill.price);
      if (price <= 0) continue;
      totalSoldQty += orderAmount / price;
    }

    // 매도 집계 (수동)
    for (const trade of manualSells) {
      totalSoldQty += Number(trade.quantity);
    }

    const avgCostBasis = totalBoughtQty > 0 ? totalKrwSpent / totalBoughtQty : 0;
    const currentHolding = Math.max(0, totalBoughtQty - totalSoldQty);

    const manualTrades: ManualTradeDto[] = manualTradesRaw.map((t: any) => ({
      id: t.id,
      ticker: t.ticker,
      type: t.type,
      price: Number(t.price),
      quantity: Number(t.quantity),
      note: t.note ?? null,
      tradedAt: t.tradedAt.toISOString(),
    }));

    return {
      ticker,
      avgCostBasis: Math.round(avgCostBasis * 100) / 100,
      totalBoughtQty: Math.round(totalBoughtQty * 100000) / 100000,
      totalSoldQty: Math.round(totalSoldQty * 100000) / 100000,
      currentHolding: Math.round(currentHolding * 100000) / 100000,
      totalKrwSpent: Math.round(totalKrwSpent),
      botBuyCount: botBuyFills.length,
      botSellCount: botSellFills.length,
      manualBuyCount: manualBuys.length,
      manualSellCount: manualSells.length,
      manualTrades,
    };
  }

  async getAllStablecoinSummary(userId: number): Promise<TickerCostBasis[]> {
    const results = await Promise.all(
      STABLECOIN_TICKERS.map(ticker => this.getTickerCostBasis(userId, ticker))
    );
    return results.filter(r => r.totalBoughtQty > 0);
  }

  async createManualTrade(
    userId: number,
    data: { ticker: string; type: string; price: number; quantity: number; note?: string; tradedAt?: string }
  ): Promise<ManualTradeDto> {
    const trade = await (prisma as any).manualTrade.create({
      data: {
        userId,
        ticker: data.ticker,
        type: data.type,
        price: data.price,
        quantity: data.quantity,
        note: data.note ?? null,
        tradedAt: data.tradedAt ? new Date(data.tradedAt) : new Date(),
      },
    });
    return {
      id: trade.id,
      ticker: trade.ticker,
      type: trade.type,
      price: Number(trade.price),
      quantity: Number(trade.quantity),
      note: trade.note ?? null,
      tradedAt: trade.tradedAt.toISOString(),
    };
  }

  async deleteManualTrade(userId: number, id: number): Promise<void> {
    const trade = await (prisma as any).manualTrade.findFirst({
      where: { id, userId },
    });
    if (!trade) throw new Error('거래 기록을 찾을 수 없거나 권한이 없습니다');
    await (prisma as any).manualTrade.delete({ where: { id } });
  }
}

export const costBasisService = new CostBasisService();
