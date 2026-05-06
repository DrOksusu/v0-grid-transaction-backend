import { BaseAgent } from './base-agent';
import { stablecoinPrisma } from '../config/database';
import mainPrisma from '../config/database';
import { decrypt } from '../utils/encryption';
import { PushService } from '../services/push.service';
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
  /** DB write 실패 / killSwitch 적용 실패 시 즉시 차단할 봇 ID 집합. process 재시작 시 초기화. */
  private emergencyBlocked: Set<number> = new Set();

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
    // 자격증명 누락은 throw — BaseAgent 가 status='error' + lastError 로 표면화 (silent disable 방지).
    const credential = await mainPrisma.credential.findFirst({
      where: { userId: UPBIT_ADMIN_USER_ID, exchange: 'upbit' },
    });
    if (!credential) {
      throw new Error(`[CrossExchangeArb] Upbit credential 없음 (userId=${UPBIT_ADMIN_USER_ID})`);
    }
    const accessKey = decrypt(credential.apiKey);
    const secretKey = decrypt(credential.secretKey);
    this.upbit = new UpbitClient({ accessKey, secretKey });

    // Bithumb: prisma.credential 에서 admin user 의 bithumb 자격증명 로드 후 복호화
    const bithumbCredential = await mainPrisma.credential.findFirst({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: { userId: UPBIT_ADMIN_USER_ID, exchange: 'bithumb' as any },
    });
    if (!bithumbCredential) {
      throw new Error(`[CrossExchangeArb] Bithumb credential 없음 (userId=${UPBIT_ADMIN_USER_ID}). 설정 > API 키에서 bithumb 키를 등록하세요.`);
    }
    this.bithumb = new BithumbClient({
      accessKey: decrypt(bithumbCredential.apiKey),
      secretKey: decrypt(bithumbCredential.secretKey),
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

      // 이번 사이클에 필요한 코인 목록 수집 — 거래소별 중복 제거
      const upbitCoins = new Set<string>();
      const bithumbCoins = new Set<string>();
      for (const bot of bots) {
        const buyCoin = bot.buyCoin ?? bot.coin;
        const sellCoin = bot.sellCoin ?? bot.coin;
        if (bot.targetDirection === 'UB') {
          upbitCoins.add(buyCoin);
          bithumbCoins.add(sellCoin);
        } else {
          bithumbCoins.add(buyCoin);
          upbitCoins.add(sellCoin);
        }
      }

      // 호가 + 잔고를 사이클당 1회씩만 병렬 조회
      const [upbitBookMap, bithumbBookMap, upbitBalances, bithumbBalances] =
        await Promise.all([
          Promise.all(
            [...upbitCoins].map(async (coin) => {
              const book = await this.upbit!.getOrderbookTop(coin);
              return [coin, book] as const;
            }),
          ).then((entries) => new Map(entries)),
          Promise.all(
            [...bithumbCoins].map(async (coin) => {
              const book = await this.bithumb!.getOrderbookTop(coin);
              return [coin, book] as const;
            }),
          ).then((entries) => new Map(entries)),
          this.upbit.getBalances().catch((err: any) => {
            console.error('[CrossExchangeArb] Upbit 잔고 조회 실패:', err.message);
            return null;
          }),
          this.bithumb.getBalances().catch((err: any) => {
            console.error('[CrossExchangeArb] Bithumb 잔고 조회 실패:', err.message);
            return null;
          }),
        ]);

      if (!upbitBalances || !bithumbBalances) return;

      for (const bot of bots) {
        try {
          await this.processBot(bot, upbitBookMap, bithumbBookMap, upbitBalances, bithumbBalances);
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
    upbitBookMap: Map<string, Awaited<ReturnType<ExchangeClient['getOrderbookTop']>>>,
    bithumbBookMap: Map<string, Awaited<ReturnType<ExchangeClient['getOrderbookTop']>>>,
    upbitBalances: Record<string, BalanceEntry>,
    bithumbBalances: Record<string, BalanceEntry>,
  ): Promise<void> {
    // emergency blocklist: DB write 실패 / killSwitch 실패 fallback. process 재시작 전까지 차단.
    if (this.emergencyBlocked.has(bot.id)) return;
    if (!this.upbit || !this.bithumb) return;
    const upbit = this.upbit;
    const bithumb = this.bithumb;

    // 이종 코인 지원: buyCoin/sellCoin null이면 coin 으로 fallback
    const buyCoin = bot.buyCoin ?? bot.coin;
    const sellCoin = bot.sellCoin ?? bot.coin;
    const direction = bot.targetDirection as 'UB' | 'BU';
    const isUB = direction === 'UB';

    // 캐시된 호가 맵에서 조회 — UB: upbit=buyCoin, bithumb=sellCoin / BU: 반대
    const buyExchangeBook = isUB ? upbitBookMap.get(buyCoin) : bithumbBookMap.get(buyCoin);
    const sellExchangeBook = isUB ? bithumbBookMap.get(sellCoin) : upbitBookMap.get(sellCoin);
    if (!buyExchangeBook || !sellExchangeBook) return;

    // OrderbookSnapshot: upbit* = 업비트 측 가격, bithumb* = 빗썸 측 가격
    const upbitBook = isUB ? buyExchangeBook : sellExchangeBook;
    const bithumbBook = isUB ? sellExchangeBook : buyExchangeBook;
    const snapshot: OrderbookSnapshot = {
      upbitBid: upbitBook.bid,
      upbitAsk: upbitBook.ask,
      bithumbBid: bithumbBook.bid,
      bithumbAsk: bithumbBook.ask,
    };

    // 호가 유효성 + 실제 spread 측정 (minSpreadBps=0 으로 호출 → ok=false 면 호가 자체가 invalid)
    const spreadProbe = isSpreadProfitable(snapshot, direction, 0);
    if (!spreadProbe.ok) return;
    const spreadBps = spreadProbe.spreadBps;

    // 일일 카운트 + 손실 집계 (KST 자정 기준)
    // todayCount 는 모든 row (FILLED + LEG_A_FAILED + LEG_B_FAILED) — 실패 누적도 dailyCountLimit 에 카운트
    // todayLossKrw 는 FILLED + profitKrw<0 만 — 실패는 손실 미반영
    const sinceAt = startOfTodayKst();
    const [todayCount, lossAgg] = await Promise.all([
      stablecoinPrisma.crossExchangeArbTrade.count({
        where: { botId: bot.id, createdAt: { gte: sinceAt } },
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
        sellCoin: sellCoin !== bot.coin ? sellCoin : undefined,
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

    // executor 실행 (호가 정보 전달 → bithumb market_buy KRW 동적 산정)
    const result = await runExecutor({
      botId: bot.id,
      direction,
      coin: bot.coin,
      buyCoin: buyCoin !== bot.coin ? buyCoin : undefined,
      sellCoin: sellCoin !== bot.coin ? sellCoin : undefined,
      quantity: bot.quantity,
      spreadBps,
      upbit,
      bithumb,
      upbitAskKrw: upbitBook.ask,
      bithumbAskKrw: bithumbBook.ask,
    });

    // direction 으로 leg 거래소/사이드 도출 (executor isUB 매핑과 동일).
    // schema 가 NOT NULL 요구 — result.legA/legB 가 undefined 여도 row 에는 항상 채움.
    const legAExchange = isUB ? 'upbit' : 'bithumb';
    const legBExchange = isUB ? 'bithumb' : 'upbit';

    // === 거래소 체결 발생 후 DB 기록 — 실패 시 자본 노출 누적 위험 ===
    try {
      await stablecoinPrisma.crossExchangeArbTrade.create({
        data: {
          botId: bot.id,
          direction,
          spreadBpsAtPlacement: spreadBps,
          legAExchange,
          legASide: 'buy',
          legACoin: buyCoin,
          legAOrderId: result.legA?.orderId ?? null,
          legAFilledQty: result.legA?.filledQty ?? null,
          legAAvgPrice: result.legA?.avgFillPrice ?? null,
          legAFeeKrw: result.legA?.totalFeeKrw ?? null,
          legBExchange,
          legBSide: 'sell',
          legBCoin: sellCoin,
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
    } catch (err) {
      // 거래소 체결 발생했는데 DB 기록 실패 → 즉시 봇 차단 (5건 cap 무력화 + 다음 cycle 또 거래 위험)
      this.emergencyBlocked.add(bot.id);
      console.error(
        `[CrossExchangeArb] bot ${bot.id} TRADE ROW WRITE FAILED — emergency blocked. status=${result.status}, profit=${result.profitKrw ?? 'n/a'}, err=${(err as any)?.message}`,
      );
      // killSwitch 도 시도 — DB 가 회복돼도 다른 instance/restart 시 자동 차단되도록
      try {
        await stablecoinPrisma.crossExchangeArbBot.update({
          where: { id: bot.id },
          data: { killSwitch: true },
        });
      } catch (killErr) {
        console.error(
          `[CrossExchangeArb] bot ${bot.id} killSwitch update ALSO FAILED — emergencyBlocked remains in-memory only. err=${(killErr as any)?.message}`,
        );
      }
      return; // shouldKillSwitch 분기 건너뛰고 다음 봇으로
    }

    if (result.status === 'FILLED') {
      console.log(
        `[CrossExchangeArb] bot ${bot.id} FILLED: profit=${result.profitKrw?.toFixed(2)} KRW spread=${spreadBps}bps`,
      );
    }

    // LegB 실패 시 push 알림
    if (result.status === 'LEG_B_FAILED') {
      PushService.sendToUser(UPBIT_ADMIN_USER_ID, {
        title: '[긴급] CrossExchange LegB 실패',
        body: `bot #${bot.id} (${bot.coin} ${bot.targetDirection}) — ${result.failureReason ?? '원인 불명'}. 재고 노출 가능. 즉시 확인 필요.`,
        tag: `cross-exchange-legb-fail-${bot.id}`,
      }).catch((err: any) =>
        console.error(`[CrossExchangeArb] push 전송 실패:`, err?.message),
      );
    }

    // 자동 kill switch (LegB 실패 등 재고 노출 시나리오)
    if (result.shouldKillSwitch) {
      try {
        await stablecoinPrisma.crossExchangeArbBot.update({
          where: { id: bot.id },
          data: { killSwitch: true },
        });
        console.error(
          `[CrossExchangeArb] bot ${bot.id} autoKillSwitch ON: ${result.failureReason}`,
        );
      } catch (err) {
        // killSwitch DB update 실패 → in-memory blocklist 로 fallback (재고 노출 상태로 재거래 방지)
        this.emergencyBlocked.add(bot.id);
        console.error(
          `[CrossExchangeArb] bot ${bot.id} killSwitch update FAILED — emergencyBlocked in-memory. Restart 시 잃을 수 있으므로 운영자 즉시 개입 필요. err=${(err as any)?.message}`,
        );
      }
    }
  }
}
