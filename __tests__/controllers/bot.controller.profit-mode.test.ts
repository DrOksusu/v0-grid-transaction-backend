/**
 * createBot profitMode 파라미터 테스트 (설계서 §4(d))
 * - 미전달 → 'fixed_amount' 디폴트 저장
 * - 'coin_neutral' → 그대로 저장
 * - 허용 외 값 → 400 VALIDATION_ERROR
 */
jest.mock('../../src/services/grid.service', () => ({
  GridService: { createGridLevels: jest.fn() },
  calculateBuyPrices: jest.fn(() => []),
}));
jest.mock('../../src/services/upbit.service', () => ({ UpbitService: jest.fn() }));
jest.mock('../../src/services/exchange/bithumb-client', () => ({ BithumbClient: jest.fn() }));
jest.mock('../../src/services/upbit-price-manager', () => ({ priceManager: {} }));
jest.mock('../../src/services/bot-engine.service', () => ({ botEngine: { onBotStarted: jest.fn() } }));
jest.mock('../../src/services/profit.service', () => ({ ProfitService: {} }));

import prisma from '../../__mocks__/database';
import { createBot } from '../../src/controllers/bot.controller';

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const validBody = {
  exchange: 'upbit',
  ticker: 'KRW-USDT',
  lowerPrice: 1000,
  upperPrice: 1100,
  priceChangePercent: 0.8,
  orderAmount: 10000,
};

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.bot.create as jest.Mock).mockResolvedValue({
    id: 1, exchange: 'upbit', ticker: 'KRW-USDT', gridCount: 12,
    investmentAmount: 120000, status: 'stopped', profitMode: 'fixed_amount',
    createdAt: new Date(),
  });
});

describe('createBot — profitMode', () => {
  it('미전달 시 fixed_amount 디폴트로 저장', async () => {
    const req: any = { userId: 1, body: { ...validBody } };
    const res = mockRes();
    await createBot(req, res, jest.fn());

    expect(prisma.bot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ profitMode: 'fixed_amount' }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('coin_neutral 전달 시 그대로 저장', async () => {
    const req: any = { userId: 1, body: { ...validBody, profitMode: 'coin_neutral' } };
    const res = mockRes();
    await createBot(req, res, jest.fn());

    expect(prisma.bot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ profitMode: 'coin_neutral' }),
      })
    );
  });

  it('허용 외 값이면 400 + bot.create 미호출', async () => {
    const req: any = { userId: 1, body: { ...validBody, profitMode: 'invalid_mode' } };
    const res = mockRes();
    await createBot(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.bot.create).not.toHaveBeenCalled();
  });
});
