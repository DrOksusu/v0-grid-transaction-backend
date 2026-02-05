import { Router } from 'express';
import { maController } from '../controllers/ma.controller';

const router = Router();

// GET /api/ma - 현재 MA 지표 조회
router.get('/', (req, res) => maController.getIndicator(req, res));

// GET /api/ma/status - 서비스 상태 조회
router.get('/status', (req, res) => maController.getStatus(req, res));

// POST /api/ma/refresh - 수동 갱신 (개발/테스트용)
router.post('/refresh', (req, res) => maController.refresh(req, res));

export default router;
