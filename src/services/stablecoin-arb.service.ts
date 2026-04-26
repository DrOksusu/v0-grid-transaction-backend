import { stablecoinPrisma as prisma } from '../config/database';
import { Prisma } from '.prisma/client-stablecoin';

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

/**
 * 기회 카운트 집계 — 대시보드 위젯 ③
 */
export interface OpportunityStats {
  total: number;
  last24h: number;
  last1h: number;
  ge20bpLast24h: number;
}

export async function getOpportunityStats(): Promise<OpportunityStats> {
  const now = Date.now();
  const t24h = new Date(now - 24 * 3600 * 1000);
  const t1h = new Date(now - 3600 * 1000);

  const [total, last24h, last1h, ge20bpLast24h] = await Promise.all([
    prisma.stablecoinArbOpportunity.count(),
    prisma.stablecoinArbOpportunity.count({ where: { detectedAt: { gt: t24h } } }),
    prisma.stablecoinArbOpportunity.count({ where: { detectedAt: { gt: t1h } } }),
    prisma.stablecoinArbOpportunity.count({
      where: { detectedAt: { gt: t24h }, spreadBps: { gte: 20 } },
    }),
  ]);

  return { total, last24h, last1h, ge20bpLast24h };
}

/**
 * 최근 기회 N건 — 대시보드 위젯 ④
 *
 * limit이 NaN/음수/소수/100 초과인 경우:
 *   - NaN/Infinity → default 20으로 폴백
 *   - 음수 또는 0 → 1로 클램프
 *   - 100 초과 → 100으로 클램프
 *   - 소수 → Math.floor 적용
 */
export async function listRecentOpportunities(limit = 20) {
  const n = Number.isFinite(limit) ? Math.floor(limit) : 20;
  const safeLimit = Math.min(Math.max(n, 1), 100);
  return prisma.stablecoinArbOpportunity.findMany({
    orderBy: { detectedAt: 'desc' },
    take: safeLimit,
  });
}

/**
 * Maker-Taker 시뮬레이터 종합 — 대시보드 위젯 ⑤
 */
export interface SimOverview {
  bots: any[];           // Prisma model 타입 — 컨트롤러에서 직렬화 시 Decimal/Date 처리
  stats: {
    pending: number;
    filled: number;
    expired: number;
    cancelled: number;
    totalNetProfitKrw: string;
  };
  recentTrades: any[];   // Prisma model 타입
}

export async function getSimOverview(): Promise<SimOverview> {
  const [bots, statusGroups, profitAgg, recentTrades] = await Promise.all([
    prisma.makerTakerSimBot.findMany({ orderBy: { id: 'asc' } }),
    prisma.makerTakerSimTrade.groupBy({
      by: ['status'],
      _count: { id: true },
    }),
    prisma.makerTakerSimTrade.aggregate({
      _sum: { netProfitKrw: true },
    }),
    prisma.makerTakerSimTrade.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const statusMap = Object.fromEntries(
    statusGroups.map((g: any) => [g.status, g._count.id])
  );
  const stats = {
    pending: statusMap.PENDING ?? 0,
    filled: statusMap.FILLED ?? 0,
    expired: statusMap.EXPIRED ?? 0,
    cancelled: statusMap.CANCELLED ?? 0,
    totalNetProfitKrw: profitAgg._sum.netProfitKrw?.toString() ?? '0',
  };

  return { bots, stats, recentTrades };
}

/**
 * 오늘 KST 0시 이후 봇 거래 통계 — preCheck.runAll에 전달
 *
 * @returns todayTradeCount: 모든 status 거래 (COMPLETED/FAILED/FALLBACK_DONE 등)
 * @returns todayNetProfitKrw: krwFlowNetKrw 합 (자산 변환 무시한 보수적 net)
 */
export async function getTodayStats(botId: number): Promise<{
  todayTradeCount: number;
  todayNetProfitKrw: number;
}> {
  // KST 자정 = UTC 15:00 전날
  const now = new Date();
  const kstMidnight = new Date(now);
  kstMidnight.setUTCHours(15, 0, 0, 0);
  if (kstMidnight > now) {
    kstMidnight.setUTCDate(kstMidnight.getUTCDate() - 1);
  }

  const trades = await prisma.stablecoinArbTrade.findMany({
    where: { botId, detectedAt: { gte: kstMidnight } },
    select: { krwFlowNetKrw: true },
  });

  const todayTradeCount = trades.length;
  const todayNetProfitKrw = trades.reduce(
    (s, t) => s + (t.krwFlowNetKrw ? Number(t.krwFlowNetKrw) : 0),
    0,
  );

  return { todayTradeCount, todayNetProfitKrw };
}

/**
 * StablecoinArbBot.live 토글 (Admin 전용).
 * live=true 전환은 controller에서 confirm body 검증 필수.
 */
export async function setLive(userId: number, live: boolean) {
  return updateBotConfig(userId, { live });
}

/**
 * Canary Stage 1/2/3 일괄 적용 (Admin 전용).
 * Stage 1: 1만원/일3건/손실 1만원
 * Stage 2: 2만원/일10건/손실 3만원
 * Stage 3: 5만원/일30건/손실 5만원
 */
export type CanaryStage = 1 | 2 | 3;

const STAGE_VALUES: Record<CanaryStage, {
  tradeSizeKrw: number;
  maxDailyTrades: number;
  dailyLossLimitKrw: number;
}> = {
  1: { tradeSizeKrw: 10000, maxDailyTrades: 3, dailyLossLimitKrw: 10000 },
  2: { tradeSizeKrw: 20000, maxDailyTrades: 10, dailyLossLimitKrw: 30000 },
  3: { tradeSizeKrw: 50000, maxDailyTrades: 30, dailyLossLimitKrw: 50000 },
};

export async function setStage(userId: number, stage: CanaryStage) {
  return updateBotConfig(userId, STAGE_VALUES[stage]);
}
