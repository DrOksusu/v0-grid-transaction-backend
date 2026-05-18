import { Router, Response, NextFunction } from 'express';
import { pairScannerService, PairConfig } from '../services/pair-scanner.service';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import { stablecoinPrisma } from '../config/database';
import { AuthRequest } from '../types';

const router = Router();

// ── 모니터링 엔드포인트 (인증 불필요) ─────────────────────────────────

// GET /api/pair-scanner/pairs
router.get('/pairs', (_req, res: Response) => {
  res.json({ success: true, data: pairScannerService.getPairs() });
});

// POST /api/pair-scanner/pairs
router.post('/pairs', (req, res: Response) => {
  const { name, makerCoin, takerCoin, qty, makerFeeRate, takerFeeRate, exchange, makerExchange, takerExchange } = req.body as Partial<PairConfig>;

  if (!name || !makerCoin || !takerCoin || qty == null || makerFeeRate == null || takerFeeRate == null) {
    res.status(400).json({ success: false, error: '필수 필드 누락: name, makerCoin, takerCoin, qty, makerFeeRate, takerFeeRate' });
    return;
  }

  const result = pairScannerService.addPair({
    name, makerCoin, takerCoin,
    qty: Number(qty),
    makerFeeRate: Number(makerFeeRate),
    takerFeeRate: Number(takerFeeRate),
    ...(exchange && { exchange }),
    ...(makerExchange && { makerExchange }),
    ...(takerExchange && { takerExchange }),
  });

  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json({ success: true, data: pairScannerService.getPairs() });
});

// DELETE /api/pair-scanner/pairs/:name
router.delete('/pairs/:name', (req, res: Response) => {
  const { name } = req.params;
  const removed = pairScannerService.removePair(name);

  if (!removed) {
    res.status(404).json({ success: false, error: `페어 '${name}'을 찾을 수 없습니다` });
    return;
  }

  res.json({ success: true, data: pairScannerService.getPairs() });
});

// GET /api/pair-scanner/stats
router.get('/stats', (_req, res: Response) => {
  res.json({ success: true, data: pairScannerService.getSnapshot() });
});

// ── 봇 CRUD (authenticate + requireAdmin 필요) ─────────────────────────

// GET /api/pair-scanner/bots
router.get(
  '/bots',
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const bots = await stablecoinPrisma.makerTakerSimBot.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      res.json({ success: true, data: bots });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/pair-scanner/bots
router.post(
  '/bots',
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const { makerCoin, takerCoin, qty, makerFeeBps, takerFeeBps, minSpreadBps, bidOffsetKrw, minTakerBalance, makerExchange, takerExchange, live } = req.body;

      if (!makerCoin || !takerCoin) {
        res.status(400).json({ success: false, error: 'makerCoin, takerCoin 필수' });
        return;
      }

      const existing = await stablecoinPrisma.makerTakerSimBot.findFirst({
        where: { userId, makerCoin, takerCoin },
      });
      if (existing) {
        res.status(409).json({ success: false, error: '이미 존재하는 페어입니다', data: existing });
        return;
      }

      const bot = await (stablecoinPrisma.makerTakerSimBot as any).create({
        data: {
          userId,
          makerCoin,
          takerCoin,
          quantity: qty ?? 10,
          makerFeeBps: makerFeeBps ?? 5,
          takerFeeBps: takerFeeBps ?? 5,
          minSpreadBps: minSpreadBps ?? 20,
          bidOffsetKrw: bidOffsetKrw ?? 0,
          minTakerBalance: minTakerBalance ?? null,
          makerExchange: makerExchange ?? 'upbit',
          takerExchange: takerExchange ?? 'upbit',
          enabled: true,
          killSwitch: false,
          live: live ?? false,
        },
      });
      res.json({ success: true, data: bot });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/pair-scanner/bots/:id
router.patch(
  '/bots/:id',
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const id = parseInt(req.params.id, 10);
      const { enabled, killSwitch, minSpreadBps, takerUpgradeBps, live, bidOffsetKrw, makerExchange, takerExchange, sellStrategy } = req.body;

      const existing = await stablecoinPrisma.makerTakerSimBot.findFirst({ where: { id, userId } });
      if (!existing) {
        res.status(404).json({ success: false, error: '봇을 찾을 수 없습니다' });
        return;
      }

      const VALID_STRATEGIES = ['TAKER_SELL_FIRST', 'MAKER_SELL_FIRST'];
      const patch: Record<string, unknown> = {};
      if (enabled !== undefined) patch.enabled = Boolean(enabled);
      if (killSwitch !== undefined) patch.killSwitch = Boolean(killSwitch);
      if (minSpreadBps !== undefined) patch.minSpreadBps = Number(minSpreadBps);
      if ('takerUpgradeBps' in req.body) patch.takerUpgradeBps = takerUpgradeBps === null ? null : Number(takerUpgradeBps);
      if (live !== undefined) patch.live = Boolean(live);
      if (bidOffsetKrw !== undefined) patch.bidOffsetKrw = Number(bidOffsetKrw);
      if (makerExchange !== undefined) patch.makerExchange = String(makerExchange);
      if (takerExchange !== undefined) patch.takerExchange = String(takerExchange);
      if (sellStrategy !== undefined && VALID_STRATEGIES.includes(String(sellStrategy))) patch.sellStrategy = String(sellStrategy);

      const bot = await (stablecoinPrisma.makerTakerSimBot as any).update({ where: { id }, data: patch });
      res.json({ success: true, data: bot });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/pair-scanner/bots/:id
router.delete(
  '/bots/:id',
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const id = parseInt(req.params.id, 10);

      const existing = await stablecoinPrisma.makerTakerSimBot.findFirst({ where: { id, userId } });
      if (!existing) {
        res.status(404).json({ success: false, error: '봇을 찾을 수 없습니다' });
        return;
      }

      await stablecoinPrisma.makerTakerSimBot.delete({ where: { id } });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/pair-scanner/pending-trades — 전체 미체결(PENDING/PARTIAL_HOLD) 거래 조회
router.get(
  '/pending-trades',
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const trades = await stablecoinPrisma.makerTakerSimTrade.findMany({
        where: {
          status: { in: ['PENDING', 'TAKER_PENDING', 'PARTIAL_HOLD'] },
          bot: { userId },
        },
        include: {
          bot: {
            select: {
              makerExchange: true,
              takerExchange: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ success: true, data: trades }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/pair-scanner/all-trades?limit=100&status=&botId=&startDate=&endDate=
router.get(
  '/all-trades',
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const limit = Math.min(Number(req.query.limit ?? 200), 500);
      const { status, botId, startDate, endDate } = req.query as Record<string, string>;

      const where: Record<string, unknown> = { bot: { userId } };
      if (status) where.status = status;
      if (botId) where.botId = parseInt(botId, 10);
      if (startDate || endDate) {
        where.createdAt = {
          ...(startDate ? { gte: new Date(startDate) } : {}),
          ...(endDate ? { lte: new Date(endDate) } : {}),
        };
      }

      const trades = await stablecoinPrisma.makerTakerSimTrade.findMany({
        where,
        include: {
          bot: {
            select: { makerCoin: true, takerCoin: true, makerExchange: true, takerExchange: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ success: true, data: trades }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/pair-scanner/bots/:id/trades
router.get(
  '/bots/:id/trades',
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const id = parseInt(req.params.id, 10);

      const bot = await stablecoinPrisma.makerTakerSimBot.findFirst({ where: { id, userId } });
      if (!bot) {
        res.status(404).json({ success: false, error: '봇을 찾을 수 없습니다' });
        return;
      }

      const trades = await stablecoinPrisma.makerTakerSimTrade.findMany({
        where: { botId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ success: true, data: trades }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
