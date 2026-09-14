// 쿨다운 + 카카오톡 발송 + MultiArbOpportunity 기록 (spec §4 ArbAlertNotifier, §5 step 6, §7~§9)
// 쿨다운: (symbol, currencyZone) 최근 notifiedAt 30분 이내면 스킵
// 발송 실패 시 notifiedAt 미갱신 → 다음 사이클에서 재시도 (spec §9)
import prisma from '../config/database';
import { kakaoNotifyService } from './kakao-notify.service';
import { EXCHANGE_LABELS, FeasibilityResult, SpreadCandidate } from './multi-arb-types';

const COOLDOWN_MS = 30 * 60 * 1000; // 30분 (spec §2)

// 가격 표기: KRW권은 천단위 콤마, USDT권 소수점 코인도 유효자리 유지
function formatPrice(price: number): string {
  return price.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
}

// 카카오톡 메시지 포맷 (spec §7) — 순수함수, 단위테스트 대상
export function buildAlertMessage(
  candidate: SpreadCandidate,
  feasibility: FeasibilityResult,
  kimchiPct: number | null,
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
    ];
    if (kimchiPct !== null) {
      const sign = kimchiPct >= 0 ? '+' : '';
      lines.push(`참고 김프: 해외 대비 ${sign}${kimchiPct.toFixed(1)}%`);
    }
    lines.push(disclaimer);
    return lines.join('\n');
  }

  // 함정 경고 (network_mismatch / deposit_halt / unverified) — 정보용(주의) 등급 (spec §6)
  const lines = [
    `⚠️ 차익 후보(주의) · ${candidate.symbol}  ${sellLabel} ${formatPrice(candidate.sellPrice)} / ${buyLabel} ${formatPrice(candidate.buyPrice)} (+${Math.round(candidate.spreadPct)}%)`,
    `⛔ ${feasibility.note}`,
    '→ 실현 어려움. 정보용 참고',
  ];
  if (kimchiPct !== null) {
    const sign = kimchiPct >= 0 ? '+' : '';
    lines.push(`참고 김프: 해외 대비 ${sign}${kimchiPct.toFixed(1)}%`);
  }
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

    // 기회 이력 기록 (notifiedAt=null — 발송 성공 시에만 갱신)
    const row = await (prisma as any).multiArbOpportunity.create({
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
        note: feasibility.note,
        kimchiPct,
        notifiedAt: null,
      },
    });

    // I-1: 발송 게이트/상한/필터에 걸린 후보는 여기서 종료 — notifiedAt=null 유지 (쿨다운 미발동)
    if (!send) return false;

    const message = buildAlertMessage(candidate, feasibility, kimchiPct);
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
