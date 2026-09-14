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
}

// 거래소 1곳의 "코인 심볼 → 지원 네트워크 목록" 맵
export type WalletStatusMap = Map<string, NetworkStatus[]>;

// 거래소 1곳의 "코인 심볼 → 현재가" 맵 (통화권 단위: KRW 또는 USDT)
export type PriceMap = Map<string, number>;

// 스프레드 후보 (SpreadCalculator 출력)
export interface SpreadCandidate {
  symbol: string;
  currencyZone: CurrencyZone;
  buyExchange: MultiArbExchange;
  buyPrice: number;
  sellExchange: MultiArbExchange;
  sellPrice: number;
  spreadPct: number;        // (sell - buy) / buy * 100, 항상 > 0
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
