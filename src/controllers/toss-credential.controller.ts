import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { encrypt, decrypt } from '../utils/encryption';
import { tossService, TossApiError } from '../services/toss.service';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';

// spec § 4: accountSeq는 spec 상 int64. 우리는 numeric-only string으로 검증 후 저장.
// int64 max = 9223372036854775807 (19자리) → 1~19자리 숫자만 허용.
const ACCOUNT_SEQ_PATTERN = /^\d{1,19}$/;

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

    if (!ACCOUNT_SEQ_PATTERN.test(String(accountSeq))) {
      return errorResponse(
        res,
        'ACCOUNT_SEQ_INVALID',
        'accountSeq는 1~19자리 숫자만 허용 (int64)',
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
        accountSeq: String(accountSeq),
        isValid: true,
        lastValidatedAt: new Date(),
      },
      update: {
        apiKey: encrypt(clientId),
        secretKey: encrypt(clientSecret),
        accountSeq: String(accountSeq),
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

// POST /api/toss-credentials/preview-accounts
// body: { clientId, clientSecret }
// 저장 전에 계좌 목록을 미리 조회해서 dropdown에 표시하기 위한 endpoint.
// credential 저장은 안 하고, 토스 accounts API를 호출한 결과만 반환.
export const previewAccounts = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { clientId, clientSecret } = req.body;
    if (!clientId || !clientSecret) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        'clientId, clientSecret 필수',
        400
      );
    }
    try {
      const accounts = await tossService.getAccounts({
        clientId,
        clientSecret,
      });
      return successResponse(res, {
        accounts: accounts.map((a) => ({
          accountNo: a.accountNo,
          accountSeq: String(a.accountSeq), // int64 → string 노출
          accountType: a.accountType,
        })),
      });
    } catch (e) {
      const msg = e instanceof TossApiError
        ? `${e.code}: ${e.message}`
        : e instanceof Error ? e.message : String(e);
      return errorResponse(res, 'TOSS_AUTH_FAILED', `계좌 조회 실패: ${msg}`, 400);
    }
  } catch (e) {
    next(e);
  }
};

// GET /api/toss-credentials/accounts
// 저장된 credential로 계좌 목록 재조회 (등록 후 변경 사항 확인용).
export const listAccounts = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const cred = await prisma.credential.findFirst({
      where: { userId, exchange: 'toss', purpose: 'default' },
    });
    if (!cred) {
      return errorResponse(res, 'CREDENTIAL_NOT_FOUND', '토스 API 키 미등록', 400);
    }
    const accounts = await tossService.getAccounts({
      clientId: decrypt(cred.apiKey),
      clientSecret: decrypt(cred.secretKey),
    });
    return successResponse(res, {
      accounts: accounts.map((a) => ({
        accountNo: a.accountNo,
        accountSeq: String(a.accountSeq),
        accountType: a.accountType,
      })),
    });
  } catch (e) {
    next(e);
  }
};
