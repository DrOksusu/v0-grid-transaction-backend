import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { config } from '../config/env';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';

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
