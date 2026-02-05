import axios from 'axios';
import { socketService } from './socket.service';

// 캔들 데이터 인터페이스
interface CandleData {
  market: string;
  candle_date_time_utc: string;
  candle_date_time_kst: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;  // 종가
  timestamp: number;
  candle_acc_trade_price: number;
  candle_acc_trade_volume: number;
  unit: number;
}

// MA 계산 결과 인터페이스
export interface MAIndicator {
  market: string;
  currentPrice: number;
  timestamp: number;
  ma20: number;
  ma60: number;
  ma120: number;
  // 현재가 vs MA 위치
  pricePosition: {
    aboveMA20: boolean;
    aboveMA60: boolean;
    aboveMA120: boolean;
  };
  // 크로스 신호
  crossSignal: {
    goldenCross: boolean;  // MA20이 MA60 상향 돌파
    deadCross: boolean;    // MA20이 MA60 하향 돌파
    crossType: 'golden' | 'dead' | 'none';
  };
  // 종합 추세 신호
  trendSignal: {
    signal: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
    strength: number;  // -100 ~ 100
    description: string;
  };
}

// 이전 MA 값 저장 (크로스 감지용)
interface PreviousMA {
  ma20: number;
  ma60: number;
  timestamp: number;
}

class MAIndicatorService {
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly UPBIT_CANDLE_API = 'https://api.upbit.com/v1/candles/minutes/30';
  private readonly MARKET = 'KRW-BTC';
  private readonly UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30분

  private previousMA: PreviousMA | null = null;
  private currentIndicator: MAIndicator | null = null;
  private lastFetchTime: number = 0;

  // 캔들 데이터 조회
  private async fetchCandles(count: number = 120): Promise<CandleData[]> {
    try {
      const response = await axios.get<CandleData[]>(this.UPBIT_CANDLE_API, {
        params: {
          market: this.MARKET,
          count: count,
        },
        headers: {
          'Accept': 'application/json',
        },
      });
      return response.data;
    } catch (error) {
      console.error('[MAIndicator] Failed to fetch candles:', error);
      throw error;
    }
  }

  // MA 계산
  private calculateMA(candles: CandleData[], period: number): number {
    if (candles.length < period) {
      console.warn(`[MAIndicator] Not enough candles for MA${period}: ${candles.length}/${period}`);
      return 0;
    }

    const sum = candles
      .slice(0, period)
      .reduce((acc, candle) => acc + candle.trade_price, 0);

    return sum / period;
  }

  // 추세 신호 계산
  private calculateTrendSignal(
    currentPrice: number,
    ma20: number,
    ma60: number,
    ma120: number,
    crossSignal: { goldenCross: boolean; deadCross: boolean }
  ): { signal: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell'; strength: number; description: string } {
    // 기본 점수 계산
    let score = 0;
    const descriptions: string[] = [];

    // 현재가 vs MA 위치 점수 (+/- 각 20점)
    if (currentPrice > ma20) {
      score += 20;
    } else {
      score -= 20;
    }

    if (currentPrice > ma60) {
      score += 20;
    } else {
      score -= 20;
    }

    if (currentPrice > ma120) {
      score += 20;
    } else {
      score -= 20;
    }

    // MA 배열 점수 (+/- 20점)
    if (ma20 > ma60 && ma60 > ma120) {
      score += 20;
      descriptions.push('MA 정배열(상승추세)');
    } else if (ma20 < ma60 && ma60 < ma120) {
      score -= 20;
      descriptions.push('MA 역배열(하락추세)');
    } else {
      descriptions.push('MA 혼조세');
    }

    // 크로스 신호 (+/- 20점)
    if (crossSignal.goldenCross) {
      score += 20;
      descriptions.push('골든크로스 발생');
    } else if (crossSignal.deadCross) {
      score -= 20;
      descriptions.push('데드크로스 발생');
    }

    // 신호 결정
    let signal: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
    if (score >= 60) {
      signal = 'strong_buy';
      descriptions.unshift('강한 매수 신호');
    } else if (score >= 20) {
      signal = 'buy';
      descriptions.unshift('매수 신호');
    } else if (score <= -60) {
      signal = 'strong_sell';
      descriptions.unshift('강한 매도 신호');
    } else if (score <= -20) {
      signal = 'sell';
      descriptions.unshift('매도 신호');
    } else {
      signal = 'neutral';
      descriptions.unshift('중립');
    }

    return {
      signal,
      strength: score,
      description: descriptions.join(' | '),
    };
  }

  // MA 지표 계산 및 업데이트
  async calculateIndicator(): Promise<MAIndicator | null> {
    try {
      const candles = await this.fetchCandles(120);

      if (candles.length < 120) {
        console.warn(`[MAIndicator] Insufficient candles: ${candles.length}`);
        return null;
      }

      const currentPrice = candles[0].trade_price;
      const timestamp = Date.now();

      const ma20 = this.calculateMA(candles, 20);
      const ma60 = this.calculateMA(candles, 60);
      const ma120 = this.calculateMA(candles, 120);

      // 크로스 신호 감지
      let goldenCross = false;
      let deadCross = false;

      if (this.previousMA) {
        // 골든크로스: 이전에 MA20 < MA60 이었는데, 현재 MA20 > MA60
        if (this.previousMA.ma20 < this.previousMA.ma60 && ma20 > ma60) {
          goldenCross = true;
          console.log('[MAIndicator] Golden Cross detected!');
        }
        // 데드크로스: 이전에 MA20 > MA60 이었는데, 현재 MA20 < MA60
        if (this.previousMA.ma20 > this.previousMA.ma60 && ma20 < ma60) {
          deadCross = true;
          console.log('[MAIndicator] Dead Cross detected!');
        }
      }

      // 이전 MA 저장
      this.previousMA = { ma20, ma60, timestamp };

      // 추세 신호 계산
      const crossSignal = {
        goldenCross,
        deadCross,
        crossType: goldenCross ? 'golden' : deadCross ? 'dead' : 'none' as 'golden' | 'dead' | 'none',
      };

      const trendSignal = this.calculateTrendSignal(currentPrice, ma20, ma60, ma120, crossSignal);

      this.currentIndicator = {
        market: this.MARKET,
        currentPrice,
        timestamp,
        ma20,
        ma60,
        ma120,
        pricePosition: {
          aboveMA20: currentPrice > ma20,
          aboveMA60: currentPrice > ma60,
          aboveMA120: currentPrice > ma120,
        },
        crossSignal,
        trendSignal,
      };

      this.lastFetchTime = timestamp;

      console.log(`[MAIndicator] Updated - Price: ${currentPrice.toLocaleString()}, MA20: ${ma20.toLocaleString()}, MA60: ${ma60.toLocaleString()}, MA120: ${ma120.toLocaleString()}, Signal: ${trendSignal.signal}`);

      return this.currentIndicator;
    } catch (error) {
      console.error('[MAIndicator] Failed to calculate indicator:', error);
      return null;
    }
  }

  // 서비스 시작
  async start() {
    console.log('[MAIndicator] Starting MA indicator service...');

    // 초기 데이터 로드
    await this.calculateIndicator();

    // 30분마다 업데이트
    this.updateInterval = setInterval(async () => {
      const indicator = await this.calculateIndicator();
      if (indicator) {
        // 소켓으로 브로드캐스트
        socketService.emitMAUpdate(indicator);
      }
    }, this.UPDATE_INTERVAL_MS);

    console.log('[MAIndicator] MA indicator service started (30min interval)');
  }

  // 서비스 중지
  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    console.log('[MAIndicator] MA indicator service stopped');
  }

  // 현재 지표 반환
  getCurrentIndicator(): MAIndicator | null {
    return this.currentIndicator;
  }

  // 마지막 업데이트 시간 반환
  getLastFetchTime(): number {
    return this.lastFetchTime;
  }

  // 서비스 상태 반환
  getStatus(): { running: boolean; lastUpdate: number; market: string; interval: string } {
    return {
      running: this.updateInterval !== null,
      lastUpdate: this.lastFetchTime,
      market: this.MARKET,
      interval: '30min',
    };
  }
}

export const maIndicatorService = new MAIndicatorService();
