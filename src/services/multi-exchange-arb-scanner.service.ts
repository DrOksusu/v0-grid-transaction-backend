// 멀티 거래소 차익 스캐너 오케스트레이터 (spec §4~§5)
// 60초 주기 (MultiExchangeArbAgent에서 호출): 교집합 → 시세 → 스프레드 → 임계값 → 실현가능성 → 쿨다운/알림
import { multiArbSymbolUniverseService } from './multi-arb-symbol-universe.service';
import { multiArbPriceSource } from './multi-arb-price-source.service';
import { multiArbWalletStatusService } from './multi-arb-wallet-status.service';
import { calculateSpreads } from './multi-arb-spread-calculator';
import { evaluateFeasibility } from './multi-arb-feasibility-filter';
import { multiArbNotifierService } from './multi-arb-notifier.service';
import {
  KRW_ZONE_EXCHANGES, USDT_ZONE_EXCHANGES, MultiArbExchange, PriceMap,
  SpreadCandidate, WalletStatusMap,
} from './multi-arb-types';

// 알림 임계값: 스프레드 2% 이상 (spec §2, 조정 가능 — env 우선)
const SPREAD_THRESHOLD_PCT = Number(process.env.MULTI_ARB_THRESHOLD_PCT ?? '2');

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

    // 5~7. 실현가능성 판정 → 쿨다운/알림 (+김프 첨부) — spec §5 step 5~7
    let alerted = 0;
    const mismatchLines: string[] = []; // 사이클당 1회 요약 로깅용
    for (const candidate of hot) {
      try {
        const feasibility = evaluateFeasibility(candidate, wallets);
        if (feasibility.feasibility === 'network_mismatch') {
          mismatchLines.push(formatNetworkMismatchLine(candidate, wallets));
        }
        const kimchiPct = computeKimchiPct(candidate.symbol, prices, krwPerUsdt);
        const sent = await multiArbNotifierService.notify(candidate, feasibility, kimchiPct);
        if (sent) alerted++;
      } catch (err: any) {
        // 후보 1건 실패가 나머지 후보 처리를 막지 않도록 격리
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
      console.log(`[MultiExchangeArbScanner] 후보 ${hot.length}건 (발송 ${alerted}건) — 임계값 ${SPREAD_THRESHOLD_PCT}%`);
    }
    return this.lastSummary;
  }
}

export const multiExchangeArbScannerService = new MultiExchangeArbScannerService();
