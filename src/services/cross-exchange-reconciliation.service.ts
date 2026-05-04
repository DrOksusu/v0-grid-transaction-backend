// src/services/cross-exchange-reconciliation.service.ts
//
// Cross-exchange arbitrage 봇의 reconciliation 서비스
// PR H 패턴: DB FILLED row 와 거래소 done order 를 비교하여 정합성 확인
//
// Stage 1 canary 에서는 거래소 API 호출이 mockOrders 파라미터로 stub 처리됨.
// (ExchangeClient 인터페이스에 done order 조회 메서드가 없기 때문에
//  실제 거래소 통합은 추후 PR 에서 진행)

import { ExchangeClient } from './exchange/exchange-client';

export interface ReconciliationReport {
  botId: number;
  coin: string;
  buyCoin?: string;
  sellCoin?: string;
  sinceSource: 'lastResumeAt' | 'createdAt';
  sinceAt: Date;
  dbFilledCount: number;
  upbitDoneCount: number;
  bithumbDoneCount: number;
  isReconciled: boolean;
  diff?: string;
  pageTruncated: boolean;
}

interface MockOrders {
  mockUpbitOrders?: Array<{ filledQty: number; side: 'buy' | 'sell'; timestamp: Date }>;
  mockBithumbOrders?: Array<{ filledQty: number; side: 'buy' | 'sell'; timestamp: Date }>;
}

/**
 * cross-exchange arbitrage 봇의 DB FILLED 행을 거래소 done order 와 비교한다.
 *
 * - sinceAt: bot.lastResumeAt 우선, 없으면 bot.createdAt
 * - DB 조회: take=101 으로 페이지 잘림 감지 (100 건 초과 시 pageTruncated=true)
 * - 거래소 조회: Stage 1 에서는 mockOrders 로 주입 (read-only)
 * - isReconciled: 세 카운트가 모두 일치할 때 true
 */
export async function reconcileCrossExchangeBot(
  botId: number,
  stablecoinPrisma: any,
  upbitClient: ExchangeClient,
  bithumbClient: ExchangeClient,
  mockOrders?: MockOrders,
): Promise<ReconciliationReport> {
  const bot = await stablecoinPrisma.crossExchangeArbBot.findUnique({ where: { id: botId } });
  if (!bot) {
    throw new Error(`Bot ${botId} not found`);
  }

  // sinceAt 결정: lastResumeAt 우선, fallback 으로 createdAt
  const sinceSource: 'lastResumeAt' | 'createdAt' = bot.lastResumeAt ? 'lastResumeAt' : 'createdAt';
  const sinceAt: Date = bot.lastResumeAt ?? bot.createdAt;

  // DB FILLED rows 조회 — take=101 으로 page 잘림 감지
  const dbTrades = await stablecoinPrisma.crossExchangeArbTrade.findMany({
    where: { botId, status: 'FILLED', createdAt: { gte: sinceAt } },
    orderBy: { createdAt: 'asc' },
    take: 101,
  });
  const dbFilledCount = Math.min(dbTrades.length, 100);
  const pageTruncated = dbTrades.length > 100;

  // 거래소 done order — Stage 1 에서는 mock 주입, 미주입 시 빈 배열
  const upbitOrders = mockOrders?.mockUpbitOrders ?? [];
  const bithumbOrders = mockOrders?.mockBithumbOrders ?? [];

  const upbitDoneCount = upbitOrders.length;
  const bithumbDoneCount = bithumbOrders.length;

  // 세 카운트 모두 일치해야 reconciled.
  // pageTruncated 시에는 DB 가 100건 cap 되므로 카운트 일치는 false-positive 가능 → reconciled=false 강제
  const countsMatch = dbFilledCount === upbitDoneCount && dbFilledCount === bithumbDoneCount;
  const isReconciled = !pageTruncated && countsMatch;
  const diff = isReconciled
    ? undefined
    : pageTruncated
      ? `db=${dbFilledCount}+ (truncated), upbit=${upbitDoneCount}, bithumb=${bithumbDoneCount}`
      : `db=${dbFilledCount}, upbit=${upbitDoneCount}, bithumb=${bithumbDoneCount}`;

  return {
    botId,
    coin: bot.coin,
    buyCoin: bot.buyCoin ?? undefined,
    sellCoin: bot.sellCoin ?? undefined,
    sinceSource,
    sinceAt,
    dbFilledCount,
    upbitDoneCount,
    bithumbDoneCount,
    isReconciled,
    diff,
    pageTruncated,
  };
}
