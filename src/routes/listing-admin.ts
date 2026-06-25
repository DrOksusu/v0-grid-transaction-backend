import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import {
  listAnnouncements,
  getAnnouncement,
  triggerSnapshot,
  fetchCurrentPrices,
  createManual,
  getAutoTradeConfig,
  updateAutoTradeConfig,
  listAutoOrders,
  correctAutoOrder,
  checkBinancePermissions,
} from '../controllers/listing-admin.controller';

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

// 자동매수 관련 (/:id 라우트보다 먼저 등록)
router.get('/auto-trade/config', getAutoTradeConfig);
router.put('/auto-trade/config', updateAutoTradeConfig);
router.get('/auto-trade/orders', listAutoOrders);
router.patch('/auto-trade/orders/:id', correctAutoOrder);
router.get('/auto-trade/check-permissions', checkBinancePermissions);

router.get('/', listAnnouncements);
router.post('/manual', createManual);
router.get('/:id', getAnnouncement);
router.post('/:id/snapshot', triggerSnapshot);
router.get('/:id/prices', fetchCurrentPrices);

export default router;
