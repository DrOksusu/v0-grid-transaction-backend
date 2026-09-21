// 멀티 거래소 차익 스캐너 오케스트레이터 (spec §4~§5, 2026-09-22 호가·깊이·순차익 개편)
// 60초 주기 (MultiExchangeArbAgent에서 호출): 교집합 → 호가 → 실현스프레드 → 임계값 → sanity → 실현가능성 → 깊이+순차익 → 쿨다운/알림
import { multiArbSymbolUniverseService } from './multi-arb-symbol-universe.service';
import { multiArbBookSource } from './multi-arb-book-source.service';
import { multiArbPriceSource } from './multi-arb-price-source.service';
import { fetchBinanceDepth, fetchMexcDepth, fetchGateioDepth } from './multi-arb-depth.service';
import { multiArbWalletStatusService } from './multi-arb-wallet-status.service';
import { calculateSpreads } from './multi-arb-spread-calculator';
import { checkPriceSanity } from './multi-arb-price-sanity';
import { evaluateFeasibility } from './multi-arb-feasibility-filter';
import { computeNet, WithdrawFeeInput } from './multi-arb-net-calculator';
import { multiArbNotifierService } from './multi-arb-notifier.service';
import { getAdminCreds } from './admin-credentials';
import { BithumbClient } from './exchange/bithumb-client';
import {
  BookLevel, BookMap, FeasibilityResult, KRW_ZONE_EXCHANGES, USDT_ZONE_EXCHANGES,
  MIN_NOTIONAL_BY_ZONE, MultiArbExchange, NetResult, PriceMap,
  SpreadCandidate, WalletStatusMap,
} from './multi-arb-types';
import { EXCHANGE_FEE_BPS as INVENTORY_ARB_FEE_BPS } from './inventory-arb/candidate-scanner';

// 알림 임계값: 이제 "순차익 %" 의미 (2026-09-22 사용자 결정). env 없을 때만 기본값 1로 하향.
const SPREAD_THRESHOLD_PCT = Number(process.env.MULTI_ARB_THRESHOLD_PCT ?? '1');

// (H1 리뷰 반영) 출금료 미확인 시 적용할 보수적 폴백 출금료율(%) — 0으로 통과시키지 않기 위함.
// gateio/upbit 매수 상시 + bithumb 조회 실패 시에도 순차익이 과대평가되지 않도록 불리하게(빼는 방향) 반영.
function readUnknownWithdrawFallbackPct(): number {
  const raw = Number(process.env.MULTI_ARB_UNKNOWN_WITHDRAW_PCT ?? '1');
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

// 거래수수료 bps — inventory-arb candidate-scanner의 상수를 재사용하고 gateio만 폴백 추가
const EXCHANGE_FEE_BPS: Record<MultiArbExchange, number> = {
  upbit: INVENTORY_ARB_FEE_BPS.upbit ?? 5,
  bithumb: INVENTORY_ARB_FEE_BPS.bithumb ?? 5,
  binance: INVENTORY_ARB_FEE_BPS.binance ?? 10,
  mexc: INVENTORY_ARB_FEE_BPS.mexc ?? 10,
  gateio: 20,
};

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

// BookMap → PriceMap(중간가) 파생 — 기존 checkPriceSanity/computeKimchiPct는 숫자 PriceMap 계약이라
// 헬퍼 수정 없이 그대로 재사용하기 위해 호가에서 mid=(ask+bid)/2를 뽑아 넘긴다.
function deriveMidPrices(books: Partial<Record<MultiArbExchange, BookMap>>): Partial<Record<MultiArbExchange, PriceMap>> {
  const out: Partial<Record<MultiArbExchange, PriceMap>> = {};
  for (const [exchange, bookMap] of Object.entries(books) as Array<[MultiArbExchange, BookMap]>) {
    const priceMap: PriceMap = new Map();
    for (const [symbol, top] of bookMap.entries()) {
      priceMap.set(symbol, (top.ask + top.bid) / 2);
    }
    out[exchange] = priceMap;
  }
  return out;
}

// KRW권 depth: book-source가 이미 배치로 채운 levels를 그대로 사용
function krwLevelsFromBooks(
  books: Partial<Record<MultiArbExchange, BookMap>>,
  exchange: MultiArbExchange,
  symbol: string,
): { askLevels: BookLevel[]; bidLevels: BookLevel[] } | null {
  const top = books[exchange]?.get(symbol);
  if (!top || !top.askLevels || !top.bidLevels) return null;
  return { askLevels: top.askLevels, bidLevels: top.bidLevels };
}

// USDT권 depth: shortlist(sane 통과 후보)만 per-symbol 조회
async function usdtLevelsFromDepth(
  exchange: MultiArbExchange,
  symbol: string,
): Promise<{ askLevels: BookLevel[]; bidLevels: BookLevel[] } | null> {
  switch (exchange) {
    case 'binance': return fetchBinanceDepth(symbol);
    case 'mexc': return fetchMexcDepth(symbol);
    case 'gateio': return fetchGateioDepth(symbol);
    default: return null; // upbit/bithumb는 USDT권 소속 아님
  }
}

// 매수측 출금수수료 조회 — bithumb(정액/정률 API) · binance/mexc(NetworkStatus.withdrawFee) · gateio/upbit(미확인)
// (MEDIUM-1 리뷰 반영) matchedNetwork가 없으면(비feasible, feasibleOnly=false일 때 도달) 심볼명으로
// fabricate하지 않고 조회 자체를 건너뛴다 — symbol을 net_type처럼 넘기면 엉뚱한 네트워크를 조회하게 된다.
// 빗썸 status/wallet net_type은 전부 네이티브 코드(별칭 없음)라 matchedNetwork가 있을 때는 그대로 넘겨도 안전(검증됨).
async function resolveWithdrawFee(
  buyExchange: MultiArbExchange,
  symbol: string,
  matchedNetwork: string | null,
  wallets: Partial<Record<MultiArbExchange, WalletStatusMap>>,
  bithumbClient: BithumbClient | null,
  bithumbFeeCache: Map<string, WithdrawFeeInput | null>,
): Promise<WithdrawFeeInput | null> {
  if (!matchedNetwork) return null; // 정규화된 네트워크를 모르면 미확인 처리 (fabricate 금지)
  const network = matchedNetwork;

  if (buyExchange === 'bithumb') {
    if (!bithumbClient) return null;
    const cacheKey = `${symbol}:${network}`;
    if (bithumbFeeCache.has(cacheKey)) return bithumbFeeCache.get(cacheKey) ?? null;
    const info = await bithumbClient.getWithdrawFeeInfo(symbol, network);
    // rate>0 우선(정률), 없으면 feeCoin>0(정액) — 0/미확인은 출금료 미확인으로 취급 (은폐 금지)
    let result: WithdrawFeeInput | null = null;
    if (info?.rate != null && info.rate > 0) {
      result = { rate: info.rate };
    } else if (info?.feeCoin != null && info.feeCoin > 0) {
      result = { feeCoin: info.feeCoin };
    }
    bithumbFeeCache.set(cacheKey, result);
    return result;
  }

  if (buyExchange === 'binance' || buyExchange === 'mexc') {
    const entry = wallets[buyExchange]?.get(symbol)?.find(n => n.network === network);
    if (entry?.withdrawFee != null && entry.withdrawFee > 0) {
      return { feeCoin: entry.withdrawFee };
    }
    return null;
  }

  // gateio/upbit는 매수측 출금료 미제공 (spec 확정)
  return null;
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

    // 2. 호가 + 지갑 상태 + 환율 병렬 조회 — spec §5 step 2 (Promise.allSettled는 각 모듈 내부에서 처리)
    const [books, wallets, krwPerUsdt] = await Promise.all([
      multiArbBookSource.fetchAllBooks(universe.krw),
      multiArbWalletStatusService.getAll(),
      multiArbPriceSource.getKrwPerUsdt(),
    ]);

    // sanity/kimchi 헬퍼는 숫자 PriceMap 계약이라 호가에서 mid=(ask+bid)/2를 파생해 그대로 넘긴다
    const midPrices = deriveMidPrices(books);

    // 3. 같은 통화권 내 순서쌍 실현 스프레드 계산 — spec §5 step 3 (국내↔해외 김프는 트리거 아님, §2)
    const candidates = [
      ...calculateSpreads('KRW', universe.krw, books, KRW_ZONE_EXCHANGES),
      ...calculateSpreads('USDT', universe.usdt, books, USDT_ZONE_EXCHANGES),
    ];

    // 4. 1차 필터: 실현 최우선호가 스프레드 임계값 초과만 — spec §5 step 4
    const hot = candidates.filter(c => c.spreadPct >= SPREAD_THRESHOLD_PCT);

    // 4.5 가격 sanity check (Task 12): 티커 충돌/단위 이상치 후보 제외
    //   기준가 = 바이낸스 USDT (KRW권은 환율 환산). 기준가 없으면 스프레드 상한 폴백.
    const sane: SpreadCandidate[] = [];
    const sanityLines: string[] = []; // 사이클당 1회 요약 로깅용
    for (const candidate of hot) {
      const sanity = checkPriceSanity(candidate, midPrices.binance, krwPerUsdt);
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
        const kimchiPct = computeKimchiPct(candidate.symbol, midPrices, krwPerUsdt);
        evaluated.push({ candidate, feasibility, kimchiPct });
      } catch (err: any) {
        // 후보 1건 실패가 나머지 후보 처리를 막지 않도록 격리
        console.error(`[MultiExchangeArbScanner] 후보 처리 실패 (${candidate.symbol}):`, err?.message ?? err);
      }
    }

    // 5.5 깊이+순차익 계산 (2026-09-22 개편) — feasible(또는 sane) 후보마다 최소주문 VWAP·출금료 반영 순차익
    const gate = readAlertGateConfig();
    const unknownWithdrawFallbackPct = readUnknownWithdrawFallbackPct(); // (H1) 출금료 미확인 시 보수적 폴백률
    const bithumbCred = await getAdminCreds('bithumb');
    const bithumbClient = bithumbCred
      ? new BithumbClient({ accessKey: bithumbCred.apiKey, secretKey: bithumbCred.secretKey })
      : null;
    const bithumbFeeCache = new Map<string, WithdrawFeeInput | null>();

    const withNet: Array<{
      candidate: SpreadCandidate;
      feasibility: FeasibilityResult;
      kimchiPct: number | null;
      net: NetResult;
    }> = [];
    for (const { candidate, feasibility, kimchiPct } of evaluated) {
      try {
        const minNotional = MIN_NOTIONAL_BY_ZONE[candidate.currencyZone];
        const buyLevels = candidate.currencyZone === 'KRW'
          ? krwLevelsFromBooks(books, candidate.buyExchange, candidate.symbol)?.askLevels
          : (await usdtLevelsFromDepth(candidate.buyExchange, candidate.symbol))?.askLevels;
        const sellLevels = candidate.currencyZone === 'KRW'
          ? krwLevelsFromBooks(books, candidate.sellExchange, candidate.symbol)?.bidLevels
          : (await usdtLevelsFromDepth(candidate.sellExchange, candidate.symbol))?.bidLevels;

        if (!buyLevels || !sellLevels) {
          // 깊이 조회 실패(USDT 개별 depth 실패 등) — depthOk=false로 명시, 발송 대상에서 자동 제외
          withNet.push({
            candidate, feasibility, kimchiPct,
            net: {
              filledNotional: 0, depthOk: false, buyVwap: 0, sellVwap: 0,
              grossSpreadPct: 0, tradingFeePct: 0, withdrawFeePct: 0,
              withdrawFeeKnown: false, netSpreadPct: 0,
            },
          });
          continue;
        }

        const withdrawFee = await resolveWithdrawFee(
          candidate.buyExchange, candidate.symbol, feasibility.matchedNetwork, wallets, bithumbClient, bithumbFeeCache,
        );
        const net = computeNet({
          buyLevels,
          sellLevels,
          minNotional,
          buyFeeBps: EXCHANGE_FEE_BPS[candidate.buyExchange],
          sellFeeBps: EXCHANGE_FEE_BPS[candidate.sellExchange],
          withdrawFee,
          unknownWithdrawFallbackPct,
        });
        withNet.push({ candidate, feasibility, kimchiPct, net });
      } catch (err: any) {
        console.error(`[MultiExchangeArbScanner] 깊이/순차익 계산 실패 (${candidate.symbol}):`, err?.message ?? err);
      }
    }

    // 6. 발송 우선순위 정렬 (I-1 확장): feasible 우선 → 순차익 큰 순
    const ordered = [...withNet].sort((a, b) => {
      const aRank = a.feasibility.feasibility === 'feasible' ? 0 : 1;
      const bRank = b.feasibility.feasibility === 'feasible' ? 0 : 1;
      if (aRank !== bRank) return aRank - bRank;
      return b.net.netSpreadPct - a.net.netSpreadPct;
    });

    // 7. 쿨다운/DB 기록/알림 — spec §5 step 6~7 (2026-09-22: 깊이+순차익 조건 추가)
    //    게이트·상한·feasible 필터·깊이·순차익 임계값은 "카톡 발송"에만 적용
    //    (send:false여도 DB 기록·쿨다운 확인은 수행 — 미충족 후보도 관찰 목적으로 기록)
    let alerted = 0;
    for (const { candidate, feasibility, kimchiPct, net } of ordered) {
      try {
        const wantSend = gate.enabled
          && (!gate.feasibleOnly || feasibility.feasibility === 'feasible')
          && net.depthOk
          && net.netSpreadPct >= SPREAD_THRESHOLD_PCT
          && alerted < gate.maxPerCycle; // 상한은 실제 발송 성공 수 기준 (쿨다운 스킵은 미소모)
        const sent = await multiArbNotifierService.notify(candidate, feasibility, kimchiPct, net, { send: wantSend });
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
      console.log(`[MultiExchangeArbScanner] 후보 ${hot.length}건 (발송 ${alerted}건${gateNote}) — 순차익 임계값 ${SPREAD_THRESHOLD_PCT}%`);
    }
    return this.lastSummary;
  }
}

export const multiExchangeArbScannerService = new MultiExchangeArbScannerService();
