/**
 * 기존 종목의 totalInvested, avgPrice 재계산 스크립트
 *
 * 문제: 기존에는 buyAmount(설정된 매수금)을 totalInvested에 더했으나,
 *       실제 투자금은 quantity * price (정수 수량 × 실제 매수가)여야 함
 *
 * 해결: 매수 기록(InfiniteBuyRecord)을 기반으로 재계산
 */

import prisma from '../config/database';

async function recalculateInvested() {
  console.log('=== 기존 데이터 재계산 시작 ===\n');

  // 모든 무한매수 종목 조회
  const stocks = await prisma.infiniteBuyStock.findMany();

  console.log(`총 ${stocks.length}개 종목 발견\n`);

  let updatedCount = 0;

  for (const stock of stocks) {
    // 해당 종목의 모든 매수 기록 조회
    const rawBuyRecords = await prisma.infiniteBuyRecord.findMany({
      where: {
        stockId: stock.id,
        type: 'buy',
      },
      orderBy: { executedAt: 'asc' },
    });

    // 체결된 주문만 필터링 (filled 또는 orderStatus가 null인 기존 데이터)
    // pending, cancelled는 제외
    const allBuyRecords = rawBuyRecords.filter(
      (r) => r.orderStatus === 'filled' || r.orderStatus === null
    );

    if (allBuyRecords.length === 0) {
      console.log(`[${stock.ticker}] 매수 기록 없음 - 스킵`);
      continue;
    }

    // 기존 값
    const oldTotalInvested = stock.totalInvested;
    const oldTotalQuantity = stock.totalQuantity;
    const oldAvgPrice = stock.avgPrice;

    // 재계산: 실제 투자금 = sum(price * quantity)
    let newTotalInvested = 0;
    let newTotalQuantity = 0;

    console.log(`\n[${stock.ticker}] 매수 기록 ${allBuyRecords.length}건 분석:`);

    for (const record of allBuyRecords) {
      const actualAmount = record.price * record.quantity;
      newTotalInvested += actualAmount;
      newTotalQuantity += record.quantity;

      console.log(`  - ${record.round || '?'}회차: ${record.quantity}주 × $${record.price.toFixed(2)} = $${actualAmount.toFixed(2)} (기록된 amount: $${record.amount.toFixed(2)})`);
    }

    // 새 평균단가
    const newAvgPrice = newTotalQuantity > 0 ? newTotalInvested / newTotalQuantity : 0;

    // 변경 여부 확인
    const investedDiff = Math.abs(newTotalInvested - oldTotalInvested);
    const quantityDiff = Math.abs(newTotalQuantity - oldTotalQuantity);
    const avgPriceDiff = Math.abs(newAvgPrice - oldAvgPrice);

    const hasChange = investedDiff > 0.01 || quantityDiff > 0.0001 || avgPriceDiff > 0.01;

    if (hasChange) {
      console.log(`\n  [변경 감지]`);
      console.log(`    totalInvested: $${oldTotalInvested.toFixed(2)} → $${newTotalInvested.toFixed(2)} (차이: $${investedDiff.toFixed(2)})`);
      console.log(`    totalQuantity: ${oldTotalQuantity.toFixed(4)} → ${newTotalQuantity.toFixed(4)}`);
      console.log(`    avgPrice: $${oldAvgPrice.toFixed(2)} → $${newAvgPrice.toFixed(2)}`);

      // DB 업데이트 - 종목
      await prisma.infiniteBuyStock.update({
        where: { id: stock.id },
        data: {
          totalInvested: newTotalInvested,
          totalQuantity: newTotalQuantity,
          avgPrice: newAvgPrice,
        },
      });

      // 매수 기록의 amount도 수정
      for (const record of allBuyRecords) {
        const actualAmount = record.price * record.quantity;
        if (Math.abs(record.amount - actualAmount) > 0.01) {
          await prisma.infiniteBuyRecord.update({
            where: { id: record.id },
            data: { amount: actualAmount },
          });
        }
      }

      console.log(`  ✅ 업데이트 완료`);
      updatedCount++;
    } else {
      console.log(`  (변경 없음)`);
    }
  }

  console.log(`\n=== 재계산 완료 ===`);
  console.log(`총 ${stocks.length}개 종목 중 ${updatedCount}개 업데이트됨\n`);
}

// 스크립트 실행
recalculateInvested()
  .then(() => {
    console.log('스크립트 정상 종료');
    process.exit(0);
  })
  .catch((error) => {
    console.error('스크립트 오류:', error);
    process.exit(1);
  });
