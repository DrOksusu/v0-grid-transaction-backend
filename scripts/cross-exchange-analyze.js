// Stage 3 brainstorming용 — Cross-exchange snapshot 분석
// 최근 5일치 통계: 코인별, 양방향별, 임계값별 발생 빈도
const prisma = require('/app/dist/config/database').default;

const THRESHOLDS = [10, 20, 30, 40, 50, 75, 100]; // bps

(async () => {
  // 1) Overview
  const overviewRaw = await prisma.$queryRawUnsafe(
    "SELECT COUNT(*) AS total, MIN(timestamp) AS firstAt, MAX(timestamp) AS lastAt FROM cross_exchange_snapshots"
  );
  const ov = overviewRaw[0];
  const total = Number(ov.total);
  console.log("=== Overview ===");
  console.log("total rows:", total);
  console.log("from:", ov.firstAt);
  console.log("to:  ", ov.lastAt);

  // 2) Per-coin counts
  console.log("\n=== Per-coin counts ===");
  const perCoinRaw = await prisma.$queryRawUnsafe(
    "SELECT market, COUNT(*) AS n FROM cross_exchange_snapshots GROUP BY market ORDER BY market"
  );
  perCoinRaw.forEach(r => console.log(`  ${r.market}: ${Number(r.n)}`));

  // 3) Per-coin spread stats (avg / p50 / p95 / max for ub_spread, bu_spread)
  console.log("\n=== Per-coin spread bps stats ===");
  const stats = await prisma.$queryRawUnsafe(`
    SELECT market,
      ROUND(AVG(ubSpreadBps), 1) AS avg_ub,
      MAX(ubSpreadBps) AS max_ub,
      ROUND(AVG(buSpreadBps), 1) AS avg_bu,
      MAX(buSpreadBps) AS max_bu,
      ROUND(AVG(maxSpreadBps), 1) AS avg_max,
      MAX(maxSpreadBps) AS max_overall
    FROM cross_exchange_snapshots
    GROUP BY market
    ORDER BY market
  `);
  stats.forEach(r => {
    console.log(
      `  ${r.market}: avg_ub=${r.avg_ub} max_ub=${r.max_ub} | avg_bu=${r.avg_bu} max_bu=${r.max_bu} | avg_max=${r.avg_max} max_overall=${r.max_overall}`
    );
  });

  // 4) Threshold breach rates per coin per direction
  console.log("\n=== Threshold breach rates (% of rows where spread >= threshold) ===");
  for (const thr of THRESHOLDS) {
    console.log(`\n--- spread >= ${thr} bps ---`);
    const breach = await prisma.$queryRawUnsafe(`
      SELECT market,
        SUM(CASE WHEN ubSpreadBps >= ${thr} THEN 1 ELSE 0 END) AS ub_count,
        SUM(CASE WHEN buSpreadBps >= ${thr} THEN 1 ELSE 0 END) AS bu_count,
        COUNT(*) AS n
      FROM cross_exchange_snapshots
      GROUP BY market
      ORDER BY market
    `);
    breach.forEach(r => {
      const ub = Number(r.ub_count);
      const bu = Number(r.bu_count);
      const n = Number(r.n);
      const ubPct = ((ub / n) * 100).toFixed(2);
      const buPct = ((bu / n) * 100).toFixed(2);
      console.log(`  ${r.market}: UB ${ub}/${n} (${ubPct}%), BU ${bu}/${n} (${buPct}%)`);
    });
  }

  // 5) Total events per coin at 30 bps threshold (assuming this is rough fee+margin)
  console.log("\n=== Trade opportunity events at 30 bps (fee 9bps + 21bps margin) ===");
  const oppEvents = await prisma.$queryRawUnsafe(`
    SELECT market,
      SUM(CASE WHEN ubSpreadBps >= 30 OR buSpreadBps >= 30 THEN 1 ELSE 0 END) AS opp_count,
      SUM(CASE WHEN ubSpreadBps >= 30 THEN 1 ELSE 0 END) AS ub_opp,
      SUM(CASE WHEN buSpreadBps >= 30 THEN 1 ELSE 0 END) AS bu_opp,
      COUNT(*) AS n
    FROM cross_exchange_snapshots
    GROUP BY market
    ORDER BY opp_count DESC
  `);
  oppEvents.forEach(r => {
    const opp = Number(r.opp_count);
    const ub = Number(r.ub_opp);
    const bu = Number(r.bu_opp);
    const n = Number(r.n);
    const oppPct = ((opp / n) * 100).toFixed(2);
    const days = (Number(ov.total > 0 ? (new Date(ov.lastAt) - new Date(ov.firstAt)) / 86400000 : 1)).toFixed(1);
    const eventsPerDay = (opp / parseFloat(days)).toFixed(0);
    console.log(`  ${r.market}: ${opp} events / ${n} rows (${oppPct}%, ~${eventsPerDay}/day) — UB:${ub} BU:${bu}`);
  });

  console.log("\nNote: \"events\" counts each 10-second snapshot where spread >= threshold. Actual distinct opportunities may cluster.");

})().catch(e => {
  console.error("ERR:", e.message);
  console.error(e.stack);
  process.exit(1);
}).finally(() => prisma.$disconnect());
