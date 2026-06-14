import axios from 'axios';
import prisma from '../config/database';
import { UpbitService } from './upbit.service';
import { decrypt } from '../utils/encryption';
import { kakaoNotifyService } from './kakao-notify.service';
import { AppError } from '../middlewares/errorHandler';
import {
  calcTargetPrice,
  getTradeDate,
  evaluateExit,
  ExitReason,
} from '../utils/volatility-breakout-core';

const FEE_PCT_PER_SIDE = 0.05; // 업비트 시장가 수수료 (편도)
const MIN_ORDER_KRW = 5000; // 업비트 최소 주문금액
const UPBIT_API_URL = 'https://api.upbit.com/v1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===== CRUD =====

export async function listBots(userId: number) {
  const bots = await prisma.volatilityBreakoutBot.findMany({
    where: { userId },
    orderBy: { id: 'asc' },
  });

  // 실시간 상태 enrich: 목표가, 현재가, 돌파까지 %, 포지션
  const tradeDate = getTradeDate(new Date());
  return Promise.all(
    bots.map(async (bot) => {
      let targetPrice: number | null = null;
      let currentPrice: number | null = null;
      try {
        const ref = await getDayRef(bot.market, tradeDate);
        targetPrice = calcTargetPrice(ref.todayOpen, ref.prevHigh, ref.prevLow, bot.k);
        const ticker = await UpbitService.getCurrentPrice(bot.market);
        currentPrice = ticker.trade_price;
      } catch {
        // 시세 조회 실패해도 봇 목록은 반환
      }
      const holding = await prisma.volatilityBreakoutTrade.findFirst({
        where: { botId: bot.id, status: 'HOLDING' },
      });
      const todayTrade = await prisma.volatilityBreakoutTrade.findFirst({
        where: { botId: bot.id, tradeDate },
        orderBy: { id: 'desc' },
      });
      return {
        ...bot,
        status: {
          tradeDate,
          targetPrice,
          currentPrice,
          breakoutDistancePct:
            targetPrice && currentPrice ? ((targetPrice - currentPrice) / currentPrice) * 100 : null,
          position: holding ? 'HOLDING' : todayTrade ? 'CLOSED_TODAY' : 'WAITING',
          holding: holding
            ? {
                entryPrice: holding.entryPrice,
                qty: holding.qty,
                entryAt: holding.entryAt,
                unrealizedPnlKrw: currentPrice
                  ? (currentPrice - holding.entryPrice) * holding.qty
                  : null,
              }
            : null,
        },
      };
    }),
  );
}

export async function createBot(params: {
  userId: number;
  market: string;
  buyAmountKrw: number;
  k?: number;
  stopLossPct?: number;
}) {
  const existing = await prisma.volatilityBreakoutBot.findFirst({
    where: { userId: params.userId, market: params.market },
  });
  if (existing) throw new AppError(`${params.market} 봇이 이미 존재합니다`, 400);

  return prisma.volatilityBreakoutBot.create({
    data: {
      userId: params.userId,
      market: params.market,
      buyAmountKrw: params.buyAmountKrw,
      ...(params.k !== undefined && { k: params.k }),
      ...(params.stopLossPct !== undefined && { stopLossPct: params.stopLossPct }),
    },
  });
}

export async function updateBot(
  userId: number,
  botId: number,
  patch: Partial<{
    buyAmountKrw: number;
    k: number;
    stopLossPct: number;
    live: boolean;
    enabled: boolean;
  }>,
) {
  const bot = await prisma.volatilityBreakoutBot.findFirst({ where: { id: botId, userId } });
  if (!bot) throw new AppError('봇을 찾을 수 없습니다', 404);
  return prisma.volatilityBreakoutBot.update({ where: { id: botId }, data: patch });
}

export async function deleteBot(userId: number, botId: number) {
  const bot = await prisma.volatilityBreakoutBot.findFirst({ where: { id: botId, userId } });
  if (!bot) throw new AppError('봇을 찾을 수 없습니다', 404);

  const holding = await prisma.volatilityBreakoutTrade.findFirst({
    where: { botId, status: 'HOLDING' },
  });
  if (holding) throw new AppError('HOLDING 포지션이 있어 삭제할 수 없습니다. 청산 후 삭제하세요', 400);

  await prisma.volatilityBreakoutTrade.deleteMany({ where: { botId } });
  await prisma.volatilityBreakoutBot.delete({ where: { id: botId } });
}

export async function listTrades(userId: number, botId: number, page: number, pageSize: number) {
  const bot = await prisma.volatilityBreakoutBot.findFirst({ where: { id: botId, userId } });
  if (!bot) throw new AppError('봇을 찾을 수 없습니다', 404);

  const [trades, total] = await Promise.all([
    prisma.volatilityBreakoutTrade.findMany({
      where: { botId },
      orderBy: { id: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.volatilityBreakoutTrade.count({ where: { botId } }),
  ]);
  return { trades, total, page, pageSize };
}

// ===== 사이클 로직 (에이전트가 30초마다 호출) =====

interface DayRef {
  todayOpen: number;
  prevHigh: number;
  prevLow: number;
}

// 거래일당 1회만 일봉 조회 (market:tradeDate 키)
const dayRefCache = new Map<string, DayRef>();
// 실거래 매수 주문 실패한 거래일 — 중복 주문 방지 우선, 해당일 재시도 안 함
const failedEntryDates = new Map<number, string>();

async function getDayRef(market: string, tradeDate: string): Promise<DayRef> {
  const key = `${market}:${tradeDate}`;
  const cached = dayRefCache.get(key);
  if (cached) return cached;

  const res = await axios.get(`${UPBIT_API_URL}/candles/days`, {
    params: { market, count: 2 },
    timeout: 10_000,
  });
  const [today, prev] = res.data; // 최신순: [0]=오늘, [1]=전일
  if (today.candle_date_time_utc.slice(0, 10) !== tradeDate) {
    // 09:00 직후 일봉 갱신 지연 — 다음 사이클에서 재시도
    throw new Error(`${market} 일봉 미갱신 (응답=${today.candle_date_time_utc}, 기대=${tradeDate})`);
  }
  const ref: DayRef = {
    todayOpen: today.opening_price,
    prevHigh: prev.high_price,
    prevLow: prev.low_price,
  };
  dayRefCache.set(key, ref);
  // 과거 거래일 캐시 정리 (메모리 누수 방지)
  if (dayRefCache.size > 100) {
    const oldest = dayRefCache.keys().next().value;
    if (oldest) dayRefCache.delete(oldest);
  }
  return ref;
}

async function getUpbitClientFor(userId: number): Promise<UpbitService> {
  const credential = await prisma.credential.findFirst({
    where: { userId, exchange: 'upbit' },
  });
  if (!credential) throw new Error(`userId=${userId} 업비트 인증정보 없음`);
  return new UpbitService({
    accessKey: decrypt(credential.apiKey),
    secretKey: decrypt(credential.secretKey),
  });
}

/** 주문 체결 확인 — 0.5초 간격 최대 10회 폴링 */
async function waitForFill(
  upbit: UpbitService,
  uuid: string,
): Promise<{ avgPrice: number; qty: number }> {
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const order = await upbit.getOrder(uuid);
    const vol = parseFloat(order.executed_volume ?? '0');
    if ((order.state === 'done' || order.state === 'cancel') && vol > 0) {
      const funds = parseFloat((order as any).executed_funds ?? '0');
      if (funds > 0) return { avgPrice: funds / vol, qty: vol };
      // executed_funds 미제공 시 trades 합산 폴백
      const trades = (order as any).trades ?? [];
      const sumFunds = trades.reduce(
        (a: number, t: any) => a + parseFloat(t.funds ?? '0'),
        0,
      );
      if (sumFunds > 0) return { avgPrice: sumFunds / vol, qty: vol };
    }
  }
  throw new Error(`주문 체결 확인 실패 uuid=${uuid}`);
}

function notify(msg: string): void {
  kakaoNotifyService
    .sendToMe(msg)
    .catch((e: any) => console.error('[VolatilityBreakout] 카카오 알림 실패:', e.message));
}

// 동시 실행 가드 — 직전 사이클이 waitForFill로 길어져 30초 인터벌과 겹치면 중복 매수 위험
let cycleRunning = false;

export async function runCycle(): Promise<void> {
  if (cycleRunning) {
    console.warn('[VolatilityBreakout] 직전 사이클 미완료 — 이번 사이클 skip');
    return;
  }
  cycleRunning = true;
  try {
    const now = new Date();
    const tradeDate = getTradeDate(now);

    // 거래일 바뀐 failedEntryDates 키 정리 (메모리 누수 방지)
    for (const [botId, date] of failedEntryDates) {
      if (date !== tradeDate) failedEntryDates.delete(botId);
    }

    // 대상: enabled 봇 + (disabled여도 HOLDING 거래가 있는 봇 — 청산 감시 유지)
    const enabledBots = await prisma.volatilityBreakoutBot.findMany({ where: { enabled: true } });
    const holdingTrades = await prisma.volatilityBreakoutTrade.findMany({
      where: { status: 'HOLDING' },
    });
    const enabledIds = new Set(enabledBots.map((b) => b.id));
    const extraIds = holdingTrades.map((t) => t.botId).filter((id) => !enabledIds.has(id));
    const extraBots =
      extraIds.length > 0
        ? await prisma.volatilityBreakoutBot.findMany({ where: { id: { in: extraIds } } })
        : [];

    for (const bot of [...enabledBots, ...extraBots]) {
      try {
        const holding = holdingTrades.find((t) => t.botId === bot.id) ?? null;
        await runBotCycle(bot, holding, now, tradeDate);
      } catch (e: any) {
        // 개별 봇 에러는 다른 봇 사이클을 막지 않음 — 다음 사이클에서 조건 재평가
        console.error(`[VolatilityBreakout] bot=${bot.id} ${bot.market} 사이클 에러:`, e.message);
      }
    }
  } finally {
    cycleRunning = false;
  }
}

async function runBotCycle(
  bot: { id: number; userId: number; market: string; buyAmountKrw: number; k: number; stopLossPct: number; live: boolean; enabled: boolean },
  holding: { id: number; tradeDate: string; entryPrice: number; qty: number; isLive: boolean } | null,
  now: Date,
  tradeDate: string,
): Promise<void> {
  const ticker = await UpbitService.getCurrentPrice(bot.market);
  const currentPrice: number = ticker.trade_price;

  // 1) HOLDING 포지션: 청산 조건 평가 (disabled여도 수행)
  if (holding) {
    const reason = evaluateExit({
      now,
      currentPrice,
      entryPrice: holding.entryPrice,
      stopLossPct: bot.stopLossPct,
      entryTradeDate: holding.tradeDate,
    });
    if (reason) await exitPosition(bot, holding, currentPrice, reason);
    return; // 보유 중에는 신규 진입 없음
  }

  // 2) 신규 진입: enabled 봇만
  if (!bot.enabled) return;
  if (isNearCycleEnd(now)) return; // 강제청산 창 직전·내 신규 진입 금지
  if (failedEntryDates.get(bot.id) === tradeDate) return; // 주문 실패한 날 skip
  const existing = await prisma.volatilityBreakoutTrade.findFirst({
    where: { botId: bot.id, tradeDate },
  });
  if (existing) return; // 하루 최대 1회 진입

  const ref = await getDayRef(bot.market, tradeDate);
  const target = calcTargetPrice(ref.todayOpen, ref.prevHigh, ref.prevLow, bot.k);
  if (currentPrice < target) return; // 돌파 전 — 대기

  await enterPosition(bot, target, currentPrice, tradeDate);
}

/** KST 08:50 이후(UTC 23:50~)는 신규 진입 금지 — 진입 직후 강제청산 방지 */
function isNearCycleEnd(now: Date): boolean {
  return now.getUTCHours() === 23 && now.getUTCMinutes() >= 50;
}

async function enterPosition(
  bot: { id: number; userId: number; market: string; buyAmountKrw: number; live: boolean },
  targetPrice: number,
  currentPrice: number,
  tradeDate: string,
): Promise<void> {
  let entryPrice = currentPrice;
  let qty = bot.buyAmountKrw / currentPrice; // 모의: 현재가 가상 체결

  if (bot.live) {
    if (bot.buyAmountKrw < MIN_ORDER_KRW) {
      failedEntryDates.set(bot.id, tradeDate);
      notify(`[변동성돌파 ⚠️] ${bot.market} 매수금액 ${bot.buyAmountKrw} < 최소 5,000 KRW — 오늘 진입 skip`);
      return;
    }
    // uuid를 try 바깥에 보존 — buyMarket 성공 후 waitForFill 타임아웃 시
    // 실제로는 체결됐을 수 있어 운영자가 사후 수동 복구 가능하게 알림에 포함
    let buyOrderUuid: string | null = null;
    try {
      const upbit = await getUpbitClientFor(bot.userId);
      const order = await upbit.buyMarket(bot.market, bot.buyAmountKrw);
      buyOrderUuid = order.uuid;
      const filled = await waitForFill(upbit, order.uuid);
      entryPrice = filled.avgPrice;
      qty = filled.qty;
    } catch (e: any) {
      // 매수 실패: 중복 주문 방지 우선 — 해당 거래일 재시도 안 함
      failedEntryDates.set(bot.id, tradeDate);
      console.error(`[VolatilityBreakout] bot=${bot.id} 매수 실패(uuid=${buyOrderUuid ?? 'none'}):`, e.message);
      if (buyOrderUuid) {
        // 주문은 접수됐는데 체결 확인만 실패 — 잔고에 코인 있을 수 있음
        notify(
          `[변동성돌파 ❌ 매수 체결 확인 실패] ${bot.market} (uuid=${buyOrderUuid}) — 업비트에서 직접 확인 필요. 잔고에 코인 있으면 봇 정지 후 수동 처리: ${e.message}`,
        );
      } else {
        // 주문 자체가 거부됨 — 잔고 영향 없음
        notify(`[변동성돌파 ❌ 매수 실패] ${bot.market}\n${e.message}\n오늘(${tradeDate}) 진입 skip`);
      }
      return;
    }
  }

  await prisma.volatilityBreakoutTrade.create({
    data: {
      botId: bot.id,
      tradeDate,
      targetPrice,
      entryPrice,
      entryAt: new Date(),
      qty,
      isLive: bot.live,
      status: 'HOLDING',
    },
  });

  notify(
    `[변동성돌파 🚀 진입${bot.live ? '' : ' (모의)'}] ${bot.market}\n` +
      `목표가 ${Math.round(targetPrice).toLocaleString()} 돌파\n` +
      `진입가 ${Math.round(entryPrice).toLocaleString()} / 수량 ${qty.toFixed(8)}`,
  );
}

async function exitPosition(
  bot: { id: number; userId: number; market: string },
  holding: { id: number; entryPrice: number; qty: number; isLive: boolean },
  currentPrice: number,
  reason: ExitReason,
): Promise<void> {
  let exitPrice = currentPrice; // 모의: 현재가 가상 체결
  let qty = holding.qty;

  if (holding.isLive) {
    // uuid를 try 바깥에 보존 — sellMarket 성공 후 waitForFill 타임아웃 시
    // 운영자가 사후 수동 확인할 수 있도록 알림에 포함
    let sellOrderUuid: string | null = null;
    try {
      const upbit = await getUpbitClientFor(bot.userId);
      const order = await upbit.sellMarket(bot.market, holding.qty);
      sellOrderUuid = order.uuid;
      const filled = await waitForFill(upbit, order.uuid);
      exitPrice = filled.avgPrice;
      qty = filled.qty;
    } catch (e: any) {
      // 매도 실패는 재시도함 (포지션 방치가 더 위험) — 다음 사이클의 조건 재평가가 자연 재시도
      console.error(`[VolatilityBreakout] bot=${bot.id} 매도 실패(${reason}, uuid=${sellOrderUuid ?? 'none'}):`, e.message);
      if (sellOrderUuid) {
        notify(
          `[변동성돌파 ❌ ${reason} 매도 체결 확인 실패] ${bot.market} (uuid=${sellOrderUuid}) — 다음 사이클 재시도: ${e.message}`,
        );
      } else {
        notify(`[변동성돌파 ⚠️ 매도 실패] ${bot.market} (${reason})\n${e.message}\n다음 사이클 재시도`);
      }
      return;
    }
  }

  // 수수료 차감 손익: 매수·매도 각 0.05% 가정 (모의/실거래 동일 공식 — 실거래 실측은 paid_fee 비교로 검증)
  const entryCostKrw = holding.entryPrice * holding.qty * (1 + FEE_PCT_PER_SIDE / 100);
  const exitNetKrw = exitPrice * qty * (1 - FEE_PCT_PER_SIDE / 100);
  const pnlKrw = exitNetKrw - entryCostKrw;
  const pnlPct = (pnlKrw / entryCostKrw) * 100;

  await prisma.volatilityBreakoutTrade.update({
    where: { id: holding.id },
    data: {
      exitPrice,
      exitAt: new Date(),
      exitReason: reason,
      pnlKrw,
      pnlPct,
      status: 'CLOSED',
    },
  });

  const emoji = reason === 'STOP' ? '🛑 손절' : '🔔 청산';
  notify(
    `[변동성돌파 ${emoji}${holding.isLive ? '' : ' (모의)'}] ${bot.market}\n` +
      `진입 ${Math.round(holding.entryPrice).toLocaleString()} → 청산 ${Math.round(exitPrice).toLocaleString()}\n` +
      `손익 ${Math.round(pnlKrw).toLocaleString()} KRW (${pnlPct.toFixed(2)}%)`,
  );
}
