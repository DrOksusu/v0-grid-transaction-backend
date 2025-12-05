import { Response, NextFunction } from 'express';
import axios from 'axios';
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
