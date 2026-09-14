// 거래소별 코인 입출금 상태 + 네트워크 맵 제공자 (spec §4 WalletStatusProvider, §6 필터 입력)
// capital/config·status/wallet은 전체를 한 번에 반환하므로 거래소당 1콜 → 5분 통째 캐시 (spec §9)
import axios from 'axios';
import { signedGet, generateUpbitJwt, BINANCE, MEXC } from './exchange/exchange-signer';
import { generateBithumbJwt } from './exchange/bithumb-client';
import { getAdminCreds } from './admin-credentials';
import { MultiArbExchange, NetworkStatus, WalletStatusMap } from './multi-arb-types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5분 (spec §9: 5~10분 캐시)
const HTTP_TIMEOUT_MS = 10000;

// 네트워크명 별칭 → 정규형 (거래소마다 표기가 달라 교집합 판정 전 통일)
const NETWORK_ALIASES: Record<string, string> = {
  ERC20: 'ETH',
  ETHEREUM: 'ETH',
  TRC20: 'TRX',
  TRON: 'TRX',
  BEP20: 'BSC',
  'BEP20(BSC)': 'BSC',
  LISK: 'LSK',
};

export function normalizeNetwork(raw: string): string {
  const key = String(raw ?? '').trim().toUpperCase();
  return NETWORK_ALIASES[key] ?? key;
}

// ── 거래소별 응답 파싱 (순수함수 — 단위테스트 대상) ─────────────────────────

// Binance GET /sapi/v1/capital/config/getall (spec §3 실측: 744개 코인)
export function parseBinanceWalletConfig(rows: any[]): WalletStatusMap {
  const map: WalletStatusMap = new Map();
  for (const row of rows ?? []) {
    if (!row?.coin || !Array.isArray(row.networkList)) continue;
    map.set(String(row.coin).toUpperCase(), row.networkList.map((n: any): NetworkStatus => ({
      network: normalizeNetwork(n.network),
      depositEnabled: !!n.depositEnable,
      withdrawEnabled: !!n.withdrawEnable,
    })));
  }
  return map;
}

// MEXC GET /api/v3/capital/config/getall (spec §3 실측: 9,539개 코인)
// 구버전 응답은 network 대신 netWork 필드 사용 → 둘 다 처리
export function parseMexcWalletConfig(rows: any[]): WalletStatusMap {
  const map: WalletStatusMap = new Map();
  for (const row of rows ?? []) {
    if (!row?.coin || !Array.isArray(row.networkList)) continue;
    map.set(String(row.coin).toUpperCase(), row.networkList.map((n: any): NetworkStatus => ({
      network: normalizeNetwork(n.network ?? n.netWork),
      depositEnabled: !!n.depositEnable,
      withdrawEnabled: !!n.withdrawEnable,
    })));
  }
  return map;
}

// 업비트/빗썸 GET /v1/status/wallet → [{ currency, net_type, wallet_state, block_state }]
// wallet_state: working(입출금 정상) | withdraw_only | deposit_only | paused | unsupported
function parseKrwWalletStatus(rows: any[]): WalletStatusMap {
  const map: WalletStatusMap = new Map();
  for (const row of rows ?? []) {
    if (!row?.currency) continue;
    const symbol = String(row.currency).toUpperCase();
    const state = String(row.wallet_state ?? '');
    const entry: NetworkStatus = {
      network: normalizeNetwork(row.net_type ?? symbol),
      depositEnabled: state === 'working' || state === 'deposit_only',
      withdrawEnabled: state === 'working' || state === 'withdraw_only',
    };
    const existing = map.get(symbol);
    // 멀티 net_type 코인 (예: USDT TRX/ETH) 누적 — 불변 패턴
    map.set(symbol, existing ? [...existing, entry] : [entry]);
  }
  return map;
}

export function parseUpbitWalletStatus(rows: any[]): WalletStatusMap {
  return parseKrwWalletStatus(rows);
}

export function parseBithumbWalletStatus(rows: any[]): WalletStatusMap {
  return parseKrwWalletStatus(rows);
}

// Gate.io GET /api/v4/spot/currencies (public) → [{ currency, chains?: [...], chain?, deposit_disabled, withdraw_disabled }]
export function parseGateioCurrencies(rows: any[]): WalletStatusMap {
  const map: WalletStatusMap = new Map();
  for (const row of rows ?? []) {
    if (!row?.currency) continue;
    const symbol = String(row.currency).toUpperCase();
    let entries: NetworkStatus[];
    if (Array.isArray(row.chains) && row.chains.length > 0) {
      entries = row.chains.map((c: any): NetworkStatus => ({
        network: normalizeNetwork(c.name),
        depositEnabled: !c.deposit_disabled,
        withdrawEnabled: !c.withdraw_disabled,
      }));
    } else {
      entries = [{
        network: normalizeNetwork(row.chain ?? symbol),
        depositEnabled: !row.deposit_disabled,
        withdrawEnabled: !row.withdraw_disabled,
      }];
    }
    map.set(symbol, entries);
  }
  return map;
}

// ── 서비스 (조회 + 캐시) ─────────────────────────────────────────────────────

class MultiArbWalletStatusService {
  private cache: Map<MultiArbExchange, { at: number; map: WalletStatusMap }> = new Map();

  // 5개 거래소 지갑 상태를 병렬 조회 (실패 거래소는 결과에서 제외 → FeasibilityFilter가 unverified 처리)
  async getAll(): Promise<Partial<Record<MultiArbExchange, WalletStatusMap>>> {
    const exchanges: MultiArbExchange[] = ['upbit', 'bithumb', 'binance', 'mexc', 'gateio'];
    const results = await Promise.allSettled(exchanges.map(ex => this.getForExchange(ex)));

    const out: Partial<Record<MultiArbExchange, WalletStatusMap>> = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value !== null) {
        out[exchanges[i]] = r.value;
      } else if (r.status === 'rejected') {
        console.error(`[MultiArbWalletStatus] ${exchanges[i]} 지갑 상태 조회 실패:`, r.reason?.message ?? r.reason);
      }
    });
    return out;
  }

  private async getForExchange(exchange: MultiArbExchange): Promise<WalletStatusMap | null> {
    const cached = this.cache.get(exchange);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.map;

    const map = await this.fetchForExchange(exchange);
    if (map === null) return null; // 자격증명 없음 — 캐시하지 않음
    this.cache.set(exchange, { at: Date.now(), map });
    return map;
  }

  private async fetchForExchange(exchange: MultiArbExchange): Promise<WalletStatusMap | null> {
    switch (exchange) {
      case 'binance': {
        const cred = await getAdminCreds('binance');
        if (!cred) return null;
        const data = await signedGet(BINANCE.baseUrl, BINANCE.apiKeyHeader, cred.apiKey, cred.secretKey, '/sapi/v1/capital/config/getall');
        return parseBinanceWalletConfig(data);
      }
      case 'mexc': {
        const cred = await getAdminCreds('mexc');
        if (!cred) return null;
        const data = await signedGet(MEXC.baseUrl, MEXC.apiKeyHeader, cred.apiKey, cred.secretKey, '/api/v3/capital/config/getall');
        return parseMexcWalletConfig(data);
      }
      case 'upbit': {
        const cred = await getAdminCreds('upbit');
        if (!cred) return null;
        const res = await axios.get('https://api.upbit.com/v1/status/wallet', {
          headers: { Authorization: `Bearer ${generateUpbitJwt(cred.apiKey, cred.secretKey)}` },
          timeout: HTTP_TIMEOUT_MS,
        });
        return parseUpbitWalletStatus(res.data);
      }
      case 'bithumb': {
        const cred = await getAdminCreds('bithumb');
        if (!cred) return null;
        const res = await axios.get('https://api.bithumb.com/v1/status/wallet', {
          headers: { Authorization: `Bearer ${generateBithumbJwt(cred.apiKey, cred.secretKey)}` },
          timeout: HTTP_TIMEOUT_MS,
        });
        return parseBithumbWalletStatus(res.data);
      }
      case 'gateio': {
        // /api/v4/spot/currencies는 public — 서명 불필요 (spec §3의 currency_chains 대신 전체 1콜 버전)
        const res = await axios.get('https://api.gateio.ws/api/v4/spot/currencies', { timeout: HTTP_TIMEOUT_MS });
        return parseGateioCurrencies(res.data);
      }
    }
  }
}

export const multiArbWalletStatusService = new MultiArbWalletStatusService();
