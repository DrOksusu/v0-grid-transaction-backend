// canary stage 2 — T_start 확정 + 첫 PENDING 검증 (read-only)
// 동작:
//   1. 봇 #1 SELECT (enabled/live/updatedAt)
//   2. 현재 UTC 시각 출력
//   3. 가장 최근 maker_taker_sim_trades row 5건 (botId=1, live=true 우선)
//   4. T_start 권장값 출력

const path = require('path');

(async () => {
  let stablecoinPrisma;
  try {
    stablecoinPrisma = require('/app/dist/config/database').stablecoinPrisma;
  } catch {
    stablecoinPrisma = require(path.resolve(__dirname, '..', 'dist', 'config', 'database')).stablecoinPrisma;
  }

  try {
    const bot = await stablecoinPrisma.makerTakerSimBot.findUnique({
      where: { id: 1 },
      select: {
        id: true, enabled: true, live: true, killSwitch: true,
        minTakerBalance: true, updatedAt: true,
      },
    });
    console.log('=== 봇 #1 ===');
    console.log(JSON.stringify(bot, null, 2));

    const now = new Date();
    console.log(`\n현재 UTC : ${now.toISOString()}`);
    console.log(`bot updatedAt: ${bot.updatedAt.toISOString()}`);
    const diffSec = Math.round((now - bot.updatedAt) / 1000);
    console.log(`(updatedAt부터 ${diffSec}초 경과)`);

    // 최근 trade rows
    const rows = await stablecoinPrisma.makerTakerSimTrade.findMany({
      where: { botId: 1 },
      orderBy: { id: 'desc' },
      take: 10,
      select: {
        id: true, status: true, live: true, makerOrderUuid: true,
        makerOrderPrice: true, createdAt: true,
      },
    });

    console.log('\n=== 봇 #1 최근 거래 10건 (live 컬럼 주목) ===');
    rows.forEach((r) => {
      const flag = r.live ? '🟢 LIVE' : 'sim';
      console.log(
        `id=${r.id.toString().padStart(4)} ${flag.padEnd(8)} status=${r.status.padEnd(11)} ` +
        `uuid=${r.makerOrderUuid ?? '-'} price=${r.makerOrderPrice} createdAt=${r.createdAt.toISOString()}`
      );
    });

    // T_start 권장
    console.log('\n=== T_start 권장 ===');
    if (bot.enabled) {
      console.log(`T_start = ${bot.updatedAt.toISOString()}  ← 봇 #1 enabled=true가 적용된 시점`);
      console.log('이 값을 메모해두세요. T+1h, T+4h, T+24h 모니터 실행 시 사용.');
    } else {
      console.log(`⚠️  봇 #1 enabled=${bot.enabled}. Resume 클릭이 적용되지 않았거나 자동 정지된 상태.`);
      console.log('   → live는 ON이지만 평가 안 됨. UI 새로고침 후 Resume 다시 시도.');
    }

    const livePending = rows.find((r) => r.live && r.status === 'PENDING');
    if (livePending) {
      console.log(`\n✅ live PENDING 첫 row 확인: id=${livePending.id}, uuid=${livePending.makerOrderUuid}`);
    } else {
      console.log('\n⏳ 아직 live PENDING row 없음. 30분 이내 자동 생성 예상.');
    }
  } finally {
    await stablecoinPrisma.$disconnect();
  }
})().catch((e) => { console.error(e); process.exit(1); });
