// 쿨다운 + 카카오톡 발송 + MultiArbOpportunity 기록 (spec §4 ArbAlertNotifier, §5 step 6, §7~§9)
// 쿨다운: (symbol, currencyZone) 최근 notifiedAt 30분 이내면 스킵
// 발송 실패 시 notifiedAt 미갱신 → 다음 사이클에서 재시도 (spec §9)
// DB 행 누적 방지: 알림 off라 notifiedAt이 채워지지 않는 기간에도, 동일 (symbol, currencyZone)이
// detectedAt 기준 30분 내 이미 기록되어 있으면 새 행을 만들지 않고 그 행을 재사용한다.
// (기록 dedup과 발송 게이팅은 별개 — dedup은 "어느 행에 쓸지"만 정하고, 발송 여부/쿨다운 판단은 그대로)
import prisma from '../config/database';
import { kakaoNotifyService } from './kakao-notify.service';
import { config } from '../config/env';
import { EXCHANGE_LABELS, FeasibilityResult, MIN_NOTIONAL_BY_ZONE, NetResult, SpreadCandidate } from './multi-arb-types';

const COOLDOWN_MS = 30 * 60 * 1000; // 30분 (spec §2)

// 재고형(로밍) 실행 가능 최소 매도측 재고 가치 — 거래소 최소주문 기준(KRW 5000, USDT 5).
// 매도측 재고가 이 값 미만이면 dust라 실제 실행 불가 → 카톡 발송 제외.
// (2026-10-02: 업비트 ARK 0.00000001 dust가 sellHeld>0을 통과해 "실행 가능" 알림이 왔으나 로밍은 최소주문 미달로 스킵 → 노이즈 제거)
const MIN_SELL_VALUE_BY_ZONE: Record<SpreadCandidate['currencyZone'], number> = { KRW: 5000, USDT: 5 };

// 가격 표기: KRW권은 천단위 콤마, USDT권 소수점 코인도 유효자리 유지
function formatPrice(price: number): string {
  return price.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
}

// 검증 규모 표기 (spec §7): KRW권 "10만원", USDT권 "100USDT"
function formatVerifiedNotional(currencyZone: SpreadCandidate['currencyZone']): string {
  const minNotional = MIN_NOTIONAL_BY_ZONE[currencyZone];
  return currencyZone === 'KRW' ? `${(minNotional / 10000).toFixed(0)}만원` : `${minNotional}USDT`;
}

// 출금료 표기 (2026-09-22 개편, H1 리뷰 반영): 정액/정률/미확인을 은폐 없이 명시
// 미확인 시 순차익 계산에는 보수적 폴백률(withdrawFeePct)이 이미 반영돼 있으므로 그 값을 그대로 노출한다.
function formatWithdrawFee(net: NetResult): string {
  if (!net.withdrawFeeKnown) return `출금료 미확인 — 보수적 ${net.withdrawFeePct.toFixed(2)}% 가정`;
  return `출금료 ${net.withdrawFeePct.toFixed(2)}%`;
}

// 통화권별 금액 표기: KRW권 "₩1,234,000", USDT권 "123.45 USDT"
function formatNotional(amount: number, currencyZone: SpreadCandidate['currencyZone']): string {
  return currencyZone === 'KRW'
    ? `₩${Math.round(amount).toLocaleString('ko-KR')}`
    : `${amount.toFixed(2)} USDT`;
}

// 최대 체결가능 규모 줄 (호가 깊이 기준, 순차익이 임계값 이상 유지되는 최대 매수·매도 금액)
function formatMaxExecutable(candidate: SpreadCandidate, net: NetResult): string | null {
  if (!(net.maxExecBuyNotional > 0)) return null;
  const buy = formatNotional(net.maxExecBuyNotional, candidate.currencyZone);
  const sell = formatNotional(net.maxExecSellNotional, candidate.currencyZone);
  // 조회 호가 끝까지 임계 유지 시 실제론 더 클 수 있음 → "≥" + 한도 표기
  const prefix = net.maxExecDepthLimited ? '≥ ' : '≈ ';
  const suffix = net.maxExecDepthLimited ? ' (조회 호가 한도, 실제 더 큼)' : ' (순차익 유지 최대)';
  return `📊 최대 체결가능 ${prefix}매수 ${buy} → 매도 ${sell}${suffix}`;
}

// 순차익/실현/깊이 요약 줄 (spec §7 개편: 순차익 기준 선별로 변경)
function buildNetSummaryLines(candidate: SpreadCandidate, feasibility: FeasibilityResult, net: NetResult): string[] {
  const lines = [
    `💰 순차익 +${net.netSpreadPct.toFixed(2)}% (실현 최우선호가 +${candidate.spreadPct.toFixed(1)}%)`,
    `🔍 검증 규모: ${formatVerifiedNotional(candidate.currencyZone)} 깊이 확인 (${net.depthOk ? '충족' : '⚠️ 미충족'})`,
  ];
  const maxExecLine = formatMaxExecutable(candidate, net);
  if (maxExecLine) lines.push(maxExecLine);
  lines.push(`💸 ${formatWithdrawFee(net)}`);
  if (feasibility.matchedNetwork) {
    lines.push(`🌐 매칭 네트워크: ${feasibility.matchedNetwork}`);
  }
  return lines;
}

const SNAPSHOT_DISCLAIMER = '⏱️ 전송에 수분~수시간 소요 — 실현차익은 현재 호가 스냅샷 기준';

// 카카오톡 메시지 포맷 (spec §7, 2026-09-22 개편: 순차익/깊이/출금료/스냅샷 주의 추가) — 순수함수, 단위테스트 대상
export interface AlertExtraLines {
  holdingLine?: string; // 보유 여부/로밍 실행 가능 표시
  freqLine?: string;    // 최근 30일 감지 빈도
}

// 재고 미보유(매도측 재고 부족) 배제 게이트 판정 (2026-09-28, 2026-10-02 가치기준으로 강화) — 순수함수, 단위테스트 대상
// 매도측 재고가 "실행 가능한 규모"(최소주문 이상)여야 재고형(즉시 매도) 실행이 가능하다.
// 재고 없음/dust는 전송(로밍) 차익뿐이라 표시 순간 실현 불가(전송 수분~수시간+가격변동) → 발송 제외.
//   sellHeldValue = 매도측 보유수량 × 매도가(quote 통화). dust(예: 0.00000001코인)는 value가 0에 수렴해 제외된다.
//   holding=null 은 "재고 조회 실패" → fail-open(발송 유지). 영구 장애 시 전체 블랙아웃 방지.
export type InventoryGateReason = 'toggle-off' | 'query-failed' | 'has-sell-inventory' | 'no-sell-inventory';
export function evaluateInventoryGate(
  holding: { sellHeldValue: number } | null,
  excludeEnabled: boolean,
  minSellValue: number,
): { exclude: boolean; reason: InventoryGateReason } {
  if (!excludeEnabled) return { exclude: false, reason: 'toggle-off' };
  if (!holding) return { exclude: false, reason: 'query-failed' }; // fail-open: 조회 실패 시 발송 유지
  if (holding.sellHeldValue >= minSellValue) return { exclude: false, reason: 'has-sell-inventory' };
  return { exclude: true, reason: 'no-sell-inventory' };
}

export function buildAlertMessage(
  candidate: SpreadCandidate,
  feasibility: FeasibilityResult,
  kimchiPct: number | null,
  net: NetResult,
  extra?: AlertExtraLines,
): string {
  const buyLabel = EXCHANGE_LABELS[candidate.buyExchange];
  const sellLabel = EXCHANGE_LABELS[candidate.sellExchange];
  const disclaimer = '⚠️ 표시가 기준 · 실제 유동성/체결 확인 필요';

  if (feasibility.feasibility === 'feasible') {
    const lines = [
      `🔔 차익 후보 (${candidate.currencyZone}권) · ${candidate.symbol}`,
      `📉 매수 ${buyLabel} 매도호가(ask) ${formatPrice(candidate.buyPrice)}`,
      `📈 매도 ${sellLabel} 매수호가(bid) ${formatPrice(candidate.sellPrice)}  → +${candidate.spreadPct.toFixed(1)}%`,
      `✅ ${feasibility.note}`,
      ...buildNetSummaryLines(candidate, feasibility, net),
    ];
    if (extra?.holdingLine) lines.push(extra.holdingLine);
    if (extra?.freqLine) lines.push(extra.freqLine);
    if (kimchiPct !== null) {
      const sign = kimchiPct >= 0 ? '+' : '';
      lines.push(`참고 김프: 해외 대비 ${sign}${kimchiPct.toFixed(1)}%`);
    }
    lines.push(SNAPSHOT_DISCLAIMER);
    lines.push(disclaimer);
    return lines.join('\n');
  }

  // 함정 경고 (network_mismatch / deposit_halt / unverified) — 정보용(주의) 등급 (spec §6)
  const lines = [
    `⚠️ 차익 후보(주의) · ${candidate.symbol}  매수 ${buyLabel} 매도호가 ${formatPrice(candidate.buyPrice)} → 매도 ${sellLabel} 매수호가 ${formatPrice(candidate.sellPrice)} (+${Math.round(candidate.spreadPct)}%)`,
    `⛔ ${feasibility.note}`,
    '→ 실현 어려움. 정보용 참고',
    ...buildNetSummaryLines(candidate, feasibility, net),
  ];
  if (kimchiPct !== null) {
    const sign = kimchiPct >= 0 ? '+' : '';
    lines.push(`참고 김프: 해외 대비 ${sign}${kimchiPct.toFixed(1)}%`);
  }
  lines.push(SNAPSHOT_DISCLAIMER);
  lines.push(disclaimer);
  return lines.join('\n');
}

class MultiArbNotifierService {
  // 반환: 발송 성공 여부 (쿨다운 스킵/발송 게이트 off/발송 실패 = false)
  // options.send=false (I-1 발송 게이트): 쿨다운 확인·DB 기록은 종전대로 수행하고 카톡 발송만 스킵
  async notify(
    candidate: SpreadCandidate,
    feasibility: FeasibilityResult,
    kimchiPct: number | null,
    net: NetResult,
    options?: { send?: boolean },
  ): Promise<boolean> {
    const send = options?.send ?? true;

    // 쿨다운 확인 (spec §8: (symbol, currencyZone)의 최근 notifiedAt 30분 이내면 스킵)
    const since = new Date(Date.now() - COOLDOWN_MS);
    const recent = await (prisma as any).multiArbOpportunity.findFirst({
      where: {
        symbol: candidate.symbol,
        currencyZone: candidate.currencyZone,
        notifiedAt: { gte: since },
      },
    });
    if (recent) return false;

    // DB 행 누적 방지: 알림 off(notifiedAt 미갱신) 상태에서도 동일 (symbol, currencyZone)이
    // 30분 내 이미 기록되어 있으면 새 행을 만들지 않고 기존 행을 재사용한다.
    // (price_anomaly 기록은 별도 카테고리이므로 재사용 대상에서 제외 — recordPriceAnomaly와 동일 관례)
    // 위 쿨다운을 통과했다는 것은 이 기존 행의 notifiedAt이 null이라는 뜻이므로 재사용 후
    // update로 notifiedAt을 채워도 발송 이력을 덮어쓸 위험이 없다.
    let row = await (prisma as any).multiArbOpportunity.findFirst({
      where: {
        symbol: candidate.symbol,
        currencyZone: candidate.currencyZone,
        feasibility: { not: 'price_anomaly' },
        detectedAt: { gte: since },
      },
    });

    if (!row) {
      // 기회 이력 기록 (notifiedAt=null — 발송 성공 시에만 갱신)
      row = await (prisma as any).multiArbOpportunity.create({
        data: {
          symbol: candidate.symbol,
          currencyZone: candidate.currencyZone,
          buyExchange: candidate.buyExchange,
          buyPrice: candidate.buyPrice,
          sellExchange: candidate.sellExchange,
          sellPrice: candidate.sellPrice,
          spreadPct: candidate.spreadPct,
          feasibility: feasibility.feasibility,
          networkMatch: feasibility.networkMatch,
          matchedNetwork: feasibility.matchedNetwork,
          // 2026-09-22 개편: DB 스키마는 그대로 두고 note에 순차익 요약을 덧붙여 기록 (은폐 금지)
          note: `${feasibility.note} · 순차익 ${net.netSpreadPct.toFixed(2)}% (${formatWithdrawFee(net)}, 깊이 ${net.depthOk ? '충족' : '미충족'})`,
          kimchiPct,
          notifiedAt: null,
        },
      });
    }

    // I-1: 발송 게이트/상한/필터에 걸린 후보는 여기서 종료 — notifiedAt=null 유지 (쿨다운 미발동)
    if (!send) return false;

    // 재고 미보유 배제 게이트 (2026-09-28): 매도측 재고가 있어야 재고형(즉시 매도) 실행이 가능하다.
    // 재고 없는 기회는 전송(로밍) 차익뿐이라 표시 순간 실현이 불가능 → 카톡 발송에서 제외 (기본 ON).
    // MULTI_ARB_EXCLUDE_NO_INVENTORY=false 로 명시해야 해제된다. 조회 실패는 fail-open(발송 유지).
    const excludeNoInventory = process.env.MULTI_ARB_EXCLUDE_NO_INVENTORY !== 'false';
    let holding: { sellHeld: number; buyHeld: number } | null = null;
    try {
      holding = await this.resolveHolding(candidate);
    } catch (err: any) {
      // 재고 조회 실패(관리자 미존재/잔고 API 오류) → 발송 유지. 영구 장애 시 전체 블랙아웃 방지.
      console.log(`[MultiArbNotifier] ${candidate.symbol}(${candidate.currencyZone}) 재고 조회 실패 — 발송 유지(fail-open):`, err?.message ?? err);
    }
    const sellHeldValue = holding ? holding.sellHeld * candidate.sellPrice : 0; // 매도측 재고 가치(quote 통화)
    const gate = evaluateInventoryGate(
      holding ? { sellHeldValue } : null,
      excludeNoInventory,
      MIN_SELL_VALUE_BY_ZONE[candidate.currencyZone],
    );
    if (gate.exclude) {
      // notifiedAt 미갱신 → 쿨다운 미발동 → 재고가 생기면 다음 사이클에서 다시 후보로 뜬다.
      console.log(`[MultiArbNotifier] ${candidate.symbol}(${candidate.currencyZone}) 발송 제외 — 매도측(${EXCHANGE_LABELS[candidate.sellExchange]}) 실행가능 재고 부족(sellHeld=${holding?.sellHeld ?? 0}, 가치≈${Math.round(sellHeldValue)})`);
      return false;
    }

    // 위에서 조회한 재고 스냅샷을 재사용(중복 API 호출 방지)
    const extra = await this.buildExtraLines(candidate, holding).catch(() => undefined);
    const message = buildAlertMessage(candidate, feasibility, kimchiPct, net, extra);
    try {
      await kakaoNotifyService.sendToMe(message);
    } catch (err: any) {
      // 발송 실패: notifiedAt 미갱신 → 쿨다운 미발동 → 다음 사이클 재시도 (spec §9)
      console.error(`[MultiArbNotifier] 카카오 발송 실패 (${candidate.symbol}):`, err?.message ?? err);
      return false;
    }

    await (prisma as any).multiArbOpportunity.update({
      where: { id: row.id },
      data: { notifiedAt: new Date() },
    });
    return true;
  }

  // 보유 여부 + 30일 빈도 라인 생성 (실패 시 라인 생략 — 알림 발송은 계속)
  // holding: notify()에서 이미 조회한 재고 스냅샷을 넘겨 중복 조회를 피한다.
  //   undefined(미전달)면 여기서 직접 조회, null이면 조회 실패 → 보유 라인 생략.
  private async buildExtraLines(
    candidate: SpreadCandidate,
    holding?: { sellHeld: number; buyHeld: number } | null,
  ): Promise<AlertExtraLines> {
    const extra: AlertExtraLines = {};
    // 빈도: 최근 30일 같은 심볼/통화권 feasible 감지 횟수 (이번 건 포함)
    try {
      const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const agg = await (prisma as any).multiArbOpportunity.aggregate({
        where: { symbol: candidate.symbol, currencyZone: candidate.currencyZone, feasibility: 'feasible', detectedAt: { gte: since30 } },
        _count: { id: true }, _avg: { spreadPct: true },
      });
      const cnt = agg._count?.id ?? 0;
      if (cnt > 0) {
        extra.freqLine = `📊 최근 30일 ${cnt}회 감지 (평균 +${(agg._avg?.spreadPct ?? 0).toFixed(1)}%)`;
      }
    } catch { /* 생략 */ }

    // 보유: 매도측(비싼 거래소) 재고가 있어야 재고형(로밍) 실행 가능
    try {
      const h = holding === undefined ? await this.resolveHolding(candidate).catch(() => null) : holding;
      if (h) {
        const sellLabel = EXCHANGE_LABELS[candidate.sellExchange];
        const buyLabel = EXCHANGE_LABELS[candidate.buyExchange];
        const fmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
        const sellHeldValue = h.sellHeld * candidate.sellPrice;
        if (sellHeldValue >= MIN_SELL_VALUE_BY_ZONE[candidate.currencyZone]) {
          extra.holdingLine = `👛 보유: ${sellLabel} ${fmt(h.sellHeld)} — 재고형(로밍) 실행 가능`;
        } else if (h.buyHeld > 0) {
          extra.holdingLine = `👛 보유: ${buyLabel}에만 ${fmt(h.buyHeld)} — 매도측(${sellLabel}) 재고 없어 재고형 불가`;
        } else {
          extra.holdingLine = `👛 미보유 — 재고형(로밍) 실행 불가, 전송 차익만 가능`;
        }
      }
    } catch { /* 생략 */ }
    return extra;
  }

  // 재고 스냅샷 조회 — 매도측/매수측 보유 수량. 조회 불가(관리자 미존재/잔고 API 오류)면 throw.
  // KRW권: 관리자 계정의 업비트/빗썸 잔고. USDT권: Gate/MEXC/Binance 잔고.
  // 심볼 키는 KRW·USDT 모두 base 심볼 대문자로 통일되어 candidate.symbol과 직접 매칭된다.
  private async resolveHolding(candidate: SpreadCandidate): Promise<{ sellHeld: number; buyHeld: number }> {
    if (candidate.currencyZone === 'KRW') {
      const admin = await (prisma as any).user.findFirst({ where: { email: config.adminEmail }, select: { id: true } });
      if (!admin) throw new Error('관리자 계정 없음 — 재고 조회 불가');
      const { inventoryArbService } = await import('./inventory-arb.service');
      const h = await inventoryArbService.getKrwHoldings(admin.id);
      const pick = (ex: string) => (ex === 'upbit' ? h.upbit : h.bithumb);
      return {
        sellHeld: pick(candidate.sellExchange)[candidate.symbol] ?? 0,
        buyHeld: pick(candidate.buyExchange)[candidate.symbol] ?? 0,
      };
    }
    // ⚠️ fail-open은 KRW권에서만 보장된다. getBalancesByExchange()는 거래소별 조회 실패를 내부에서
    //   삼키고 빈 Map을 반환하므로 여기서 throw가 발생하지 않는다 → 잔고 API 장애 시 sellHeld=0으로
    //   조용히 제외(fail-closed). 현재 USDT권은 재고 미배치라 무해하지만, 향후 Gate↔MEXC 재고를
    //   배치하면 이 지점을 fail-open으로 보완해야 한다(조회 실패와 genuine 0을 구분).
    const { usdtInventoryService } = await import('./inventory-arb/usdt-inventory.service');
    const b = await usdtInventoryService.getBalancesByExchange();
    return {
      sellHeld: b.get(candidate.sellExchange as any)?.[candidate.symbol] ?? 0,
      buyHeld: b.get(candidate.buyExchange as any)?.[candidate.symbol] ?? 0,
    };
  }

  // I-2: price sanity 제외 건 기록 — 분석/티커충돌 수집용 (카톡 발송 없음, notifiedAt=null)
  // 동일 (symbol, currencyZone) 이상치는 30분 내 중복 기록 스킵 (사이클마다 행이 쌓이는 것 방지)
  async recordPriceAnomaly(candidate: SpreadCandidate, reason: string): Promise<void> {
    const since = new Date(Date.now() - COOLDOWN_MS);
    const recent = await (prisma as any).multiArbOpportunity.findFirst({
      where: {
        symbol: candidate.symbol,
        currencyZone: candidate.currencyZone,
        feasibility: 'price_anomaly',
        detectedAt: { gte: since },
      },
    });
    if (recent) return;

    await (prisma as any).multiArbOpportunity.create({
      data: {
        symbol: candidate.symbol,
        currencyZone: candidate.currencyZone,
        buyExchange: candidate.buyExchange,
        buyPrice: candidate.buyPrice,
        sellExchange: candidate.sellExchange,
        sellPrice: candidate.sellPrice,
        spreadPct: candidate.spreadPct,
        feasibility: 'price_anomaly',
        networkMatch: null,
        matchedNetwork: null,
        note: reason,
        kimchiPct: null,
        notifiedAt: null,
      },
    });
  }
}

export const multiArbNotifierService = new MultiArbNotifierService();
