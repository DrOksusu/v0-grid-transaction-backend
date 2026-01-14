/**
 * Metrics Routes
 *
 * 모니터링 메트릭 API 라우트
 */

import { Router } from 'express';
import {
  getMetrics,
  getSystemMetrics,
  getBusinessMetrics,
  getMetricsStatus,
} from '../controllers/metrics.controller';

const router = Router();

// 전체 메트릭
router.get('/', getMetrics);

// 시스템 메트릭만
router.get('/system', getSystemMetrics);

// 비즈니스 메트릭만
router.get('/business', getBusinessMetrics);

// 메트릭 서비스 상태
router.get('/status', getMetricsStatus);

export default router;
