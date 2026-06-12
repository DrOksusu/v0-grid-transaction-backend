/**
 * RSI 다이버전스 + 상향 돌파 확인 후 진입 백테스트 (8년치)
 *
 * 실행: npx ts-node scripts/backtest-rsi-divergence-confirmed.ts
 *
 * 구조: 다이버전스 감지(조짐) → 확인 대기 → RSI가 확인선 상향 돌파 시 진입
 *  - 확인 대기 중 가격이 다이버전스 저점을 깨면 신호 무효 (진입 안 함)
 *  - 대기 12봉 내 확인 없으면 신호 만료
 *  - 감지 시점에 RSI가 이미 확인선 위면 즉시 진입 (확인 선충족)
 * 출구: 손절 = 저점 -1%, 익절 = RSI 60/65, 시간청산 15봉. 수수료 0.2% 차감.
 */
import {
  Candle,
  Signal,
  LIVE_WINDOW,
  calcRsi,
  fetchAllCandles,
  collectSignals,
} from './backtest-rsi-divergence';

const YEARS = 8;
const BUY_AMOUNT_USD = 1000;
const FEE_ROUND_TRIP_PCT = 0.2;
const CONFIRM_WINDOW_BARS = 12; // 확인 대기 한도 (2일)
const TIME_STOP_BARS = 15;
const SL_BUFFER = 0.01;

const ENTRY_RSI_FILTERS = [50, 40];  // 저점 RSI 필터 (50 = 필터 없음과 동일, 운영 조건)
const CONFIRM_LEVELS = [30, 40, 50]; // RSI 상향 돌파 확인선
const TP_TARGETS = [60, 65];

type Outcome =
  | { kind: 'trade'; pnlPct: number; reason: 'TP' | 'SL' | 'TIME' }
  | { kind: 'invalidated' }   // 확인 전 저점 이탈 → 진입 회피
  | { kind: 'expired' };      // 대기 한도 내 확인 없음

function simulate(
  candles: Candle[],
  rsi: number[],
  sig: Signal,
  confirmLevel: number,
  tpTarget: number,
): Outcome {
  // === 1단계: 확인 대기 ===
  let entryBar = -1;
  if (rsi[sig.barIndex] >= confirmLevel) {
    entryBar = sig.barIndex; // 감지 시점에 이미 확인선 위 → 즉시 진입
  } else {
    for (let t = sig.barIndex + 1; t <= Math.min(sig.barIndex + CONFIRM_WINDOW_BARS, candles.length - 1); t++) {
      if (candles[t].low < sig.swingLowPrice) return { kind: 'invalidated' };
      if (rsi[t - 1] < confirmLevel && rsi[t] >= confirmLevel) { entryBar = t; break; }
    }
    if (entryBar === -1) return { kind: 'expired' };
  }

  // === 2단계: 진입 후 출구 ===
  const entry = candles[entryBar].close;
  const stopPrice = sig.swingLowPrice * (1 - SL_BUFFER);
  const net = (price: number) => (price / entry - 1) * 100 - FEE_ROUND_TRIP_PCT;

  for (let t = entryBar + 1; t < candles.length; t++) {
    const c = candles[t];
    if (c.low < stopPrice) return { kind: 'trade', pnlPct: net(stopPrice), reason: 'SL' };
    if (rsi[t] >= tpTarget) return { kind: 'trade', pnlPct: net(c.close), reason: 'TP' };
    if (t - entryBar >= TIME_STOP_BARS) return { kind: 'trade', pnlPct: net(c.close), reason: 'TIME' };
  }
  return { kind: 'trade', pnlPct: net(candles[candles.length - 1].close), reason: 'TIME' };
}

async function main() {
  const startTime = Date.now() - YEARS * 365 * 24 * 60 * 60 * 1000 - LIVE_WINDOW * 4 * 60 * 60 * 1000;
  console.log('데이터 수집 중...');
  const candles = await fetchAllCandles(startTime);
  const rsi = calcRsi(candles.map((c) => c.close));
  const allSignals = collectSignals(candles, LIVE_WINDOW);
  console.log(`캔들 ${candles.length}개, 다이버전스 시그널 ${allSignals.length}건 (${YEARS}년)\n`);

  console.log('=== 확인 진입 스윕 (손절 저점-1%, 시간청산 15봉, 수수료 0.2% 차감) ===');
  console.log('저점필터 | 확인선 | 익절 | 진입 | 회피 | 만료 | 승률 | 평균net | 누적($) | TP/SL/TIME | 최악');

  interface Row {
    filter: number; confirm: number; tp: number;
    n: number; invalidated: number; expired: number;
    win: number; avg: number; usd: number; tpC: number; slC: number; tiC: number; worst: number;
  }
  const rows: Row[] = [];

  for (const filter of ENTRY_RSI_FILTERS) {
    const signals = allSignals.filter((s) => s.recentLow.rsi < filter);
    for (const confirm of CONFIRM_LEVELS) {
      for (const tp of TP_TARGETS) {
        const outcomes = signals.map((s) => simulate(candles, rsi, s, confirm, tp));
        const trades = outcomes.filter((o): o is Extract<Outcome, { kind: 'trade' }> => o.kind === 'trade');
        if (trades.length === 0) continue;
        const wins = trades.filter((t) => t.pnlPct > 0).length;
        rows.push({
          filter, confirm, tp,
          n: trades.length,
          invalidated: outcomes.filter((o) => o.kind === 'invalidated').length,
          expired: outcomes.filter((o) => o.kind === 'expired').length,
          win: (wins / trades.length) * 100,
          avg: trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length,
          usd: trades.reduce((a, t) => a + (BUY_AMOUNT_USD * t.pnlPct) / 100, 0),
          tpC: trades.filter((t) => t.reason === 'TP').length,
          slC: trades.filter((t) => t.reason === 'SL').length,
          tiC: trades.filter((t) => t.reason === 'TIME').length,
          worst: Math.min(...trades.map((t) => t.pnlPct)),
        });
      }
    }
  }

  rows.sort((a, b) => b.usd - a.usd);
  for (const r of rows) {
    console.log(
      `RSI<${r.filter}  | ${String(r.confirm).padStart(2)}    | ${r.tp} | ` +
      `${String(r.n).padStart(3)}건 | ${String(r.invalidated).padStart(2)} | ${String(r.expired).padStart(2)} | ` +
      `${r.win.toFixed(0).padStart(3)}% | ${r.avg >= 0 ? '+' : ''}${r.avg.toFixed(2)}% | ` +
      `${r.usd >= 0 ? '+' : ''}${r.usd.toFixed(2)} | ${r.tpC}/${r.slC}/${r.tiC} | ${r.worst.toFixed(2)}%`
    );
  }
}

main().catch((e) => {
  console.error('백테스트 실패:', e.message);
  process.exit(1);
});
