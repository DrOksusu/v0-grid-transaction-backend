import { OrderbookSnapshot, isSpreadProfitable } from './cross-exchange-spread-gate';

export interface PrecheckBotConfig {
  coin: string;
  quantity: number;
  minSpreadBps: number;
  depegMinKrw: number;
  depegMaxKrw: number;
  liquidityMultiplier: number;
  dailyCountLimit: number;
  dailyLossLimitKrw: number;
}

export interface LiquiditySnapshot {
  upbitBidQty: number;
  upbitAskQty: number;
  bithumbBidQty: number;
  bithumbAskQty: number;
}

export interface BalanceSnapshot {
  upbit: Record<string, number>;
  bithumb: Record<string, number>;
}

export interface PrecheckArgs {
  snapshot: OrderbookSnapshot;
  direction: 'UB' | 'BU';
  bot: PrecheckBotConfig;
  liquidity: LiquiditySnapshot;
  balances: BalanceSnapshot;
  todayCount: number;
  todayLossKrw: number;
}

export interface PrecheckResult {
  ok: boolean;
  abortReason?: string;
}

// 5단계 사전 검증: spread → depeg → liquidity → balance → daily limit
// 각 단계 실패 시 즉시 abortReason과 함께 반환
export function runAll(args: PrecheckArgs): PrecheckResult {
  // 1단계: spread 수익성 검증
  const spreadResult = isSpreadProfitable(args.snapshot, args.direction, args.bot.minSpreadBps);
  if (!spreadResult.ok) {
    return { ok: false, abortReason: spreadResult.reason };
  }

  // 2단계: depeg 가드 (양 거래소 mid price가 [depegMin, depegMax] 범위 안)
  const upbitMid = (args.snapshot.upbitBid + args.snapshot.upbitAsk) / 2;
  const bithumbMid = (args.snapshot.bithumbBid + args.snapshot.bithumbAsk) / 2;
  for (const [name, mid] of [
    ['upbit', upbitMid],
    ['bithumb', bithumbMid],
  ] as const) {
    if (mid < args.bot.depegMinKrw || mid > args.bot.depegMaxKrw) {
      return {
        ok: false,
        abortReason: `depeg guard: ${name} mid ${mid} KRW outside [${args.bot.depegMinKrw}, ${args.bot.depegMaxKrw}]`,
      };
    }
  }

  // 3단계: 유동성 검증 (top of book 수량 ≥ quantity * multiplier)
  const required = args.bot.quantity * args.bot.liquidityMultiplier;
  const liqs = [
    ['upbit bid', args.liquidity.upbitBidQty],
    ['upbit ask', args.liquidity.upbitAskQty],
    ['bithumb bid', args.liquidity.bithumbBidQty],
    ['bithumb ask', args.liquidity.bithumbAskQty],
  ] as const;
  for (const [label, qty] of liqs) {
    if (qty < required) {
      return {
        ok: false,
        abortReason: `liquidity: ${label} ${qty} < required ${required.toFixed(1)} (quantity ${args.bot.quantity} × ${args.bot.liquidityMultiplier})`,
      };
    }
  }

  // 4단계: 잔고 검증 (매수측 KRW + 매도측 코인)
  // 매수는 한쪽 거래소에서만 발생 → 방향별 buy-side ask만 사용. 10% 안전 마진 곱함.
  const { coin, quantity } = args.bot;
  const buyAsk = args.direction === 'UB' ? args.snapshot.upbitAsk : args.snapshot.bithumbAsk;
  const requiredKrwForBuy = buyAsk * quantity * 1.1;

  if (args.direction === 'UB') {
    const upbitKrw = args.balances.upbit.KRW ?? 0;
    if (upbitKrw < requiredKrwForBuy) {
      return {
        ok: false,
        abortReason: `balance: Upbit KRW ${upbitKrw} < required ${requiredKrwForBuy.toFixed(0)}`,
      };
    }
    const bithumbCoin = args.balances.bithumb[coin] ?? 0;
    if (bithumbCoin < quantity) {
      return {
        ok: false,
        abortReason: `balance: Bithumb ${coin} ${bithumbCoin} < quantity ${quantity}`,
      };
    }
  } else {
    const bithumbKrw = args.balances.bithumb.KRW ?? 0;
    if (bithumbKrw < requiredKrwForBuy) {
      return {
        ok: false,
        abortReason: `balance: Bithumb KRW ${bithumbKrw} < required ${requiredKrwForBuy.toFixed(0)}`,
      };
    }
    const upbitCoin = args.balances.upbit[coin] ?? 0;
    if (upbitCoin < quantity) {
      return {
        ok: false,
        abortReason: `balance: Upbit ${coin} ${upbitCoin} < quantity ${quantity}`,
      };
    }
  }

  // 5단계: 일일 한도 검증 (count + 손실)
  if (args.todayCount >= args.bot.dailyCountLimit) {
    return {
      ok: false,
      abortReason: `daily count limit: today ${args.todayCount} >= ${args.bot.dailyCountLimit}`,
    };
  }
  if (args.todayLossKrw >= args.bot.dailyLossLimitKrw) {
    return {
      ok: false,
      abortReason: `daily loss limit: today ${args.todayLossKrw} KRW >= ${args.bot.dailyLossLimitKrw}`,
    };
  }

  return { ok: true };
}
