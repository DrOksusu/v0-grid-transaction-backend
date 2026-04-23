/**
 * 크로스-거래소 관찰 리포트
 *
 * 사용법:
 *   npx ts-node scripts/cross-exchange-observe.ts
 *
 * 출력:
 *   1. 에이전트 상태 (REST /api/agents/cross-exchange-observer)
 *   2. 스냅샷 총계 (전체 / 24시간 / 1시간)
 *   3. 마켓별 통계 (ub/bu 방향 스프레드 bp 분포)
 *   4. 상위 10개 기회 스냅샷
 *   5. 시간대별 스냅샷 수 (최근 24시간)
 *
 * 환경 변수:
 *   AGENT_STATUS_URL (기본: http://54.180.188.8:3010/api/agents/cross-exchange-observer)
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const AGENT_STATUS_URL = process.env.AGENT_STATUS_URL
  || 'http://54.180.188.8:3010/api/agents/cross-exchange-observer';

const SEP = '='.repeat(70);
function header(title: string): void {
  console.log(SEP);
  console.log(title);
  console.log(SEP);
}

async function showAgentStatus(): Promise<void> {
  header('🤖 CrossExchangeObserver 에이전트 상태');
  try {
    const res = await axios.get(AGENT_STATUS_URL, { timeout: 5000 });
    const data = res.data?.data;
    if (!data) {
      console.log('(응답 data 없음)');
      return;
    }
    console.log(`Status:     ${data.status}`);
    console.log(`StartedAt:  ${data.metrics?.startedAt ?? '(-)'}`);
    console.log(`Cycles:     ${data.metrics?.cycles ?? 0}`);
    console.log(`Errors:     ${data.metrics?.errors ?? 0}`);
    console.log(`LastError:  ${data.metrics?.lastError ?? '(없음)'}`);
    console.log(`LastCycle:  ${data.metrics?.lastCycleAt ?? '(-)'}`);
  } catch (err: any) {
    console.error(`❌ 상태 조회 실패: ${err.message}`);
  }
  console.log();
}

async function showCounts(prisma: PrismaClient): Promise<number> {
  header('📊 스냅샷 총계');
  const now = Date.now();
  const [total, last24h, last1h] = await Promise.all([
    prisma.crossExchangeSnapshot.count(),
    prisma.crossExchangeSnapshot.count({
      where: { timestamp: { gt: new Date(now - 24 * 3600 * 1000) } },
    }),
    prisma.crossExchangeSnapshot.count({
      where: { timestamp: { gt: new Date(now - 3600 * 1000) } },
    }),
  ]);
  console.log(`전체:        ${total.toLocaleString()} 건`);
  console.log(`최근 24시간: ${last24h.toLocaleString()} 건`);
  console.log(`최근 1시간:  ${last1h.toLocaleString()} 건`);
  console.log();
  return total;
}

async function showMarketStats(prisma: PrismaClient): Promise<void> {
  header('🔀 마켓별 스프레드 통계 (최근 24시간)');

  // 각 마켓에 대해 양방향 스프레드 분포 + 기회 건수 (> 20bp)
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT market,
            COUNT(*) as n,
            ROUND(AVG(ubSpreadBps)) as ub_avg_bp,
            MAX(ubSpreadBps) as ub_max_bp,
            SUM(CASE WHEN ubSpreadBps >= 20 THEN 1 ELSE 0 END) as ub_opps,
            ROUND(AVG(buSpreadBps)) as bu_avg_bp,
            MAX(buSpreadBps) as bu_max_bp,
            SUM(CASE WHEN buSpreadBps >= 20 THEN 1 ELSE 0 END) as bu_opps
     FROM cross_exchange_snapshots
     WHERE timestamp > DATE_SUB(NOW(), INTERVAL 1 DAY)
     GROUP BY market
     ORDER BY market`
  );
  if (rows.length === 0) {
    console.log('(최근 24시간 데이터 없음)');
  } else {
    console.table(rows.map(r => ({
      market: r.market,
      n: Number(r.n),
      'ub_avg(bp)': Number(r.ub_avg_bp),
      'ub_max(bp)': Number(r.ub_max_bp),
      'ub≥20 기회': Number(r.ub_opps),
      'bu_avg(bp)': Number(r.bu_avg_bp),
      'bu_max(bp)': Number(r.bu_max_bp),
      'bu≥20 기회': Number(r.bu_opps),
    })));
    console.log();
    console.log('범례:');
    console.log('  ub = Upbit bid → Bithumb ask (Upbit에서 팔고 Bithumb에서 사는 방향)');
    console.log('  bu = Bithumb bid → Upbit ask (Bithumb에서 팔고 Upbit에서 사는 방향)');
  }
  console.log();
}

async function showTopOpportunities(prisma: PrismaClient): Promise<void> {
  header('🏆 상위 10개 기회 스냅샷 (최근 24시간, maxSpreadBps 기준)');
  const rows = await prisma.crossExchangeSnapshot.findMany({
    where: {
      timestamp: { gt: new Date(Date.now() - 24 * 3600 * 1000) },
      maxSpreadBps: { gt: 0 },
    },
    orderBy: { maxSpreadBps: 'desc' },
    take: 10,
  });
  if (rows.length === 0) {
    console.log('(기회 없음 — maxSpreadBps > 0 인 스냅샷 없음)');
  } else {
    console.table(rows.map(r => {
      const dir = r.ubSpreadBps > r.buSpreadBps ? 'Upbit→Bithumb' : 'Bithumb→Upbit';
      return {
        시각: r.timestamp.toISOString(),
        market: r.market,
        upbit: `${r.upbitBid}/${r.upbitAsk}`,
        bithumb: `${r.bithumbBid}/${r.bithumbAsk}`,
        'max(bp)': r.maxSpreadBps,
        방향: dir,
      };
    }));
  }
  console.log();
}

async function showHourlyDistribution(prisma: PrismaClient): Promise<void> {
  header('⏰ 시간대별 스냅샷 수 (최근 24시간, UTC)');
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DATE_FORMAT(timestamp, '%Y-%m-%d %H:00') as hour,
            COUNT(*) as n,
            MAX(maxSpreadBps) as max_bp
     FROM cross_exchange_snapshots
     WHERE timestamp > DATE_SUB(NOW(), INTERVAL 1 DAY)
     GROUP BY hour
     ORDER BY hour DESC
     LIMIT 24`
  );
  if (rows.length === 0) {
    console.log('(데이터 없음)');
  } else {
    const sorted = [...rows].reverse();
    for (const r of sorted) {
      const n = Number(r.n);
      const maxBp = Number(r.max_bp);
      // 기대치: 10초 * 6/분 * 60분 = 360 샘플/시간 (5마켓 × 360 ≈ 1800 row/hr)
      const bar = '█'.repeat(Math.min(Math.floor(n / 50), 40));
      console.log(`${r.hour}  ${String(n).padStart(6)}  max=${String(maxBp).padStart(3)}bp  ${bar}`);
    }
  }
  console.log();
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await showAgentStatus();
    const total = await showCounts(prisma);
    if (total === 0) {
      console.log('ℹ️  아직 스냅샷이 없습니다. 배포 직후라면 수분 후 재실행.');
      return;
    }
    await showMarketStats(prisma);
    await showTopOpportunities(prisma);
    await showHourlyDistribution(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
