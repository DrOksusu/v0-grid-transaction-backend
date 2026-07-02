import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { tossService, TossCredentials } from '../services/toss.service';
import { resolveKoreanStockSymbol } from '../services/korean-stock-symbol.service';
import {
  simulateGridProfit,
  DEFAULT_FEE_RATE,
  DEFAULT_TAX_RATE,
} from '../utils/korean-stock-fee-calculator';
import {
  calculateGridPrices,
  validateGridRange,
} from '../services/korean-stock-grid.service';
import { snapToTickSize } from '../utils/korean-stock-tick-size';
import { decrypt } from '../utils/encryption';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';

// userId → 토스 credential 로드 헬퍼. accountSeq 없으면 null.
async function loadTossCredentials(userId: number): Promise<TossCredentials | null> {
  const cred = await prisma.credential.findFirst({
    where: { userId, exchange: 'toss', purpose: 'default' },
  });
  if (!cred || !cred.accountSeq) return null;
  return {
    clientId: decrypt(cred.apiKey),
    clientSecret: decrypt(cred.secretKey),
    accountSeq: cred.accountSeq,
  };
}

// GET /api/korean-stocks/symbols/search?q=삼성&limit=20
export const searchSymbols = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    if (q.length < 1) return successResponse(res, []);

    const symbols = await prisma.koreanStockSymbol.findMany({
      where: {
        OR: [
          { code: { startsWith: q } },
          { name: { startsWith: q } },
          { name: { contains: q } },
        ],
      },
      take: limit,
      orderBy: { name: 'asc' },
    });

    // spec § 10 lazy resolve: DB miss + q가 6자리 종목코드면 토스 stocks API로 1회 조회 후 upsert
    if (symbols.length === 0 && /^\d{6}$/.test(q)) {
      const cred = await loadTossCredentials(userId);
      if (cred) {
        const resolved = await resolveKoreanStockSymbol(cred, q);
        if (resolved) return successResponse(res, [resolved]);
      }
    }

    return successResponse(res, symbols);
  } catch (e) {
    next(e);
  }
};

// POST /api/korean-stocks/simulate
// body: { buyPrice, sellPrice, orderAmount, feeRate?, taxRate? }
export const simulate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { buyPrice, sellPrice, orderAmount, feeRate, taxRate } = req.body;
    if (!buyPrice || !sellPrice || !orderAmount) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        'buyPrice, sellPrice, orderAmount 필수',
        400
      );
    }
    const result = simulateGridProfit({
      buyPrice,
      sellPrice,
      orderAmount,
      feeRate,
      taxRate,
    });
    return successResponse(res, result);
  } catch (e) {
    next(e);
  }
};

// GET /api/korean-stocks/balance
// spec § 4: KRW 매수가능금액 + 보유주식 조회 조합 (accountSeq는 credential에 저장되어 있음)
export const getBalance = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const cred = await loadTossCredentials(userId);
    if (!cred) {
      return errorResponse(
        res,
        'CREDENTIAL_NOT_FOUND',
        '토스 API 키 또는 계좌 시퀀스가 등록되지 않았습니다',
        400
      );
    }
    const [buyingPower, holdings] = await Promise.all([
      tossService.getBuyingPower(cred, 'KRW'),
      tossService.getHoldings(cred),
    ]);
    return successResponse(res, {
      currency: 'KRW',
      cashBuyingPower: buyingPower.cashBuyingPower,
      krwBalance: Number(buyingPower.cashBuyingPower),
      totalPurchaseAmount: holdings.totalPurchaseAmount,
      holdings: holdings.items.map((h) => ({
        symbol: h.symbol,
        name: h.name,
        marketCountry: h.marketCountry,
        currency: h.currency,
        quantity: h.quantity,
        lastPrice: h.lastPrice,
        averagePurchasePrice: h.averagePurchasePrice,
      })),
    });
  } catch (e) {
    next(e);
  }
};

// GET /api/korean-stocks/bots
export const listBots = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const bots = await prisma.bot.findMany({
      where: { userId, market: 'KOREAN_STOCK', deletedAt: null },
      include: { gridLevels: true },
      orderBy: { createdAt: 'desc' },
    });
    return successResponse(res, bots);
  } catch (e) {
    next(e);
  }
};

// POST /api/korean-stocks/bots
// body: { ticker, lowerPrice, upperPrice, gridCount, orderAmount, feeRate?, taxRate?, prevClose }
export const createBot = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const {
      ticker,
      lowerPrice,
      upperPrice,
      gridCount,
      orderAmount,
      feeRate,
      taxRate,
      prevClose,
    } = req.body;

    if (
      !ticker ||
      typeof lowerPrice !== 'number' ||
      typeof upperPrice !== 'number' ||
      typeof gridCount !== 'number' ||
      typeof orderAmount !== 'number' ||
      typeof prevClose !== 'number'
    ) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        'ticker, lowerPrice, upperPrice, gridCount, orderAmount, prevClose 필수',
        400
      );
    }

    // 상하한가 검증
    const validation = validateGridRange({ lowerPrice, upperPrice, prevClose });
    if (!validation.ok) {
      return errorResponse(res, 'PRICE_RANGE_INVALID', validation.reason!, 400);
    }

    // 종목 존재 확인 — spec § 10 lazy resolve
    let symbol = await prisma.koreanStockSymbol.findUnique({
      where: { code: ticker },
    });
    if (!symbol) {
      const cred = await loadTossCredentials(userId);
      if (cred) {
        const resolved = await resolveKoreanStockSymbol(cred, ticker);
        if (resolved) {
          if (resolved.status && resolved.status !== 'ACTIVE') {
            return errorResponse(
              res,
              'SYMBOL_NOT_TRADABLE',
              `현재 거래 불가 종목: ${ticker} (status=${resolved.status})`,
              400
            );
          }
          symbol = await prisma.koreanStockSymbol.findUnique({
            where: { code: ticker },
          });
        }
      }
    }
    if (!symbol) {
      return errorResponse(
        res,
        'SYMBOL_NOT_FOUND',
        `존재하지 않는 종목코드: ${ticker}`,
        400
      );
    }

    // 그리드 가격 계산 (호가 단위 보정 포함)
    const prices = calculateGridPrices({ lowerPrice, upperPrice, gridCount });
    const midPrice = (prices[0] + prices[prices.length - 1]) / 2;

    // Bot + GridLevel 생성. status는 stopped로 시작 (사용자가 명시적으로 running 전환).
    const bot = await prisma.bot.create({
      data: {
        userId,
        market: 'KOREAN_STOCK',
        exchange: 'toss',
        ticker,
        lowerPrice: prices[0],
        upperPrice: prices[prices.length - 1],
        priceChangePercent: ((prices[1] - prices[0]) / prices[0]) * 100,
        gridCount,
        orderAmount,
        feeRate: feeRate ?? DEFAULT_FEE_RATE,
        taxRate: taxRate ?? DEFAULT_TAX_RATE,
        investmentAmount: orderAmount * gridCount,
        status: 'stopped',
        gridLevels: {
          create: prices.map((price) => ({
            price: snapToTickSize(price),
            type: price < midPrice ? 'buy' : 'sell',
            status: 'available',
          })),
        },
      },
      include: { gridLevels: true },
    });

    return successResponse(res, bot);
  } catch (e) {
    next(e);
  }
};

// PUT /api/korean-stocks/bots/:id (status 변경: running/stopped)
export const updateBot = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const botId = Number(req.params.id);
    const { status } = req.body;
    if (!['running', 'stopped'].includes(status)) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        'status는 running 또는 stopped',
        400
      );
    }

    // 소유권 확인
    const existing = await prisma.bot.findFirst({
      where: { id: botId, userId, market: 'KOREAN_STOCK', deletedAt: null },
    });
    if (!existing) {
      return errorResponse(res, 'BOT_NOT_FOUND', '봇을 찾을 수 없습니다', 404);
    }

    const bot = await prisma.bot.update({
      where: { id: botId },
      data: { status, errorMessage: null },
    });
    return successResponse(res, bot);
  } catch (e) {
    next(e);
  }
};

// DELETE /api/korean-stocks/bots/:id (soft delete)
export const deleteBot = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const botId = Number(req.params.id);

    const existing = await prisma.bot.findFirst({
      where: { id: botId, userId, market: 'KOREAN_STOCK', deletedAt: null },
    });
    if (!existing) {
      return errorResponse(res, 'BOT_NOT_FOUND', '봇을 찾을 수 없습니다', 404);
    }

    await prisma.bot.update({
      where: { id: botId },
      data: { status: 'stopped', deletedAt: new Date() },
    });
    return successResponse(res, { ok: true });
  } catch (e) {
    next(e);
  }
};
