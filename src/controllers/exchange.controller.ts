import { Response, NextFunction } from 'express';
import axios from 'axios';
import { parse } from 'node-html-parser';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';

// 티커 캐시 (메모리 캐시, 5분간 유효)
let tickerCache: {
  upbit: { data: any[]; timestamp: number } | null;
  binance: { data: any[]; timestamp: number } | null;
} = { upbit: null, binance: null };

const CACHE_TTL = 5 * 60 * 1000; // 5분

// 가격 캐시 (10초간 유효)
const priceCache: Map<string, { data: any; timestamp: number }> = new Map();
const PRICE_CACHE_TTL = 10 * 1000; // 10초

// API 호출 쓰로틀링
let lastPriceApiCall = 0;
const PRICE_API_MIN_INTERVAL = 100; // 100ms

async function throttlePriceApi(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastPriceApiCall;
  if (elapsed < PRICE_API_MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, PRICE_API_MIN_INTERVAL - elapsed));
  }
  lastPriceApiCall = Date.now();
}

export const getTickers = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { exchange } = req.params;

    if (exchange !== 'upbit' && exchange !== 'binance') {
      return errorResponse(
        res,
        'INVALID_EXCHANGE',
        '지원하지 않는 거래소입니다',
        400
      );
    }

    const now = Date.now();
    let tickers: any[] = [];

    if (exchange === 'upbit') {
      // 캐시 확인
      if (tickerCache.upbit && (now - tickerCache.upbit.timestamp) < CACHE_TTL) {
        tickers = tickerCache.upbit.data;
      } else {
        // 업비트 API에서 전체 마켓 목록 가져오기
        const response = await axios.get('https://api.upbit.com/v1/market/all');

        // KRW 마켓만 필터링하고 프론트엔드 형식으로 변환
        tickers = response.data
          .filter((item: any) => item.market.startsWith('KRW-'))
          .map((item: any) => ({
            market: item.market,
            korean_name: item.korean_name,
            english_name: item.english_name,
          }));

        // 캐시 저장
        tickerCache.upbit = { data: tickers, timestamp: now };
        console.log(`[Exchange] Upbit tickers cached: ${tickers.length} items`);
      }
    } else {
      // 캐시 확인
      if (tickerCache.binance && (now - tickerCache.binance.timestamp) < CACHE_TTL) {
        tickers = tickerCache.binance.data;
      } else {
        // 바이낸스 API에서 전체 심볼 목록 가져오기
        const response = await axios.get('https://api.binance.com/api/v3/exchangeInfo');

        // USDT 마켓만 필터링하고 프론트엔드 형식으로 변환
        tickers = response.data.symbols
          .filter((item: any) => item.quoteAsset === 'USDT' && item.status === 'TRADING')
          .map((item: any) => ({
            symbol: item.symbol,
            baseAsset: item.baseAsset,
            quoteAsset: item.quoteAsset,
          }));

        // 캐시 저장
        tickerCache.binance = { data: tickers, timestamp: now };
        console.log(`[Exchange] Binance tickers cached: ${tickers.length} items`);
      }
    }

    return successResponse(res, { tickers });
  } catch (error: any) {
    console.error(`[Exchange] Failed to fetch tickers:`, error.message);
    return errorResponse(
      res,
      'TICKER_FETCH_ERROR',
      '티커 목록을 가져올 수 없습니다',
      500
    );
  }
};

export const getPrice = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { exchange, ticker } = req.params;

    if (exchange !== 'upbit' && exchange !== 'binance') {
      return errorResponse(
        res,
        'INVALID_EXCHANGE',
        '지원하지 않는 거래소입니다',
        400
      );
    }

    let priceData;

    // 캐시 확인
    const cacheKey = `${exchange}:${ticker}`;
    const cached = priceCache.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < PRICE_CACHE_TTL) {
      return successResponse(res, cached.data);
    }

    if (exchange === 'upbit') {
      // 업비트 API 호출 (throttling 적용)
      await throttlePriceApi();
      const response = await axios.get(`https://api.upbit.com/v1/ticker?markets=${ticker}`);

      if (!response.data || response.data.length === 0) {
        return errorResponse(
          res,
          'TICKER_NOT_FOUND',
          '해당 티커를 찾을 수 없습니다',
          404
        );
      }

      const data = response.data[0];
      priceData = {
        ticker,
        currentPrice: data.trade_price,
        change24h: data.signed_change_rate * 100,
        volume24h: data.acc_trade_price_24h,
        high24h: data.high_price,
        low24h: data.low_price,
        timestamp: new Date().toISOString(),
      };

      // 캐시 저장
      priceCache.set(cacheKey, { data: priceData, timestamp: now });
    } else {
      // 바이낸스 API 호출
      const [priceResponse, statsResponse] = await Promise.all([
        axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${ticker}`),
        axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${ticker}`)
      ]);

      priceData = {
        ticker,
        currentPrice: parseFloat(priceResponse.data.price),
        change24h: parseFloat(statsResponse.data.priceChangePercent),
        volume24h: parseFloat(statsResponse.data.quoteVolume),
        high24h: parseFloat(statsResponse.data.highPrice),
        low24h: parseFloat(statsResponse.data.lowPrice),
        timestamp: new Date().toISOString(),
      };

      // 캐시 저장
      priceCache.set(cacheKey, { data: priceData, timestamp: now });
    }

    return successResponse(res, priceData);
  } catch (error: any) {
    console.error(`[Exchange] Price fetch error for ${req.params.ticker}:`, error.message);

    // API 에러 응답 처리
    if (error.response) {
      const status = error.response.status;
      if (status === 429) {
        console.log(`[Exchange] Rate limited for ${req.params.ticker}, returning cached or error`);
        // 캐시가 있으면 만료되었더라도 반환
        const cacheKey = `${req.params.exchange}:${req.params.ticker}`;
        const cached = priceCache.get(cacheKey);
        if (cached) {
          return successResponse(res, cached.data);
        }
        return errorResponse(
          res,
          'RATE_LIMITED',
          '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
          429
        );
      }
      if (status === 400 || status === 404) {
        return errorResponse(
          res,
          'INVALID_TICKER',
          '잘못된 티커 심볼입니다',
          400
        );
      }
    }

    // 네트워크 에러 또는 기타 에러
    return errorResponse(
      res,
      'PRICE_FETCH_ERROR',
      '가격 정보를 가져올 수 없습니다',
      500
    );
  }
};

// 환율 캐시 (1시간 유효)
let exchangeRateCache: { rate: number; timestamp: number } | null = null;
let frankfurterCache: { rate: number; timestamp: number } | null = null;
let koreaEximCache: { rate: number; timestamp: number; date?: string } | null = null;
let naverCache: { rate: number; timestamp: number; change?: number } | null = null;
const EXCHANGE_RATE_CACHE_TTL = 60 * 60 * 1000; // 1시간
const NAVER_CACHE_TTL = 60 * 1000; // 네이버는 1분 캐시 (실시간에 가깝게)

// 한국수출입은행 환율 조회 함수
async function fetchKoreaEximRate(): Promise<{ rate: number; date: string } | null> {
  try {
    const apiKey = process.env.KOREA_EXIM_API_KEY;
    if (!apiKey) {
      console.log('[Exchange] 한국수출입은행 API 키가 설정되지 않음');
      return null;
    }

    // 오늘 날짜 (YYYYMMDD 형식)
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

    const response = await axios.get(
      'https://www.koreaexim.go.kr/site/program/financial/exchangeJSON',
      {
        params: {
          authkey: apiKey,
          searchdate: dateStr,
          data: 'AP01', // 환율
        },
        timeout: 5000,
      }
    );

    if (response.data && Array.isArray(response.data)) {
      // USD 찾기
      const usdRate = response.data.find((item: any) => item.cur_unit === 'USD');
      if (usdRate && usdRate.deal_bas_r) {
        // 쉼표 제거 후 숫자로 변환 (예: "1,450.5" → 1450.5)
        const rate = parseFloat(usdRate.deal_bas_r.replace(/,/g, ''));
        return { rate, date: dateStr };
      }
    }

    // 주말/공휴일에는 데이터가 없을 수 있음 - 이전 영업일 조회
    console.log('[Exchange] 오늘 한국수출입은행 데이터 없음, 이전 영업일 조회');
    for (let i = 1; i <= 5; i++) {
      const prevDate = new Date(today);
      prevDate.setDate(prevDate.getDate() - i);
      const prevDateStr = prevDate.toISOString().slice(0, 10).replace(/-/g, '');

      const prevResponse = await axios.get(
        'https://www.koreaexim.go.kr/site/program/financial/exchangeJSON',
        {
          params: {
            authkey: apiKey,
            searchdate: prevDateStr,
            data: 'AP01',
          },
          timeout: 5000,
        }
      );

      if (prevResponse.data && Array.isArray(prevResponse.data) && prevResponse.data.length > 0) {
        const usdRate = prevResponse.data.find((item: any) => item.cur_unit === 'USD');
        if (usdRate && usdRate.deal_bas_r) {
          const rate = parseFloat(usdRate.deal_bas_r.replace(/,/g, ''));
          return { rate, date: prevDateStr };
        }
      }
    }

    return null;
  } catch (error: any) {
    console.error('[Exchange] 한국수출입은행 API 에러:', error.message);
    return null;
  }
}

// 네이버 금융 환율 스크래핑 함수
async function fetchNaverExchangeRate(): Promise<{ rate: number; change: number } | null> {
  try {
    const response = await axios.get(
      'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_USDKRW',
      {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      }
    );

    const root = parse(response.data);

    // 현재 환율 추출 - 개별 span 숫자들을 조합 (no0~no9, shim=쉼표, jum=소수점)
    // 구조: <p class="no_today"><em><em><span class="no1">1</span><span class="shim">,</span>...
    let rateText = '';
    const rateSpans = root.querySelectorAll('.no_today em em span');
    for (const span of rateSpans) {
      const className = span.getAttribute('class') || '';
      if (className.startsWith('no')) {
        // no0, no1, ..., no9 -> 해당 숫자 추출
        const digit = className.replace('no', '');
        if (/^\d$/.test(digit)) {
          rateText += digit;
        }
      } else if (className === 'jum') {
        // 소수점
        rateText += '.';
      }
      // shim(쉼표)는 무시
    }

    // 전일 대비 변동 추출
    let changeText = '';
    const changeSpans = root.querySelectorAll('.no_exday em span');
    for (const span of changeSpans) {
      const className = span.getAttribute('class') || '';
      if (className.startsWith('no')) {
        const digit = className.replace('no', '');
        if (/^\d$/.test(digit)) {
          changeText += digit;
        }
      } else if (className === 'jum') {
        changeText += '.';
      }
    }

    // 상승/하락 여부 확인
    const noExday = root.querySelector('.no_exday');
    const noTodayEm = root.querySelector('.no_today em');
    const isDown = (noExday?.classNames?.includes('no_down')) ||
                   (noTodayEm?.classNames?.includes('no_down'));

    if (rateText) {
      const rate = parseFloat(rateText);
      let change = changeText ? parseFloat(changeText) : 0;
      if (isDown) {
        change = -Math.abs(change);
      }

      if (!isNaN(rate) && rate > 0) {
        console.log(`[Exchange] 네이버 환율 조회 성공: ${rate}원 (${change >= 0 ? '+' : ''}${change})`);
        return { rate, change };
      }
    }

    console.log('[Exchange] 네이버 환율 파싱 실패, rateText:', rateText);
    return null;
  } catch (error: any) {
    console.error('[Exchange] 네이버 금융 스크래핑 에러:', error.message);
    return null;
  }
}

export const getExchangeRate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const now = Date.now();

    // 1. 한국수출입은행 캐시 확인
    if (koreaEximCache && (now - koreaEximCache.timestamp) < EXCHANGE_RATE_CACHE_TTL) {
      return successResponse(res, {
        rate: koreaEximCache.rate,
        currency: 'USD/KRW',
        timestamp: new Date(koreaEximCache.timestamp).toISOString(),
        source: 'koreaexim',
        cached: true,
      });
    }

    // 2. 한국수출입은행 API 우선 시도
    const eximResult = await fetchKoreaEximRate();
    if (eximResult) {
      koreaEximCache = { rate: eximResult.rate, timestamp: now, date: eximResult.date };
      return successResponse(res, {
        rate: eximResult.rate,
        currency: 'USD/KRW',
        timestamp: new Date().toISOString(),
        source: 'koreaexim',
        date: eximResult.date,
      });
    }

    // 3. 한국수출입은행 실패 시 Currency API 폴백
    const response = await axios.get(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      { timeout: 5000 }
    );

    if (response.data && response.data.usd && response.data.usd.krw) {
      const rate = response.data.usd.krw;
      exchangeRateCache = { rate, timestamp: now };

      return successResponse(res, {
        rate,
        currency: 'USD/KRW',
        timestamp: new Date().toISOString(),
        source: 'currency-api',
        cached: false,
      });
    }

    // 4. 최후의 백업: 업비트/바이낸스 BTC 가격 비교로 추정
    const [upbitRes, binanceRes] = await Promise.all([
      axios.get('https://api.upbit.com/v1/ticker?markets=KRW-BTC'),
      axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
    ]);

    const upbitBtc = upbitRes.data[0].trade_price;
    const binanceBtc = parseFloat(binanceRes.data.price);
    const estimatedRate = upbitBtc / binanceBtc;

    exchangeRateCache = { rate: estimatedRate, timestamp: now };

    return successResponse(res, {
      rate: estimatedRate,
      currency: 'USD/KRW',
      timestamp: new Date().toISOString(),
      source: 'btc-estimate',
      estimated: true,
    });
  } catch (error: any) {
    console.error('[Exchange] Exchange rate fetch error:', error.message);

    // 캐시가 있으면 만료되었더라도 반환
    if (exchangeRateCache) {
      return successResponse(res, {
        rate: exchangeRateCache.rate,
        currency: 'USD/KRW',
        timestamp: new Date(exchangeRateCache.timestamp).toISOString(),
        cached: true,
        stale: true,
      });
    }

    return errorResponse(
      res,
      'EXCHANGE_RATE_ERROR',
      '환율 정보를 가져올 수 없습니다',
      500
    );
  }
};

// Frankfurter API (ECB 유럽중앙은행 데이터)
export const getExchangeRateFrankfurter = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const now = Date.now();

    // 캐시 확인
    if (frankfurterCache && (now - frankfurterCache.timestamp) < EXCHANGE_RATE_CACHE_TTL) {
      return successResponse(res, {
        rate: frankfurterCache.rate,
        currency: 'USD/KRW',
        source: 'frankfurter',
        timestamp: new Date(frankfurterCache.timestamp).toISOString(),
        cached: true,
      });
    }

    // Frankfurter API 호출 (ECB 데이터)
    const response = await axios.get('https://api.frankfurter.app/latest', {
      params: {
        from: 'USD',
        to: 'KRW',
      },
    });

    if (response.data && response.data.rates && response.data.rates.KRW) {
      const rate = response.data.rates.KRW;
      frankfurterCache = { rate, timestamp: now };

      return successResponse(res, {
        rate,
        currency: 'USD/KRW',
        source: 'frankfurter',
        date: response.data.date,
        timestamp: new Date().toISOString(),
        cached: false,
      });
    }

    return errorResponse(
      res,
      'EXCHANGE_RATE_ERROR',
      'Frankfurter API에서 환율을 가져올 수 없습니다',
      500
    );
  } catch (error: any) {
    console.error('[Exchange] Frankfurter exchange rate fetch error:', error.message);

    // 캐시가 있으면 만료되었더라도 반환
    if (frankfurterCache) {
      return successResponse(res, {
        rate: frankfurterCache.rate,
        currency: 'USD/KRW',
        source: 'frankfurter',
        timestamp: new Date(frankfurterCache.timestamp).toISOString(),
        cached: true,
        stale: true,
      });
    }

    return errorResponse(
      res,
      'EXCHANGE_RATE_ERROR',
      'Frankfurter 환율 정보를 가져올 수 없습니다',
      500
    );
  }
};

// 네이버 금융 + 공개 API 두 가지 환율 반환
export const getDualExchangeRates = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const now = Date.now();
    let naverRate: number | null = null;
    let naverChange: number | undefined;
    let currencyApiRate: number | null = null;

    // 1. 네이버 금융 조회 (1분 캐시)
    if (naverCache && (now - naverCache.timestamp) < NAVER_CACHE_TTL) {
      naverRate = naverCache.rate;
      naverChange = naverCache.change;
    } else {
      const naverResult = await fetchNaverExchangeRate();
      if (naverResult) {
        naverCache = { rate: naverResult.rate, timestamp: now, change: naverResult.change };
        naverRate = naverResult.rate;
        naverChange = naverResult.change;
      }
    }

    // 2. 공개 API (Currency API) 조회
    if (exchangeRateCache && (now - exchangeRateCache.timestamp) < EXCHANGE_RATE_CACHE_TTL) {
      currencyApiRate = exchangeRateCache.rate;
    } else {
      try {
        const currencyRes = await axios.get(
          'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
          { timeout: 5000 }
        );
        if (currencyRes.data?.usd?.krw) {
          currencyApiRate = currencyRes.data.usd.krw;
          exchangeRateCache = { rate: currencyApiRate, timestamp: now };
        }
      } catch (e) {
        console.log('[Exchange] Currency API 조회 실패');
      }
    }

    return successResponse(res, {
      naver: naverRate
        ? { rate: naverRate, change: naverChange }
        : null,
      currencyApi: currencyApiRate
        ? { rate: currencyApiRate }
        : null,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[Exchange] Dual exchange rate error:', error.message);
    return errorResponse(
      res,
      'EXCHANGE_RATE_ERROR',
      '환율 정보를 가져올 수 없습니다',
      500
    );
  }
};

// 여러 소스 환율 비교
export const getExchangeRateComparison = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const now = Date.now();
    const results: {
      source: string;
      rate: number | null;
      error?: string;
      date?: string;
    }[] = [];

    // 1. 한국수출입은행 (가장 공신력 있음)
    try {
      if (koreaEximCache && (now - koreaEximCache.timestamp) < EXCHANGE_RATE_CACHE_TTL) {
        results.push({
          source: '한국수출입은행',
          rate: koreaEximCache.rate,
          date: koreaEximCache.date,
        });
      } else {
        const eximResult = await fetchKoreaEximRate();
        if (eximResult) {
          koreaEximCache = { rate: eximResult.rate, timestamp: now, date: eximResult.date };
          results.push({
            source: '한국수출입은행',
            rate: eximResult.rate,
            date: eximResult.date,
          });
        } else {
          results.push({ source: '한국수출입은행', rate: null, error: 'API 키 미설정 또는 조회 실패' });
        }
      }
    } catch (e: any) {
      results.push({ source: '한국수출입은행', rate: null, error: e.message });
    }

    // 2. Frankfurter API (ECB)
    try {
      if (frankfurterCache && (now - frankfurterCache.timestamp) < EXCHANGE_RATE_CACHE_TTL) {
        results.push({
          source: 'ECB (Frankfurter)',
          rate: frankfurterCache.rate,
        });
      } else {
        const frankfurterRes = await axios.get('https://api.frankfurter.app/latest', {
          params: { from: 'USD', to: 'KRW' },
          timeout: 5000,
        });
        if (frankfurterRes.data?.rates?.KRW) {
          const rate = frankfurterRes.data.rates.KRW;
          frankfurterCache = { rate, timestamp: now };
          results.push({
            source: 'ECB (Frankfurter)',
            rate,
            date: frankfurterRes.data.date,
          });
        }
      }
    } catch (e: any) {
      results.push({ source: 'ECB (Frankfurter)', rate: null, error: e.message });
    }

    // 2. Fawaz Ahmed Currency API (무료, API 키 불필요)
    try {
      if (exchangeRateCache && (now - exchangeRateCache.timestamp) < EXCHANGE_RATE_CACHE_TTL) {
        results.push({
          source: 'Currency API',
          rate: exchangeRateCache.rate,
        });
      } else {
        const currencyRes = await axios.get(
          'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
          { timeout: 5000 }
        );
        if (currencyRes.data?.usd?.krw) {
          const rate = currencyRes.data.usd.krw;
          exchangeRateCache = { rate, timestamp: now };
          results.push({
            source: 'Currency API',
            rate,
          });
        }
      }
    } catch (e: any) {
      results.push({ source: 'Currency API', rate: null, error: e.message });
    }

    // 3. BTC 가격 비교 추정
    try {
      const [upbitRes, binanceRes] = await Promise.all([
        axios.get('https://api.upbit.com/v1/ticker?markets=KRW-BTC', { timeout: 5000 }),
        axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { timeout: 5000 }),
      ]);
      const upbitBtc = upbitRes.data[0].trade_price;
      const binanceBtc = parseFloat(binanceRes.data.price);
      const estimatedRate = upbitBtc / binanceBtc;
      results.push({
        source: 'BTC 가격 비교 (추정)',
        rate: Math.round(estimatedRate * 100) / 100,
      });
    } catch (e: any) {
      results.push({ source: 'BTC 가격 비교 (추정)', rate: null, error: e.message });
    }

    // 평균 환율 계산 (유효한 값만)
    const validRates = results.filter(r => r.rate !== null).map(r => r.rate as number);
    const avgRate = validRates.length > 0
      ? Math.round((validRates.reduce((a, b) => a + b, 0) / validRates.length) * 100) / 100
      : null;

    return successResponse(res, {
      currency: 'USD/KRW',
      rates: results,
      average: avgRate,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[Exchange] Exchange rate comparison error:', error.message);
    return errorResponse(
      res,
      'EXCHANGE_RATE_COMPARISON_ERROR',
      '환율 비교 정보를 가져올 수 없습니다',
      500
    );
  }
};

export const validateCredentials = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { exchange, apiKey, secretKey } = req.body;

    if (!exchange || !apiKey || !secretKey) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '필수 필드가 누락되었습니다',
        400
      );
    }

    const mockAccountInfo = {
      currency: 'KRW',
      balance: 1000000,
      locked: 50000,
      avgBuyPrice: 0,
    };

    return successResponse(
      res,
      {
        isValid: true,
        accountInfo: mockAccountInfo,
      },
      'API 인증 정보가 유효합니다'
    );
  } catch (error) {
    next(error);
  }
};
