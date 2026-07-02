import { koreanStockBotEngine } from '../../src/services/korean-stock-bot-engine.service';
import * as marketHours from '../../src/services/korean-stock-market-hours.service';
import { tossService, TossApiError } from '../../src/services/toss.service';

jest.mock('../../src/services/korean-stock-market-hours.service');
jest.mock('../../src/services/toss.service', () => ({
  tossService: {
    getPrices: jest.fn(),
    placeOrder: jest.fn(),
    cancelOrder: jest.fn(),
  },
  TossApiError: class TossApiError extends Error {
    constructor(public code: string, message: string, public httpStatus: number) {
      super(message);
    }
  },
}));
// encryption / database 모킹은 jest.config의 moduleNameMapper로 자동 적용됨.
// __mocks__/encryption.ts: decrypt(text) → text.replace('encrypted_', '')

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbMock = require('../../__mocks__/database').default;
const mockIsMarketOpen = marketHours.isMarketOpen as jest.MockedFunction<
  typeof marketHours.isMarketOpen
>;
const mockShouldCancel = marketHours.shouldCancelPendingOrders as jest.MockedFunction<
  typeof marketHours.shouldCancelPendingOrders
>;

describe('KoreanStockBotEngine.runCycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbMock.bot.findMany.mockResolvedValue([]);
    dbMock.bot.update.mockResolvedValue({});
    dbMock.gridLevel.findMany.mockResolvedValue([]);
    dbMock.gridLevel.update.mockResolvedValue({});
    dbMock.credential.findFirst.mockResolvedValue(null);
  });

  it('장 마감 + shouldCancel false → 즉시 return (시세/DB 호출 없음)', async () => {
    mockIsMarketOpen.mockResolvedValue(false);
    mockShouldCancel.mockResolvedValue(false);

    await koreanStockBotEngine.runCycle();

    expect(tossService.getPrices).not.toHaveBeenCalled();
    expect(dbMock.gridLevel.findMany).not.toHaveBeenCalled();
    expect(dbMock.bot.findMany).not.toHaveBeenCalled();
  });

  it('장 마감 직후 윈도우(shouldCancel true) → cancelAllPendingOrders 진입', async () => {
    mockIsMarketOpen.mockResolvedValue(false);
    mockShouldCancel.mockResolvedValue(true);

    await koreanStockBotEngine.runCycle();

    expect(dbMock.gridLevel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'pending' }),
      }),
    );
  });

  it('장 시간 + BUY level 현재가 도달 → placeOrder BUY(decimal string) + gridLevel pending', async () => {
    mockIsMarketOpen.mockResolvedValue(true);
    dbMock.bot.findMany.mockResolvedValueOnce([
      {
        id: 1,
        userId: 2,
        ticker: '005930',
        orderAmount: 100000,
        gridLevels: [{ id: 11, type: 'buy', price: 75000, status: 'available' }],
      },
    ]);
    dbMock.credential.findFirst.mockResolvedValueOnce({
      apiKey: 'encrypted_id',
      secretKey: 'encrypted_sec',
      accountSeq: '1',
    });
    (tossService.getPrices as jest.Mock).mockResolvedValueOnce([
      { symbol: '005930', lastPrice: '74500', currency: 'KRW' },
    ]);
    (tossService.placeOrder as jest.Mock).mockResolvedValueOnce({
      orderId: 'ord_42',
      clientOrderId: 'cli_42',
    });

    await koreanStockBotEngine.runCycle();

    // cred 객체로 호출
    expect(tossService.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'id',
        clientSecret: 'sec',
        accountSeq: '1',
      }),
      expect.objectContaining({
        symbol: '005930',
        side: 'BUY',
        orderType: 'LIMIT',
        quantity: '1', // floor(100000/75000)=1
        price: '75000',
      }),
    );
    expect(dbMock.gridLevel.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { status: 'pending', orderId: 'ord_42', clientOrderId: 'cli_42' },
    });
  });

  it('SELL level 현재가 도달 → placeOrder SELL', async () => {
    mockIsMarketOpen.mockResolvedValue(true);
    dbMock.bot.findMany.mockResolvedValueOnce([
      {
        id: 1,
        userId: 2,
        ticker: '005930',
        orderAmount: 100000,
        gridLevels: [
          { id: 22, type: 'sell', price: 78000, buyPrice: 75000, status: 'available' },
        ],
      },
    ]);
    dbMock.credential.findFirst.mockResolvedValueOnce({
      apiKey: 'encrypted_e1',
      secretKey: 'encrypted_e2',
      accountSeq: '9',
    });
    (tossService.getPrices as jest.Mock).mockResolvedValueOnce([
      { symbol: '005930', lastPrice: '78500', currency: 'KRW' },
    ]);
    (tossService.placeOrder as jest.Mock).mockResolvedValueOnce({
      orderId: 'ord_99',
      clientOrderId: 'cli_99',
    });

    await koreanStockBotEngine.runCycle();

    expect(tossService.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'e1', clientSecret: 'e2', accountSeq: '9' }),
      expect.objectContaining({ side: 'SELL', price: '78000', quantity: '1' }),
    );
  });

  it('credentials 없으면 봇 skip (getPrices 호출 안함)', async () => {
    mockIsMarketOpen.mockResolvedValue(true);
    dbMock.bot.findMany.mockResolvedValueOnce([
      {
        id: 1,
        userId: 2,
        ticker: '005930',
        orderAmount: 100000,
        gridLevels: [],
      },
    ]);
    dbMock.credential.findFirst.mockResolvedValueOnce(null);

    await koreanStockBotEngine.runCycle();

    expect(tossService.getPrices).not.toHaveBeenCalled();
    expect(tossService.placeOrder).not.toHaveBeenCalled();
  });

  it('TossService 에러 → bot.update errorMessage 기록', async () => {
    mockIsMarketOpen.mockResolvedValue(true);
    dbMock.bot.findMany.mockResolvedValueOnce([
      {
        id: 1,
        userId: 2,
        ticker: '005930',
        orderAmount: 100000,
        gridLevels: [],
      },
    ]);
    dbMock.credential.findFirst.mockResolvedValueOnce({
      apiKey: 'encrypted_e1',
      secretKey: 'encrypted_e2',
      accountSeq: '1',
    });
    (tossService.getPrices as jest.Mock).mockRejectedValueOnce(new Error('Toss API down'));

    await koreanStockBotEngine.runCycle();

    expect(dbMock.bot.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { errorMessage: 'Toss API down' },
    });
  });
});
