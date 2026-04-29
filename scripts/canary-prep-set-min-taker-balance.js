// PR G — Canary Stage 2 사전조건: 봇 #1의 minTakerBalance를 5로 설정 (idempotent)
//
// 사용:
//   호스트에서 STABLECOIN_DATABASE_URL 환경변수 세팅 후:
//     node scripts/canary-prep-set-min-taker-balance.js
//   또는 컨테이너 내부에서:
//     docker cp scripts/canary-prep-set-min-taker-balance.js grid-bot:/tmp/
//     docker exec grid-bot node /tmp/canary-prep-set-min-taker-balance.js
//
// 동작:
//   - 봇 #1을 SELECT → 현재 minTakerBalance 출력
//   - 5와 다르면 UPDATE, 같으면 noop
//   - 변경 후 재조회하여 결과 확인
//
// 안전:
//   - 봇 #1만 대상 (조건 명시)
//   - read 후 write — diff 출력
//   - 5에서 변경하지 않음(이미 5면 변화 없음)

const path = require('path');

(async () => {
  let prismaModule;
  try {
    prismaModule = require('/app/dist/config/database');
  } catch {
    // 호스트 실행 시 빌드 산출물 경로
    prismaModule = require(path.resolve(__dirname, '..', 'dist', 'config', 'database'));
  }
  const { stablecoinPrisma } = prismaModule;

  const TARGET_BOT_ID = 1;
  // 봇 quantity=10. guard 비교는 takerBalance < minTakerBalance(strict).
  // minTakerBalance=10이면 USDT 잔고 10에서도 통과(10<10 false) → 거래 시도 → balance shortage.
  // 따라서 quantity + 1 = 11로 두어 USDT < 11일 때 정지하도록 한다(advisor 권고).
  const TARGET_VALUE = 11;

  const before = await stablecoinPrisma.makerTakerSimBot.findUnique({
    where: { id: TARGET_BOT_ID },
    select: { id: true, makerCoin: true, takerCoin: true, enabled: true, live: true, minTakerBalance: true },
  });
  if (!before) {
    console.error(`bot id=${TARGET_BOT_ID} not found`);
    await stablecoinPrisma.$disconnect();
    process.exit(1);
  }
  console.log('=== BEFORE ===');
  console.log(JSON.stringify(before, null, 2));

  if (before.minTakerBalance === TARGET_VALUE) {
    console.log(`\nNoop: minTakerBalance already = ${TARGET_VALUE}`);
    await stablecoinPrisma.$disconnect();
    return;
  }

  const updated = await stablecoinPrisma.makerTakerSimBot.update({
    where: { id: TARGET_BOT_ID },
    data: { minTakerBalance: TARGET_VALUE },
    select: { id: true, minTakerBalance: true },
  });
  console.log('\n=== UPDATED ===');
  console.log(JSON.stringify(updated, null, 2));

  const after = await stablecoinPrisma.makerTakerSimBot.findUnique({
    where: { id: TARGET_BOT_ID },
    select: { id: true, makerCoin: true, takerCoin: true, enabled: true, live: true, minTakerBalance: true },
  });
  console.log('\n=== AFTER (verified) ===');
  console.log(JSON.stringify(after, null, 2));

  await stablecoinPrisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
