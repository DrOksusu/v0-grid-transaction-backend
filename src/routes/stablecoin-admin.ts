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

export default router;
