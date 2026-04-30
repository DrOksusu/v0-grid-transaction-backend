/**
 * Maker-Taker 봇의 자산 정합 검증 — DB 기록(FILLED, live=true) 합계와
 * 거래소(Upbit) 의 done order 합계를 비교한다.
 *
 * Canary 검증 절차의 자동화 (PR D 수준의 수동 검증을 UI 한 번 클릭으로 대체).
 *
 * - 기준 시점(since): bot.lastResumeAt ?? bot.createdAt
 * - 비교 대상:
 *   - bot 측: makerTakerSimTrade(status=FILLED, live=true, makerFilledAt >= since)
 *   - Upbit 측: getOrdersByMarket(`KRW-${makerCoin}`, 'done').filter(side='bid' && created_at >= since)
 *               동일 패턴으로 takerCoin ask 합계
 *
 * 페이지네이션 미지원 (1봇 24h 규모 < 100건). count===100 이면 pageTruncated=true 로 표시.
 */

import { stablecoinPrisma } from '../config/database';
import mainPrisma from '../config/database';
import { UpbitService } from './upbit.service';
import { decrypt } from '../utils/encryption';

/** reconcileBotAssets 반환 타입 */
export interface ReconciliationReport {
  botId: number;
  sinceUtc: string;
  sinceSource: 'lastResumeAt' | 'createdAt';
  bot: {
    filledTradesCount: number;
    pendingTradesCount: number;
    filledMakerSumQty: string;
    filledTakerSumQty: string;
  };
  exchange: {
    makerCoin: string;
    takerCoin: string;
    makerDoneBidQty: string;
    takerDoneAskQty: string;
    makerDoneOrderCount: number;
    takerDoneOrderCount: number;
    pageTruncated: boolean;
  };
  diff: {
    makerCoinDiff: string;
    takerCoinDiff: string;
  };
  isReconciled: boolean;
}

/** 정합으로 판정하는 허용 오차 (소수점 부동소수 오차 흡수용) */
const RECONCILE_TOLERANCE = 0.001;

/** 문자열/숫자 배열의 합산 */
function sumDecimal(values: Array<string | number>): number {
  return values.reduce((acc: number, v) => acc + (typeof v === 'string' ? parseFloat(v) : v), 0);
}

/** 소수점 불필요한 trailing zero 제거 후 문자열 변환 */
function fmt(n: number): string {
  return n.toFixed(8).replace(/\.?0+$/, '') || '0';
}

/**
 * 봇 DB 기록과 Upbit done order 를 비교하여 정합 여부를 반환한다.
 *
 * @param params.botId - 검증 대상 봇 ID
 * @param params.userId - 요청자 userId (ownership 검증용)
 * @throws Bot not found / not owned / credential not registered
 */
export async function reconcileBotAssets(params: {
  botId: number;
  userId: number;
}): Promise<ReconciliationReport> {
  const { botId, userId } = params;

  // 1. 봇 조회 + ownership 검증
  const bot = await stablecoinPrisma.makerTakerSimBot.findUnique({
    where: { id: botId },
  });
  if (!bot) throw new Error('Bot not found');
  if ((bot as any).userId !== userId) throw new Error('Bot not owned by user');

  // 2. 기준 시점 결정: lastResumeAt 우선, 없으면 createdAt 폴백
  const lastResumeAt = (bot as any).lastResumeAt as Date | null;
  const createdAt = (bot as any).createdAt as Date;
  const since: Date = lastResumeAt ?? createdAt;
  const sinceSource: 'lastResumeAt' | 'createdAt' = lastResumeAt ? 'lastResumeAt' : 'createdAt';

  // 3. Upbit credential 조회
  const credential = await mainPrisma.credential.findFirst({
    where: { userId, exchange: 'upbit' },
  });
  if (!credential) throw new Error('Upbit credential not registered');

  // 4. bot DB 합계 — since 이후 FILLED + live=true 거래
  const filledTrades = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: {
      botId,
      status: 'FILLED',
      live: true,
      makerFilledAt: { gte: since },
    },
    select: { id: true, quantity: true, makerFilledAt: true },
  });
  const pendingTradesCount = await stablecoinPrisma.makerTakerSimTrade.count({
    where: { botId, status: 'PENDING', live: true },
  });

  const botMakerSum = sumDecimal((filledTrades as any[]).map((t) => t.quantity?.toString() ?? '0'));
  // maker-taker cross-coin direct swap: maker 매수 qty = taker 매도 qty (1:1)
  const botTakerSum = botMakerSum;

  // 5. Upbit done order 조회 + since 필터링
  const accessKey = decrypt((credential as any).apiKey);
  const secretKey = decrypt((credential as any).secretKey);
  const upbit = new UpbitService({ accessKey, secretKey });

  const makerCoin = (bot as any).makerCoin as string;
  const takerCoin = (bot as any).takerCoin as string;

  const makerOrders = await upbit.getOrdersByMarket(`KRW-${makerCoin}`, 'done');
  const takerOrders = await upbit.getOrdersByMarket(`KRW-${takerCoin}`, 'done');

  const sinceMs = since.getTime();

  // since 이후 makerCoin bid 주문만 집계
  const makerBids = (makerOrders ?? []).filter(
    (o: any) => o.side === 'bid' && new Date(o.created_at).getTime() >= sinceMs,
  );
  // since 이후 takerCoin ask 주문만 집계
  const takerAsks = (takerOrders ?? []).filter(
    (o: any) => o.side === 'ask' && new Date(o.created_at).getTime() >= sinceMs,
  );

  const exchangeMakerSum = sumDecimal(makerBids.map((o: any) => o.executed_volume ?? '0'));
  const exchangeTakerSum = sumDecimal(takerAsks.map((o: any) => o.executed_volume ?? '0'));

  // Upbit 페이지 100건 한계 — 초과 여부 경고 플래그
  const pageTruncated =
    (makerOrders?.length ?? 0) === 100 || (takerOrders?.length ?? 0) === 100;

  // 6. 차이 계산 및 정합 판정
  const makerDiff = botMakerSum - exchangeMakerSum;
  const takerDiff = botTakerSum - exchangeTakerSum;
  const isReconciled =
    Math.abs(makerDiff) < RECONCILE_TOLERANCE &&
    Math.abs(takerDiff) < RECONCILE_TOLERANCE;

  return {
    botId,
    sinceUtc: since.toISOString(),
    sinceSource,
    bot: {
      filledTradesCount: filledTrades.length,
      pendingTradesCount,
      filledMakerSumQty: fmt(botMakerSum),
      filledTakerSumQty: fmt(botTakerSum),
    },
    exchange: {
      makerCoin,
      takerCoin,
      makerDoneBidQty: fmt(exchangeMakerSum),
      takerDoneAskQty: fmt(exchangeTakerSum),
      makerDoneOrderCount: makerBids.length,
      takerDoneOrderCount: takerAsks.length,
      pageTruncated,
    },
    diff: {
      makerCoinDiff: fmt(makerDiff),
      takerCoinDiff: fmt(takerDiff),
    },
    isReconciled,
  };
}
