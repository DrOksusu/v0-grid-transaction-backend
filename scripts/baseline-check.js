// Baseline 점검 — canary stage 2 시작 전 운영 상태 스냅샷
const { stablecoinPrisma } = require('/app/dist/config/database');
const r = (k, v) => typeof v === 'bigint' ? v.toString() : v;

(async () => {
  const bots = await stablecoinPrisma.makerTakerSimBot.findMany({
    select: { id: true, makerCoin: true, takerCoin: true, enabled: true, live: true, killSwitch: true, minTakerBalance: true, quantity: true },
    orderBy: { id: 'asc' },
  });
  console.log('=== BOTS ===');
  console.log(JSON.stringify(bots, r, 2));

  const since24 = new Date(Date.now() - 24 * 3600 * 1000);
  const recentTrades = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: { createdAt: { gte: since24 } },
    select: { id: true, botId: true, live: true, status: true, createdAt: true },
    orderBy: { id: 'desc' },
    take: 10,
  });
  console.log('\n=== RECENT 24h TRADES (top 10) ===');
  console.log(JSON.stringify(recentTrades, r, 2));

  const counts = await stablecoinPrisma.makerTakerSimTrade.groupBy({
    by: ['status', 'botId', 'live'],
    where: { createdAt: { gte: since24 } },
    _count: true,
  });
  console.log('\n=== 24h COUNTS ===');
  console.log(JSON.stringify(counts, r, 2));

  await stablecoinPrisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
