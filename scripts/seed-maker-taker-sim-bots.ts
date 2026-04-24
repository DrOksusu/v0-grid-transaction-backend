/**
 * Maker-Taker 시뮬레이터 초기 봇 3개 seed 스크립트
 *
 * 설계서 §7 — 관찰용 3개 봇 (USDS → USDT, offset -2/-4/-6)
 *
 * 사용법:
 *   dry-run (기본): npx ts-node scripts/seed-maker-taker-sim-bots.ts
 *   실제 INSERT:    npx ts-node scripts/seed-maker-taker-sim-bots.ts --apply
 *
 * 환경 변수:
 *   SIM_USER_ID   (선택, 기본: 2 — ok4192@hanmail.net)
 */
import 'dotenv/config';
import { PrismaClient as StablecoinPrismaClient } from '../node_modules/.prisma/client-stablecoin';

const prisma = new StablecoinPrismaClient({
  datasources: { db: { url: process.env.STABLECOIN_DATABASE_URL } },
});

const USER_ID = parseInt(process.env.SIM_USER_ID || '2', 10);

const SEEDS = [
  {
    makerCoin: 'USDS',
    takerCoin: 'USDT',
    bidOffsetKrw: -2,
    quantity: 10,
    maxPendingMs: 3_600_000,
    minTakerBidKrw: 1485,
    makerFeeBps: 5,
    takerFeeBps: 5,
    enabled: true,
    killSwitch: false,
  },
  {
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
  {
    makerCoin: 'USDS',
    takerCoin: 'USDT',
    bidOffsetKrw: -6,
    quantity: 10,
    maxPendingMs: 3_600_000,
    minTakerBidKrw: 1485,
    makerFeeBps: 5,
    takerFeeBps: 5,
    enabled: true,
    killSwitch: false,
  },
];

async function main() {
  const apply = process.argv.includes('--apply');

  console.log('='.repeat(70));
  console.log(`Maker-Taker 시뮬레이터 봇 seed ${apply ? '(--apply)' : '(dry-run)'}`);
  console.log('='.repeat(70));
  console.log(`userId=${USER_ID}, 봇 ${SEEDS.length}개 예정:\n`);

  SEEDS.forEach((s, i) => {
    console.log(
      `  [${i + 1}] ${s.makerCoin} → ${s.takerCoin} | offset=${s.bidOffsetKrw} | qty=${s.quantity} | minTakerBid=${s.minTakerBidKrw}`,
    );
  });

  const existing = await prisma.makerTakerSimBot.findMany({ where: { userId: USER_ID } });
  console.log(`\n기존 봇: ${existing.length}개 (userId=${USER_ID})`);
  if (existing.length > 0) {
    existing.forEach((b) => {
      console.log(
        `  - id=${b.id} ${b.makerCoin}→${b.takerCoin} offset=${b.bidOffsetKrw} enabled=${b.enabled} killSwitch=${b.killSwitch}`,
      );
    });
  }

  if (!apply) {
    console.log('\n🔸 dry-run 모드: 실제 INSERT 하지 않음. 적용하려면 --apply 플래그 사용');
    await prisma.$disconnect();
    return;
  }

  if (existing.length >= SEEDS.length) {
    console.log(`\n⚠️  이미 ${existing.length}개 봇 존재. 추가 INSERT 생략 (중복 방지).`);
    await prisma.$disconnect();
    return;
  }

  const created: number[] = [];
  for (const seed of SEEDS) {
    const bot = await prisma.makerTakerSimBot.create({
      data: { ...seed, userId: USER_ID },
    });
    created.push(bot.id);
    console.log(`  ✔ 생성: id=${bot.id} offset=${bot.bidOffsetKrw}`);
  }

  console.log(`\n✅ ${created.length}개 봇 생성 완료: ids=[${created.join(', ')}]`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('seed 실패:', err);
  await prisma.$disconnect();
  process.exit(1);
});
