// 후보 스캐너 (온디맨드): 공통 상장 ∩ 내 보유 코인마다 라이브 크로스 스프레드 + 내 잔고로
// "지금 실행 가능한" 재고형 아비 후보를 판정. 순수 판정(buildCandidate) + 공통상장 조회.
import type { BookTop, InventoryArbCandidate } from './types';
import { detectOpportunity } from './spread-detector';

const MIN_ORDER_KRW = 5000;

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

  return {
    symbol,
    direction: opp.direction,
    buyExchange: opp.buyExchange,
    sellExchange: opp.sellExchange,
    spreadBps: opp.spreadBps,
    buyPrice: opp.buyPrice,
    sellPrice: opp.sellPrice,
    executableQty: Math.floor(executableQty * 1e8) / 1e8,
    executableKrw: Math.round(executableKrw),
    type,
    sellCoinBalance,
    buyKrwBalance: Math.round(buyKrwBalance),
  };
}

/** 스프레드 큰 순 정렬 */
export function rankCandidates(candidates: InventoryArbCandidate[]): InventoryArbCandidate[] {
  return [...candidates].sort((a, b) => b.spreadBps - a.spreadBps);
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
