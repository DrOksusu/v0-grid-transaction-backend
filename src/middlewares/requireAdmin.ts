import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { config } from '../config/env';
import { AppError } from './errorHandler';
import { AuthRequest } from '../types';

/**
 * authenticate 미들웨어 다음에 위치.
 * req.userId로 user를 조회해서 email === config.adminEmail 인 경우만 next() 통과.
 *
 * 참고: JWT payload는 {userId} 만 담고 있어 매 요청마다 prisma.user lookup 필요.
 * 단일 admin 사용자 환경에서는 부하 무시 수준 (~2 lookup/sec).
 * 다중 사용자 확장(M7) 시 5분 TTL 캐시 도입 검토.
 */
export const requireAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.userId) {
      throw new AppError('Unauthorized: missing userId', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true },
    });

    if (!user) {
      throw new AppError('Unauthorized: user not found', 401);
    }

    if (user.email !== config.adminEmail) {
      throw new AppError('Forbidden: admin only', 403);
    }

    next();
  } catch (error) {
    next(error);
  }
};
