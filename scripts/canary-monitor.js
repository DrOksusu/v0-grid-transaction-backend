// PR G — Canary Stage 2 모니터링 스크립트
//
// 사용:
//   docker exec grid-bot node /tmp/canary-monitor.js [T_START_ISO]
//   T_START_ISO 미지정 시 24h 전 시점 사용.
//
// 출력:
//   - G1: SUM(netProfitKrw) FILLED
//   - G2: COUNT(PARTIAL_HOLD)
//   - G3: MTM (현재 USDS bid 기반)
//   - G4: T+4h 시점 fast-fail 상태
//   - 각 게이트 ABORT 여부 강조 (stderr)
//
// 임계값:
const ABORT_NET_KRW = -200;       // G1
const ABORT_PARTIAL_COUNT = 2;    // G2 (>= 2 abort)
const ABORT_MTM_KRW = -500;       // G3 (<= -500 abort)
const FAST_FAIL_HOURS = 4;        // G4

const path = require('path');
const https = require('https');

(async () => {
  let prismaModule;
  try {
    prismaModule = require('/app/dist/config/database');
  } catch {
    prismaModule = require(path.resolve(__dirname, '..', 'dist', 'config', 'database'));
  }
  const { stablecoinPrisma } = prismaModule;

  // T_start 파싱
  const arg = process.argv[2];
  let tStart;
  if (arg) {
    tStart = new Date(arg);
    if (Number.isNaN(tStart.getTime())) {
      console.error(`Invalid T_START_ISO: ${arg}`);
      process.exit(1);
    }
  } else {
    tStart = new Date(Date.now() - 24 * 3600 * 1000);
    console.log(`(T_START 미지정 — 24h 전부터: ${tStart.toISOString()})`);
  }
  const elapsedMs = Date.now() - tStart.getTime();
  const elapsedH = elapsedMs / 3600 / 1000;

  const BOT_ID = 1;
  const where = { botId: BOT_ID, live: true, createdAt: { gte: tStart } };

  // G1
  const filled = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: { ...where, status: 'FILLED' },
    select: { netProfitKrw: true },
  });
  const sumNet = filled.reduce((s, t) => s + Number(t.netProfitKrw || 0), 0);

  // G2
  const partials = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: { ...where, status: 'PARTIAL_HOLD' },
    select: { id: true, makerOrderPrice: true, quantity: true, makerOrderUuid: true },
  });
  const partialCount = partials.length;

  // G3 MTM
  let mtm = 0;
  let currentBid = null;
  let mtmError = null;
  if (partialCount > 0) {
    try {
      currentBid = await fetchUsdsBid();
      const heldUsds = partials.reduce((s, t) => s + Number(t.quantity), 0);
      const partialBuyKrw = partials.reduce(
        (s, t) => s + Number(t.makerOrderPrice) * Number(t.quantity),
        0
      );
      mtm = currentBid * heldUsds - partialBuyKrw;
    } catch (e) {
      mtmError = e.message || String(e);
    }
  }

  // 출력
  console.log('=== CANARY MONITOR ===');
  console.log(`T_start: ${tStart.toISOString()}`);
  console.log(`elapsed: ${elapsedH.toFixed(2)}h`);
  console.log(`bot: #${BOT_ID} (live=true)`);
  console.log('');
  console.log(`G1 FILLED count=${filled.length} sumNet=${sumNet.toFixed(2)} KRW (abort if <= ${ABORT_NET_KRW})`);
  console.log(`G2 PARTIAL_HOLD count=${partialCount} (abort if >= ${ABORT_PARTIAL_COUNT})`);
  if (partialCount > 0) {
    if (mtmError) {
      console.log(`G3 MTM=N/A (Upbit fetch failed: ${mtmError}) — abort 판단 보류`);
    } else {
      console.log(`G3 MTM=${mtm.toFixed(2)} KRW (currentUsdsBid=${currentBid}, abort if <= ${ABORT_MTM_KRW})`);
    }
    for (const t of partials) {
      console.log(`   - id=${t.id} bought=${t.makerOrderPrice}x${t.quantity}=${Number(t.makerOrderPrice)*Number(t.quantity)} KRW uuid=${t.makerOrderUuid}`);
    }
  } else {
    console.log(`G3 MTM=N/A (PARTIAL_HOLD 0건)`);
  }
  console.log(`G4 fast-fail: elapsed=${elapsedH.toFixed(2)}h, FILLED+PARTIAL=${filled.length+partialCount} (wind-down 검토 if elapsed>=${FAST_FAIL_HOURS}h && both 0)`);

  // ABORT 신호
  const abortSignals = [];
  if (sumNet <= ABORT_NET_KRW) abortSignals.push(`G1 sumNet=${sumNet.toFixed(2)}`);
  if (partialCount >= ABORT_PARTIAL_COUNT) abortSignals.push(`G2 partialCount=${partialCount}`);
  if (partialCount > 0 && !mtmError && mtm <= ABORT_MTM_KRW) abortSignals.push(`G3 MTM=${mtm.toFixed(2)}`);

  console.log('');
  if (abortSignals.length > 0) {
    console.error(`!!! ABORT TRIGGERED !!!`);
    for (const s of abortSignals) console.error(`  - ${s}`);
    console.error('');
    console.error('즉시 봇 #1 enabled=false + live=false 처리 권장.');
    await stablecoinPrisma.$disconnect();
    process.exit(2);
  }
  if (elapsedH >= FAST_FAIL_HOURS && filled.length === 0 && partialCount === 0) {
    console.warn('--- FAST-FAIL CANDIDATE ---');
    console.warn(`T+${elapsedH.toFixed(2)}h, FILLED 0건 + PARTIAL_HOLD 0건. 가동 종료 검토.`);
  } else {
    console.log('OK — abort 임계값 미충족.');
  }

  await stablecoinPrisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });

function fetchUsdsBid() {
  return new Promise((resolve, reject) => {
    https.get('https://api.upbit.com/v1/orderbook?markets=KRW-USDS', (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const bid = json[0]?.orderbook_units?.[0]?.bid_price;
          if (typeof bid !== 'number') return reject(new Error('no bid in response'));
          resolve(bid);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}
