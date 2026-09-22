// 멀티 거래소 차익거래 알림 — 공용 타입/상수 (spec 2026-09-14 §4~§6)

export type MultiArbExchange = 'upbit' | 'bithumb' | 'binance' | 'mexc' | 'gateio';
export type CurrencyZone = 'KRW' | 'USDT';

// 통화권별 소속 거래소 (spec §5: KRW권 = 업비트·빗썸 / USDT권 = 바이낸스·MEXC·Gate.io)
export const KRW_ZONE_EXCHANGES: MultiArbExchange[] = ['upbit', 'bithumb'];
export const USDT_ZONE_EXCHANGES: MultiArbExchange[] = ['binance', 'mexc', 'gateio'];

// 거래소 한글 표기 (카카오톡 메시지용)
export const EXCHANGE_LABELS: Record<MultiArbExchange, string> = {
  upbit: '업비트',
  bithumb: '빗썸',
  binance: '바이낸스',
  mexc: 'MEXC',
  gateio: 'Gate.io',
};

// 코인 1개의 특정 네트워크 입출금 상태 (정규화 후)
export interface NetworkStatus {
  network: string;          // 정규화된 네트워크명 (예: "ETH", "LSK", "TRX")
  depositEnabled: boolean;
  withdrawEnabled: boolean;
  withdrawFee?: number;     // 코인 단위 출금 수수료 (바이낸스/MEXC 제공, KRW 거래소는 미제공)
}

// 거래소 1곳의 "코인 심볼 → 지원 네트워크 목록" 맵
export type WalletStatusMap = Map<string, NetworkStatus[]>;

// 거래소 1곳의 "코인 심볼 → 현재가" 맵 (통화권 단위: KRW 또는 USDT)
export type PriceMap = Map<string, number>;

// 호가 한 단계 (가격 + 수량)
export interface BookLevel {
  price: number;
  qty: number;
}

// 거래소 1곳 코인 1개의 호가 (최우선 + 선택적 depth levels)
export interface BookTop {
  ask: number;              // 최저 매도호가 (여기에 매수 = 내가 지불)
  bid: number;               // 최고 매수호가 (여기에 매도 = 내가 수취)
  askLevels?: BookLevel[];  // 오름차순(낮은 ask 먼저). 배치로 얻은 경우만(KRW권)
  bidLevels?: BookLevel[];  // 내림차순(높은 bid 먼저)
}

// 거래소 1곳의 "코인 심볼 → 호가" 맵
export type BookMap = Map<string, BookTop>;

// 최소주문 규모(순차익 계산용). KRW권=원, USDT권=USDT.
export const MIN_NOTIONAL_BY_ZONE: Record<CurrencyZone, number> = { KRW: 100000, USDT: 100 };

// 스프레드 후보 (SpreadCalculator 출력)
// buyPrice=매수측 최저 매도호가(ask, 내가 지불) · sellPrice=매도측 최고 매수호가(bid, 내가 수취)
export interface SpreadCandidate {
  symbol: string;
  currencyZone: CurrencyZone;
  buyExchange: MultiArbExchange;
  buyPrice: number;         // = askPrice (매수측 ask)
  askPrice: number;         // 매수측 최저 매도호가
  sellExchange: MultiArbExchange;
  sellPrice: number;        // = bidPrice (매도측 bid)
  bidPrice: number;         // 매도측 최고 매수호가
  spreadPct: number;        // 실현 최우선호가 스프레드: (sell.bid - buy.ask) / buy.ask * 100, 항상 > 0
}

// 순차익 계산 결과 (NetCalculator 출력)
export interface NetResult {
  filledNotional: number;   // 최소주문 규모까지 실제 채운 금액(양쪽 min)
  depthOk: boolean;         // 최소주문 규모를 양쪽 호가가 커버했는가
  buyVwap: number;          // 매수측 체결 VWAP(지불 단가)
  sellVwap: number;         // 매도측 체결 VWAP(수취 단가)
  grossSpreadPct: number;   // (sellVwap − buyVwap)/buyVwap*100 (깊이 반영)
  tradingFeePct: number;    // 양쪽 taker 수수료 합 %
  withdrawFeePct: number;   // 출금료 %환산 (미확인=0)
  withdrawFeeKnown: boolean;
  netSpreadPct: number;     // grossSpreadPct − tradingFeePct − withdrawFeePct
  // 순차익이 임계값(thresholdPct) 이상 유지되는 최대 체결 규모 (호가 깊이 기준). thresholdPct 미전달 시 0/false.
  maxExecBuyNotional: number;   // 최대 매수 규모(지불액, 통화권 단위)
  maxExecSellNotional: number;  // 같은 수량의 매도 수취액 (> 매수액)
  maxExecDepthLimited: boolean; // 조회 호가 끝까지 임계 유지된 채 소진(실제론 더 클 수 있음)
}

// 실현가능성 태그 (spec §6, DB feasibility 컬럼과 동일 문자열)
// 주의: DB feasibility 컬럼에는 이 외에 기록 전용 태그 'price_anomaly'(price sanity 제외 건, I-2)도 저장된다
export type FeasibilityTag = 'feasible' | 'network_mismatch' | 'deposit_halt' | 'notice_warning' | 'unverified';

export interface FeasibilityResult {
  feasibility: FeasibilityTag;
  networkMatch: boolean | null;   // 판정 불가(unverified) 시 null
  matchedNetwork: string | null;  // 입출금까지 정상인 교집합 네트워크 (feasible일 때만; 그 외는 항상 null)
  note: string;                   // 사람이 읽을 요약/경고 (DB note 컬럼 + 카톡 메시지)
}
