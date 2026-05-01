import { BaseAgent } from './base-agent';
import { stablecoinPrisma } from '../config/database';
import mainPrisma from '../config/database';
import { decrypt } from '../utils/encryption';
import { UpbitClient } from '../services/exchange/upbit-client';
import { BithumbClient } from '../services/exchange/bithumb-client';
import { ExchangeClient, BalanceEntry } from '../services/exchange/exchange-client';
import {
  isSpreadProfitable,
  OrderbookSnapshot,
} from '../services/cross-exchange-spread-gate';
import {
  runAll as runPrecheckAll,
  PrecheckArgs,
} from '../services/cross-exchange-precheck';
import { execute as runExecutor } from '../services/cross-exchange-executor';

/** 폴링 간격 (5초). 호가 변동 + REST 호출 부담 사이 균형. */
const CYCLE_INTERVAL_MS = 5_000;

/** Upbit 자격증명 lookup 대상 admin userId. */
const UPBIT_ADMIN_USER_ID = 2;

/**
 * BalanceEntry 사전 → precheck 가 요구하는 number 사전 변환.
 * (.available 만 사용 — locked 는 매매 불가 잔고)
 */
function toNumberBalances(
  raw: Record<string, BalanceEntry>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v.available]),
  );
}

/**
 * 한국 시간(UTC+9) 기준 오늘 00:00 의 UTC Date.
 * dailyCountLimit / dailyLossLimitKrw 집계 윈도우 시작점.
 */
function startOfTodayKst(): Date {
  const now = new Date();
  const kstMs = now.getTime() + 9 * 60 * 60 * 1000;
  const kstDate = new Date(kstMs);
  kstDate.setUTCHours(0, 0, 0, 0);
  return new Date(kstDate.getTime() - 9 * 60 * 60 * 1000);
}

/**
 * Upbit-Bithumb 크로스-거래소 차익거래 에이전트 (Stage 1 canary).
 *
 * 비유: 두 환전소에서 같은 외화를 사고팔며 가격차로 수익을 내는 환전상.
 * 5초마다 enabled+killSwitch=false 봇을 모두 검사하여:
 *   1. 양 거래소 호가/잔고 조회
 *   2. spread → depeg → liquidity → balance → daily limit 5단계 precheck
 *   3. 통과 시 LegA(매수) → LegB(매도) sequential executor 실행
 *   4. 결과를 CrossExchangeArbTrade 에 기록
 *   5. shouldKillSwitch=true 면 자동으로 killSwitch=true 토글
 */
export class CrossExchangeArbAgent extends BaseAgent {
  private upbit: ExchangeClient | null = null;
  private bithumb: ExchangeClient | null = null;
  private cycleInFlight = false;

  constructor() {
    super({
      id: 'cross-exchange-arb',
      name: 'CrossExchangeArbAgent',
      description: 'Upbit-Bithumb 크로스-거래소 차익거래 (5초 cycle, Stage 1 canary)',
      cycleIntervalMs: CYCLE_INTERVAL_MS,
    });
  }

  protected async onStart(): Promise<void> {
    // Upbit: prisma.credential 에서 admin user(=2) 의 upbit 자격증명 로드 후 복호화
    try {
      const credential = await mainPrisma.credential.findFirst({
        where: { userId: UPBIT_ADMIN_USER_ID, exchange: 'upbit' },
      });
      if (!credential) {
        console.warn(
          `[CrossExchangeArb] Upbit credential 없음 (userId=${UPBIT_ADMIN_USER_ID}) — clients null 유지`,
        );
        return;
      }
      const accessKey = decrypt(credential.apiKey);
      const secretKey = decrypt(credential.secretKey);
      this.upbit = new UpbitClient({ accessKey, secretKey });
    } catch (err: any) {
      console.warn('[CrossExchangeArb] Upbit credential 로드 실패:', err.message);
      return;
    }

    // Bithumb: env 직접 (Stage 1 단순화 — 글로벌 admin 키 1조만 운영)
    const bithumbAccessKey = process.env.BITHUMB_ACCESS_KEY;
    const bithumbSecretKey = process.env.BITHUMB_SECRET_KEY;
    if (!bithumbAccessKey || !bithumbSecretKey) {
      console.warn('[CrossExchangeArb] BITHUMB_ACCESS_KEY/SECRET_KEY env 없음 — clients null 유지');
      this.upbit = null;
      return;
    }
    this.bithumb = new BithumbClient({
      accessKey: bithumbAccessKey,
      secretKey: bithumbSecretKey,
    });

    console.log('[CrossExchangeArb] 시작 — 5초마다 enabled 봇 평가');
  }

  protected async onStop(): Promise<void> {
    console.log('[CrossExchangeArb] 정지');
  }

  protected async onCycle(): Promise<void> {
    if (this.cycleInFlight) return;
    if (!this.upbit || !this.bithumb) return;

    this.cycleInFlight = true;
    try {
      const bots = await stablecoinPrisma.crossExchangeArbBot.findMany({
        where: { enabled: true, killSwitch: false },
      });
      if (bots.length === 0) return;

      for (const bot of bots) {
        try {
          await this.processBot(bot);
        } catch (err: any) {
          this.metrics.errors++;
          this.metrics.lastError = err.message;
          console.error(
            `[CrossExchangeArb] bot ${bot.id} processBot 실패:`,
            err.message,
          );
        }
      }
    } finally {
      this.cycleInFlight = false;
    }
  }

  private async processBot(
    bot: Awaited<ReturnType<typeof stablecoinPrisma.crossExchangeArbBot.findMany>>[number],
  ): Promise<void> {
    const upbit = this.upbit!;
    const bithumb = this.bithumb!;

    // 양 거래소 호가 동시 조회 (한쪽만 살아있어도 의미 없음)
    const [upbitBook, bithumbBook] = await Promise.all([
      upbit.getOrderbookTop(bot.coin),
      bithumb.getOrderbookTop(bot.coin),
    ]);
    if (!upbitBook || !bithumbBook) return;

    const snapshot: OrderbookSnapshot = {
      upbitBid: upbitBook.bid,
      upbitAsk: upbitBook.ask,
      bithumbBid: bithumbBook.bid,
      bithumbAsk: bithumbBook.ask,
    };

    const direction = bot.targetDirection as 'UB' | 'BU';

    // 호가 유효성 + 실제 spread 측정 (minSpreadBps=0 으로 호출 → ok=false 면 호가 자체가 invalid)
    const spreadProbe = isSpreadProfitable(snapshot, direction, 0);
    if (!spreadProbe.ok) return;
    const spreadBps = spreadProbe.spreadBps;

    // 잔고 동시 조회
    let upbitBalances: Record<string, BalanceEntry>;
    let bithumbBalances: Record<string, BalanceEntry>;
    try {
      [upbitBalances, bithumbBalances] = await Promise.all([
        upbit.getBalances(),
        bithumb.getBalances(),
      ]);
    } catch (err: any) {
      console.error(`[CrossExchangeArb] bot ${bot.id} 잔고 조회 실패:`, err.message);
      return;
    }

    // 일일 카운트 + 손실 집계 (KST 자정 이후 FILLED 만)
    const sinceAt = startOfTodayKst();
    const [todayCount, lossAgg] = await Promise.all([
      stablecoinPrisma.crossExchangeArbTrade.count({
        where: { botId: bot.id, status: 'FILLED', createdAt: { gte: sinceAt } },
      }),
      stablecoinPrisma.crossExchangeArbTrade.aggregate({
        _sum: { profitKrw: true },
        where: {
          botId: bot.id,
          status: 'FILLED',
          createdAt: { gte: sinceAt },
          profitKrw: { lt: 0 },
        },
      }),
    ]);
    // profitKrw 음수 합 → precheck 가 기대하는 양수 KRW 손실량으로 변환
    const lossSumRaw = lossAgg._sum.profitKrw;
    const todayLossKrw = lossSumRaw == null ? 0 : Math.abs(Number(lossSumRaw));

    const precheckArgs: PrecheckArgs = {
      snapshot,
      direction,
      bot: {
        coin: bot.coin,
        quantity: bot.quantity,
        minSpreadBps: bot.minSpreadBps,
        depegMinKrw: bot.depegMinKrw,
        depegMaxKrw: bot.depegMaxKrw,
        liquidityMultiplier: bot.liquidityMultiplier,
        dailyCountLimit: bot.dailyCountLimit,
        dailyLossLimitKrw: bot.dailyLossLimitKrw,
      },
      liquidity: {
        upbitBidQty: upbitBook.bidQty,
        upbitAskQty: upbitBook.askQty,
        bithumbBidQty: bithumbBook.bidQty,
        bithumbAskQty: bithumbBook.askQty,
      },
      balances: {
        upbit: toNumberBalances(upbitBalances),
        bithumb: toNumberBalances(bithumbBalances),
      },
      todayCount,
      todayLossKrw,
    };

    const precheck = runPrecheckAll(precheckArgs);
    if (!precheck.ok) {
      console.log(
        `[CrossExchangeArb] bot ${bot.id} skip: ${precheck.abortReason}`,
      );
      return;
    }

    // executor 실행
    const result = await runExecutor({
      botId: bot.id,
      direction,
      coin: bot.coin,
      quantity: bot.quantity,
      spreadBps,
      upbit,
      bithumb,
    });

    // direction 으로 leg 거래소/사이드 도출 (executor isUB 매핑과 동일).
    // schema 가 NOT NULL 요구 — result.legA/legB 가 undefined 여도 row 에는 항상 채움.
    const isUB = direction === 'UB';
    const legAExchange = isUB ? 'upbit' : 'bithumb';
    const legBExchange = isUB ? 'bithumb' : 'upbit';

    await stablecoinPrisma.crossExchangeArbTrade.create({
      data: {
        botId: bot.id,
        direction,
        spreadBpsAtPlacement: spreadBps,
        legAExchange,
        legASide: 'buy',
        legAOrderId: result.legA?.orderId ?? null,
        legAFilledQty: result.legA?.filledQty ?? null,
        legAAvgPrice: result.legA?.avgFillPrice ?? null,
        legAFeeKrw: result.legA?.totalFeeKrw ?? null,
        legBExchange,
        legBSide: 'sell',
        legBOrderId: result.legB?.orderId ?? null,
        legBFilledQty: result.legB?.filledQty ?? null,
        legBAvgPrice: result.legB?.avgFillPrice ?? null,
        legBFeeKrw: result.legB?.totalFeeKrw ?? null,
        profitKrw: result.profitKrw ?? null,
        status: result.status,
        failureReason: result.failureReason ?? null,
        completedAt: result.status === 'FILLED' ? new Date() : null,
      },
    });

    if (result.status === 'FILLED') {
      console.log(
        `[CrossExchangeArb] bot ${bot.id} FILLED: profit=${result.profitKrw?.toFixed(2)} KRW spread=${spreadBps}bps`,
      );
    }

    // 자동 kill switch (LegB 실패 등 재고 노출 시나리오)
    if (result.shouldKillSwitch) {
      await stablecoinPrisma.crossExchangeArbBot.update({
        where: { id: bot.id },
        data: { killSwitch: true },
      });
      console.error(
        `[CrossExchangeArb] bot ${bot.id} killSwitch 자동 ON: ${result.failureReason}`,
      );
    }
  }
}
