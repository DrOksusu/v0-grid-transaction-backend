// PR G — Canary Stage 2 사전조건: 봇 #1 owner의 Upbit 잔고 조회 (read-only)
//
// 사용:
//   호스트에서 (.env에 STABLECOIN_DATABASE_URL/DATABASE_URL 세팅 후):
//     node scripts/check-upbit-balance.js
//   컨테이너 내부:
//     docker cp scripts/check-upbit-balance.js grid-bot:/tmp/
//     docker exec grid-bot node /tmp/check-upbit-balance.js
//
// 동작 (read-only):
//   1. stablecoinPrisma → 봇 #1의 userId/quantity/minTakerBalance 조회
//   2. mainPrisma → 해당 user의 Upbit credential (encrypted) 조회
//   3. decrypt → UpbitService.getAccounts() 호출
//   4. canary 관련 코인만 필터링 (USDT/KRW/USDS/USD1) → 잔고 출력
//   5. USDT 총 잔고로 canary 게이트 판단 (11 미만 / 11-20 / 21+)
//
// 안전:
//   - 어떤 write도 하지 않음 (read-only)
//   - 비밀키는 출력하지 않음 (decrypt 후 메모리에서만 사용)

const path = require('path');

(async () => {
  // 1. 모듈 로드 (컨테이너/호스트 모두 지원)
  let mainPrisma, stablecoinPrisma, decrypt, UpbitService;
  try {
    const dbMod = require('/app/dist/config/database');
    mainPrisma = dbMod.default;
    stablecoinPrisma = dbMod.stablecoinPrisma;
    decrypt = require('/app/dist/utils/encryption').decrypt;
    UpbitService = require('/app/dist/services/upbit.service').UpbitService;
  } catch {
    const dbMod = require(path.resolve(__dirname, '..', 'dist', 'config', 'database'));
    mainPrisma = dbMod.default;
    stablecoinPrisma = dbMod.stablecoinPrisma;
    decrypt = require(path.resolve(__dirname, '..', 'dist', 'utils', 'encryption')).decrypt;
    UpbitService = require(path.resolve(__dirname, '..', 'dist', 'services', 'upbit.service')).UpbitService;
  }

  const TARGET_BOT_ID = 1;

  try {
    // 2. 봇 #1 → userId 조회
    const bot = await stablecoinPrisma.makerTakerSimBot.findUnique({
      where: { id: TARGET_BOT_ID },
      select: {
        id: true,
        userId: true,
        makerCoin: true,
        takerCoin: true,
        quantity: true,
        minTakerBalance: true,
        enabled: true,
        live: true,
        killSwitch: true,
      },
    });
    if (!bot) {
      console.error(`[ERROR] bot id=${TARGET_BOT_ID} not found in maker_taker_sim_bots`);
      process.exit(1);
    }
    console.log('=== 봇 #1 현재 상태 ===');
    console.log(JSON.stringify({ ...bot, quantity: bot.quantity.toString() }, null, 2));

    // 3. user의 Upbit credential 조회 (grid_transaction.credentials)
    const cred = await mainPrisma.credential.findFirst({
      where: { userId: bot.userId, exchange: 'upbit' },
    });
    if (!cred) {
      console.error(`[ERROR] Upbit credential not found for userId=${bot.userId}`);
      process.exit(1);
    }

    const accessKey = decrypt(cred.apiKey);
    const secretKey = decrypt(cred.secretKey);
    const upbit = new UpbitService({ accessKey, secretKey });

    // 4. Upbit 계좌 조회
    const accounts = await upbit.getAccounts();

    // canary 관련 코인만 필터링
    const TARGETS = new Set(['USDT', 'KRW', 'USDS', 'USD1']);
    const filtered = accounts
      .filter((a) => TARGETS.has(a.currency))
      .map((a) => ({
        currency: a.currency,
        balance: a.balance,
        locked: a.locked,
        total: (Number(a.balance) + Number(a.locked)).toString(),
        avg_buy_price: a.avg_buy_price,
      }));

    console.log('\n=== Upbit 잔고 (canary 관련 코인) ===');
    if (filtered.length === 0) {
      console.log('(해당 코인 잔고 없음)');
    } else {
      console.table(filtered);
    }

    // 5. canary 게이트 판단
    // 가드 코드(maker-taker-min-balance-guard.ts + upbit-balance-cache.ts)는
    // free balance(row.balance)만 비교하고 locked는 제외한다. 다른 봇 주문에
    // 묶인 USDT는 봇 #1 leg-2에 사용 불가하므로 게이트도 free 기준으로 본다.
    const usdt = filtered.find((a) => a.currency === 'USDT');
    const usdtFree = usdt ? Number(usdt.balance) : 0;
    const usdtLocked = usdt ? Number(usdt.locked) : 0;

    console.log('\n=== Canary 게이트 판단 (free balance 기준) ===');
    console.log(`USDT free  : ${usdtFree}  ← 가드/봇 #1 가용 잔고`);
    console.log(`USDT locked: ${usdtLocked} (다른 봇 주문에 점유 — 봇 #1과 무관)`);
    console.log(`봇 #1 minTakerBalance: ${bot.minTakerBalance ?? '(null — 11 설정 권장)'}`);
    console.log(`봇 #1 quantity: ${bot.quantity.toString()} (1 fill 당 USDT 차감)`);
    console.log(`봇 #1 enabled/live/killSwitch: ${bot.enabled}/${bot.live}/${bot.killSwitch}`);

    if (usdtFree < 11) {
      const lo = Math.max(11 - Math.floor(usdtFree), 7);
      const hi = Math.max(20 - Math.floor(usdtFree), lo);
      console.log('\n❌ STATUS: free USDT 11 미만 — canary 가동 시 즉시 autoPause.');
      console.log(`   → Upbit 앱에서 KRW로 USDT ${lo}~${hi}개 시장가 매수 (free 11~20 범위로 진입).`);
    } else if (usdtFree > 20) {
      console.log('\n⚠️  STATUS: free USDT 21+ — 2회 이상 fill 가능 (canary 1-fill semantics 위반).');
      console.log(`   → Upbit 앱에서 USDT ${usdtFree - 20}+ 만큼 시장가 매도하여 free 11~20 범위로 trim.`);
    } else {
      console.log('\n✅ STATUS: free USDT 11~20 범위. canary 가동 사전조건 충족.');
      console.log('   다음 단계: minTakerBalance=11 설정 → Admin UI에서 enabled+live=true 토글');
    }
  } finally {
    // disconnect (read-only지만 connection은 닫아야 프로세스 종료)
    await stablecoinPrisma.$disconnect();
    await mainPrisma.$disconnect();
  }
})().catch((e) => { console.error(e); process.exit(1); });
