import type { Response } from 'express';
import type { AuthRequest } from '../../src/types';
import { getTickers, getPrice } from '../../src/controllers/exchange.controller';
import { mexcGridPriceManager } from '../../src/services/mexc-grid-price-manager';

jest.mock('../../src/services/mexc-grid-price-manager', () => ({
  mexcGridPriceManager: { getPriceWithFallback: jest.fn() },
}));
jest.mock('../../src/services/upbit-price-manager', () => ({ priceManager: {} }));
jest.mock('../../src/services/binance-price-manager', () => ({ binancePriceManager: {} }));
jest.mock('../../src/services/bithumb-grid-price-manager', () => ({ bithumbPriceManager: {} }));

describe('exchange.controller MEXC 분기', () => {
  let res: Partial<Response>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;
  const next = jest.fn();

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    res = { status: statusMock } as Partial<Response>;
    jest.clearAllMocks();
    statusMock.mockReturnValue({ json: jsonMock });
  });

  it('getTickers: mexc는 큐레이션 6종을 binance와 동일 shape로 반환', async () => {
    const req = { params: { exchange: 'mexc' } } as unknown as AuthRequest;
    await getTickers(req, res as Response, next);
    expect(statusMock).toHaveBeenCalledWith(200);
    const body = jsonMock.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.tickers).toHaveLength(6);
    expect(body.data.tickers[0]).toEqual({ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' });
    expect(body.data.tickers.map((t: any) => t.symbol)).toEqual([
      'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'DOGEUSDT', 'BNBUSDT',
    ]);
  });

  it('getPrice: mexc는 mexcGridPriceManager 가격을 기존 shape로 반환', async () => {
    (mexcGridPriceManager.getPriceWithFallback as jest.Mock).mockResolvedValue(63000.5);
    const req = { params: { exchange: 'mexc', ticker: 'BTCUSDT' } } as unknown as AuthRequest;
    await getPrice(req, res as Response, next);
    expect(mexcGridPriceManager.getPriceWithFallback).toHaveBeenCalledWith('BTCUSDT');
    expect(statusMock).toHaveBeenCalledWith(200);
    const data = jsonMock.mock.calls[0][0].data;
    expect(data).toMatchObject({
      ticker: 'BTCUSDT',
      currentPrice: 63000.5,
      change24h: 0,
      volume24h: 0,
      high24h: 0,
      low24h: 0,
    });
    expect(typeof data.timestamp).toBe('string');
  });
});
