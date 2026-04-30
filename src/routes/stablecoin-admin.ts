import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import {
  getBot,
  getOrderbooks,
  getOpportunityStats,
  getRecentOpportunities,
  getSimOverview,
  postKillswitch,
  postLive,
  postStage,
  listMakerBots,
  createMakerBot,
  patchMakerBot,
  deleteMakerBot,
  verifyMakerBotReconciliation,
} from '../controllers/stablecoin-admin.controller';

const router = Router();

// 모든 라우트에 authenticate + requireAdmin 적용
router.use(authenticate);
router.use(requireAdmin);

router.get('/bot', getBot);
router.get('/orderbooks', getOrderbooks);
router.get('/opportunities/stats', getOpportunityStats);
router.get('/opportunities/recent', getRecentOpportunities);
router.get('/sim/overview', getSimOverview);
router.post('/bot/killswitch', postKillswitch);
router.post('/bot/live', postLive);
router.post('/bot/stage', postStage);

// Maker-Taker 봇 CRUD (Admin 전용)
router.get('/maker-bots', listMakerBots);
router.post('/maker-bots', createMakerBot);
router.patch('/maker-bots/:id', patchMakerBot);
router.delete('/maker-bots/:id', deleteMakerBot);
router.post('/maker-bots/:id/verify-reconciliation', verifyMakerBotReconciliation);

export default router;
