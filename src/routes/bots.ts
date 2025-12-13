import { Router } from 'express';
import {
  createBot,
  getAllBots,
  getBotById,
  updateBot,
  startBot,
  stopBot,
  deleteBot,
  getGridLevels,
  getTrades,
  getPerformance,
  getPriceManagerStatus,
} from '../controllers/bot.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

// 인증 필요
router.use(authenticate);

router.post('/', createBot);
router.get('/', getAllBots);
router.get('/status/price-manager', getPriceManagerStatus); // WebSocket 상태 조회 (봇 ID보다 먼저 배치)
router.get('/:id', getBotById);
router.put('/:id', updateBot);
router.post('/:id/start', startBot);
router.post('/:id/stop', stopBot);
router.delete('/:id', deleteBot);
router.get('/:id/grid-levels', getGridLevels);
router.get('/:id/trades', getTrades);
router.get('/:id/performance', getPerformance);

export default router;
