import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { successResponse, errorResponse } from '../utils/response';
import { encrypt, decrypt, maskApiKey } from '../utils/encryption';
import { AuthRequest } from '../types';
import { getUpbitApiKeyInfo } from '../utils/upbit';

export const createCredential = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { exchange, apiKey, secretKey, ipWhitelist } = req.body;

    if (!exchange || !apiKey || !secretKey) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '필수 필드가 누락되었습니다',
        400
      );
    }

    // 마스킹된 API 키 저장 방지
    if (apiKey.includes('****') || apiKey.includes('*')) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '마스킹된 API 키는 저장할 수 없습니다. 실제 API 키를 입력해주세요.',
        400
      );
    }

    const existing = await prisma.credential.findFirst({
      where: { userId, exchange },
    });

    if (existing) {
      return errorResponse(
        res,
        'CREDENTIAL_EXISTS',
        '해당 거래소의 인증 정보가 이미 존재합니다',
        400
      );
    }

    const encryptedApiKey = encrypt(apiKey);
    const encryptedSecretKey = encrypt(secretKey);

    const credential = await prisma.credential.create({
      data: {
        userId,
        exchange,
        apiKey: encryptedApiKey,
        secretKey: encryptedSecretKey,
        ipWhitelist,
        isValid: true,
        lastValidatedAt: new Date(),
      },
    });

    return successResponse(
      res,
      {
        credentialId: credential.id.toString(),
        exchange: credential.exchange,
        isValid: credential.isValid,
      },
      '인증 정보가 저장되었습니다',
      201
    );
  } catch (error) {
    next(error);
  }
};

export const getAllCredentials = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;

    const credentials = await prisma.credential.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    const credentialsData = credentials.map(cred => {
      const decryptedApiKey = decrypt(cred.apiKey);
      return {
        _id: cred.id.toString(),
        exchange: cred.exchange,
        apiKey: maskApiKey(decryptedApiKey),
        secretKey: cred.secretKey ? 'SAVED' : null, // Secret Key 존재 여부만 표시
        ipWhitelist: cred.ipWhitelist,
        isValid: cred.isValid,
        lastValidatedAt: cred.lastValidatedAt,
        createdAt: cred.createdAt,
      };
    });

    return successResponse(res, { credentials: credentialsData });
  } catch (error) {
    next(error);
  }
};

export const getCredentialByExchange = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { exchange } = req.params;

    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: exchange as any },
    });

    if (!credential) {
      return errorResponse(
        res,
        'CREDENTIAL_NOT_FOUND',
        '인증 정보를 찾을 수 없습니다',
        404
      );
    }

    const decryptedApiKey = decrypt(credential.apiKey);

    return successResponse(res, {
      _id: credential.id.toString(),
      exchange: credential.exchange,
      apiKey: maskApiKey(decryptedApiKey),
      ipWhitelist: credential.ipWhitelist,
      isValid: credential.isValid,
      lastValidatedAt: credential.lastValidatedAt,
      createdAt: credential.createdAt,
    });
  } catch (error) {
    next(error);
  }
};

export const updateCredential = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const exchange = req.params.exchange as 'upbit' | 'binance';
    const { apiKey, secretKey, ipWhitelist } = req.body;

    // 마스킹된 API 키 저장 방지
    if (apiKey && (apiKey.includes('****') || apiKey.includes('*'))) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '마스킹된 API 키는 저장할 수 없습니다. 실제 API 키를 입력해주세요.',
        400
      );
    }

    const credential = await prisma.credential.findFirst({
      where: { userId, exchange },
    });

    if (!credential) {
      return errorResponse(
        res,
        'CREDENTIAL_NOT_FOUND',
        '인증 정보를 찾을 수 없습니다',
        404
      );
    }

    const updateData: any = {};
    if (apiKey) updateData.apiKey = encrypt(apiKey);
    if (secretKey) updateData.secretKey = encrypt(secretKey);
    if (ipWhitelist !== undefined) updateData.ipWhitelist = ipWhitelist;

    if (apiKey || secretKey) {
      updateData.isValid = true;
      updateData.lastValidatedAt = new Date();
    }

    await prisma.credential.update({
      where: { id: credential.id },
      data: updateData,
    });

    return successResponse(
      res,
      {
        exchange,
        isValid: true,
        updatedAt: new Date(),
      },
      '인증 정보가 업데이트되었습니다'
    );
  } catch (error) {
    next(error);
  }
};

export const deleteCredential = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { exchange } = req.params;

    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: exchange as any },
    });

    if (!credential) {
      return errorResponse(
        res,
        'CREDENTIAL_NOT_FOUND',
        '인증 정보를 찾을 수 없습니다',
        404
      );
    }

    await prisma.credential.delete({
      where: { id: credential.id },
    });

    return successResponse(res, null, '인증 정보가 삭제되었습니다');
  } catch (error) {
    next(error);
  }
};

// 업비트 API 키 만료일 조회 (테스트용)
export const testUpbitApiKey = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;

    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: 'upbit' },
    });

    if (!credential) {
      return errorResponse(
        res,
        'CREDENTIAL_NOT_FOUND',
        '업비트 인증 정보를 찾을 수 없습니다',
        404
      );
    }

    const decryptedApiKey = decrypt(credential.apiKey);
    const decryptedSecretKey = decrypt(credential.secretKey);

    const apiKeyInfo = await getUpbitApiKeyInfo(decryptedApiKey, decryptedSecretKey);

    return successResponse(res, { apiKeyInfo }, '업비트 API 키 정보 조회 성공');
  } catch (error) {
    console.error('Test error:', error);
    next(error);
  }
};
