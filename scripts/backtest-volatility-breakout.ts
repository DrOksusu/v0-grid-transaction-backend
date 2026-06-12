/**
 * BTC/USDT 변동성 돌파 백테스트 (래리 윌리엄스, 일봉, 8년치)
 *
 * 실행: npx ts-node scripts/backtest-volatility-breakout.ts
 *
 * 규칙: 당일 가격이 [당일 시가 + 전일 변동폭(고가-저가) × k]를 돌파하면 그 가격에 매수,
 *       당일 종가에 청산. 하루 1회, 롱 온리.
 * 변형: MA5 필터 — 전일 종가가 5일 이동평균 위일 때만 진입 (상승 추세 확인)
 * 4h 캔들을 UTC 일봉(OHLC)으로 합산. 수수료 왕복 0.2% 차감. 복리($1000 시작).
 */
import { Candle, fetchAllCandles } from './backtest-rsi-divergence';

const YEARS = 8;
const START_CAPITAL = 1000;
const FEE_ROUND_TRIP_PCT = 0.1; // 업비트 0.05% × 2
const K_VALUES = [0.6, 0.65, 0.7];
const MA_FILTER_PERIOD = 5;

interface Daily {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function toDaily(candles: Candle[]): Daily[] {
  const byDay = new Map<number, Daily>();
  for (const c of candles) {
    const day = Math.floor(c.openTime / 86_400_000) * 86_400_000;
    const d = byDay.get(day);
    if (!d) {
      byDay.set(day, { time: day, open: c.open, high: c.high, low: c.low, close: c.close });
    } else {
      d.high = Math.max(d.high, c.high);
      d.low = Math.min(d.low, c.low);
      d.close = c.close; // 마지막 캔들 종가
    }
  }
  return [...byDay.values()].sort((a, b) => a.time - b.time);
}

interface Result {
  n: number;
  winRate: number;
  avgNet: number;
  equity: number;
  maxDd: number;
  worst: number;
  yearlyPnl: Map<number, number>; // 연도별 손익률(%) — 복리 아닌 합산 참고용
}

function runStrategy(daily: Daily[], k: number, useMaFilter: boolean, evalStartIdx: number): Result {
  let equity = START_CAPITAL;
  let peak = equity;
  let maxDd = 0;
  let n = 0;
  let wins = 0;
  let sumNet = 0;
  let worst = Infinity;
  const yearlyPnl = new Map<number, number>();

  for (let i = Math.max(evalStartIdx, MA_FILTER_PERIOD + 1); i < daily.length; i++) {
    const today = daily[i];
    const prev = daily[i - 1];

    if (useMaFilter) {
      let sum = 0;
      for (let j = i - MA_FILTER_PERIOD; j < i; j++) sum += daily[j].close;
      if (prev.close <= sum / MA_FILTER_PERIOD) continue;
    }

    const range = prev.high - prev.low;
    const target = today.open + range * k;
    if (today.high < target) continue; // 돌파 없음

    const pnlPct = (today.close / target - 1) * 100 - FEE_ROUND_TRIP_PCT;
    n++;
    sumNet += pnlPct;
    if (pnlPct > 0) wins++;
    worst = Math.min(worst, pnlPct);

    equity *= 1 + pnlPct / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (1 - equity / peak) * 100);

    const year = new Date(today.time).getUTCFullYear();
    yearlyPnl.set(year, (yearlyPnl.get(year) ?? 0) + pnlPct);
  }

  return {
    n,
    winRate: n > 0 ? (wins / n) * 100 : 0,
    avgNet: n > 0 ? sumNet / n : 0,
    equity,
    maxDd,
    worst: n > 0 ? worst : 0,
    yearlyPnl,
  };
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main() {
  const startTime = Date.now() - (YEARS * 365 + 10) * 86_400_000;
  console.log('데이터 수집 중...');
  const candles = await fetchAllCandles(startTime);
  const daily = toDaily(candles);

  const evalStartTime = Date.now() - YEARS * 365 * 86_400_000;
  const evalStartIdx = daily.findIndex((d) => d.time >= evalStartTime);
  const evalStart = daily[evalStartIdx];
  const last = daily[daily.length - 1];
  console.log(`일봉 ${daily.length}개, 평가 구간: ${fmtDate(evalStart.time)} ~ ${fmtDate(last.time)} (${YEARS}년)\n`);

  const bhMultiple = last.close / evalStart.close;
  console.log(`[기준] 단순 보유: $${START_CAPITAL} → $${(START_CAPITAL * bhMultiple).toFixed(2)} (${((bhMultiple - 1) * 100).toFixed(0)}%)\n`);

  console.log(`=== 변동성 돌파 스윕 (당일 종가 청산, 복리 $1000, 수수료 ${FEE_ROUND_TRIP_PCT}%/회 차감) ===`);
  console.log('k   | MA5필터 | 거래  | 승률 | 평균net | 최종자본($) | 최악 | MDD');

  let best: { k: number; filter: boolean; res: Result } | null = null;
  for (const k of K_VALUES) {
    for (const filter of [false, true]) {
      const res = runStrategy(daily, k, filter, evalStartIdx);
      if (!best || res.equity > best.res.equity) best = { k, filter, res };
      console.log(
        `${k.toFixed(2)} | ${filter ? 'ON ' : 'OFF'}     | ${String(res.n).padStart(4)}건 | ` +
        `${res.winRate.toFixed(0).padStart(3)}% | ${res.avgNet >= 0 ? '+' : ''}${res.avgNet.toFixed(3)}% | ` +
        `${res.equity.toFixed(2).padStart(10)} | ${res.worst.toFixed(2)}% | ${res.maxDd.toFixed(1)}%`
      );
    }
  }

  if (best) {
    console.log(`\n=== 최고 조합 (k=${best.k}, MA5 ${best.filter ? 'ON' : 'OFF'}) 연도별 손익 합산 ===`);
    const years = [...best.res.yearlyPnl.keys()].sort();
    for (const y of years) {
      const v = best.res.yearlyPnl.get(y)!;
      console.log(`  ${y}: ${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
    }
  }
}

main().catch((e) => {
  console.error('백테스트 실패:', e.message);
  process.exit(1);
});
