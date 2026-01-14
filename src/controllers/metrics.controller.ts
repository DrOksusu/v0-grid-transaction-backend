/**
 * Metrics Controller
 *
 * 모니터링 메트릭 API 엔드포인트
 */

import { Request, Response, NextFunction } from 'express';
import { successResponse } from '../utils/response';
import { metricsService } from '../services/metrics.service';

/**
 * 전체 메트릭 조회
 * GET /api/metrics
 */
export const getMetrics = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const metrics = metricsService.getMetrics();
    return successResponse(res, metrics);
  } catch (error) {
    next(error);
  }
};

/**
 * 시스템 메트릭만 조회
 * GET /api/metrics/system
 */
export const getSystemMetrics = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const systemMetrics = metricsService.getSystemMetrics();
    return successResponse(res, systemMetrics);
  } catch (error) {
    next(error);
  }
};

/**
 * 비즈니스 메트릭만 조회
 * GET /api/metrics/business
 */
export const getBusinessMetrics = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const businessMetrics = metricsService.getBusinessMetrics();
    return successResponse(res, businessMetrics);
  } catch (error) {
    next(error);
  }
};

/**
 * 메트릭 서비스 상태 조회
 * GET /api/metrics/status
 */
export const getMetricsStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const status = metricsService.getStatus();
    return successResponse(res, status);
  } catch (error) {
    next(error);
  }
};
