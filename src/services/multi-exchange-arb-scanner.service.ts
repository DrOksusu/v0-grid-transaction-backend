// 멀티 거래소 차익 스캐너 오케스트레이터 (spec §4~§5)
// 60초 주기 (MultiExchangeArbAgent에서 호출): 교집합 → 시세 → 스프레드 → 임계값 → 실현가능성 → 쿨다운/알림
import { multiArbSymbolUniverseService } from './multi-arb-symbol-universe.service';
import { multiArbPriceSource } from './multi-arb-price-source.service';
import { multiArbWalletStatusService } from './multi-arb-wallet-status.service';
import { calculateSpreads } from './multi-arb-spread-calculator';
import { checkPriceSanity } from './multi-arb-price-sanity';
import { evaluateFeasibility } from './multi-arb-feasibility-filter';
import { multiArbNotifierService } from './multi-arb-notifier.service';
import {
  FeasibilityResult, KRW_ZONE_EXCHANGES, USDT_ZONE_EXCHANGES, MultiArbExchange, PriceMap,
  SpreadCandidate, WalletStatusMap,
} from './multi-arb-types';

// 알림 임계값: 스프레드 2% 이상 (spec §2, 조정 가능 — env 우선)
const SPREAD_THRESHOLD_PCT = Number(process.env.MULTI_ARB_THRESHOLD_PCT ?? '2');

// 발송 게이트 설정 (I-1: 첫 배포 카톡 폭주 방지) — 게이트는 "카톡 발송"에만 적용,
// 스캔·DB 기록·쿨다운·별칭 수집 로그는 게이트와 무관하게 종전대로 수행한다.
// 사이클마다 재읽기 (운영 중 env 변경/테스트 용이)
interface AlertGateConfig {
  enabled: boolean;      // 카톡 발송 게이트 (canary=기본 off 정책)
  maxPerCycle: number;   // 사이클당 발송 상한 (실제 발송 성공 수 기준)
  feasibleOnly: boolean; // true면 feasible 후보만 발송 (주의 태그는 DB 기록+로그만)
}

function readAlertGateConfig(): AlertGateConfig {
  const rawMax = Number(process.env.MULTI_ARB_MAX_ALERTS_PER_CYCLE ?? '10');
  return {
    enabled: process.env.MULTI_ARB_ALERT_ENABLED === 'true',                // 기본 false
    maxPerCycle: Number.isFinite(rawMax) && rawMax >= 0 ? rawMax : 10,      // 기본 10
    feasibleOnly: process.env.MULTI_ARB_ALERT_FEASIBLE_ONLY !== 'false',    // 기본 true
  };
}

export interface ScanSummary {
  scannedKrw: number;
  scannedUsdt: number;
  hotCandidates: number;  // 임계값 초과 후보 수
  alerted: number;        // 실제 카톡 발송 수 (쿨다운 통과분)
  lastScanAt: string | null;
}

// 참고 김프 계산 (spec §5 step 7): 국내(업비트→빗썸 순) vs 해외(바이낸스→MEXC→Gate.io 순), 업비트 KRW-USDT 환율 환산
export function computeKimchiPct(
  symbol: string,
  prices: Partial<Record<MultiArbExchange, PriceMap>>,
  krwPerUsdt: number | null,
): number | null {
  if (krwPerUsdt === null || krwPerUsdt <= 0) return null;
  const domestic = prices.upbit?.get(symbol) ?? prices.bithumb?.get(symbol);
  const overseas = prices.binance?.get(symbol) ?? prices.mexc?.get(symbol) ?? prices.gateio?.get(symbol);
  if (!domestic || !overseas) return null;
  return (domestic / (overseas * krwPerUsdt) - 1) * 100;
}

// network_mismatch 후보의 양쪽 거래소 정규화 네트워크 목록 로그 라인 (Task 7 리뷰 반영)
// 목적: USDT권 네트워크 별칭 커버리지 부족을 운영 초기에 실데이터로 수집해 후속 확충
function formatNetworkMismatchLine(
  candidate: SpreadCandidate,
  wallets: Partial<Record<MultiArbExchange, WalletStatusMap>>,
): string {
  const nets = (exchange: MultiArbExchange): string =>
    (wallets[exchange]?.get(candidate.symbol) ?? []).map(n => n.network).join(',') || '-';
  return `${candidate.symbol} zone=${candidate.currencyZone} `
    + `buy=${candidate.buyExchange}[${nets(candidate.buyExchange)}] `
    + `sell=${candidate.sellExchange}[${nets(candidate.sellExchange)}]`;
}

class MultiExchangeArbScannerService {
  private lastSummary: ScanSummary = {
    scannedKrw: 0, scannedUsdt: 0, hotCandidates: 0, alerted: 0, lastScanAt: null,
  };

  getLastScanSummary(): ScanSummary {
    return { ...this.lastSummary };
  }

  async scanOnce(): Promise<ScanSummary> {
    // 1. 심볼 교집합 (1시간 캐시) — spec §5 step 1
    const universe = await multiArbSymbolUniverseService.getUniverse();

    // 2. 시세 + 지갑 상태 + 환율 병렬 조회 — spec §5 step 2 (Promise.allSettled는 각 모듈 내부에서 처리)
    const [prices, wallets, krwPerUsdt] = await Promise.all([
      multiArbPriceSource.fetchAllPrices(universe.krw),
      multiArbWalletStatusService.getAll(),
      multiArbPriceSource.getKrwPerUsdt(),
    ]);

    // 3. 같은 통화권 내 스프레드 계산 — spec §5 step 3 (국내↔해외 김프는 트리거 아님, §2)
    const candidates = [
      ...calculateSpreads('KRW', universe.krw, prices, KRW_ZONE_EXCHANGES),
      ...calculateSpreads('USDT', universe.usdt, prices, USDT_ZONE_EXCHANGES),
    ];

    // 4. 1차 필터: 임계값 초과만 — spec §5 step 4
    const hot = candidates.filter(c => c.spreadPct >= SPREAD_THRESHOLD_PCT);

    // 4.5 가격 sanity check (Task 12): 티커 충돌/단위 이상치 후보 제외
    //   기준가 = 바이낸스 USDT (KRW권은 환율 환산). 기준가 없으면 스프레드 상한 폴백.
    const sane: SpreadCandidate[] = [];
    const sanityLines: string[] = []; // 사이클당 1회 요약 로깅용
    for (const candidate of hot) {
      const sanity = checkPriceSanity(candidate, prices.binance, krwPerUsdt);
      if (sanity.ok) {
        sane.push(candidate);
      } else {
        sanityLines.push(`${candidate.symbol} zone=${candidate.currencyZone} ${sanity.reason}`);
        // I-2: 제외 건도 price_anomaly 태그로 DB 기록 (카톡 발송 없음) — 나중 분석/티커충돌 수집용
        try {
          await multiArbNotifierService.recordPriceAnomaly(candidate, sanity.reason ?? 'price_anomaly');
        } catch (err: any) {
          console.error(`[MultiExchangeArbScanner] price_anomaly 기록 실패 (${candidate.symbol}):`, err?.message ?? err);
        }
      }
    }
    if (sanityLines.length > 0) {
      console.warn(`[multi-arb] price_sanity 제외 ${sanityLines.join(' | ')}`);
    }

    // 5. 실현가능성 판정 (+김프 첨부) — spec §5 step 5 (발송 우선순위 정렬을 위해 전량 먼저 판정)
    const mismatchLines: string[] = []; // 사이클당 1회 요약 로깅용
    const evaluated: Array<{
      candidate: SpreadCandidate;
      feasibility: FeasibilityResult;
      kimchiPct: number | null;
    }> = [];
    for (const candidate of sane) {
      try {
        const feasibility = evaluateFeasibility(candidate, wallets);
        if (feasibility.feasibility === 'network_mismatch') {
          mismatchLines.push(formatNetworkMismatchLine(candidate, wallets));
        }
        const kimchiPct = computeKimchiPct(candidate.symbol, prices, krwPerUsdt);
        evaluated.push({ candidate, feasibility, kimchiPct });
      } catch (err: any) {
        // 후보 1건 실패가 나머지 후보 처리를 막지 않도록 격리
        console.error(`[MultiExchangeArbScanner] 후보 처리 실패 (${candidate.symbol}):`, err?.message ?? err);
      }
    }

    // 6. 발송 우선순위 정렬 (I-1): feasible 우선 → 스프레드 큰 순
    const gate = readAlertGateConfig();
    const ordered = [...evaluated].sort((a, b) => {
      const aRank = a.feasibility.feasibility === 'feasible' ? 0 : 1;
      const bRank = b.feasibility.feasibility === 'feasible' ? 0 : 1;
      if (aRank !== bRank) return aRank - bRank;
      return b.candidate.spreadPct - a.candidate.spreadPct;
    });

    // 7. 쿨다운/DB 기록/알림 — spec §5 step 6~7
    //    게이트·상한·feasible 필터는 "카톡 발송"에만 적용 (send:false여도 DB 기록·쿨다운 확인은 수행)
    let alerted = 0;
    for (const { candidate, feasibility, kimchiPct } of ordered) {
      try {
        const wantSend = gate.enabled
          && (!gate.feasibleOnly || feasibility.feasibility === 'feasible')
          && alerted < gate.maxPerCycle; // 상한은 실제 발송 성공 수 기준 (쿨다운 스킵은 미소모)
        const sent = await multiArbNotifierService.notify(candidate, feasibility, kimchiPct, { send: wantSend });
        if (sent) alerted++;
      } catch (err: any) {
        console.error(`[MultiExchangeArbScanner] 후보 처리 실패 (${candidate.symbol}):`, err?.message ?? err);
      }
    }

    // 네트워크 별칭 커버리지 수집용 요약 로그 — 사이클당 warn 1회 (과도 로깅 방지)
    if (mismatchLines.length > 0) {
      console.warn(`[multi-arb] network_mismatch ${mismatchLines.join(' | ')}`);
    }

    this.lastSummary = {
      scannedKrw: universe.krw.length,
      scannedUsdt: universe.usdt.length,
      hotCandidates: hot.length,
      alerted,
      lastScanAt: new Date().toISOString(),
    };
    if (hot.length > 0) {
      const gateNote = gate.enabled ? '' : ' · 알림 비활성(MULTI_ARB_ALERT_ENABLED=false)';
      console.log(`[MultiExchangeArbScanner] 후보 ${hot.length}건 (발송 ${alerted}건${gateNote}) — 임계값 ${SPREAD_THRESHOLD_PCT}%`);
    }
    return this.lastSummary;
  }
}

export const multiExchangeArbScannerService = new MultiExchangeArbScannerService();
