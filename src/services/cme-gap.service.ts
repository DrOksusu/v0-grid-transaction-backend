/**
 * CME 갭 매매 서비스
 *
 * CME(시카고상업거래소) BTC 선물의 주말 갭을 이용한 자동매매 봇 핵심 로직.
 *
 * - 하방 갭(down): 월요일 시가가 금요일 종가보다 낮음 → 즉시 시장가 매수, 금요일 종가에 익절
 * - 상방 갭(up): 월요일 시가가 금요일 종가보다 높음 → 가격이 갭 구간으로 진입 시 매수, 월요일 시가에 익절
 *
 * 업비트 BTC/KRW 가격을 기준으로 CME 갭을 근사:
 *   - 토요일 07:00 KST: CME 금요일 종가 (fridayCloseKrw) 기록
 *   - 월요일 07:00 KST: CME 월요일 시가 (mondayOpenKrw) 기록 → 갭 계산
 *
 * ⚠️ 주의: fridayCloseKrw는 인메모리 저장 → 서버 재시작 시 유실됨.
 *    토요일~월요일 사이에 재시작이 발생하면 당주 갭 감지를 놓칠 수 있음.
 *    향후 개선: CmeGapBot 테이블에 fridayCloseKrw 컬럼 추가하거나 별도 싱글톤 Row 활용 권고.
 */

import prisma from '../config/database';
import { UpbitService } from './upbit.service';
import { config } from '../config/env';

// ───────────────────────────────────────
// 타입 정의
// ───────────────────────────────────────

/** CME 갭 봇 생성 요청 파라미터 */
export interface CreateCmeGapBotParams {
  name?: string;
  quantity: number;   // BTC 수량 (예: 0.01)
  minGapPct: number;  // 최소 갭 크기 % (예: 0.3)
  enabled?: boolean;
  live?: boolean;
}

/** CME 갭 봇 수정 요청 파라미터 */
export interface UpdateCmeGapBotParams {
  name?: string;
  quantity?: number;
  minGapPct?: number;
  enabled?: boolean;
  live?: boolean;
}

/** 갭 목록 조회 필터 */
export interface GetGapsFilter {
  botId?: number;
  status?: string;
}

// ───────────────────────────────────────
// ISO 주차 계산 유틸리티
// ───────────────────────────────────────

/**
 * 날짜로부터 ISO 주차 키 생성 (예: "2026-W20")
 * ISO 8601 기준: 월요일 시작, 1월 첫 주는 해당 주에 목요일이 포함된 주
 */
function getIsoWeekKey(date: Date): string {
  // 목요일이 포함된 주를 기준으로 ISO 주차 계산
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));

  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const weekNum = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86400000 + ((yearStart.getUTCDay() + 6) % 7) + 1) / 7
  );

  const paddedWeek = weekNum.toString().padStart(2, '0');
  return `${thursday.getUTCFullYear()}-W${paddedWeek}`;
}

// ───────────────────────────────────────
// CME 갭 서비스 (싱글톤)
// ───────────────────────────────────────

class CmeGapService {
  /**
   * 인메모리 금요일 종가 저장소
   * ⚠️ 서버 재시작 시 유실되는 한계가 있음 (주석 상단 설명 참고)
   */
  private fridayCloseKrw: number | null = null;

  /** 당주 fridayClose 기록 완료 여부 (중복 기록 방지) */
  private fridayCloseRecordedWeek: string | null = null;

  /** 당주 mondayOpen 기록 완료 여부 (중복 기록 방지) */
  private mondayOpenRecordedWeek: string | null = null;

  // ─────────────────────────────────────
  // 봇 CRUD
  // ─────────────────────────────────────

  /** 전체 봇 목록 조회 */
  async getBots() {
    return prisma.cmeGapBot.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { gaps: true } },
      },
    });
  }

  /** 봇 생성 */
  async createBot(params: CreateCmeGapBotParams) {
    return prisma.cmeGapBot.create({
      data: {
        name: params.name ?? 'BTC CME 갭 봇',
        quantity: params.quantity,
        minGapPct: params.minGapPct,
        enabled: params.enabled ?? true,
        live: params.live ?? false,
      },
    });
  }

  /** 봇 수정 */
  async updateBot(id: number, params: UpdateCmeGapBotParams) {
    return prisma.cmeGapBot.update({
      where: { id },
      data: {
        ...(params.name !== undefined && { name: params.name }),
        ...(params.quantity !== undefined && { quantity: params.quantity }),
        ...(params.minGapPct !== undefined && { minGapPct: params.minGapPct }),
        ...(params.enabled !== undefined && { enabled: params.enabled }),
        ...(params.live !== undefined && { live: params.live }),
      },
    });
  }

  /** 봇 삭제 */
  async deleteBot(id: number) {
    // 연결된 갭 레코드 먼저 삭제 후 봇 삭제 (FK 제약)
    await prisma.cmeGap.deleteMany({ where: { botId: id } });
    return prisma.cmeGapBot.delete({ where: { id } });
  }

  // ─────────────────────────────────────
  // 갭 조회 / 통계
  // ─────────────────────────────────────

  /** 갭 목록 조회 (선택적 필터 적용) */
  async getGaps(filter: GetGapsFilter = {}) {
    return prisma.cmeGap.findMany({
      where: {
        ...(filter.botId !== undefined && { botId: filter.botId }),
        ...(filter.status !== undefined && { status: filter.status }),
      },
      orderBy: { detectedAt: 'desc' },
      include: {
        bot: { select: { id: true, name: true } },
      },
    });
  }

  /** 통계 요약 조회 */
  async getStats() {
    const [totalGaps, watchingGaps, enteredGaps, tpOrderedGaps, filledGaps, expiredGaps] =
      await Promise.all([
        prisma.cmeGap.count(),
        prisma.cmeGap.count({ where: { status: 'watching' } }),
        prisma.cmeGap.count({ where: { status: 'entered' } }),
        prisma.cmeGap.count({ where: { status: 'tp_ordered' } }),
        prisma.cmeGap.count({ where: { status: 'filled' } }),
        prisma.cmeGap.count({ where: { status: 'expired' } }),
      ]);

    // 총 실현 손익 합산
    const pnlAggregate = await prisma.cmeGap.aggregate({
      where: { status: 'filled' },
      _sum: { pnlKrw: true },
      _avg: { pnlPct: true },
    });

    return {
      totalGaps,
      byStatus: {
        watching: watchingGaps,
        entered: enteredGaps,
        tp_ordered: tpOrderedGaps,
        filled: filledGaps,
        expired: expiredGaps,
      },
      totalPnlKrw: pnlAggregate._sum.pnlKrw?.toNumber() ?? 0,
      avgPnlPct: pnlAggregate._avg.pnlPct?.toNumber() ?? 0,
      fridayCloseKrw: this.fridayCloseKrw,
      fridayCloseRecordedWeek: this.fridayCloseRecordedWeek,
      mondayOpenRecordedWeek: this.mondayOpenRecordedWeek,
    };
  }

  // ─────────────────────────────────────
  // 스케줄 트리거 (에이전트에서 호출)
  // ─────────────────────────────────────

  /**
   * 금요일 종가 기록 (토요일 07:00 KST 트리거)
   * 업비트 현재가를 CME 금요일 종가로 사용
   */
  async recordFridayClose(): Promise<void> {
    const now = new Date();
    const weekKey = getIsoWeekKey(now);

    // 당주 이미 기록했으면 스킵 (중복 방지)
    if (this.fridayCloseRecordedWeek === weekKey) {
      console.log(`[CmeGapService] 금요일 종가 이미 기록됨 (${weekKey}), 스킵`);
      return;
    }

    const ticker = await UpbitService.getCurrentPrice('KRW-BTC');
    if (!ticker) {
      throw new Error('[CmeGapService] 업비트 BTC 현재가 조회 실패');
    }

    this.fridayCloseKrw = ticker.trade_price as number;
    this.fridayCloseRecordedWeek = weekKey;

    console.log(
      `[CmeGapService] 금요일 종가 기록 완료: ${this.fridayCloseKrw.toLocaleString()} KRW (${weekKey})`
    );
  }

  /**
   * 월요일 시가 기록 및 갭 감지 (월요일 07:00 KST 트리거)
   * enabled=true && live=true 봇들에 대해 CmeGap 레코드를 생성하고
   * 하방 갭이면 즉시 진입을 시도한다.
   */
  async recordMondayOpenAndDetectGaps(): Promise<void> {
    const now = new Date();
    const weekKey = getIsoWeekKey(now);

    // 당주 이미 기록했으면 스킵
    if (this.mondayOpenRecordedWeek === weekKey) {
      console.log(`[CmeGapService] 월요일 시가 이미 기록됨 (${weekKey}), 스킵`);
      return;
    }

    // fridayClose가 없으면 갭 계산 불가
    if (!this.fridayCloseKrw) {
      console.warn('[CmeGapService] fridayCloseKrw 없음 — 갭 계산 불가. 토요일 07:00에 가격이 기록되었는지 확인 필요');
      return;
    }

    const ticker = await UpbitService.getCurrentPrice('KRW-BTC');
    if (!ticker) {
      throw new Error('[CmeGapService] 업비트 BTC 현재가 조회 실패');
    }

    const mondayOpenKrw = ticker.trade_price as number;
    const fridayCloseKrw = this.fridayCloseKrw;

    // 갭 방향 및 크기 계산
    const gapPct = Math.abs(mondayOpenKrw - fridayCloseKrw) / fridayCloseKrw * 100;
    const direction = mondayOpenKrw > fridayCloseKrw ? 'up' : 'down';
    const gapHiKrw = Math.max(mondayOpenKrw, fridayCloseKrw);
    const gapLoKrw = Math.min(mondayOpenKrw, fridayCloseKrw);

    console.log(
      `[CmeGapService] 갭 감지: 방향=${direction}, 크기=${gapPct.toFixed(3)}%, ` +
      `금요일종가=${fridayCloseKrw.toLocaleString()}, 월요일시가=${mondayOpenKrw.toLocaleString()} (${weekKey})`
    );

    // enabled=true, live=true 봇만 처리
    const activeBots = await prisma.cmeGapBot.findMany({
      where: { enabled: true, live: true },
    });

    for (const bot of activeBots) {
      const minGapPct = Number(bot.minGapPct);

      // 최소 갭 크기 미달 시 스킵
      if (gapPct < minGapPct) {
        console.log(
          `[CmeGapService] Bot#${bot.id}: 갭 ${gapPct.toFixed(3)}% < 최소 ${minGapPct}% — 스킵`
        );
        continue;
      }

      // 당주 이미 갭 레코드가 있으면 스킵 (중복 방지)
      const existing = await prisma.cmeGap.findFirst({
        where: { botId: bot.id, weekKey },
      });
      if (existing) {
        console.log(`[CmeGapService] Bot#${bot.id}: ${weekKey} 갭 이미 존재 — 스킵`);
        continue;
      }

      const gap = await prisma.cmeGap.create({
        data: {
          botId: bot.id,
          weekKey,
          fridayCloseKrw,
          mondayOpenKrw,
          gapPct,
          direction,
          gapHiKrw,
          gapLoKrw,
          status: 'watching',
        },
      });

      console.log(`[CmeGapService] Bot#${bot.id}: 갭 레코드 생성 (gap#${gap.id}, direction=${direction})`);

      // 하방 갭이면 즉시 진입 (현재가 ≈ gapLoKrw = mondayOpenKrw)
      if (direction === 'down') {
        console.log(`[CmeGapService] Bot#${bot.id}: 하방 갭 → 즉시 진입 시도`);
        // 비동기 처리 (사이클 블로킹 방지)
        this.enterPosition(gap.id, bot, mondayOpenKrw).catch((err: Error) => {
          console.error(`[CmeGapService] Bot#${bot.id}: enterPosition 오류 — ${err.message}`);
        });
      }
    }

    this.mondayOpenRecordedWeek = weekKey;
  }

  /**
   * 시장가 매수로 포지션 진입
   * @param gapId - CmeGap 레코드 ID
   * @param bot   - CmeGapBot 레코드
   * @param currentPrice - 현재 업비트 BTC/KRW 가격
   */
  async enterPosition(
    gapId: number,
    bot: { id: number; quantity: unknown; live: boolean },
    currentPrice: number
  ): Promise<void> {
    const quantity = Number(bot.quantity); // BTC 수량
    const totalKrw = Math.round(currentPrice * quantity); // 매수에 쓸 KRW 금액

    console.log(
      `[CmeGapService] Gap#${gapId}: 시장가 매수 시도 — ${quantity} BTC ≈ ${totalKrw.toLocaleString()} KRW`
    );

    // live=false이면 드라이런 (실제 주문 없음)
    if (!bot.live) {
      console.log(`[CmeGapService] Gap#${gapId}: live=false → 드라이런 (실제 주문 안 함)`);
      await prisma.cmeGap.update({
        where: { id: gapId },
        data: {
          status: 'entered',
          entryPrice: currentPrice,
          entryOrderId: `DRY-${Date.now()}`,
          entryFilledQty: quantity,
          enteredAt: new Date(),
        },
      });

      // 드라이런에서도 TP 주문 시뮬레이션
      const gap = await prisma.cmeGap.findUnique({ where: { id: gapId } });
      if (gap) {
        await this.placeTpOrder(gapId, Number(gap.gapHiKrw), quantity);
      }
      return;
    }

    // 업비트 시장가 매수 실행
    const upbit = new UpbitService({
      accessKey: config.donation.upbitAccessKey,
      secretKey: config.donation.upbitSecretKey,
    });

    const order = await upbit.buyMarket('KRW-BTC', totalKrw);

    await prisma.cmeGap.update({
      where: { id: gapId },
      data: {
        status: 'entered',
        entryPrice: currentPrice,
        entryOrderId: order.uuid,
        enteredAt: new Date(),
      },
    });

    console.log(`[CmeGapService] Gap#${gapId}: 시장가 매수 주문 완료 (uuid=${order.uuid})`);

    // 2초 후 체결 수량 확인 및 TP 주문 등록
    setTimeout(async () => {
      try {
        await this.pollEntryAndPlaceTp(gapId, upbit, order.uuid);
      } catch (err: any) {
        console.error(`[CmeGapService] Gap#${gapId}: TP 주문 등록 오류 — ${err.message}`);
      }
    }, 2000);
  }

  /**
   * 진입 주문 체결 확인 후 TP(익절) 주문 등록
   * @param gapId   - CmeGap 레코드 ID
   * @param upbit   - UpbitService 인스턴스
   * @param orderId - 매수 주문 UUID
   */
  private async pollEntryAndPlaceTp(
    gapId: number,
    upbit: UpbitService,
    orderId: string
  ): Promise<void> {
    const gap = await prisma.cmeGap.findUnique({ where: { id: gapId } });
    if (!gap) {
      console.error(`[CmeGapService] Gap#${gapId}: 레코드를 찾을 수 없음`);
      return;
    }

    const order = await upbit.getOrder(orderId);
    const filledQty = parseFloat(order.executed_volume ?? '0');
    const avgPrice = order.executed_funds && order.executed_volume
      ? parseFloat(order.executed_funds) / parseFloat(order.executed_volume)
      : Number(gap.entryPrice);

    if (filledQty <= 0) {
      console.warn(`[CmeGapService] Gap#${gapId}: 매수 체결 수량 0 → TP 주문 스킵`);
      return;
    }

    // 체결 수량 업데이트
    await prisma.cmeGap.update({
      where: { id: gapId },
      data: {
        entryFilledQty: filledQty,
        entryPrice: avgPrice,
      },
    });

    // 익절가: 갭 상단 (gapHiKrw)
    const tpPriceKrw = Number(gap.gapHiKrw);
    await this.placeTpOrder(gapId, tpPriceKrw, filledQty);
  }

  /**
   * 익절(TP) 지정가 매도 주문 등록
   * @param gapId      - CmeGap 레코드 ID
   * @param tpPriceKrw - 목표 익절가 (KRW)
   * @param filledQty  - 매수 체결 수량 (BTC)
   */
  async placeTpOrder(gapId: number, tpPriceKrw: number, filledQty: number): Promise<void> {
    const gap = await prisma.cmeGap.findUnique({ where: { id: gapId } });
    if (!gap) {
      throw new Error(`Gap#${gapId} 레코드를 찾을 수 없음`);
    }

    console.log(
      `[CmeGapService] Gap#${gapId}: TP 주문 등록 — 가격=${tpPriceKrw.toLocaleString()} KRW, ` +
      `수량=${filledQty} BTC`
    );

    // bot 관계 조회하여 live 여부 확인
    const botRow = await prisma.cmeGapBot.findUnique({ where: { id: gap.botId } });

    // live=false이면 드라이런
    if (!botRow?.live) {
      console.log(`[CmeGapService] Gap#${gapId}: live=false → TP 주문 드라이런`);
      await prisma.cmeGap.update({
        where: { id: gapId },
        data: {
          status: 'tp_ordered',
          tpPrice: tpPriceKrw,
          tpOrderId: `DRY-TP-${Date.now()}`,
        },
      });
      return;
    }

    // 실제 지정가 매도 주문 (live=true)
    const upbit = new UpbitService({
      accessKey: config.donation.upbitAccessKey,
      secretKey: config.donation.upbitSecretKey,
    });

    const order = await upbit.placeLimitOrder('KRW-BTC', 'ask', {
      price: tpPriceKrw.toString(),
      volume: filledQty.toString(),
    });

    await prisma.cmeGap.update({
      where: { id: gapId },
      data: {
        status: 'tp_ordered',
        tpPrice: tpPriceKrw,
        tpOrderId: order.uuid,
      },
    });

    console.log(`[CmeGapService] Gap#${gapId}: TP 주문 완료 (uuid=${order.uuid})`);
  }

  /**
   * 활성 갭 상태 점검 (30초마다 에이전트에서 호출)
   *
   * 처리 항목:
   * 1. watching 상태 상방 갭: 현재가 < gapHiKrw * 0.998 이면 진입
   * 2. watching 상태 갭이 7일 경과하면 expired 처리
   * 3. tp_ordered 상태: 체결 여부 확인 → filled 처리
   */
  async checkActiveGaps(): Promise<void> {
    const activeGaps = await prisma.cmeGap.findMany({
      where: {
        status: { in: ['watching', 'entered', 'tp_ordered'] },
      },
    });

    if (activeGaps.length === 0) return;

    // 현재가 조회 (API 1회 호출로 재사용)
    const ticker = await UpbitService.getCurrentPrice('KRW-BTC').catch(() => null);
    const currentPrice: number | null = ticker?.trade_price ?? null;

    const now = new Date();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    for (const gap of activeGaps) {
      try {
        // ── watching 상태 처리 ──────────────────────────────────────
        if (gap.status === 'watching') {
          // 7일 이상 경과하면 만료 처리
          const age = now.getTime() - gap.detectedAt.getTime();
          if (age > sevenDaysMs) {
            await prisma.cmeGap.update({
              where: { id: gap.id },
              data: { status: 'expired' },
            });
            console.log(`[CmeGapService] Gap#${gap.id}: 7일 경과 → expired`);
            continue;
          }

          // 상방 갭: 현재가가 gapHiKrw * 0.998 이하면 진입
          if (gap.direction === 'up' && currentPrice !== null) {
            const entryThreshold = Number(gap.gapHiKrw) * 0.998;
            if (currentPrice <= entryThreshold) {
              // bot 정보 조회 (live 여부 확인 목적)
              const botRow = await prisma.cmeGapBot.findUnique({ where: { id: gap.botId } });
              if (!botRow) {
                console.error(`[CmeGapService] Gap#${gap.id}: 봇 #${gap.botId} 없음 — 진입 스킵`);
                continue;
              }
              console.log(
                `[CmeGapService] Gap#${gap.id}: 상방 갭 진입 조건 충족 ` +
                `(현재가=${currentPrice.toLocaleString()} ≤ 임계값=${entryThreshold.toFixed(0)})`
              );
              this.enterPosition(gap.id, botRow, currentPrice).catch((err: Error) => {
                console.error(`[CmeGapService] Gap#${gap.id}: enterPosition 오류 — ${err.message}`);
              });
            }
          }
        }

        // ── entered 상태 처리 (TP 주문 미등록 복구) ─────────────────
        // 서버 재시작이나 pollEntryAndPlaceTp 실패 시 entered 상태에서
        // tpOrderId가 null인 채로 고착될 수 있음 → 복구 시도
        if (gap.status === 'entered' && !gap.tpOrderId) {
          const filledQty = Number(gap.entryFilledQty ?? 0);
          if (filledQty > 0) {
            // entryFilledQty가 이미 기록되어 있으면 TP 주문만 재시도
            console.log(
              `[CmeGapService] Gap#${gap.id}: entered 상태에서 tpOrderId 없음 ` +
              `(entryFilledQty=${filledQty}) → TP 주문 복구 시도`
            );
            await this.placeTpOrder(gap.id, Number(gap.gapHiKrw), filledQty);
          } else if (gap.entryOrderId && !gap.entryOrderId.startsWith('DRY-')) {
            // entryFilledQty도 없으면 업비트에서 체결 수량 재조회
            console.log(
              `[CmeGapService] Gap#${gap.id}: entered 상태에서 entryFilledQty 없음 ` +
              `→ 업비트 주문 폴링 (orderId=${gap.entryOrderId})`
            );
            const upbit = new UpbitService({
              accessKey: config.donation.upbitAccessKey,
              secretKey: config.donation.upbitSecretKey,
            });
            const order = await upbit.getOrder(gap.entryOrderId);
            const qty = parseFloat(order.executed_volume ?? '0');
            if (qty > 0) {
              await prisma.cmeGap.update({
                where: { id: gap.id },
                data: { entryFilledQty: qty },
              });
              await this.placeTpOrder(gap.id, Number(gap.gapHiKrw), qty);
            } else {
              console.warn(
                `[CmeGapService] Gap#${gap.id}: 업비트에서도 체결 수량 0 → 복구 불가. 수동 확인 필요`
              );
            }
          }
          // entered 처리가 완료되었으므로 다음 갭으로 이동
          continue;
        }

        // ── tp_ordered 상태 처리 (TP 체결 확인) ──────────────────────
        if (gap.status === 'tp_ordered' && gap.tpOrderId) {
          // 드라이런 주문 ID는 스킵
          if (gap.tpOrderId.startsWith('DRY-')) {
            continue;
          }

          const upbit = new UpbitService({
            accessKey: config.donation.upbitAccessKey,
            secretKey: config.donation.upbitSecretKey,
          });

          const order = await upbit.getOrder(gap.tpOrderId);
          if (order.state === 'done') {
            const exitFilledQty = parseFloat(order.executed_volume ?? '0');
            const exitPrice = order.executed_funds && order.executed_volume
              ? parseFloat(order.executed_funds) / parseFloat(order.executed_volume)
              : Number(gap.tpPrice);

            // PnL 계산: (매도금액 - 매수금액) = (exitPrice - entryPrice) * qty
            const entryPrice = Number(gap.entryPrice ?? 0);
            const pnlKrw = (exitPrice - entryPrice) * exitFilledQty;
            const pnlPct = entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice * 100 : 0;

            await prisma.cmeGap.update({
              where: { id: gap.id },
              data: {
                status: 'filled',
                exitPrice,
                exitFilledQty,
                pnlKrw,
                pnlPct,
                closedAt: new Date(),
              },
            });

            console.log(
              `[CmeGapService] Gap#${gap.id}: 익절 완료! ` +
              `PnL=${pnlKrw.toFixed(0)} KRW (${pnlPct.toFixed(3)}%) ` +
              `진입=${entryPrice.toFixed(0)}, 익절=${exitPrice.toFixed(0)}, qty=${exitFilledQty}`
            );
          }
        }
      } catch (err: any) {
        console.error(`[CmeGapService] Gap#${gap.id} 처리 오류 — ${err.message}`);
      }
    }
  }

  // ─────────────────────────────────────
  // 수동 트리거 (테스트용)
  // ─────────────────────────────────────

  /** 외부에서 fridayCloseKrw 직접 설정 (테스트 트리거용) */
  setFridayCloseKrw(price: number, weekKey: string): void {
    this.fridayCloseKrw = price;
    this.fridayCloseRecordedWeek = weekKey;
  }

  /** 내부 상태 초기화 (테스트용) */
  resetRecordedFlags(): void {
    this.fridayCloseRecordedWeek = null;
    this.mondayOpenRecordedWeek = null;
  }
}

export const cmeGapService = new CmeGapService();
