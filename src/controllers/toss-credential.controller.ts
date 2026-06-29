import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { encrypt } from '../utils/encryption';
import { tossService } from '../services/toss.service';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';

// POST /api/toss-credentials
// body: { clientId, clientSecret, accountSeq }
// 토스 API에 실제 토큰 발급 시도하여 유효성까지 검증.
export const saveCredential = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { clientId, clientSecret, accountSeq } = req.body;

    if (!clientId || !clientSecret || !accountSeq) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        'clientId, clientSecret, accountSeq 필수',
        400
      );
    }

    // 토스 API에 실제 토큰 발급 시도하여 키 검증
    try {
      await tossService.getAccessToken(clientId, clientSecret);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResponse(
        res,
        'TOSS_AUTH_FAILED',
        `토스 API 키 검증 실패: ${msg}`,
        400
      );
    }

    const cred = await prisma.credential.upsert({
      where: {
        userId_exchange_purpose: {
          userId,
          exchange: 'toss',
          purpose: 'default',
        },
      },
      create: {
        userId,
        exchange: 'toss',
        purpose: 'default',
        apiKey: encrypt(clientId),
        secretKey: encrypt(clientSecret),
        accountSeq,
        isValid: true,
        lastValidatedAt: new Date(),
      },
      update: {
        apiKey: encrypt(clientId),
        secretKey: encrypt(clientSecret),
        accountSeq,
        isValid: true,
        lastValidatedAt: new Date(),
      },
    });

    return successResponse(res, {
      id: cred.id,
      accountSeq: cred.accountSeq,
      hasKey: true,
    });
  } catch (e) {
    next(e);
  }
};

// GET /api/toss-credentials/me (등록 여부만, 키는 반환 X)
export const getCredentialStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const cred = await prisma.credential.findFirst({
      where: { userId, exchange: 'toss', purpose: 'default' },
    });
    if (!cred) return successResponse(res, { registered: false });
    return successResponse(res, {
      registered: true,
      accountSeq: cred.accountSeq,
    });
  } catch (e) {
    next(e);
  }
};

// DELETE /api/toss-credentials/me
export const deleteCredential = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    await prisma.credential.deleteMany({
      where: { userId, exchange: 'toss', purpose: 'default' },
    });
    return successResponse(res, { ok: true });
  } catch (e) {
    next(e);
  }
};
