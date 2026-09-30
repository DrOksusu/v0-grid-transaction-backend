import { Response, NextFunction } from 'express';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';
import { reclaimService } from '../services/reclaim/reclaim.service';

export async function getReclaimStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    return successResponse(res, await reclaimService.getStatus(req.userId!));
  } catch (e) {
    next(e);
  }
}

export async function putReclaimConfig(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const allowed = ['enabled', 'minNetPct', 'maxOrderKrw', 'dailyMaxCount', 'dailyMaxKrw', 'withdrawFeePctThreshold', 'imbalanceCapKrw', 'excludeMajors', 'killSwitch'] as const;
    const data: Record<string, any> = {};
    for (const k of allowed) if (k in req.body) data[k] = req.body[k];
    if (data.maxOrderKrw != null && (typeof data.maxOrderKrw !== 'number' || data.maxOrderKrw <= 0 || data.maxOrderKrw > 1_000_000))
      return errorResponse(res, 'VALIDATION_ERROR', 'maxOrderKrw는 0~100만원', 400);
    if (data.minNetPct != null && (typeof data.minNetPct !== 'number' || data.minNetPct < 0))
      return errorResponse(res, 'VALIDATION_ERROR', 'minNetPct는 0 이상', 400);
    if (data.dailyMaxCount != null && (typeof data.dailyMaxCount !== 'number' || !Number.isInteger(data.dailyMaxCount) || data.dailyMaxCount < 0 || data.dailyMaxCount > 100_000))
      return errorResponse(res, 'VALIDATION_ERROR', 'dailyMaxCount는 0~100000 정수', 400);
    const cfg = await reclaimService.putConfig(req.userId!, data);
    return successResponse(res, cfg);
  } catch (e) {
    next(e);
  }
}
