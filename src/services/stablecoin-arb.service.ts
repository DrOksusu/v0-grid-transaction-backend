import prisma from '../config/database';
import { Prisma } from '@prisma/client';

/**
 * 유저의 봇 조회 또는 기본값으로 생성
 */
export async function getOrCreateBot(userId: number) {
  const existing = await prisma.stablecoinArbBot.findUnique({
    where: { userId },
  });
  if (existing) return existing;

  return prisma.stablecoinArbBot.create({
    data: {
      userId,
      // M1 발견: USDS/USDE는 저유동성(74bp/54bp)이므로 기본 off
      // USDT/USDC/USD1만 활성화로 시작. 필요 시 관리자가 UI로 토글.
      coinsEnabled: ['USDT', 'USDC', 'USD1'],
    },
  });
}

export async function getBot(userId: number) {
  return prisma.stablecoinArbBot.findUnique({ where: { userId } });
}

export async function updateBotConfig(
  userId: number,
  patch: Prisma.StablecoinArbBotUpdateInput
) {
  return prisma.stablecoinArbBot.update({
    where: { userId },
    data: patch,
  });
}

export async function setEnabled(userId: number, enabled: boolean) {
  return updateBotConfig(userId, { enabled });
}

export async function setKillSwitch(userId: number, killSwitch: boolean) {
  return updateBotConfig(userId, { killSwitch });
}

/**
 * 감지된 기회 1건을 기록 (실행되었든 스킵되었든).
 * 튜닝용 데이터 — M6 관찰에서 분석.
 */
export async function logOpportunity(args: {
  botId: number;
  detectedAt: Date;
  soldCoin: string;
  boughtCoin: string;
  bidSoldKrw: number;
  askBoughtKrw: number;
  spreadBps: number;
  executed: boolean;
  skipReason?: string;
}) {
  return prisma.stablecoinArbOpportunity.create({
    data: {
      botId: args.botId,
      detectedAt: args.detectedAt,
      soldCoin: args.soldCoin,
      boughtCoin: args.boughtCoin,
      bidSoldKrw: args.bidSoldKrw,
      askBoughtKrw: args.askBoughtKrw,
      spreadBps: args.spreadBps,
      executed: args.executed,
      skipReason: args.skipReason ?? null,
    },
  });
}

export async function listRecentTrades(userId: number, limit = 50) {
  const bot = await prisma.stablecoinArbBot.findUnique({ where: { userId } });
  if (!bot) return [];
  return prisma.stablecoinArbTrade.findMany({
    where: { botId: bot.id },
    orderBy: { detectedAt: 'desc' },
    take: limit,
  });
}

/**
 * 7일 이전 opportunity 레코드 삭제 (cron에서 호출 예정).
 * @returns 삭제된 row 개수
 */
export async function pruneOldOpportunities(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const result = await prisma.stablecoinArbOpportunity.deleteMany({
    where: { detectedAt: { lt: cutoff } },
  });
  return result.count;
}
