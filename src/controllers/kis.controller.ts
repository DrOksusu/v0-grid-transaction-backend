import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { successResponse, errorResponse } from '../utils/response';
import { encrypt, decrypt, maskApiKey } from '../utils/encryption';
import { AuthRequest } from '../types';
import { KisService } from '../services/kis.service';

// KIS Credential 저장
export const saveKisCredential = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { appKey, appSecret, accountNo, isPaper } = req.body;

    if (!appKey || !appSecret || !accountNo) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        'App Key, App Secret, 계좌번호는 필수입니다',
        400
      );
    }

    // 계좌번호 형식 검증 (12345678-01)
    if (!/^\d{8}-\d{2}$/.test(accountNo)) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '계좌번호 형식이 올바르지 않습니다 (예: 12345678-01)',
        400
      );
    }

    // 기존 KIS credential 확인
    const existing = await prisma.credential.findFirst({
      where: { userId, exchange: 'kis' },
    });

    const encryptedAppKey = encrypt(appKey);
    const encryptedAppSecret = encrypt(appSecret);

    if (existing) {
      // 기존 credential 업데이트
      await prisma.credential.update({
        where: { id: existing.id },
        data: {
          apiKey: encryptedAppKey,
          secretKey: encryptedAppSecret,
          accountNo,
          isPaper: isPaper ?? true,
          isValid: true,
          lastValidatedAt: new Date(),
          // 토큰 초기화 (새 credential로 다시 발급 필요)
          accessToken: null,
          tokenExpireAt: null,
        },
      });

      return successResponse(
        res,
        {
          exchange: 'kis',
          accountNo,
          isPaper: isPaper ?? true,
          isValid: true,
        },
        '한국투자증권 API 설정이 업데이트되었습니다'
      );
    }

    // 새 credential 생성
    const credential = await prisma.credential.create({
      data: {
        userId,
        exchange: 'kis',
        apiKey: encryptedAppKey,
        secretKey: encryptedAppSecret,
        accountNo,
        isPaper: isPaper ?? true,
        isValid: true,
        lastValidatedAt: new Date(),
      },
    });

    return successResponse(
      res,
      {
        credentialId: credential.id.toString(),
        exchange: 'kis',
        accountNo,
        isPaper: isPaper ?? true,
        isValid: true,
      },
      '한국투자증권 API 설정이 저장되었습니다',
      201
    );
  } catch (error) {
    next(error);
  }
};

// KIS 연결 테스트 (토큰 발급 테스트)
export const testKisConnection = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;

    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: 'kis' },
    });

    if (!credential) {
      return errorResponse(
        res,
        'CREDENTIAL_NOT_FOUND',
        '한국투자증권 API 설정을 찾을 수 없습니다',
        404
      );
    }

    const appKey = decrypt(credential.apiKey);
    const appSecret = decrypt(credential.secretKey);

    const kisService = new KisService({
      appKey,
      appSecret,
      accountNo: credential.accountNo || '',
      isPaper: credential.isPaper,
    });

    // Access Token 발급 테스트
    const tokenInfo = await kisService.getAccessToken();

    // 토큰을 DB에 저장
    await prisma.credential.update({
      where: { id: credential.id },
      data: {
        accessToken: encrypt(tokenInfo.accessToken),
        tokenExpireAt: tokenInfo.tokenExpireAt,
        isValid: true,
        lastValidatedAt: new Date(),
      },
    });

    return successResponse(
      res,
      {
        connected: true,
        tokenExpireAt: tokenInfo.tokenExpireAt,
        isPaper: credential.isPaper,
        accountNo: credential.accountNo,
      },
      '한국투자증권 API 연결 성공'
    );
  } catch (error: any) {
    console.error('KIS connection test error:', error);
    return errorResponse(
      res,
      'KIS_API_ERROR',
      error.message || '한국투자증권 API 연결 실패',
      500
    );
  }
};

// KIS 연결 상태 확인
export const getKisStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;

    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: 'kis' },
    });

    if (!credential) {
      return successResponse(res, {
        connected: false,
        hasCredential: false,
      });
    }

    // 토큰 유효성 확인
    let isTokenValid = false;
    let tokenExpireAt = credential.tokenExpireAt;
    if (credential.accessToken && credential.tokenExpireAt) {
      const now = new Date();
      const bufferTime = 10 * 60 * 1000; // 10분
      isTokenValid = credential.tokenExpireAt.getTime() - bufferTime > now.getTime();
    }

    // 토큰이 만료되었지만 apiKey/secretKey가 있으면 자동 갱신 시도
    if (!isTokenValid && credential.apiKey && credential.secretKey) {
      try {
        const kisService = new KisService({
          appKey: decrypt(credential.apiKey),
          appSecret: decrypt(credential.secretKey),
          accountNo: credential.accountNo || '',
          isPaper: credential.isPaper ?? true,
        });

        const tokenInfo = await kisService.getAccessToken();

        // DB에 새 토큰 저장
        await prisma.credential.update({
          where: { id: credential.id },
          data: {
            accessToken: encrypt(tokenInfo.accessToken),
            tokenExpireAt: tokenInfo.tokenExpireAt,
            lastValidatedAt: new Date(),
          },
        });

        isTokenValid = true;
        tokenExpireAt = tokenInfo.tokenExpireAt;
        console.log(`[KIS] 토큰 자동 갱신 완료 (userId: ${userId})`);
      } catch (refreshError: any) {
        console.error(`[KIS] 토큰 자동 갱신 실패 (userId: ${userId}):`, refreshError.message);
        // 갱신 실패 시 isTokenValid는 false 유지
      }
    }

    return successResponse(res, {
      connected: isTokenValid,
      hasCredential: true,
      isPaper: credential.isPaper,
      accountNo: credential.accountNo,
      tokenExpireAt: tokenExpireAt,
      lastValidatedAt: credential.lastValidatedAt,
    });
  } catch (error) {
    next(error);
  }
};

// 미국주식 현재가 조회
export const getUSStockPrice = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { ticker, exchange } = req.query;

    if (!ticker) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '종목코드(ticker)는 필수입니다',
        400
      );
    }

    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: 'kis' },
    });

    if (!credential) {
      return errorResponse(
        res,
        'CREDENTIAL_NOT_FOUND',
        '한국투자증권 API 설정을 찾을 수 없습니다',
        404
      );
    }

    const appKey = decrypt(credential.apiKey);
    const appSecret = decrypt(credential.secretKey);

    const kisService = new KisService({
      appKey,
      appSecret,
      accountNo: credential.accountNo || '',
      isPaper: credential.isPaper,
    });

    // 저장된 토큰이 있으면 설정
    if (credential.accessToken && credential.tokenExpireAt) {
      kisService.setAccessToken(
        decrypt(credential.accessToken),
        credential.tokenExpireAt
      );
    }

    const priceData = await kisService.getUSStockPrice(
      ticker as string,
      (exchange as string) || 'NAS'
    );

    // 토큰이 갱신되었을 수 있으므로 확인 후 저장
    // (KisService 내부에서 토큰을 갱신할 수 있음)

    return successResponse(res, priceData);
  } catch (error: any) {
    console.error('US stock price error:', error);
    return errorResponse(
      res,
      'KIS_API_ERROR',
      error.message || '현재가 조회 실패',
      500
    );
  }
};

// 미국주식 종목 검색
export const searchUSStock = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { ticker } = req.query;

    if (!ticker) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '종목코드(ticker)는 필수입니다',
        400
      );
    }

    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: 'kis' },
    });

    if (!credential) {
      return errorResponse(
        res,
        'CREDENTIAL_NOT_FOUND',
        '한국투자증권 API 설정을 찾을 수 없습니다',
        404
      );
    }

    const appKey = decrypt(credential.apiKey);
    const appSecret = decrypt(credential.secretKey);

    const kisService = new KisService({
      appKey,
      appSecret,
      accountNo: credential.accountNo || '',
      isPaper: credential.isPaper,
    });

    // 저장된 토큰이 있으면 설정
    if (credential.accessToken && credential.tokenExpireAt) {
      kisService.setAccessToken(
        decrypt(credential.accessToken),
        credential.tokenExpireAt
      );
    }

    const stockData = await kisService.searchUSStock(ticker as string);

    return successResponse(res, stockData);
  } catch (error: any) {
    console.error('US stock search error:', error);
    return errorResponse(
      res,
      'KIS_API_ERROR',
      error.message || '종목 검색 실패',
      500
    );
  }
};

// 미국주식 잔고 조회
export const getUSStockBalance = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;

    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: 'kis' },
    });

    if (!credential) {
      return errorResponse(
        res,
        'CREDENTIAL_NOT_FOUND',
        '한국투자증권 API 설정을 찾을 수 없습니다',
        404
      );
    }

    const appKey = decrypt(credential.apiKey);
    const appSecret = decrypt(credential.secretKey);

    const kisService = new KisService({
      appKey,
      appSecret,
      accountNo: credential.accountNo || '',
      isPaper: credential.isPaper,
    });

    // 저장된 토큰이 있으면 설정
    if (credential.accessToken && credential.tokenExpireAt) {
      kisService.setAccessToken(
        decrypt(credential.accessToken),
        credential.tokenExpireAt
      );
    }

    const balanceData = await kisService.getUSStockBalance();

    return successResponse(res, balanceData);
  } catch (error: any) {
    console.error('US stock balance error:', error);
    return errorResponse(
      res,
      'KIS_API_ERROR',
      error.message || '잔고 조회 실패',
      500
    );
  }
};

// 환율 조회
export const getExchangeRate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;

    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: 'kis' },
    });

    if (!credential) {
      return errorResponse(
        res,
        'CREDENTIAL_NOT_FOUND',
        '한국투자증권 API 설정을 찾을 수 없습니다',
        404
      );
    }

    const appKey = decrypt(credential.apiKey);
    const appSecret = decrypt(credential.secretKey);

    const kisService = new KisService({
      appKey,
      appSecret,
      accountNo: credential.accountNo || '',
      isPaper: credential.isPaper,
    });

    // 저장된 토큰이 있으면 설정
    if (credential.accessToken && credential.tokenExpireAt) {
      kisService.setAccessToken(
        decrypt(credential.accessToken),
        credential.tokenExpireAt
      );
    }

    const rateData = await kisService.getExchangeRate();

    return successResponse(res, rateData);
  } catch (error: any) {
    console.error('Exchange rate error:', error);
    return errorResponse(
      res,
      'KIS_API_ERROR',
      error.message || '환율 조회 실패',
      500
    );
  }
};
