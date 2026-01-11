import { Router } from 'express';
import { getWhaleActivity, getWhaleStatus } from '../controllers/whale.controller';

const router = Router();

// 고래 활동 데이터 조회 (인증 불필요 - 공개 데이터)
router.get('/', getWhaleActivity);

// 서비스 상태 조회
router.get('/status', getWhaleStatus);

export default router;
