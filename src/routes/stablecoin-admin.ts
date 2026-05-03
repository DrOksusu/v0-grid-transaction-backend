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
  listCrossExchangeBots,
  createCrossExchangeBot,
  patchCrossExchangeBot,
  deleteCrossExchangeBot,
  verifyCrossExchangeReconciliation,
  getArbAutoConfig,
  patchArbAutoConfig,
  listBithumbArbTrades,
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

// Cross-Exchange 봇 CRUD (Admin 전용)
router.get('/cross-exchange-bots', listCrossExchangeBots);
router.post('/cross-exchange-bots', createCrossExchangeBot);
router.patch('/cross-exchange-bots/:id', patchCrossExchangeBot);
router.delete('/cross-exchange-bots/:id', deleteCrossExchangeBot);
router.post('/cross-exchange-bots/:id/verify-reconciliation', verifyCrossExchangeReconciliation);

// ArbAutoConfig (빗썸 단일 차익거래 글로벌 설정)
router.get('/arb-auto-config', getArbAutoConfig);
router.patch('/arb-auto-config', patchArbAutoConfig);
router.get('/bithumb-arb-trades', listBithumbArbTrades);

export default router;
