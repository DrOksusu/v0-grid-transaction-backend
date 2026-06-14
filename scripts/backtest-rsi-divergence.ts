/**
 * BTC/USDT 4h RSI 상승 다이버전스 백테스트 (2년치)
 *
 * 실행: npx ts-node scripts/backtest-rsi-divergence.ts
 *
 * 감지 로직은 btc-rsi-monitor.service.ts와 동일하게 복제
 * (서비스 import 시 prisma/kakao 의존성이 딸려와 스크립트에서 분리).
 * 로직 일치 검증: 2026-06-10 08:00 저점 다이버전스가 결과에 재현되는지 확인.
 */
import axios from 'axios';

// === 운영 서비스와 동일한 상수 ===
const RSI_PERIOD = 14;
const SWING_WINDOW = 3;
const MIN_BARS_APART = 10;
const RSI_OVERBOUGHT = 50;
export const LIVE_WINDOW = 200; // 운영 서비스는 최근 200봉만 사용

// === 백테스트 설정 ===
const YEARS = 2;
const BUY_AMOUNT_USD = 1000;
const TIME_STOP_BARS = 15; // 진입 후 15봉(60시간) 무반응 시 청산
const RSI_TARGETS = [55, 60, 65]; // 비교할 익절 RSI 기준

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Signal {
  barIndex: number;       // 감지된 봉 (진입 봉)
  entryPrice: number;     // 해당 봉 종가
  swingLowPrice: number;  // 최근 저점 (손절 기준)
  recentSwingIndex: number;
  prevLow: { price: number; rsi: number; time: number };
  recentLow: { price: number; rsi: number; time: number };
}

interface Trade {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME';
  pnlPct: number;
}

// === 운영 서비스 calcRsi 복제 (Wilder's smoothing) ===
export function calcRsi(closes: number[]): number[] {
  if (closes.length < RSI_PERIOD + 1) return [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let avgGain = gains.slice(0, RSI_PERIOD).reduce((a, b) => a + b, 0) / RSI_PERIOD;
  let avgLoss = losses.slice(0, RSI_PERIOD).reduce((a, b) => a + b, 0) / RSI_PERIOD;
  const rsiArr: number[] = new Array(RSI_PERIOD).fill(NaN);
  rsiArr.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = RSI_PERIOD; i < gains.length; i++) {
    avgGain = (avgGain * (RSI_PERIOD - 1) + gains[i]) / RSI_PERIOD;
    avgLoss = (avgLoss * (RSI_PERIOD - 1) + losses[i]) / RSI_PERIOD;
    rsiArr.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsiArr;
}

// === 운영 서비스 findSwingLows 복제 ===
export function findSwingLows(prices: number[], rsiArr: number[]): Array<{ index: number; price: number; rsi: number }> {
  const lows: Array<{ index: number; price: number; rsi: number }> = [];
  for (let i = SWING_WINDOW; i < prices.length - SWING_WINDOW; i++) {
    if (isNaN(rsiArr[i])) continue;
    const isLow = prices
      .slice(i - SWING_WINDOW, i + SWING_WINDOW + 1)
      .every((p, idx) => idx === SWING_WINDOW || prices[i] < p);
    if (isLow) lows.push({ index: i, price: prices[i], rsi: rsiArr[i] });
  }
  return lows;
}

/** 운영 detectBullishDivergence와 동일한 조건 — 윈도우 내 인덱스 기준 */
export function detectDivergence(candles: Candle[]): {
  detected: boolean;
  recentIdx: number;
  prev?: { price: number; rsi: number; index: number };
  recent?: { price: number; rsi: number; index: number };
} {
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const rsiArr = calcRsi(closes);
  const swings = findSwingLows(lows, rsiArr);
  if (swings.length < 2) return { detected: false, recentIdx: -1 };

  const recent = swings[swings.length - 1];
  if (recent.rsi >= RSI_OVERBOUGHT) return { detected: false, recentIdx: -1 };

  for (let i = swings.length - 2; i >= 0; i--) {
    const prev = swings[i];
    if (recent.index - prev.index < MIN_BARS_APART) continue;
    if (recent.price < prev.price && recent.rsi > prev.rsi) {
      return { detected: true, recentIdx: recent.index, prev, recent };
    }
    break; // 운영 로직과 동일: 첫 후보만 비교
  }
  return { detected: false, recentIdx: -1 };
}

/** Binance 4h 캔들 페이지네이션 수집 */
export async function fetchAllCandles(startTime: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = startTime;
  for (;;) {
    const res = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol: 'BTCUSDT', interval: '4h', startTime: cursor, limit: 1000 },
      timeout: 15000,
    });
    const batch = (res.data as any[]).map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    }));
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1].openTime + 1;
  }
  return all;
}

/** 워크포워드 시그널 수집 — 각 봉 마감 시점에 운영과 동일하게 최근 200봉으로 감지 */
export function collectSignals(candles: Candle[], warmupBars: number): Signal[] {
  const signals: Signal[] = [];
  const signaledSwings = new Set<number>(); // 같은 저점으로 중복 진입 방지 (절대 인덱스)

  for (let t = warmupBars; t < candles.length; t++) {
    const winStart = Math.max(0, t + 1 - LIVE_WINDOW);
    const window = candles.slice(winStart, t + 1);
    const { detected, recentIdx, prev, recent } = detectDivergence(window);
    if (!detected || !prev || !recent) continue;

    const absSwingIdx = winStart + recentIdx;
    if (signaledSwings.has(absSwingIdx)) continue;
    signaledSwings.add(absSwingIdx);

    signals.push({
      barIndex: t,
      entryPrice: candles[t].close,
      swingLowPrice: recent.price,
      recentSwingIndex: absSwingIdx,
      prevLow: { price: prev.price, rsi: prev.rsi, time: candles[winStart + prev.index].openTime },
      recentLow: { price: recent.price, rsi: recent.rsi, time: candles[absSwingIdx].openTime },
    });
  }
  return signals;
}

/** 단일 시그널에 대해 출구 시뮬레이션 */
function simulateTrade(candles: Candle[], rsiFull: number[], sig: Signal, rsiTarget: number): Trade {
  const entry = sig.entryPrice;
  for (let t = sig.barIndex + 1; t < candles.length; t++) {
    const c = candles[t];
    // 손절 우선 (보수적): 저가가 저점 이탈 시 저점 가격에 체결 가정
    if (c.low < sig.swingLowPrice) {
      return {
        entryTime: candles[sig.barIndex].openTime, entryPrice: entry,
        exitTime: c.openTime, exitPrice: sig.swingLowPrice,
        reason: 'SL', pnlPct: (sig.swingLowPrice / entry - 1) * 100,
      };
    }
    // 익절: 봉 마감 RSI가 목표 도달
    if (rsiFull[t] >= rsiTarget) {
      return {
        entryTime: candles[sig.barIndex].openTime, entryPrice: entry,
        exitTime: c.openTime, exitPrice: c.close,
        reason: 'TP', pnlPct: (c.close / entry - 1) * 100,
      };
    }
    // 시간 청산
    if (t - sig.barIndex >= TIME_STOP_BARS) {
      return {
        entryTime: candles[sig.barIndex].openTime, entryPrice: entry,
        exitTime: c.openTime, exitPrice: c.close,
        reason: 'TIME', pnlPct: (c.close / entry - 1) * 100,
      };
    }
  }
  // 데이터 끝까지 미청산 → 마지막 종가 청산
  const last = candles[candles.length - 1];
  return {
    entryTime: candles[sig.barIndex].openTime, entryPrice: entry,
    exitTime: last.openTime, exitPrice: last.close,
    reason: 'TIME', pnlPct: (last.close / entry - 1) * 100,
  };
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

async function main() {
  const startTime = Date.now() - YEARS * 365 * 24 * 60 * 60 * 1000 - LIVE_WINDOW * 4 * 60 * 60 * 1000;
  console.log(`데이터 수집 중... (${YEARS}년치 + 워밍업 ${LIVE_WINDOW}봉)`);
  const candles = await fetchAllCandles(startTime);
  console.log(`캔들 ${candles.length}개 수집: ${fmtDate(candles[0].openTime)} ~ ${fmtDate(candles[candles.length - 1].openTime)}\n`);

  const rsiFull = calcRsi(candles.map((c) => c.close));
  const signals = collectSignals(candles, LIVE_WINDOW);

  console.log(`=== 감지된 다이버전스 시그널: ${signals.length}건 ===`);
  for (const s of signals) {
    console.log(
      `  ${fmtDate(candles[s.barIndex].openTime)} 진입 $${s.entryPrice.toLocaleString()} | ` +
      `저점쌍: $${s.prevLow.price.toLocaleString()}(RSI ${s.prevLow.rsi.toFixed(2)}) → ` +
      `$${s.recentLow.price.toLocaleString()}(RSI ${s.recentLow.rsi.toFixed(2)}) @ ${fmtDate(s.recentLow.time)}`
    );
  }

  // 로직 일치 검증 앵커: 2026-06-10T08:00 저점 다이버전스
  const anchor = signals.find((s) => fmtDate(s.recentLow.time) === '2026-06-10T08:00');
  console.log(`\n[검증 앵커] 2026-06-10 08:00 실제 알림 재현: ${anchor ? '✅ 재현됨' : '❌ 미재현 — 로직 불일치 의심'}`);

  console.log(`\n=== 출구 전략 비교 (1회 $${BUY_AMOUNT_USD}, 손절=저점 이탈, 시간청산=${TIME_STOP_BARS}봉) ===`);
  console.log('익절기준 | 건수 | 승률 | 평균손익 | 누적손익($) | TP/SL/TIME | 최악거래');
  for (const target of RSI_TARGETS) {
    const trades = signals.map((s) => simulateTrade(candles, rsiFull, s, target));
    const wins = trades.filter((t) => t.pnlPct > 0).length;
    const avg = trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length;
    const totalUsd = trades.reduce((a, t) => a + (BUY_AMOUNT_USD * t.pnlPct) / 100, 0);
    const worst = Math.min(...trades.map((t) => t.pnlPct));
    const cnt = (r: string) => trades.filter((t) => t.reason === r).length;
    console.log(
      `RSI ${target}   | ${trades.length}건 | ${((wins / trades.length) * 100).toFixed(0)}% | ` +
      `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% | ${totalUsd >= 0 ? '+' : ''}${totalUsd.toFixed(2)} | ` +
      `${cnt('TP')}/${cnt('SL')}/${cnt('TIME')} | ${worst.toFixed(2)}%`
    );
  }

  // 참고: 같은 기간 단순 보유
  const bhStart = candles[LIVE_WINDOW].close;
  const bhEnd = candles[candles.length - 1].close;
  console.log(`\n[참고] 같은 기간 단순 보유: ${((bhEnd / bhStart - 1) * 100).toFixed(1)}% ($${bhStart.toLocaleString()} → $${bhEnd.toLocaleString()})`);
}

if (require.main === module) main().catch((e) => {
  console.error('백테스트 실패:', e.message);
  process.exit(1);
});
