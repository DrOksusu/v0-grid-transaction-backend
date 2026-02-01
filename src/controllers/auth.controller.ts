import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../config/database';
import { config } from '../config/env';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';
import { EmailService } from '../services/email.service';

export const register = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '이메일과 비밀번호는 필수입니다',
        400
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return errorResponse(
        res,
        'USER_EXISTS',
        '이미 존재하는 이메일입니다',
        400
      );
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
      },
    });

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      config.jwt.secret,
      { expiresIn: '30d' }
    );

    return successResponse(
      res,
      {
        userId: user.id,
        email: user.email,
        token,
      },
      '회원가입이 완료되었습니다',
      201
    );
  } catch (error) {
    next(error);
  }
};

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '이메일과 비밀번호는 필수입니다',
        400
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return errorResponse(
        res,
        'INVALID_CREDENTIALS',
        '이메일 또는 비밀번호가 올바르지 않습니다',
        401
      );
    }

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return errorResponse(
        res,
        'INVALID_CREDENTIALS',
        '이메일 또는 비밀번호가 올바르지 않습니다',
        401
      );
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      config.jwt.secret,
      { expiresIn: '30d' }
    );

    return successResponse(res, {
      userId: user.id,
      email: user.email,
      name: user.name,
      token,
    });
  } catch (error) {
    next(error);
  }
};

export const logout = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    return successResponse(res, null, '로그아웃되었습니다');
  } catch (error) {
    next(error);
  }
};

/**
 * 프로필 조회
 * GET /api/auth/profile
 */
export const getProfile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        nickname: true,
        createdAt: true,
      },
    });

    if (!user) {
      return errorResponse(res, 'USER_NOT_FOUND', '사용자를 찾을 수 없습니다', 404);
    }

    return successResponse(res, user);
  } catch (error) {
    next(error);
  }
};

/**
 * 닉네임 수정
 * PUT /api/auth/nickname
 */
export const updateNickname = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { nickname } = req.body;

    // 닉네임 유효성 검사
    if (nickname !== undefined && nickname !== null) {
      const trimmedNickname = nickname.trim();

      // 빈 문자열이면 null로 처리
      if (trimmedNickname === '') {
        await prisma.user.update({
          where: { id: userId },
          data: { nickname: null },
        });
        return successResponse(res, { nickname: null }, '닉네임이 삭제되었습니다');
      }

      // 길이 검사 (2~20자)
      if (trimmedNickname.length < 2 || trimmedNickname.length > 20) {
        return errorResponse(
          res,
          'VALIDATION_ERROR',
          '닉네임은 2~20자 사이여야 합니다',
          400
        );
      }

      // 특수문자 검사 (한글, 영문, 숫자만 허용)
      if (!/^[가-힣a-zA-Z0-9]+$/.test(trimmedNickname)) {
        return errorResponse(
          res,
          'VALIDATION_ERROR',
          '닉네임은 한글, 영문, 숫자만 사용할 수 있습니다',
          400
        );
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data: { nickname: trimmedNickname },
        select: { nickname: true },
      });

      return successResponse(res, user, '닉네임이 수정되었습니다');
    }

    return errorResponse(res, 'VALIDATION_ERROR', '닉네임을 입력해주세요', 400);
  } catch (error) {
    next(error);
  }
};

/**
 * 비밀번호 찾기 (재설정 이메일 발송)
 * POST /api/auth/forgot-password
 */
export const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, 'VALIDATION_ERROR', '이메일을 입력해주세요', 400);
    }

    // 이메일 설정 확인
    if (!EmailService.isConfigured()) {
      return errorResponse(
        res,
        'EMAIL_NOT_CONFIGURED',
        '이메일 서비스가 설정되지 않았습니다. 관리자에게 문의하세요.',
        500
      );
    }

    // 사용자 조회
    const user = await prisma.user.findUnique({
      where: { email },
    });

    // 보안상 사용자 존재 여부와 관계없이 동일한 응답
    if (!user) {
      return successResponse(
        res,
        null,
        '해당 이메일로 비밀번호 재설정 링크를 발송했습니다.'
      );
    }

    // 기존 미사용 토큰 무효화
    await prisma.passwordReset.updateMany({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        expiresAt: new Date(), // 즉시 만료
      },
    });

    // 새 토큰 생성
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1시간

    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        token,
        expiresAt,
      },
    });

    // 재설정 링크 생성
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetLink = `${frontendUrl}/reset-password?token=${token}`;

    // 이메일 발송
    const sent = await EmailService.sendPasswordResetEmail(
      email,
      resetLink,
      user.name || undefined
    );

    if (!sent) {
      return errorResponse(
        res,
        'EMAIL_SEND_FAILED',
        '이메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.',
        500
      );
    }

    return successResponse(
      res,
      null,
      '해당 이메일로 비밀번호 재설정 링크를 발송했습니다.'
    );
  } catch (error) {
    next(error);
  }
};

/**
 * 비밀번호 재설정
 * POST /api/auth/reset-password
 */
export const resetPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '토큰과 새 비밀번호를 입력해주세요',
        400
      );
    }

    if (password.length < 6) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '비밀번호는 6자 이상이어야 합니다',
        400
      );
    }

    // 토큰 조회
    const resetRecord = await prisma.passwordReset.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!resetRecord) {
      return errorResponse(
        res,
        'INVALID_TOKEN',
        '유효하지 않은 토큰입니다',
        400
      );
    }

    if (resetRecord.usedAt) {
      return errorResponse(
        res,
        'TOKEN_USED',
        '이미 사용된 토큰입니다',
        400
      );
    }

    if (resetRecord.expiresAt < new Date()) {
      return errorResponse(
        res,
        'TOKEN_EXPIRED',
        '만료된 토큰입니다. 비밀번호 찾기를 다시 시도해주세요.',
        400
      );
    }

    // 비밀번호 업데이트
    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetRecord.userId },
        data: { password: hashedPassword },
      }),
      prisma.passwordReset.update({
        where: { id: resetRecord.id },
        data: { usedAt: new Date() },
      }),
    ]);

    return successResponse(
      res,
      null,
      '비밀번호가 성공적으로 변경되었습니다. 새 비밀번호로 로그인해주세요.'
    );
  } catch (error) {
    next(error);
  }
};

/**
 * 토큰 유효성 검사
 * GET /api/auth/verify-reset-token
 */
export const verifyResetToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      return errorResponse(res, 'VALIDATION_ERROR', '토큰이 필요합니다', 400);
    }

    const resetRecord = await prisma.passwordReset.findUnique({
      where: { token },
    });

    if (!resetRecord) {
      return errorResponse(res, 'INVALID_TOKEN', '유효하지 않은 토큰입니다', 400);
    }

    if (resetRecord.usedAt) {
      return errorResponse(res, 'TOKEN_USED', '이미 사용된 토큰입니다', 400);
    }

    if (resetRecord.expiresAt < new Date()) {
      return errorResponse(res, 'TOKEN_EXPIRED', '만료된 토큰입니다', 400);
    }

    return successResponse(res, { valid: true }, '유효한 토큰입니다');
  } catch (error) {
    next(error);
  }
};
