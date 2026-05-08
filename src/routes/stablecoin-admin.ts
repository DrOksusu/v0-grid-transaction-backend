import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import {
  listMakerBots,
  createMakerBot,
  patchMakerBot,
  deleteMakerBot,
  verifyMakerBotReconciliation,
  getBalanceRequirements,
  listMakerTakerTrades,
} from '../controllers/stablecoin-admin.controller';

const router = Router();

// 모든 라우트에 authenticate + requireAdmin 적용
router.use(authenticate);
router.use(requireAdmin);

// Maker-Taker 봇 CRUD (Admin 전용)
router.get('/maker-bots', listMakerBots);
router.post('/maker-bots', createMakerBot);
router.patch('/maker-bots/:id', patchMakerBot);
router.delete('/maker-bots/:id', deleteMakerBot);
router.post('/maker-bots/:id/verify-reconciliation', verifyMakerBotReconciliation);

// 잔고 요건 — 라이브 봇별 필요 잔고 vs 현재 잔고
router.get('/balance-requirements', getBalanceRequirements);

// MakerTakerSim 거래 내역
router.get('/maker-taker-trades', listMakerTakerTrades);

export default router;
