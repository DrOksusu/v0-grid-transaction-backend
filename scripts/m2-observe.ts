/**
 * M2 관찰 스크립트
 *
 * 사용법:
 *   npx ts-node scripts/m2-observe.ts
 *
 * 출력:
 *   1. 에이전트 기동 상태 (REST /api/agents/stablecoin-arb)
 *   2. 봇 설정 (DB)
 *   3. Opportunity 총계 (전체 / 24시간 / 1시간)
 *   4. 쌍별 통계 (최근 24시간)
 *   5. 시간대별 분포 (최근 24시간)
 *   6. 최근 5건 샘플
 *
 * 환경 변수:
 *   AGENT_STATUS_URL (선택, 기본: http://54.180.188.8:3010/api/agents/stablecoin-arb)
 *   ADMIN_USER_ID    (선택, 기본: 2)
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const AGENT_STATUS_URL = process.env.AGENT_STATUS_URL
  || 'http://54.180.188.8:3010/api/agents/stablecoin-arb';
const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID || '2', 10);

const SEP = '='.repeat(70);

function header(title: string): void {
  console.log(SEP);
  console.log(title);
  console.log(SEP);
}

async function showAgentStatus(): Promise<void> {
  header('🤖 에이전트 상태');
  try {
    const res = await axios.get(AGENT_STATUS_URL, { timeout: 5000 });
    const data = res.data?.data;
    if (!data) {
      console.log('(응답 data 없음)', JSON.stringify(res.data));
      return;
    }
    console.log(`ID:         ${data.id}`);
    console.log(`Status:     ${data.status}`);
    console.log(`StartedAt:  ${data.metrics?.startedAt ?? '(-)'}`);
    console.log(`StoppedAt:  ${data.metrics?.stoppedAt ?? '(가동 중)'}`);
    console.log(`Errors:     ${data.metrics?.errors ?? 0}`);
    console.log(`LastError:  ${data.metrics?.lastError ?? '(없음)'}`);
  } catch (err: any) {
    console.error(`❌ 에이전트 상태 조회 실패: ${err.message}`);
    console.error(`   URL: ${AGENT_STATUS_URL}`);
  }
  console.log();
}

async function showBotConfig(prisma: PrismaClient): Promise<void> {
  header(`⚙️  봇 설정 (userId=${ADMIN_USER_ID})`);
  const bot = await prisma.stablecoinArbBot.findUnique({
    where: { userId: ADMIN_USER_ID },
  });
  if (!bot) {
    console.log('(봇 레코드 없음)');
    console.log();
    return;
  }
  console.log(`Enabled:         ${bot.enabled}`);
  console.log(`KillSwitch:      ${bot.killSwitch}`);
  console.log(`CoinsEnabled:    ${JSON.stringify(bot.coinsEnabled)}`);
  console.log(`EntryThreshold:  ${bot.entryThresholdBps} bp`);
  console.log(`TradeSize:       ${bot.tradeSizeKrw.toLocaleString()} KRW`);
  console.log(`MaxDailyTrades:  ${bot.maxDailyTrades}`);
  console.log(`TotalTrades:     ${bot.totalTrades}`);
  console.log(`TotalProfitUsd:  ${bot.totalProfitUsd}`);
  console.log(`LastExecutedAt:  ${bot.lastExecutedAt?.toISOString() ?? '(없음)'}`);
  console.log();
}

async function showCounts(prisma: PrismaClient): Promise<number> {
  header('📊 Opportunity 총계');
  const now = Date.now();
  const [total, last24h, last1h] = await Promise.all([
    prisma.stablecoinArbOpportunity.count(),
    prisma.stablecoinArbOpportunity.count({
      where: { detectedAt: { gt: new Date(now - 24 * 3600 * 1000) } },
    }),
    prisma.stablecoinArbOpportunity.count({
      where: { detectedAt: { gt: new Date(now - 3600 * 1000) } },
    }),
  ]);
  console.log(`전체:        ${total.toLocaleString()} 건`);
  console.log(`최근 24시간: ${last24h.toLocaleString()} 건`);
  console.log(`최근 1시간:  ${last1h.toLocaleString()} 건`);
  console.log();
  return total;
}

async function showPairStats(prisma: PrismaClient): Promise<void> {
  header('🔀 쌍별 통계 (최근 24시간)');
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT soldCoin, boughtCoin, COUNT(*) as n,
            MIN(spreadBps) as min_bp,
            ROUND(AVG(spreadBps)) as avg_bp,
            MAX(spreadBps) as max_bp
     FROM stablecoin_arb_opportunities
     WHERE detectedAt > DATE_SUB(NOW(), INTERVAL 1 DAY)
     GROUP BY soldCoin, boughtCoin
     ORDER BY n DESC
     LIMIT 30`
  );
  if (rows.length === 0) {
    console.log('(최근 24시간 기회 없음)');
  } else {
    console.table(rows.map(r => ({
      쌍: `${r.soldCoin}→${r.boughtCoin}`,
      건수: Number(r.n),
      min_bp: Number(r.min_bp),
      avg_bp: Number(r.avg_bp),
      max_bp: Number(r.max_bp),
    })));
  }
  console.log();
}

async function showHourlyDistribution(prisma: PrismaClient): Promise<void> {
  header('⏰ 시간대별 분포 (최근 24시간, UTC)');
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DATE_FORMAT(detectedAt, '%Y-%m-%d %H:00') as hour, COUNT(*) as n
     FROM stablecoin_arb_opportunities
     WHERE detectedAt > DATE_SUB(NOW(), INTERVAL 1 DAY)
     GROUP BY hour
     ORDER BY hour DESC
     LIMIT 24`
  );
  if (rows.length === 0) {
    console.log('(데이터 없음)');
  } else {
    // 역순으로 정렬해서 오래된 시간부터 위에 표시 (시계열 읽기 편하게)
    const sorted = [...rows].reverse();
    for (const r of sorted) {
      const n = Number(r.n);
      const bar = '█'.repeat(Math.min(n, 60));
      console.log(`${r.hour}  ${String(n).padStart(6)}  ${bar}`);
    }
  }
  console.log();
}

async function showRecentSamples(prisma: PrismaClient): Promise<void> {
  header('🔎 최근 Opportunity 5건');
  const rows = await prisma.stablecoinArbOpportunity.findMany({
    orderBy: { detectedAt: 'desc' },
    take: 5,
    select: {
      detectedAt: true,
      soldCoin: true,
      boughtCoin: true,
      bidSoldKrw: true,
      askBoughtKrw: true,
      spreadBps: true,
      executed: true,
      skipReason: true,
    },
  });
  if (rows.length === 0) {
    console.log('(없음)');
  } else {
    console.table(rows.map(r => ({
      시각: r.detectedAt.toISOString(),
      쌍: `${r.soldCoin}→${r.boughtCoin}`,
      bid: Number(r.bidSoldKrw),
      ask: Number(r.askBoughtKrw),
      bp: r.spreadBps,
      실행: r.executed,
      스킵사유: r.skipReason ?? '',
    })));
  }
  console.log();
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await showAgentStatus();
    await showBotConfig(prisma);
    const total = await showCounts(prisma);

    if (total === 0) {
      console.log('ℹ️  아직 감지된 기회가 없습니다.');
      console.log('    현재 USDT/USDC/USD1이 모두 동가(7bp)로 움직이면 기회가 드뭅니다.');
      console.log('    수시간~1일 대기 후 재실행 권장.');
      return;
    }

    await showPairStats(prisma);
    await showHourlyDistribution(prisma);
    await showRecentSamples(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
