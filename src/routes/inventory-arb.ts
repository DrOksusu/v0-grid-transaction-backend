import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import { createBot, getBots, getTrades, updateBot, deleteBot } from '../controllers/inventory-arb.controller';

const router = Router();
// 재고형 아비 봇은 실거래 자동 주문 — 관리자(ADMIN_EMAIL) 전용. 인증 + 관리자 가드 순서.
router.use(authenticate);
router.use(requireAdmin);

router.post('/', createBot);
router.get('/', getBots);
router.get('/:id/trades', getTrades);
router.put('/:id', updateBot);
router.delete('/:id', deleteBot);

export default router;
