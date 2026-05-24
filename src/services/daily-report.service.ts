// 일일 수익 리포트 — 매일 오전 6시 KST 카카오 나에게 보내기
import prisma, { stablecoinPrisma } from '../config/database';
import { config } from '../config/env';
import { kakaoNotifyService } from './kakao-notify.service';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function getKstDayRange(now: Date): { start: Date; end: Date } {
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const dayStart = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate());
  const start = new Date(dayStart - KST_OFFSET_MS);
  const end = new Date(dayStart - KST_OFFSET_MS + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

function getKstMonthRange(now: Date): { start: Date; end: Date } {
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const monthStart = Date.UTC(y, m, 1);
  const lastDay = new Date(y, m + 1, 0).getDate();
  const monthEnd = Date.UTC(y, m, lastDay, 23, 59, 59, 999);
  return {
    start: new Date(monthStart - KST_OFFSET_MS),
    end: new Date(monthEnd - KST_OFFSET_MS),
  };
}

function fmtKrw(n: number): string {
  const abs = Math.abs(n).toLocaleString('ko-KR');
  return n >= 0 ? `+${abs}원` : `-${abs}원`;
}

export async function sendDailyReport(): Promise<void> {
  const now = new Date();
  const dayRange = getKstDayRange(now);
  const monthRange = getKstMonthRange(now);

  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const today = `${kstNow.getUTCFullYear()}-${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}-${String(kstNow.getUTCDate()).padStart(2, '0')}`;
  const month = today.substring(0, 7);

  // 관리자 유저 조회
  const adminUser = await prisma.user.findFirst({
    where: { email: config.adminEmail },
    select: { id: true },
  });
  if (!adminUser) {
    console.error('[DailyReport] 관리자 유저 없음, 리포트 스킵');
    return;
  }
  const userId = adminUser.id;

  // 그리드 봇 ID 목록 (soft delete 포함 — 이번 달/오늘 체결이 있을 수 있음)
  const botRows = await prisma.bot.findMany({ where: { userId }, select: { id: true } });
  const botIds = botRows.map(b => b.id);

  // 그리드 수익 집계
  const [gridDay, gridMonth] = await Promise.all([
    prisma.trade.aggregate({
      where: {
        botId: { in: botIds },
        type: 'sell', status: 'filled', profit: { not: null },
        filledAt: { gte: dayRange.start, lte: dayRange.end },
      },
      _sum: { profit: true },
      _count: { id: true },
    }),
    prisma.trade.aggregate({
      where: {
        botId: { in: botIds },
        type: 'sell', status: 'filled', profit: { not: null },
        filledAt: { gte: monthRange.start, lte: monthRange.end },
      },
      _sum: { profit: true },
      _count: { id: true },
    }),
  ]);

  // 스테이블코인 MakerTaker 봇 ID
  const makerBotRows = await stablecoinPrisma.makerTakerSimBot.findMany({
    where: { userId },
    select: { id: true },
  });
  const makerBotIds = makerBotRows.map(b => b.id);

  // CrossExchange 봇 ID
  const crossBotRows = await stablecoinPrisma.crossExchangeArbBot.findMany({
    where: { userId },
    select: { id: true },
  });
  const crossBotIds = crossBotRows.map(b => b.id);

  // 스테이블코인 수익 집계 (live=true 실거래만)
  const [makerDay, makerMonth, crossDay, crossMonth] = await Promise.all([
    makerBotIds.length > 0
      ? stablecoinPrisma.makerTakerSimTrade.aggregate({
          where: {
            botId: { in: makerBotIds },
            live: true, status: 'FILLED',
            createdAt: { gte: dayRange.start, lte: dayRange.end },
          },
          _sum: { netProfitKrw: true },
          _count: { id: true },
        })
      : Promise.resolve({ _sum: { netProfitKrw: null }, _count: { id: 0 } }),
    makerBotIds.length > 0
      ? stablecoinPrisma.makerTakerSimTrade.aggregate({
          where: {
            botId: { in: makerBotIds },
            live: true, status: 'FILLED',
            createdAt: { gte: monthRange.start, lte: monthRange.end },
          },
          _sum: { netProfitKrw: true },
          _count: { id: true },
        })
      : Promise.resolve({ _sum: { netProfitKrw: null }, _count: { id: 0 } }),
    crossBotIds.length > 0
      ? stablecoinPrisma.crossExchangeArbTrade.aggregate({
          where: {
            botId: { in: crossBotIds },
            status: 'FILLED',
            createdAt: { gte: dayRange.start, lte: dayRange.end },
          },
          _sum: { profitKrw: true },
          _count: { id: true },
        })
      : Promise.resolve({ _sum: { profitKrw: null }, _count: { id: 0 } }),
    crossBotIds.length > 0
      ? stablecoinPrisma.crossExchangeArbTrade.aggregate({
          where: {
            botId: { in: crossBotIds },
            status: 'FILLED',
            createdAt: { gte: monthRange.start, lte: monthRange.end },
          },
          _sum: { profitKrw: true },
          _count: { id: true },
        })
      : Promise.resolve({ _sum: { profitKrw: null }, _count: { id: 0 } }),
  ]);

  const gridDayProfit = Math.round(gridDay._sum.profit ?? 0);
  const gridMonthProfit = Math.round(gridMonth._sum.profit ?? 0);
  const gridDayCount = gridDay._count.id ?? 0;
  const gridMonthCount = gridMonth._count.id ?? 0;

  const stabDayProfit = Math.round(
    Number(makerDay._sum.netProfitKrw ?? 0) + Number(crossDay._sum.profitKrw ?? 0),
  );
  const stabMonthProfit = Math.round(
    Number(makerMonth._sum.netProfitKrw ?? 0) + Number(crossMonth._sum.profitKrw ?? 0),
  );
  const stabDayCount = (makerDay._count.id ?? 0) + (crossDay._count.id ?? 0);
  const stabMonthCount = (makerMonth._count.id ?? 0) + (crossMonth._count.id ?? 0);

  const totalDayProfit = gridDayProfit + stabDayProfit;
  const totalMonthProfit = gridMonthProfit + stabMonthProfit;

  const lines = [
    `📊 ${today} 일일 수익 현황`,
    '',
    `📈 그리드매매`,
    `  • 오늘: ${fmtKrw(gridDayProfit)} (${gridDayCount}건)`,
    `  • ${month}: ${fmtKrw(gridMonthProfit)} (${gridMonthCount}건)`,
    '',
    `💱 스테이블코인 차익거래`,
    `  • 오늘: ${fmtKrw(stabDayProfit)} (${stabDayCount}건)`,
    `  • ${month}: ${fmtKrw(stabMonthProfit)} (${stabMonthCount}건)`,
    '',
    `💰 전체 합산`,
    `  • 오늘: ${fmtKrw(totalDayProfit)}`,
    `  • ${month}: ${fmtKrw(totalMonthProfit)}`,
  ];

  await kakaoNotifyService.sendToMe(lines.join('\n'));
  console.log(`[DailyReport] 일일 수익 리포트 발송 완료 (${today})`);
}
