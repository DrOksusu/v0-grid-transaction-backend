/**
 * Metrics Middleware
 *
 * HTTP 요청 성능 측정 미들웨어
 */

import { Request, Response, NextFunction } from 'express';
import { metricsService } from '../services/metrics.service';
import { AuthRequest } from '../types';

/**
 * HTTP 요청 메트릭 수집 미들웨어
 * 모든 API 요청의 응답 시간, 상태 코드 등을 기록
 */
export const metricsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const startTime = process.hrtime.bigint();

  // 응답 완료 시 메트릭 기록
  res.on('finish', () => {
    const endTime = process.hrtime.bigint();
    const responseTime = Number(endTime - startTime) / 1_000_000; // ns to ms

    // 헬스체크, 메트릭 엔드포인트는 제외
    if (req.path === '/api/health' || req.path.startsWith('/api/metrics')) {
      return;
    }

    metricsService.recordRequest({
      timestamp: Date.now(),
      method: req.method,
      path: req.originalUrl || req.path,
      statusCode: res.statusCode,
      responseTime: Math.round(responseTime * 100) / 100, // 소수점 2자리
      userId: (req as AuthRequest).userId,
    });
  });

  next();
};
