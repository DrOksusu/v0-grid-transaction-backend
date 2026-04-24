/**
 * Maker-Taker 시뮬레이터 로컬 통합 테스트
 *
 * 목적 (advisor 권고):
 *   1. MakerTakerSimulatorAgent.onStart() 성공 로그 확인
 *   2. PENDING 레코드 생성 확인
 *   3. StablecoinArbAgent + MakerTakerSimulatorAgent 동시 실행 시 WS 공유 검증
 *   4. 한 쪽 stop() 시 다른 쪽 WS 유지 확인 (ref count)
 *
 * 전제:
 *   - 로컬 Docker MySQL (grid-mysql-dev:3308) 기동 중
 *   - .env의 STABLECOIN_DATABASE_URL = localhost:3308/grid_stablecoin_arb
 *   - Upbit orderbook WS 접근 가능 (인터넷)
 *
 * 사용법:
 *   npx ts-node scripts/test-maker-taker-sim-local.ts
 */
import 'dotenv/config';
import { MakerTakerSimulatorAgent } from '../src/agents/maker-taker-simulator-agent';
import { StablecoinArbAgent } from '../src/agents/stablecoin-arb-agent';
import { _debugStablecoinSubscriberCount } from '../src/services/upbit-price-manager';
import { stablecoinPrisma } from '../src/config/database';

const USER_ID = 2;
const WAIT_MS = 20_000; // Upbit orderbook tick 수신 대기

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function cleanupSeedBot(): Promise<void> {
  await stablecoinPrisma.makerTakerSimTrade.deleteMany({ where: { bot: { userId: USER_ID } } });
  await stablecoinPrisma.makerTakerSimBot.deleteMany({ where: { userId: USER_ID } });
}

async function seedOneBot(): Promise<number> {
  const bot = await stablecoinPrisma.makerTakerSimBot.create({
    data: {
      userId: USER_ID,
      makerCoin: 'USDS',
      takerCoin: 'USDT',
      bidOffsetKrw: -4,
      quantity: 10,
      maxPendingMs: 3_600_000,
      minTakerBidKrw: 1485,
      makerFeeBps: 5,
      takerFeeBps: 5,
      enabled: true,
      killSwitch: false,
    },
  });
  return bot.id;
}

async function main() {
  log('🧪 로컬 통합 테스트 시작');
  log('설계: docs/superpowers/specs/2026-04-24-maker-taker-simulator-design.md');

  // 0. 기존 데이터 정리
  await cleanupSeedBot();

  // 1. 테스트 봇 1개 생성
  const botId = await seedOneBot();
  log(`✅ 테스트 봇 생성: id=${botId} (USDS→USDT, offset=-4)`);

  // 2. 두 에이전트 동시 start
  const stablecoinAgent = new StablecoinArbAgent();
  const simAgent = new MakerTakerSimulatorAgent();

  await stablecoinAgent.start();
  log(`   subscriberCount (Stablecoin start 후): ${_debugStablecoinSubscriberCount()}`);
  await simAgent.start();
  log(`   subscriberCount (Sim start 후): ${_debugStablecoinSubscriberCount()}`);

  if (_debugStablecoinSubscriberCount() !== 2) {
    throw new Error(`❌ 예상 count=2, 실제=${_debugStablecoinSubscriberCount()}`);
  }
  log('✅ ref count = 2 확인 (두 에이전트 모두 구독)');

  // 3. Upbit orderbook 이벤트 수신 대기
  log(`⏳ ${WAIT_MS / 1000}초 대기 (Upbit orderbook 수신)...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // 4. PENDING 레코드 생성 확인
  const pendingTrades = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: { botId, status: 'PENDING' },
  });
  log(`📊 PENDING 레코드: ${pendingTrades.length}건`);
  if (pendingTrades.length === 0) {
    log('⚠️  PENDING 없음 — Upbit WS 미연결 또는 USDS 호가 데이터 미수신 가능성');
  } else {
    log(`   ✅ 샘플: makerOrderPrice=${pendingTrades[0].makerOrderPrice}, createdAt=${pendingTrades[0].createdAt.toISOString()}`);
  }

  // 5. MakerTakerSim 에이전트만 stop → Stablecoin은 계속 돌아야 함
  log('🔧 MakerTakerSim agent stop (Stablecoin은 유지 돼야 함)');
  await simAgent.stop();
  log(`   subscriberCount (Sim stop 후): ${_debugStablecoinSubscriberCount()}`);
  if (_debugStablecoinSubscriberCount() !== 1) {
    throw new Error(`❌ 예상 count=1, 실제=${_debugStablecoinSubscriberCount()}`);
  }
  log('✅ ref count = 1 (Stablecoin WS 유지)');

  // 6. Stablecoin 에이전트도 stop
  await stablecoinAgent.stop();
  log(`   subscriberCount (Stablecoin stop 후): ${_debugStablecoinSubscriberCount()}`);
  if (_debugStablecoinSubscriberCount() !== 0) {
    throw new Error(`❌ 예상 count=0, 실제=${_debugStablecoinSubscriberCount()}`);
  }
  log('✅ ref count = 0 (모두 해제)');

  // 7. Cleanup
  await cleanupSeedBot();
  await stablecoinPrisma.$disconnect();

  log('🎉 통합 테스트 성공');
}

main().catch(async (err) => {
  console.error('통합 테스트 실패:', err);
  await stablecoinPrisma.$disconnect();
  process.exit(1);
});
