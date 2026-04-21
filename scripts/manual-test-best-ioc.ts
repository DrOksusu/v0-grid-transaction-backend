/**
 * Upbit best+ioc 주문 수동 테스트 스크립트
 *
 * 사용법:
 *   npx ts-node scripts/manual-test-best-ioc.ts <market> <side> <amount>
 *
 *   market: KRW-USDT | KRW-USDC | KRW-USDS | KRW-USD1 | KRW-USDE
 *   side:   bid (매수) | ask (매도)
 *   amount: bid면 KRW 금액 (예: "10000"), ask면 코인 수량 (예: "7.15")
 *
 * 예:
 *   npx ts-node scripts/manual-test-best-ioc.ts KRW-USDT bid 10000
 *   npx ts-node scripts/manual-test-best-ioc.ts KRW-USDT ask 7.15
 *
 * 환경 변수(.env.local 또는 process.env):
 *   UPBIT_ADMIN_API_KEY    — 관리자 Upbit access key
 *   UPBIT_ADMIN_SECRET_KEY — 관리자 Upbit secret key
 *
 * ⚠️ 이 스크립트는 실제 거래를 발생시킵니다. 관리자 본인 계정에서만 실행하세요.
 */
import 'dotenv/config';
import { UpbitService } from '../src/services/upbit.service';

async function main() {
  const [market, side, amount] = process.argv.slice(2);

  if (!market || !side || !amount) {
    console.error('사용법: npx ts-node scripts/manual-test-best-ioc.ts <market> <side> <amount>');
    console.error('예: npx ts-node scripts/manual-test-best-ioc.ts KRW-USDT bid 10000');
    process.exit(1);
  }

  if (side !== 'bid' && side !== 'ask') {
    console.error('side는 bid 또는 ask여야 합니다');
    process.exit(1);
  }

  const accessKey = process.env.UPBIT_ADMIN_API_KEY;
  const secretKey = process.env.UPBIT_ADMIN_SECRET_KEY;
  if (!accessKey || !secretKey) {
    console.error('UPBIT_ADMIN_API_KEY / UPBIT_ADMIN_SECRET_KEY 환경변수 필요');
    console.error('.env.local 파일에 설정하거나 shell에 export');
    process.exit(1);
  }

  console.log(`\n=== Manual Test: ${market} ${side} ${amount} (best+ioc) ===\n`);

  // UpbitService 생성자: constructor(credentials: { accessKey: string; secretKey: string })
  const upbit = new UpbitService({ accessKey, secretKey });

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
