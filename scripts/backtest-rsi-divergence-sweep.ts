/**
 * RSI 다이버전스 백테스트 파라미터 스윕 (27개 조합)
 *
 * 실행: npx ts-node scripts/backtest-rsi-divergence-sweep.ts
 *
 * 축: 손절 여유(0/1/2%) × 진입 필터(저점 RSI <50/<40/<35) × 익절(RSI 55/60/65)
 * 모든 수치는 수수료 왕복 0.2% 차감 후(net) 기준.
 * ⚠️ 과최적화 주의 — 거래 수가 적은 조합일수록 우연일 가능성이 높다.
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
const TIME_STOP_BARS = 15;
const FEE_ROUND_TRIP_PCT = 0.2; // 바이낸스 현물 0.1% × 2

const SL_BUFFERS = [0, 0.01, 0.02];        // 저점 아래 여유
const ENTRY_RSI_FILTERS = [50, 40, 35, 30];    // 최근 저점 RSI 미만일 때만 진입
const TP_TARGETS = [55, 60, 65];           // 익절 RSI

interface TradeResult {
  pnlPct: number; // 수수료 차감 후
  reason: 'TP' | 'SL' | 'TIME';
}

function simulate(
  candles: Candle[],
  rsiFull: number[],
  sig: Signal,
  tpTarget: number,
  slBuffer: number,
): TradeResult {
  const entry = sig.entryPrice;
  const stopPrice = sig.swingLowPrice * (1 - slBuffer);
  const exit = (price: number, reason: TradeResult['reason']): TradeResult => ({
    pnlPct: (price / entry - 1) * 100 - FEE_ROUND_TRIP_PCT,
    reason,
  });

  for (let t = sig.barIndex + 1; t < candles.length; t++) {
    const c = candles[t];
    if (c.low < stopPrice) return exit(stopPrice, 'SL');
    if (rsiFull[t] >= tpTarget) return exit(c.close, 'TP');
    if (t - sig.barIndex >= TIME_STOP_BARS) return exit(c.close, 'TIME');
  }
  return exit(candles[candles.length - 1].close, 'TIME');
}

async function main() {
  const startTime = Date.now() - YEARS * 365 * 24 * 60 * 60 * 1000 - LIVE_WINDOW * 4 * 60 * 60 * 1000;
  console.log('데이터 수집 중...');
  const candles = await fetchAllCandles(startTime);
  const rsiFull = calcRsi(candles.map((c) => c.close));
  const allSignals = collectSignals(candles, LIVE_WINDOW);
  console.log(`캔들 ${candles.length}개, 기본 시그널 ${allSignals.length}건\n`);

  interface Row {
    filter: number; slBuf: number; tp: number;
    n: number; winRate: number; avgNet: number; totalUsd: number;
    tpCnt: number; slCnt: number; timeCnt: number; worst: number;
  }
  const rows: Row[] = [];

  for (const filter of ENTRY_RSI_FILTERS) {
    const signals = allSignals.filter((s) => s.recentLow.rsi < filter);
    for (const slBuf of SL_BUFFERS) {
      for (const tp of TP_TARGETS) {
        if (signals.length === 0) continue;
        const trades = signals.map((s) => simulate(candles, rsiFull, s, tp, slBuf));
        const wins = trades.filter((t) => t.pnlPct > 0).length;
        rows.push({
          filter, slBuf, tp,
          n: trades.length,
          winRate: (wins / trades.length) * 100,
          avgNet: trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length,
          totalUsd: trades.reduce((a, t) => a + (BUY_AMOUNT_USD * t.pnlPct) / 100, 0),
          tpCnt: trades.filter((t) => t.reason === 'TP').length,
          slCnt: trades.filter((t) => t.reason === 'SL').length,
          timeCnt: trades.filter((t) => t.reason === 'TIME').length,
          worst: Math.min(...trades.map((t) => t.pnlPct)),
        });
      }
    }
  }

  rows.sort((a, b) => b.totalUsd - a.totalUsd);

  console.log('=== 27개 조합 결과 (수수료 0.2% 차감 후, 누적손익 내림차순) ===');
  console.log('진입필터 | 손절여유 | 익절 | 건수 | 승률 | 평균net | 누적($) | TP/SL/TIME | 최악');
  for (const r of rows) {
    console.log(
      `RSI<${r.filter}  | -${(r.slBuf * 100).toFixed(0)}%      | ${r.tp} | ` +
      `${String(r.n).padStart(2)}건 | ${r.winRate.toFixed(0).padStart(3)}% | ` +
      `${r.avgNet >= 0 ? '+' : ''}${r.avgNet.toFixed(2)}% | ` +
      `${r.totalUsd >= 0 ? '+' : ''}${r.totalUsd.toFixed(2)} | ` +
      `${r.tpCnt}/${r.slCnt}/${r.timeCnt} | ${r.worst.toFixed(2)}%`
    );
  }
}

main().catch((e) => {
  console.error('스윕 실패:', e.message);
  process.exit(1);
});
