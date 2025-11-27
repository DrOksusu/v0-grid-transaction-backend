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
      config.jwt.secret
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
      config.jwt.secret
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
