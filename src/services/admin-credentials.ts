// 관리자(userId=2) 거래소 API 자격증명 공용 조회 헬퍼
// listing-auto-trader.service.ts의 getBinanceCreds/getMexcCreds/getGateioCreds/getBithumbCreds에서 추출·일반화
import prisma from '../config/database';
import { decrypt } from '../utils/encryption';

export const ADMIN_USER_ID = 2; // Binance/Bithumb 등 인증정보 소유 유저

export interface ExchangeCreds {
  apiKey: string;
  secretKey: string;
}

export type AdminCredExchange = 'upbit' | 'binance' | 'bithumb' | 'mexc' | 'gateio';

export async function getAdminCreds(exchange: AdminCredExchange): Promise<ExchangeCreds | null> {
  const row = await prisma.credential.findFirst({
    where: { userId: ADMIN_USER_ID, exchange: exchange as any },
    select: { apiKey: true, secretKey: true },
  });
  if (row) return { apiKey: decrypt(row.apiKey), secretKey: decrypt(row.secretKey) };

  // Gate.io만 DB에 없으면 환경변수 fallback (GATEWAY_API_KEY / GATEWAY_SECRET_KEY) — spec §3
  if (exchange === 'gateio') {
    const envKey = process.env.GATEWAY_API_KEY;
    const envSecret = process.env.GATEWAY_SECRET_KEY;
    if (envKey && envSecret) return { apiKey: envKey, secretKey: envSecret };
  }
  return null;
}
