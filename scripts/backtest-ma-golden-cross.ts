/**
 * BTC/USDT 이동평균 골든크로스 백테스트 (일봉, 8년치)
 *
 * 실행: npx ts-node scripts/backtest-ma-golden-cross.ts
 *
 * 규칙: 단기 MA가 장기 MA 상향 돌파한 일봉 마감 시 전액 매수,
 *       하향 돌파(데드크로스) 일봉 마감 시 전액 매도. 롱 온리.
 * 4h 캔들을 UTC 일봉으로 합산. 수수료 왕복 0.2% 차감. 복리($1000 시작).
 * 비교 기준: 같은 기간 단순 보유(buy & hold).
 */
import { Candle, fetchAllCandles } from './backtest-rsi-divergence';

const YEARS = 8;
const START_CAPITAL = 1000;
const FEE_ROUND_TRIP_PCT = 0.1; // 업비트 0.05% × 2
const MA_PAIRS: Array<[number, number]> = [
  [10, 50],
  [20, 100],
  [20, 200],
  [50, 200], // 클래식 골든크로스
];
const WARMUP_DAYS = 210; // 가장 긴 MA(200) 산출용 사전 데이터

interface Daily {
  time: number; // UTC 일 시작 ms
  close: number;
}

function toDaily(candles: Candle[]): Daily[] {
  const byDay = new Map<number, Candle>();
  for (const c of candles) {
    const day = Math.floor(c.openTime / 86_400_000) * 86_400_000;
    byDay.set(day, c); // 같은 날의 마지막 캔들이 남음 → 그 close가 일봉 종가
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, c]) => ({ time, close: c.close }));
}

function sma(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

interface Trade {
  entryTime: number;
  exitTime: number;
  pnlPct: number; // 수수료 차감 후
  open: boolean; // 마지막 미청산 포지션 여부
}

function runStrategy(daily: Daily[], fast: number, slow: number, evalStartIdx: number) {
  const closes = daily.map((d) => d.close);
  const fastMa = sma(closes, fast);
  const slowMa = sma(closes, slow);

  const trades: Trade[] = [];
  let entryIdx = -1;
  let daysInPosition = 0;

  for (let i = Math.max(evalStartIdx, slow); i < daily.length; i++) {
    const crossUp = fastMa[i - 1] <= slowMa[i - 1] && fastMa[i] > slowMa[i];
    const crossDown = fastMa[i - 1] >= slowMa[i - 1] && fastMa[i] < slowMa[i];

    if (entryIdx === -1 && crossUp) {
      entryIdx = i;
    } else if (entryIdx !== -1) {
      daysInPosition++;
      if (crossDown) {
        trades.push({
          entryTime: daily[entryIdx].time,
          exitTime: daily[i].time,
          pnlPct: (closes[i] / closes[entryIdx] - 1) * 100 - FEE_ROUND_TRIP_PCT,
          open: false,
        });
        entryIdx = -1;
      }
    }
  }

  // 미청산 포지션은 마지막 종가로 평가
  if (entryIdx !== -1) {
    const last = daily.length - 1;
    trades.push({
      entryTime: daily[entryIdx].time,
      exitTime: daily[last].time,
      pnlPct: (closes[last] / closes[entryIdx] - 1) * 100 - FEE_ROUND_TRIP_PCT,
      open: true,
    });
  }

  // 복리 자본 곡선 + 최대 낙폭 (거래 단위)
  let equity = START_CAPITAL;
  let peak = equity;
  let maxDd = 0;
  for (const t of trades) {
    equity *= 1 + t.pnlPct / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (1 - equity / peak) * 100);
  }

  const evalDays = daily.length - evalStartIdx;
  return { trades, equity, maxDd, exposurePct: (daysInPosition / evalDays) * 100 };
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main() {
  const startTime = Date.now() - (YEARS * 365 + WARMUP_DAYS) * 86_400_000;
  console.log('데이터 수집 중...');
  const candles = await fetchAllCandles(startTime);
  const daily = toDaily(candles);

  const evalStartTime = Date.now() - YEARS * 365 * 86_400_000;
  const evalStartIdx = daily.findIndex((d) => d.time >= evalStartTime);
  const evalStart = daily[evalStartIdx];
  const last = daily[daily.length - 1];
  console.log(`일봉 ${daily.length}개, 평가 구간: ${fmtDate(evalStart.time)} ~ ${fmtDate(last.time)} (${YEARS}년)\n`);

  // 단순 보유 기준
  const bhMultiple = last.close / evalStart.close;
  const bhEquity = START_CAPITAL * bhMultiple * (1 - FEE_ROUND_TRIP_PCT / 100);
  console.log(`[기준] 단순 보유: $${START_CAPITAL} → $${bhEquity.toFixed(2)} (${((bhMultiple - 1) * 100).toFixed(0)}%)`);
  console.log(`       진입가 $${evalStart.close.toLocaleString()} → 현재가 $${last.close.toLocaleString()}\n`);

  console.log(`=== MA 골든크로스 스윕 (롱 온리, 복리 $1000, 수수료 ${FEE_ROUND_TRIP_PCT}%/회 차감) ===`);
  console.log('MA조합   | 거래 | 승률 | 평균net | 최종자본($) | 최악거래 | MDD | 시장노출');

  for (const [fast, slow] of MA_PAIRS) {
    const { trades, equity, maxDd, exposurePct } = runStrategy(daily, fast, slow, evalStartIdx);
    if (trades.length === 0) {
      console.log(`${fast}/${slow} | 거래 없음`);
      continue;
    }
    const wins = trades.filter((t) => t.pnlPct > 0).length;
    const avg = trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length;
    const worst = Math.min(...trades.map((t) => t.pnlPct));
    const openMark = trades[trades.length - 1].open ? ' (1건 보유중)' : '';
    console.log(
      `${String(fast).padStart(3)}/${String(slow).padEnd(3)} | ${String(trades.length).padStart(3)}건 | ` +
      `${((wins / trades.length) * 100).toFixed(0).padStart(3)}% | ` +
      `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% | ` +
      `${equity.toFixed(2).padStart(9)} | ${worst.toFixed(2)}% | ${maxDd.toFixed(1)}% | ${exposurePct.toFixed(0)}%${openMark}`
    );
  }

  console.log('\n=== 클래식 50/200 거래 내역 ===');
  const { trades } = runStrategy(daily, 50, 200, evalStartIdx);
  for (const t of trades) {
    console.log(
      `  ${fmtDate(t.entryTime)} → ${fmtDate(t.exitTime)} : ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%${t.open ? ' (보유중)' : ''}`
    );
  }
}

main().catch((e) => {
  console.error('백테스트 실패:', e.message);
  process.exit(1);
});
