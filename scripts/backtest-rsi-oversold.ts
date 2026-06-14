/**
 * BTC/USDT 4h RSI 과매도 진입 백테스트 (2년치)
 *
 * 실행: npx ts-node scripts/backtest-rsi-oversold.ts
 *
 * 진입: RSI가 30 아래로 하향 돌파하는 봉 마감 시 매수 (이전 봉 RSI >= 30, 현재 봉 RSI < 30)
 * 동시 포지션 1개 — 청산 전 재진입 없음, 청산 후 새 하향 돌파부터 재무장
 * 출구 스윕: 손절(없음/-3%/-5%) × 익절(RSI 50/55/60 복귀) + 시간청산 15봉
 * 수치는 수수료 왕복 0.2% 차감 후(net).
 */
import { calcRsi, fetchAllCandles, Candle, LIVE_WINDOW } from './backtest-rsi-divergence';

const YEARS = 2;
const BUY_AMOUNT_USD = 1000;
const TIME_STOP_BARS = 15;
const FEE_ROUND_TRIP_PCT = 0.2;

const RSI_ENTRY = 30;
const SL_PCTS: Array<number | null> = [null, 0.03, 0.05]; // null = 손절 없음
const TP_TARGETS = [50, 55, 60];

interface Trade {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  pnlPct: number; // 수수료 차감 후
  reason: 'TP' | 'SL' | 'TIME';
}

function runStrategy(candles: Candle[], rsi: number[], tpTarget: number, slPct: number | null): Trade[] {
  const trades: Trade[] = [];
  let inPosition = false;
  let entryPrice = 0;
  let entryBar = 0;

  for (let t = 1; t < candles.length; t++) {
    if (isNaN(rsi[t]) || isNaN(rsi[t - 1])) continue;

    if (!inPosition) {
      // 과매도 구간 진입(하향 돌파) 시 매수
      if (rsi[t - 1] >= RSI_ENTRY && rsi[t] < RSI_ENTRY) {
        inPosition = true;
        entryPrice = candles[t].close;
        entryBar = t;
      }
      continue;
    }

    const c = candles[t];
    const exit = (price: number, reason: Trade['reason']) => {
      trades.push({
        entryTime: candles[entryBar].openTime,
        entryPrice,
        exitTime: c.openTime,
        pnlPct: (price / entryPrice - 1) * 100 - FEE_ROUND_TRIP_PCT,
        reason,
      });
      inPosition = false;
    };

    const stopPrice = slPct !== null ? entryPrice * (1 - slPct) : null;
    if (stopPrice !== null && c.low < stopPrice) { exit(stopPrice, 'SL'); continue; }
    if (rsi[t] >= tpTarget) { exit(c.close, 'TP'); continue; }
    if (t - entryBar >= TIME_STOP_BARS) { exit(c.close, 'TIME'); continue; }
  }

  // 마지막 미청산 포지션은 마지막 종가 청산
  if (inPosition) {
    const last = candles[candles.length - 1];
    trades.push({
      entryTime: candles[entryBar].openTime,
      entryPrice,
      exitTime: last.openTime,
      pnlPct: (last.close / entryPrice - 1) * 100 - FEE_ROUND_TRIP_PCT,
      reason: 'TIME',
    });
  }
  return trades;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

async function main() {
  const startTime = Date.now() - YEARS * 365 * 24 * 60 * 60 * 1000 - LIVE_WINDOW * 4 * 60 * 60 * 1000;
  console.log('데이터 수집 중...');
  const candles = await fetchAllCandles(startTime);
  const rsi = calcRsi(candles.map((c) => c.close));
  console.log(`캔들 ${candles.length}개: ${fmtDate(candles[0].openTime)} ~ ${fmtDate(candles[candles.length - 1].openTime)}\n`);

  // 진입 시점 목록 (출구와 무관하게 하향 돌파 지점만)
  const crossings: number[] = [];
  for (let t = 1; t < candles.length; t++) {
    if (!isNaN(rsi[t]) && !isNaN(rsi[t - 1]) && rsi[t - 1] >= RSI_ENTRY && rsi[t] < RSI_ENTRY) crossings.push(t);
  }
  console.log(`=== RSI 30 하향 돌파(과매도 진입) 지점: ${crossings.length}회 ===`);
  for (const t of crossings) {
    console.log(`  ${fmtDate(candles[t].openTime)} 종가 $${candles[t].close.toLocaleString()} (RSI ${rsi[t].toFixed(2)})`);
  }

  console.log(`\n=== 출구 스윕 (1회 $${BUY_AMOUNT_USD}, 시간청산 ${TIME_STOP_BARS}봉, 수수료 0.2% 차감) ===`);
  console.log('손절 | 익절RSI | 건수 | 승률 | 평균net | 누적($) | TP/SL/TIME | 최악');

  interface Row { label: string; tp: number; n: number; win: number; avg: number; usd: number; tpC: number; slC: number; tiC: number; worst: number }
  const rows: Row[] = [];
  for (const slPct of SL_PCTS) {
    for (const tp of TP_TARGETS) {
      const trades = runStrategy(candles, rsi, tp, slPct);
      if (trades.length === 0) continue;
      const wins = trades.filter((t) => t.pnlPct > 0).length;
      rows.push({
        label: slPct === null ? '없음' : `-${slPct * 100}%`,
        tp,
        n: trades.length,
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
  rows.sort((a, b) => b.usd - a.usd);
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(4)} | ${r.tp}     | ${String(r.n).padStart(2)}건 | ${r.win.toFixed(0).padStart(3)}% | ` +
      `${r.avg >= 0 ? '+' : ''}${r.avg.toFixed(2)}% | ${r.usd >= 0 ? '+' : ''}${r.usd.toFixed(2)} | ` +
      `${r.tpC}/${r.slC}/${r.tiC} | ${r.worst.toFixed(2)}%`
    );
  }
}

main().catch((e) => {
  console.error('백테스트 실패:', e.message);
  process.exit(1);
});
