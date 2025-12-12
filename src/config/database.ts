import { PrismaClient } from '@prisma/client';

const isProduction = process.env.NODE_ENV === 'production';

const prisma = new PrismaClient({
  // 프로덕션에서는 에러와 경고만, 개발에서는 쿼리도 로깅
  log: isProduction ? ['warn', 'error'] : ['query', 'info', 'warn', 'error'],
});

export default prisma;
