// 빗썸 단일 거래소 스테이블코인 차익거래 에이전트
//
// 5초마다 ArbAutoConfig를 조회하여 bithumbEnabled=true이면 활성화.
// 지원 코인 호가 조회 → 최적 기회 탐색 → 일일 한도 체크 → 차익거래 실행 → DB 기록.
//
// 동시 실행 방지: cycleInFlight 플래그로 한 사이클에 최대 1건 실행.

import { BaseAgent } from './base-agent';
import { stablecoinPrisma } from '../config/database';
import mainPrisma from '../config/database';
import { decrypt } from '../utils/encryption';
import { BithumbClient } from '../services/exchange/bithumb-client';
import { fetchBithumbOrderbooks } from '../services/bithumb-price-manager';
import {
  findBestOpportunity,
  executeArb,
} from '../services/bithumb-single-arb.service';

/** 폴링 간격 (5초) */
const CYCLE_INTERVAL_MS = 5_000;

/** Bithumb 자격증명 조회 대상 admin userId */
const BITHUMB_ADMIN_USER_ID = 2;

/**
 * 한국 시간(UTC+9) 기준 오늘 00:00 의 UTC Date.
 * 일일 카운트 / 손실 집계 윈도우 시작점.
 */
function startOfTodayKst(): Date {
  const now = new Date();
  const kstMs = now.getTime() + 9 * 60 * 60 * 1000;
  const kstDate = new Date(kstMs);
  kstDate.setUTCHours(0, 0, 0, 0);
  return new Date(kstDate.getTime() - 9 * 60 * 60 * 1000);
}

/**
 * 빗썸 단일 거래소 스테이블코인 차익거래 에이전트.
 *
 * 비유: 한 환전소 내에서 두 종류 외화(USDT/USDC)의 매입/매도 가격 차이를
 * 포착해 순간적으로 교환하며 스프레드 수익을 챙기는 환전상.
 *
 * 5초마다 enabled 여부 확인 → 호가 조회 → 기회 탐색 → 실행 → 기록.
 */
export class BithumbArbAgent extends BaseAgent {
  private bithumb: BithumbClient | null = null;
  private cycleInFlight = false;

  constructor() {
    super({
      id: 'bithumb-arb',
      name: 'BithumbArbAgent',
      description: '빗썸 단일 거래소 스테이블코인 차익거래 (5초 cycle)',
      cycleIntervalMs: CYCLE_INTERVAL_MS,
    });
  }

  /**
   * 에이전트 시작 시 Bithumb 자격증명 로드 + 복호화.
   * 자격증명 누락은 throw → BaseAgent가 status='error'로 표면화.
   */
  protected async onStart(): Promise<void> {
    const bithumbCredential = await mainPrisma.credential.findFirst({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: { userId: BITHUMB_ADMIN_USER_ID, exchange: 'bithumb' as any },
    });

    if (!bithumbCredential) {
      throw new Error(
        `[BithumbArb] Bithumb credential 없음 (userId=${BITHUMB_ADMIN_USER_ID}). 설정 > API 키에서 bithumb 키를 등록하세요.`,
      );
    }

    this.bithumb = new BithumbClient({
      accessKey: decrypt(bithumbCredential.apiKey),
      secretKey: decrypt(bithumbCredential.secretKey),
    });

    console.log('[BithumbArb] 시작 — 5초마다 차익 기회 탐색');
  }

  protected async onStop(): Promise<void> {
    this.bithumb = null;
    console.log('[BithumbArb] 정지');
  }

  protected async onCycle(): Promise<void> {
    if (this.cycleInFlight) return;
    if (!this.bithumb) return;

    this.cycleInFlight = true;
    try {
      await this.processCycle();
    } catch (err: any) {
      this.metrics.errors++;
      this.metrics.lastError = err.message;
      console.error('[BithumbArb] processCycle 실패:', err.message);
    } finally {
      this.cycleInFlight = false;
    }
  }

  private async processCycle(): Promise<void> {
    if (!this.bithumb) return;

    // 1. 글로벌 설정 조회 — bithumbEnabled 확인
    const config = await stablecoinPrisma.arbAutoConfig.findFirst();
    if (!config || !config.bithumbEnabled) return;

    // bithumbCoins는 JSON 배열 타입 → string[] 캐스팅
    const coins = config.bithumbCoins as string[];
    if (!Array.isArray(coins) || coins.length < 2) return;

    // 2. 지원 코인 호가 조회 (API 응답으로 지원 여부 동적 필터)
    const books = await fetchBithumbOrderbooks(coins);
    if (books.size < 2) return;

    // 3. 최적 차익 기회 탐색
    const opp = findBestOpportunity(books, config.bithumbMinSpreadBps);
    if (!opp) return;

    // 4. 일일 한도 체크 (KST 자정 기준)
    const sinceAt = startOfTodayKst();

    const [todayCount, lossAgg] = await Promise.all([
      // 모든 시도 카운트 (성공/실패 무관)
      stablecoinPrisma.bithumbSingleArbTrade.count({
        where: { createdAt: { gte: sinceAt } },
      }),
      // FILLED 중 손실(profitKrw < 0)만 합산
      stablecoinPrisma.bithumbSingleArbTrade.aggregate({
        _sum: { profitKrw: true },
        where: {
          status: 'FILLED',
          createdAt: { gte: sinceAt },
          profitKrw: { lt: 0 },
        },
      }),
    ]);

    // 일일 거래 건수 한도 초과 시 스킵
    if (todayCount >= config.bithumbDailyCountLimit) {
      console.log(
        `[BithumbArb] 일일 거래 한도 도달 (${todayCount}/${config.bithumbDailyCountLimit})`,
      );
      return;
    }

    // 일일 손실 한도 초과 시 스킵 (로그만, killSwitch 없음)
    const todayLossKrw =
      lossAgg._sum.profitKrw == null
        ? 0
        : Math.abs(Number(lossAgg._sum.profitKrw));

    if (todayLossKrw >= config.bithumbDailyLossLimitKrw) {
      console.log(
        `[BithumbArb] 일일 손실 한도 도달 (${todayLossKrw}/${config.bithumbDailyLossLimitKrw} KRW)`,
      );
      return;
    }

    // 5. 차익거래 실행
    const result = await executeArb(this.bithumb, opp, config.bithumbQty);

    // 6. 거래 기록 DB 저장
    try {
      await stablecoinPrisma.bithumbSingleArbTrade.create({
        data: {
          coinSell: opp.coinSell,
          coinBuy: opp.coinBuy,
          qty: config.bithumbQty,
          spreadBpsAtExec: opp.spreadBps,
          legASellOrderId: result.legASellOrderId ?? null,
          legAFilledQty: result.legAFilledQty ?? null,
          legAAvgPriceKrw: result.legAAvgPriceKrw ?? null,
          legAFeeKrw: result.legAFeeKrw ?? null,
          legAReceivedKrw: result.legAReceivedKrw ?? null,
          legBBuyOrderId: result.legBBuyOrderId ?? null,
          legBFilledQty: result.legBFilledQty ?? null,
          legBAvgPriceKrw: result.legBAvgPriceKrw ?? null,
          legBFeeKrw: result.legBFeeKrw ?? null,
          legBSpentKrw: result.legBSpentKrw ?? null,
          profitKrw: result.profitKrw ?? null,
          status: result.status,
          failureReason: result.failureReason ?? null,
          completedAt: result.status === 'FILLED' ? new Date() : null,
        },
      });
    } catch (dbErr: any) {
      // DB 기록 실패는 에러 카운트 증가만 — 자금 노출 위험은 낮음 (단일 거래소)
      this.metrics.errors++;
      this.metrics.lastError = `DB 기록 실패: ${dbErr.message}`;
      console.error('[BithumbArb] 거래 DB 기록 실패:', dbErr.message);
      return;
    }

    if (result.status === 'FILLED') {
      console.log(
        `[BithumbArb] FILLED: ${opp.coinSell}→${opp.coinBuy} qty=${config.bithumbQty} profit=${result.profitKrw?.toFixed(2)} KRW spread=${opp.spreadBps}bps`,
      );
    } else {
      console.warn(
        `[BithumbArb] ${result.status}: ${result.failureReason ?? '원인 불명'}`,
      );
    }

    // 7. 손실 누적 재확인 — 한도 초과 시 경고 로그 (killSwitch 없음, 운영자 수동 대응)
    if (result.status === 'FILLED' && result.profitKrw != null && result.profitKrw < 0) {
      const newLoss = todayLossKrw + Math.abs(result.profitKrw);
      if (newLoss >= config.bithumbDailyLossLimitKrw) {
        console.warn(
          `[BithumbArb] 일일 손실 한도 초과 경고: 누적 손실 ${newLoss.toFixed(0)} KRW >= 한도 ${config.bithumbDailyLossLimitKrw} KRW. 다음 사이클부터 자동 중단.`,
        );
      }
    }
  }
}
