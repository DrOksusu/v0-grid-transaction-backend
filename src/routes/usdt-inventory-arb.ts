import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import { createBot, getBots, getStatus, getTrades, updateBot, deleteBot, getCandidates, postExecute } from '../controllers/usdt-inventory-arb.controller';

const router = Router();
// USDT권 재고형 아비 봇은 실거래 자동 주문 — 관리자(ADMIN_EMAIL) 전용. 인증 + 관리자 가드 순서.
router.use(authenticate);
router.use(requireAdmin);

router.post('/', createBot);
router.get('/', getBots);
router.get('/candidates', getCandidates); // 후보 스캔 (보유 코인 기반 양방향)
router.post('/execute', postExecute);     // 후보 즉시 실행 (1회 수동 실거래)
router.get('/:id/status', getStatus);
router.get('/:id/trades', getTrades);
router.put('/:id', updateBot);
router.delete('/:id', deleteBot);

export default router;
