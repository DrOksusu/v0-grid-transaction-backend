import type { Response, NextFunction } from 'express';
import type { AuthRequest } from '../../src/types';

// env에서 ADMIN_EMAIL 사용하므로 사전 설정
process.env.ADMIN_EMAIL = 'admin@test.com';

// src/config/database를 __mocks__/database로 모킹
jest.mock('../../src/config/database', () => require('../../__mocks__/database'));

import prisma from '../../src/config/database';
import { requireAdmin } from '../../src/middlewares/requireAdmin';

describe('requireAdmin 미들웨어', () => {
  let req: Partial<AuthRequest>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { userId: 1 };
    res = {};
    next = jest.fn();
  });

  it('admin email 일치 시 next()를 호출한다', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ email: 'admin@test.com' });
    await requireAdmin(req as AuthRequest, res as Response, next);
    expect(next).toHaveBeenCalledWith();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { email: true },
    });
  });

  it('non-admin email 시 403 에러로 next()를 호출한다', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ email: 'other@test.com' });
    await requireAdmin(req as AuthRequest, res as Response, next);
    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(403);
  });

  it('user 레코드 없음 시 401 에러로 next()를 호출한다', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await requireAdmin(req as AuthRequest, res as Response, next);
    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
  });

  it('req.userId 없음 시 401 에러로 next()를 호출한다 (authenticate 미통과)', async () => {
    req.userId = undefined;
    await requireAdmin(req as AuthRequest, res as Response, next);
    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err.statusCode).toBe(401);
  });
});
