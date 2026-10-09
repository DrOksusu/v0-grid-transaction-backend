/**
 * MEXC 그리드 시작: 전액 USDT pre-flight 제거, 자격증명 존재만 확인
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
import { MexcGridClient } from '../../src/services/exchange/mexc-grid-client';
import { createBot } from '../../src/controllers/bot.controller';

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const body = {
  exchange: 'mexc', ticker: 'BTCUSDT', lowerPrice: 1000, upperPrice: 1100,
  priceChangePercent: 0.8, orderAmount: 10000, autoStart: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.bot.create as jest.Mock).mockResolvedValue({
    id: 1, exchange: 'mexc', ticker: 'BTCUSDT', gridCount: 12,
    investmentAmount: 120000, status: 'running', profitMode: 'fixed_amount',
    createdAt: new Date(),
  });
});

describe('createBot — MEXC autoStart', () => {
  it('자격증명 있으면 잔고가 투입보다 적어도 막지 않는다', async () => {
    (prisma.credential.findFirst as jest.Mock).mockResolvedValue({ apiKey: 'a', secretKey: 'b' });
    const balSpy = jest.spyOn(MexcGridClient.prototype, 'getUsdtBalance').mockResolvedValue(1);
    const res = mockRes();
    await createBot({ userId: 1, body: { ...body } } as any, res, jest.fn());

    expect(balSpy).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).toHaveBeenCalledWith(201);
    balSpy.mockRestore();
  });

  it('자격증명 없으면 CREDENTIAL_NOT_FOUND 400', async () => {
    (prisma.credential.findFirst as jest.Mock).mockResolvedValue(null);
    const res = mockRes();
    await createBot({ userId: 1, body: { ...body } } as any, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(JSON.stringify(res.json.mock.calls)).toContain('CREDENTIAL_NOT_FOUND');
  });
});
