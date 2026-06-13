import axios from 'axios';
import { AppError } from '../middlewares/errorHandler';
import {
  DailyCandle,
  BacktestResult,
  simulateBreakout,
} from '../utils/volatility-breakout-core';

const UPBIT_API_URL = 'https://api.upbit.com/v1';
const FEE_ROUND_TRIP_PCT = 0.1; // 업비트 0.05% × 2
const START_CAPITAL = 1_000_000; // ₩100만 시작 복리

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface UpbitDayCandle {
  candle_date_time_utc: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
}

/**
 * 업비트 일봉 수집 (최신→과거 200개씩 페이지네이션 → 시간 오름차순 반환).
 * 8년 ≈ 2920개 = 15회 호출, 호출 간 150ms 대기 (public API rate limit).
 */
export async function fetchDailyCandles(market: string, days: number): Promise<DailyCandle[]> {
  const out: UpbitDayCandle[] = [];
  let to: string | undefined;

  while (out.length < days) {
    const count = Math.min(200, days - out.length);
    const res = await axios.get(`${UPBIT_API_URL}/candles/days`, {
      params: { market, count, ...(to ? { to } : {}) },
      timeout: 10_000,
    });
    const batch: UpbitDayCandle[] = res.data;
    if (!Array.isArray(batch) || batch.length === 0) break; // 상장 이전 — 데이터 끝
    out.push(...batch);
    to = batch[batch.length - 1].candle_date_time_utc;
    await sleep(150);
  }

  return out
    .reverse()
    .map((c) => ({
      date: c.candle_date_time_utc.slice(0, 10),
      open: c.opening_price,
      high: c.high_price,
      low: c.low_price,
      close: c.trade_price,
    }));
}

export async function runBacktest(params: {
  market: string;
  k: number;
  stopLossPct: number;
  years: number;
}): Promise<BacktestResult> {
  const days = params.years * 365 + 1; // 전일 변동폭 계산용 1일 여유
  const daily = await fetchDailyCandles(params.market, days);
  if (daily.length < 30) {
    throw new AppError(`캔들 데이터 부족: ${params.market} ${daily.length}일 (최소 30일)`, 400);
  }
  return simulateBreakout(daily, {
    k: params.k,
    stopLossPct: params.stopLossPct,
    feeRoundTripPct: FEE_ROUND_TRIP_PCT,
    startCapital: START_CAPITAL,
  });
}
