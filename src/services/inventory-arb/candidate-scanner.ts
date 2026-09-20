// 후보 스캐너 (온디맨드): 공통 상장 ∩ 내 보유 코인마다 라이브 크로스 스프레드 + 내 잔고로
// "지금 실행 가능한" 재고형 아비 후보를 판정. 순수 판정(buildCandidate) + 공통상장 조회.
import type { BookTop, InventoryArbCandidate } from './types';
import { detectOpportunity } from './spread-detector';

const MIN_ORDER_KRW = 5000;

// 거래 수수료 추정(bps, taker). 실체결 net은 executor가 실수수료로 계산 — 이건 후보 화면용 추정치.
// ⚠️ 빗썸 실수수료는 계정 등급에 따라 다름(확인 필요). 조정 지점.
export const EXCHANGE_FEE_BPS: Record<string, number> = { upbit: 5, bithumb: 5, binance: 10, mexc: 10 };

/** 재고형 봇에서 제외할 스테이블/페그 코인 (기존 maker-taker 스테이블 봇과 중복) */
export const EXCLUDED_STABLES = new Set<string>([
  'USDT', 'USDC', 'USDS', 'USD1', 'USDE', 'DAI', 'TUSD', 'BUSD', 'USDP', 'GUSD', 'FDUSD', 'PYUSD', 'RLUSD', 'EURC', 'USDG',
]);

export interface CandidateBalances {
  upbitCoin: number;
  upbitKrw: number;
  bithumbCoin: number;
  bithumbKrw: number;
}

/**
 * 순수 판정: 한 코인의 양쪽 호가 + 내 잔고 → 실행 가능한 후보인지.
 * 스프레드 방향을 감지하고, 그 방향에 필요한 매도측 코인 + 매수측 KRW가 있어 최소주문 이상 체결 가능하면 후보.
 * @param minSpreadBps 표시 임계 (이 미만 스프레드는 제외)
 */
export function buildCandidate(
  symbol: string,
  upbit: BookTop,
  bithumb: BookTop,
  balances: CandidateBalances,
  minSpreadBps: number,
): InventoryArbCandidate | null {
  const opp = detectOpportunity(upbit, bithumb, minSpreadBps);
  if (!opp || opp.spreadBps < minSpreadBps) return null;

  const sellCoinBalance = opp.sellExchange === 'upbit' ? balances.upbitCoin : balances.bithumbCoin;
  const buyKrwBalance = opp.buyExchange === 'upbit' ? balances.upbitKrw : balances.bithumbKrw;
  const buyCoinBalance = opp.buyExchange === 'upbit' ? balances.upbitCoin : balances.bithumbCoin;

  if (opp.buyPrice <= 0) return null;
  const executableQty = Math.min(opp.maxQtyByDepth, sellCoinBalance, buyKrwBalance / opp.buyPrice);
  const executableKrw = executableQty * opp.buyPrice;
  // 매도측 코인 또는 매수측 KRW가 없어 최소주문도 못 채우면 후보 아님
  if (executableKrw < MIN_ORDER_KRW) return null;

  // 양쪽에 코인 보유 = 양방향 가능. 매도측만 보유 = 단방향 드레인(EGLD형).
  const type: InventoryArbCandidate['type'] =
    sellCoinBalance > 0 && buyCoinBalance > 0 ? 'bidirectional' : 'one_way_drain';

  // 순이익 추정 = 규모 × 스프레드 − 양쪽 거래 수수료
  const qty = Math.floor(executableQty * 1e8) / 1e8;
  const gross = qty * (opp.sellPrice - opp.buyPrice);
  const buyFeeBps = EXCHANGE_FEE_BPS[opp.buyExchange] ?? 5;
  const sellFeeBps = EXCHANGE_FEE_BPS[opp.sellExchange] ?? 5;
  const fee = (qty * opp.buyPrice * buyFeeBps) / 10000 + (qty * opp.sellPrice * sellFeeBps) / 10000;
  const net = gross - fee;

  return {
    symbol,
    direction: opp.direction,
    buyExchange: opp.buyExchange,
    sellExchange: opp.sellExchange,
    spreadBps: opp.spreadBps,
    buyPrice: opp.buyPrice,
    sellPrice: opp.sellPrice,
    executableQty: qty,
    executableKrw: Math.round(executableKrw),
    type,
    sellCoinBalance,
    buyKrwBalance: Math.round(buyKrwBalance),
    estimatedGrossKrw: Math.round(gross),
    estimatedFeeKrw: Math.round(fee),
    estimatedNetKrw: Math.round(net),
    netProfitable: net > 0,
    realizable: true, // KRW 후보는 재고 보유 시 즉시 실행 가능 (buildCandidate가 executableKrw≥최소주문 보장)
  };
}

/** 추정 순이익 큰 순 정렬 (실제 남는 것 우선) */
export function rankCandidates(candidates: InventoryArbCandidate[]): InventoryArbCandidate[] {
  return [...candidates].sort((a, b) => b.estimatedNetKrw - a.estimatedNetKrw);
}

/** 업비트 KRW ∩ 빗썸 KRW 공통 상장 심볼 (공개 REST). 실패 시 빈 배열 */
export async function fetchCommonListings(): Promise<string[]> {
  try {
    const [upR, btR] = await Promise.all([
      fetch('https://api.upbit.com/v1/market/all?isDetails=false'),
      fetch('https://api.bithumb.com/public/ticker/ALL_KRW'),
    ]);
    if (!upR.ok || !btR.ok) return [];
    const up = await upR.json();
    const bt = await btR.json();
    const upKrw = new Set<string>(
      (up as any[]).filter((m) => typeof m.market === 'string' && m.market.startsWith('KRW-')).map((m) => m.market.slice(4)),
    );
    const btData = (bt as any)?.data ?? {};
    const btKrw = new Set<string>(Object.keys(btData).filter((k) => k !== 'date'));
    return [...upKrw].filter((c) => btKrw.has(c));
  } catch {
    return [];
  }
}
