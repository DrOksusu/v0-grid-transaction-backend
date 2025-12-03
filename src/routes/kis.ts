import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import {
  saveKisCredential,
  testKisConnection,
  getKisStatus,
  getUSStockPrice,
  searchUSStock,
  getUSStockBalance,
  getExchangeRate,
} from '../controllers/kis.controller';

const router = Router();

// 모든 라우트에 인증 미들웨어 적용
router.use(authenticate);

// KIS Credential 관리
router.post('/credential', saveKisCredential);         // KIS API 키 저장
router.get('/status', getKisStatus);                   // 연결 상태 확인
router.post('/test', testKisConnection);               // 연결 테스트 (토큰 발급)

// 미국주식 조회
router.get('/us-stock/price', getUSStockPrice);        // 현재가 조회
router.get('/us-stock/search', searchUSStock);         // 종목 검색
router.get('/us-stock/balance', getUSStockBalance);    // 잔고 조회

// 환율
router.get('/exchange-rate', getExchangeRate);         // 환율 조회

export default router;
