import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import {
  getSummary,
  getTickerBasis,
  createManualTrade,
  deleteManualTrade,
} from '../controllers/cost-basis.controller';

const router = Router();
router.use(authenticate);

router.get('/', getSummary);                              // 전체 스테이블코인 요약
router.post('/manual-trades', createManualTrade);        // 수동 거래 입력 (POST 먼저)
router.delete('/manual-trades/:id', deleteManualTrade);  // 수동 거래 삭제 (DELETE 먼저)
router.get('/:ticker', getTickerBasis);                  // 특정 티커 상세 (dynamic 마지막)

export default router;
