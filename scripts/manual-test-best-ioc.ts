/**
 * Upbit best+ioc 주문 수동 테스트 스크립트
 *
 * 사용법:
 *   npx ts-node scripts/manual-test-best-ioc.ts <market> <side> <amount> [userEmail]
 *
 *   market:    KRW-USDT | KRW-USDC | KRW-USDS | KRW-USD1 | KRW-USDE
 *   side:      bid (매수) | ask (매도)
 *   amount:    bid면 KRW 금액 (예: "10000"), ask면 코인 수량 (예: "7.15")
 *   userEmail: (선택) 관리자 유저 이메일. 미지정 시 ADMIN_EMAIL 환경변수 또는
 *              기본값 'ok4192@hanmail.net' 사용.
 *
 * 예:
 *   npx ts-node scripts/manual-test-best-ioc.ts KRW-USDT bid 10000
 *   npx ts-node scripts/manual-test-best-ioc.ts KRW-USDT ask 7.15
 *
 * 동작:
 *   DB에서 해당 유저의 upbit credential(purpose='default')을 조회하여 복호화 후 사용.
 *   별도 .env.local 세팅 불필요.
 *
 * ⚠️ 이 스크립트는 실제 거래를 발생시킵니다. 관리자 본인 계정에서만 실행하세요.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { UpbitService } from '../src/services/upbit.service';
import { decrypt } from '../src/utils/encryption';

const DEFAULT_ADMIN_EMAIL = 'ok4192@hanmail.net';

async function loadAdminCredentials(email: string) {
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error(`유저를 찾을 수 없음: ${email}`);

    const cred = await prisma.credential.findFirst({
      where: { userId: user.id, exchange: 'upbit', purpose: 'default' },
    });
    if (!cred) throw new Error(`유저 ${email}에게 upbit credential(purpose=default)이 없음`);
    if (!cred.isValid) {
      console.warn(`⚠️  credential.isValid=false (lastValidatedAt: ${cred.lastValidatedAt})`);
    }

    return {
      userId: user.id,
      accessKey: decrypt(cred.apiKey),
      secretKey: decrypt(cred.secretKey),
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const [market, side, amount, emailArg] = process.argv.slice(2);

  if (!market || !side || !amount) {
    console.error('사용법: npx ts-node scripts/manual-test-best-ioc.ts <market> <side> <amount> [userEmail]');
    console.error('예: npx ts-node scripts/manual-test-best-ioc.ts KRW-USDT bid 10000');
    process.exit(1);
  }

  if (side !== 'bid' && side !== 'ask') {
    console.error('side는 bid 또는 ask여야 합니다');
    process.exit(1);
  }

  const email = emailArg || process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;

  let creds;
  try {
    creds = await loadAdminCredentials(email);
  } catch (err: any) {
    console.error('credential 로드 실패:', err.message);
    process.exit(1);
  }

  console.log(`\n=== Manual Test: ${market} ${side} ${amount} (best+ioc) ===`);
  console.log(`관리자: ${email} (userId=${creds.userId})\n`);

  const upbit = new UpbitService({ accessKey: creds.accessKey, secretKey: creds.secretKey });

  // bid면 price(KRW 금액), ask면 volume(코인 수량)으로 파라미터 분기
  const params: { price?: string; volume?: string } =
    side === 'bid' ? { price: amount } : { volume: amount };

  let orderResp;
  try {
    orderResp = await upbit.placeBestIoc(market, side as 'bid' | 'ask', params);
  } catch (err: any) {
    console.error('주문 실패:', err.response?.data || err.message);
    process.exit(1);
  }

  console.log('--- 주문 응답 (즉시) ---');
  console.log(JSON.stringify(orderResp, null, 2));

  // 1초 대기 후 상세 조회
  console.log('\n1초 후 상세 조회...\n');
  await new Promise(r => setTimeout(r, 1000));

  let detail;
  try {
    detail = await upbit.getOrder(orderResp.uuid);
  } catch (err: any) {
    console.error('상세 조회 실패:', err.response?.data || err.message);
    process.exit(1);
  }

  console.log('--- 주문 상세 ---');
  console.log(JSON.stringify(detail, null, 2));

  // 핵심 필드 하이라이트
  console.log('\n--- 요약 ---');
  console.log(`state:           ${detail.state}`);
  console.log(`executed_volume: ${detail.executed_volume}`);
  console.log(`executed_funds:  ${detail.executed_funds ?? '(없음)'}`);
  console.log(`paid_fee:        ${detail.paid_fee}`);
  console.log(`trades_count:    ${detail.trades_count ?? '(없음)'}`);
  console.log(`체결 거래 상세: ${Array.isArray(detail.trades) ? detail.trades.length + '건' : '(없음)'}`);
}

main().catch(err => {
  console.error('예외:', err);
  process.exit(1);
});
