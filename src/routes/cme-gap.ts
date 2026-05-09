/**
 * CME 갭 매매 봇 라우트
 *
 * 모든 라우트는 authenticate + requireAdmin 미들웨어로 보호된다.
 * Base path: /admin/cme-gap (src/routes/index.ts에서 마운트)
 */

import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import {
  getBots,
  createBot,
  updateBot,
  deleteBot,
  getGaps,
  getStats,
  triggerFriday,
  triggerMonday,
} from '../controllers/cme-gap.controller';

const router = Router();

// 모든 라우트에 인증 + 관리자 권한 적용
router.use(authenticate);
router.use(requireAdmin);

// ── 봇 CRUD ────────────────────────────────────────────────
router.get('/bots', getBots);
router.post('/bots', createBot);
router.patch('/bots/:id', updateBot);
router.delete('/bots/:id', deleteBot);

// ── 갭 조회 및 통계 ─────────────────────────────────────────
router.get('/gaps', getGaps);
router.get('/stats', getStats);

// ── 수동 트리거 (테스트용) ──────────────────────────────────
router.post('/trigger/friday', triggerFriday);
router.post('/trigger/monday', triggerMonday);

export default router;
