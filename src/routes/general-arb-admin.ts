import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import {
  getConfig,
  patchConfig,
  listSymbols,
  addSymbol,
  removeSymbol,
  getSpreads,
  listOpportunities,
  getOpportunityStats,
} from '../controllers/general-arb-admin.controller';

const router = Router();

// 모든 라우트에 인증 + 관리자 권한 적용
router.use(authenticate);
router.use(requireAdmin);

// 설정 CRUD
router.get('/config', getConfig);
router.patch('/config', patchConfig);

// 감시 종목 관리
router.get('/symbols', listSymbols);
router.post('/symbols', addSymbol);
router.delete('/symbols/:symbol', removeSymbol);

// 인메모리 스프레드 스냅샷
router.get('/spreads', getSpreads);

// 기회 통계 — /opportunities보다 먼저 등록해야 Express 라우트 매칭 순서 충돌 없음
router.get('/opportunities/stats', getOpportunityStats);
router.get('/opportunities', listOpportunities);

export default router;
