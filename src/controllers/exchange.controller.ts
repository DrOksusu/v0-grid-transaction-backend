import { Response, NextFunction } from 'express';
import axios from 'axios';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';

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

    const mockTickers = exchange === 'upbit'
      ? [
          { symbol: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin' },
          { symbol: 'KRW-ETH', koreanName: '이더리움', englishName: 'Ethereum' },
          { symbol: 'KRW-XRP', koreanName: '리플', englishName: 'Ripple' },
        ]
      : [
          { symbol: 'BTCUSDT', koreanName: '비트코인', englishName: 'Bitcoin' },
          { symbol: 'ETHUSDT', koreanName: '이더리움', englishName: 'Ethereum' },
          { symbol: 'XRPUSDT', koreanName: '리플', englishName: 'Ripple' },
        ];

    return successResponse(res, { tickers: mockTickers });
  } catch (error) {
    next(error);
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

    if (exchange === 'upbit') {
      // 업비트 API 호출
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
    }

    return successResponse(res, priceData);
  } catch (error: any) {
    console.error(`[Exchange] Price fetch error for ${req.params.ticker}:`, error.message);

    // API 에러 응답 처리
    if (error.response) {
      const status = error.response.status;
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
