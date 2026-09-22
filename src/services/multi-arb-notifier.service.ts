// 쿨다운 + 카카오톡 발송 + MultiArbOpportunity 기록 (spec §4 ArbAlertNotifier, §5 step 6, §7~§9)
// 쿨다운: (symbol, currencyZone) 최근 notifiedAt 30분 이내면 스킵
// 발송 실패 시 notifiedAt 미갱신 → 다음 사이클에서 재시도 (spec §9)
// DB 행 누적 방지: 알림 off라 notifiedAt이 채워지지 않는 기간에도, 동일 (symbol, currencyZone)이
// detectedAt 기준 30분 내 이미 기록되어 있으면 새 행을 만들지 않고 그 행을 재사용한다.
// (기록 dedup과 발송 게이팅은 별개 — dedup은 "어느 행에 쓸지"만 정하고, 발송 여부/쿨다운 판단은 그대로)
import prisma from '../config/database';
import { kakaoNotifyService } from './kakao-notify.service';
import { EXCHANGE_LABELS, FeasibilityResult, MIN_NOTIONAL_BY_ZONE, NetResult, SpreadCandidate } from './multi-arb-types';

const COOLDOWN_MS = 30 * 60 * 1000; // 30분 (spec §2)

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
export function buildAlertMessage(
  candidate: SpreadCandidate,
  feasibility: FeasibilityResult,
  kimchiPct: number | null,
  net: NetResult,
): string {
  const buyLabel = EXCHANGE_LABELS[candidate.buyExchange];
  const sellLabel = EXCHANGE_LABELS[candidate.sellExchange];
  const disclaimer = '⚠️ 표시가 기준 · 실제 유동성/체결 확인 필요';

  if (feasibility.feasibility === 'feasible') {
    const lines = [
      `🔔 차익 후보 (${candidate.currencyZone}권) · ${candidate.symbol}`,
      `📉 ${buyLabel} 매수 ${formatPrice(candidate.buyPrice)}`,
      `📈 ${sellLabel} 매도 ${formatPrice(candidate.sellPrice)}  → +${candidate.spreadPct.toFixed(1)}%`,
      `✅ ${feasibility.note}`,
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

  // 함정 경고 (network_mismatch / deposit_halt / unverified) — 정보용(주의) 등급 (spec §6)
  const lines = [
    `⚠️ 차익 후보(주의) · ${candidate.symbol}  ${sellLabel} ${formatPrice(candidate.sellPrice)} / ${buyLabel} ${formatPrice(candidate.buyPrice)} (+${Math.round(candidate.spreadPct)}%)`,
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

    const message = buildAlertMessage(candidate, feasibility, kimchiPct, net);
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
