// 바이낸스 4시간봉 BTC/USDT RSI 상승 다이버전스 감지 + 카카오 알림
import axios from 'axios';
import prisma from '../config/database';
import { kakaoNotifyService } from './kakao-notify.service';

interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SwingLow {
  index: number;
  price: number;
  rsi: number;
  time: number;
}

const BINANCE_BASE = 'https://api.binance.com';
const RSI_PERIOD = 14;
const SWING_WINDOW = 3;      // 전후 3봉보다 낮은 봉을 스윙 로우로 인정
const MIN_BARS_APART = 10;   // 스윙 로우 사이 최소 간격
const RSI_OVERBOUGHT = 50;   // 다이버전스 유효 RSI 상한
const COOLDOWN_HOURS = 8;    // 중복 알림 방지 쿨다운

class BtcRsiMonitorService {
  /** Binance 4시간봉 캔들 조회 (최근 200봉) */
  private async fetchCandles(): Promise<Candle[]> {
    const res = await axios.get(`${BINANCE_BASE}/api/v3/klines`, {
      params: { symbol: 'BTCUSDT', interval: '4h', limit: 200 },
      timeout: 10000,
    });
    return (res.data as any[]).map((k: any) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    }));
  }

  /** Wilder's smoothing RSI 계산 */
  private calcRsi(closes: number[]): number[] {
    if (closes.length < RSI_PERIOD + 1) return [];

    const gains: number[] = [];
    const losses: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      gains.push(diff > 0 ? diff : 0);
      losses.push(diff < 0 ? -diff : 0);
    }

    // 첫 RSI_PERIOD 구간 단순 평균
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

  /** 스윙 로우 인덱스 목록 반환 (전후 SWING_WINDOW봉보다 낮은 봉) */
  private findSwingLows(prices: number[], rsiArr: number[]): SwingLow[] {
    const lows: SwingLow[] = [];
    for (let i = SWING_WINDOW; i < prices.length - SWING_WINDOW; i++) {
      if (isNaN(rsiArr[i])) continue;
      const isLow = prices
        .slice(i - SWING_WINDOW, i + SWING_WINDOW + 1)
        .every((p, idx) => idx === SWING_WINDOW || prices[i] < p);
      if (isLow) lows.push({ index: i, price: prices[i], rsi: rsiArr[i], time: 0 });
    }
    return lows;
  }

  /** 상승 다이버전스 감지: 가격 lower low + RSI higher low */
  private detectBullishDivergence(
    swings: SwingLow[],
    candles: Candle[],
  ): { detected: boolean; msg: string; rsi: number; price: number } {
    if (swings.length < 2) return { detected: false, msg: '', rsi: 0, price: 0 };

    // 최근 스윙 로우부터 역방향으로 탐색
    const recent = swings[swings.length - 1];
    if (recent.rsi >= RSI_OVERBOUGHT) return { detected: false, msg: '', rsi: 0, price: 0 };

    for (let i = swings.length - 2; i >= 0; i--) {
      const prev = swings[i];
      const barDiff = recent.index - prev.index;
      if (barDiff < MIN_BARS_APART) continue;

      // 가격 lower low + RSI higher low
      if (recent.price < prev.price && recent.rsi > prev.rsi) {
        const recentCandle = candles[recent.index];
        const prevCandle = candles[prev.index];
        const recentDate = new Date(recentCandle.openTime).toISOString().slice(0, 16);
        const prevDate = new Date(prevCandle.openTime).toISOString().slice(0, 16);

        const msg =
          `[BTC RSI 상승 다이버전스]\n` +
          `현재가: $${recent.price.toLocaleString()}\n` +
          `현재 RSI: ${recent.rsi.toFixed(2)}\n` +
          `이전 저점 ($${prev.price.toLocaleString()} @ ${prevDate}, RSI ${prev.rsi.toFixed(2)}) ↔ ` +
          `최근 저점 ($${recent.price.toLocaleString()} @ ${recentDate}, RSI ${recent.rsi.toFixed(2)})\n` +
          `⬇️ 가격 하락 / ⬆️ RSI 상승 → 매수 시그널`;

        return { detected: true, msg, rsi: recent.rsi, price: recent.price };
      }
      // 더 이전으로 가도 최근 스윙과 비교할 쌍이 하나면 충분
      break;
    }

    return { detected: false, msg: '', rsi: 0, price: 0 };
  }

  /** 쿨다운 내 중복 알림 여부 확인 */
  private async isWithinCooldown(): Promise<boolean> {
    const since = new Date(Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000);
    const last = await (prisma as any).btcRsiAlert.findFirst({
      where: { sentAt: { gte: since } },
      orderBy: { sentAt: 'desc' },
    });
    return !!last;
  }

  /** 알림 이력 DB 저장 */
  private async saveAlert(rsiValue: number, priceValue: number, message: string): Promise<void> {
    await (prisma as any).btcRsiAlert.create({
      data: { rsiValue, priceValue, alertType: 'bullish_divergence', message },
    });
  }

  /** 최근 알림 이력 조회 */
  async getAlertHistory(limit = 20): Promise<any[]> {
    return (prisma as any).btcRsiAlert.findMany({
      orderBy: { sentAt: 'desc' },
      take: limit,
    });
  }

  /** 현재 RSI 값 조회 (관리자 페이지용) */
  async getCurrentRsi(): Promise<{ rsi: number; price: number; timestamp: string }> {
    const candles = await this.fetchCandles();
    const closes = candles.map((c) => c.close);
    const rsiArr = this.calcRsi(closes);
    const lastRsi = rsiArr[rsiArr.length - 1];
    const lastClose = closes[closes.length - 1];
    return {
      rsi: parseFloat(lastRsi.toFixed(2)),
      price: lastClose,
      timestamp: new Date(candles[candles.length - 1].openTime).toISOString(),
    };
  }

  /** 메인 실행: 다이버전스 감지 → 카카오 알림 */
  async check(): Promise<void> {
    const candles = await this.fetchCandles();
    const lows = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);
    const rsiArr = this.calcRsi(closes);

    // 스윙 로우는 저가(low) 기준으로 찾고, RSI는 close 기준 값 사용
    const swings = this.findSwingLows(lows, rsiArr).map((s) => ({
      ...s,
      time: candles[s.index].openTime,
    }));

    const { detected, msg, rsi, price } = this.detectBullishDivergence(swings, candles);
    if (!detected) return;

    if (await this.isWithinCooldown()) {
      console.log('[BtcRsiMonitor] 다이버전스 감지, 쿨다운 내 중복 — 알림 스킵');
      return;
    }

    try {
      await kakaoNotifyService.sendToMe(msg);
      await this.saveAlert(rsi, price, msg);
      console.log('[BtcRsiMonitor] 상승 다이버전스 알림 발송 완료');
    } catch (err: any) {
      console.error('[BtcRsiMonitor] 카카오 알림 실패:', err.message);
    }
  }
}

export const btcRsiMonitorService = new BtcRsiMonitorService();
