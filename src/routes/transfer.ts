// src/routes/transfer.ts
//
// 거래소 간 코인 이체 라우트.
// 인증된 사용자만 접근 가능.

import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import {
  getBalances,
  prepareTransfer,
  executeTransfer,
  listTransfers,
} from '../controllers/transfer.controller';

const router = Router();

// 모든 라우트에 JWT 인증 적용
router.use(authenticate);

router.get('/balances', getBalances);   // 양쪽 거래소 스테이블코인 잔고 조회
router.get('/', listTransfers);          // 이체 이력 목록 (최신순 50건)
router.post('/prepare', prepareTransfer); // 이체 준비 (입금 주소 조회 + DB 저장)
router.post('/:id/execute', executeTransfer); // 이체 실행 (출금 요청)

export default router;
