import type { Response } from 'express';
import type { AuthRequest } from '../../src/types';
import * as arbService from '../../src/services/stablecoin-arb.service';
import * as priceManager from '../../src/services/upbit-price-manager';
import type { OrderbookTop } from '../../src/services/upbit-price-manager';
import {
  getBot,
  getOrderbooks,
  getOpportunityStats,
  getRecentOpportunities,
  getSimOverview,
  postKillswitch,
} from '../../src/controllers/stablecoin-admin.controller';

jest.mock('../../src/services/stablecoin-arb.service');
jest.mock('../../src/services/upbit-price-manager');

describe('stablecoin-admin.controller', () => {
  let req: Partial<AuthRequest>;
  let res: Partial<Response>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;
  let next: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    res = { json: jsonMock, status: statusMock };
    next = jest.fn();
  });

  describe('getBot', () => {
    it('userId의 봇을 조회해 200으로 반환한다', async () => {
      req = { userId: 2 };
      const mockDecimal = (v: string) => ({ toString: () => v });
      (arbService.getBot as jest.Mock).mockResolvedValueOnce({
        id: 1, userId: 2, enabled: true, killSwitch: false,
        totalProfitUsd: mockDecimal('0'),
        perCoinMinUsd: mockDecimal('10'),
        perCoinMaxUsd: mockDecimal('500'),
      });

      await getBot(req as AuthRequest, res as Response, next);

      expect(arbService.getBot).toHaveBeenCalledWith(2);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ id: 1, enabled: true }));
    });

    it('봇이 없으면 200 + 빈 객체를 반환한다', async () => {
      req = { userId: 2 };
      (arbService.getBot as jest.Mock).mockResolvedValueOnce(null);

      await getBot(req as AuthRequest, res as Response, next);

      expect(jsonMock).toHaveBeenCalledWith({});
    });

    it('서비스 에러 시 next(error)를 호출한다', async () => {
      req = { userId: 2 };
      const err = new Error('DB down');
      (arbService.getBot as jest.Mock).mockRejectedValueOnce(err);

      await getBot(req as AuthRequest, res as Response, next);

      expect(next).toHaveBeenCalledWith(err);
    });

    it('Decimal 필드를 string으로 직렬화한다', async () => {
      req = { userId: 2 };
      // Prisma Decimal mock — toString() 메서드를 가진 객체로 시뮬레이션
      const mockDecimal = (v: string) => ({ toString: () => v });
      (arbService.getBot as jest.Mock).mockResolvedValueOnce({
        id: 1, userId: 2, enabled: true, killSwitch: false,
        totalProfitUsd: mockDecimal('0.000000'),
        perCoinMinUsd: mockDecimal('10.00'),
        perCoinMaxUsd: mockDecimal('500.00'),
      });

      await getBot(req as AuthRequest, res as Response, next);

      const sent = jsonMock.mock.calls[0][0];
      expect(sent.totalProfitUsd).toBe('0.000000');
      expect(sent.perCoinMinUsd).toBe('10.00');
      expect(sent.perCoinMaxUsd).toBe('500.00');
    });
  });

  describe('getOrderbooks', () => {
    it('upbit-price-manager의 OrderbookTop Map을 KRW- 제거 + 평탄화한 형식으로 변환해 반환한다', async () => {
      // 실제 upbit-price-manager.getAllStablecoinOrderbooks()의 시그니처:
      //   Map<string("KRW-XXX"), OrderbookTop({ market, bid:{price,size}, ask:{price,size}, timestamp })>
      // 프론트 위젯 기대 형식:
      //   { [coin("XXX")]: { bid:number, ask:number, bidSize:number, askSize:number } }
      const mockMap: Map<string, OrderbookTop> = new Map([
        [
          'KRW-USDT',
          {
            market: 'KRW-USDT',
            bid: { price: 1486, size: 100 },
            ask: { price: 1487, size: 200 },
            timestamp: 1714123456789,
          },
        ],
        [
          'KRW-USDC',
          {
            market: 'KRW-USDC',
            bid: { price: 1485, size: 50 },
            ask: { price: 1488, size: 75 },
            timestamp: 1714123456999,
          },
        ],
      ]);
      (priceManager.getAllStablecoinOrderbooks as jest.Mock).mockReturnValueOnce(mockMap);

      await getOrderbooks(req as AuthRequest, res as Response, next);

      // KRW- prefix 제거 + bid/ask 평탄화 검증
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          updatedAt: expect.any(String),
          books: {
            USDT: { bid: 1486, ask: 1487, bidSize: 100, askSize: 200 },
            USDC: { bid: 1485, ask: 1488, bidSize: 50, askSize: 75 },
          },
        })
      );
      // Map이 plain object로 변환됐는지 명시 검증 (JSON 직렬화 호환)
      const sent = jsonMock.mock.calls[0][0];
      expect(sent.books).not.toBeInstanceOf(Map);
      expect(Object.keys(sent.books).sort()).toEqual(['USDC', 'USDT']);
    });

    it('빈 Map 캐시여도 정상 응답한다', async () => {
      (priceManager.getAllStablecoinOrderbooks as jest.Mock).mockReturnValueOnce(new Map());

      await getOrderbooks(req as AuthRequest, res as Response, next);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ books: {} })
      );
    });

    it('priceManager 에러 시 next(error)를 호출한다', async () => {
      const err = new Error('cache not ready');
      (priceManager.getAllStablecoinOrderbooks as jest.Mock).mockImplementationOnce(() => {
        throw err;
      });

      await getOrderbooks(req as AuthRequest, res as Response, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe('getOpportunityStats', () => {
    it('서비스 결과를 그대로 반환한다', async () => {
      (arbService.getOpportunityStats as jest.Mock).mockResolvedValueOnce({
        total: 373, last24h: 370, last1h: 0, ge20bpLast24h: 19,
      });

      await getOpportunityStats(req as AuthRequest, res as Response, next);

      expect(jsonMock).toHaveBeenCalledWith({
        total: 373, last24h: 370, last1h: 0, ge20bpLast24h: 19,
      });
    });

    it('서비스 에러 시 next(error)를 호출한다', async () => {
      const err = new Error('DB');
      (arbService.getOpportunityStats as jest.Mock).mockRejectedValueOnce(err);

      await getOpportunityStats(req as AuthRequest, res as Response, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe('getRecentOpportunities', () => {
    it('limit 쿼리 파라미터를 서비스에 전달한다', async () => {
      req = { userId: 2, query: { limit: '20' } } as any;
      (arbService.listRecentOpportunities as jest.Mock).mockResolvedValueOnce([{
        id: 1n, soldCoin: 'USD1', boughtCoin: 'USDT', spreadBps: 20,
        bidSoldKrw: '1489', askBoughtKrw: '1486',
      }]);

      await getRecentOpportunities(req as AuthRequest, res as Response, next);

      expect(arbService.listRecentOpportunities).toHaveBeenCalledWith(20);
    });

    it('limit 미지정 시 default 20을 사용한다', async () => {
      req = { userId: 2, query: {} } as any;
      (arbService.listRecentOpportunities as jest.Mock).mockResolvedValueOnce([]);

      await getRecentOpportunities(req as AuthRequest, res as Response, next);

      expect(arbService.listRecentOpportunities).toHaveBeenCalledWith(20);
    });

    it('BigInt id를 string으로 직렬화해서 반환한다', async () => {
      req = { userId: 2, query: {} } as any;
      (arbService.listRecentOpportunities as jest.Mock).mockResolvedValueOnce([
        { id: 1234n, soldCoin: 'USD1', boughtCoin: 'USDT', spreadBps: 20,
          bidSoldKrw: '1489', askBoughtKrw: '1486' },
      ]);

      await getRecentOpportunities(req as AuthRequest, res as Response, next);

      const sent = jsonMock.mock.calls[0][0];
      expect(sent[0].id).toBe('1234');
    });
  });

  describe('getSimOverview', () => {
    it('서비스 결과를 BigInt 직렬화 후 반환한다', async () => {
      (arbService.getSimOverview as jest.Mock).mockResolvedValueOnce({
        bots: [
          { id: 1, makerCoin: 'USDS', takerCoin: 'USDT', bidOffsetKrw: -2, quantity: '10' },
        ],
        stats: { pending: 3, filled: 12, expired: 5, cancelled: 0, totalNetProfitKrw: '0' },
        recentTrades: [
          { id: 100n, botId: 1, status: 'PENDING', makerOrderPrice: 1482, netProfitKrw: null },
        ],
      });

      await getSimOverview(req as AuthRequest, res as Response, next);

      const sent = jsonMock.mock.calls[0][0];
      expect(sent.bots).toHaveLength(1);
      expect(sent.stats.pending).toBe(3);
      expect(sent.recentTrades[0].id).toBe('100');
    });
  });

  describe('postKillswitch', () => {
    it('enable=true 시 setKillSwitch(userId, true)를 호출한다', async () => {
      req = { userId: 2, body: { enable: true } } as any;
      const mockDecimal = (v: string) => ({ toString: () => v });
      (arbService.setKillSwitch as jest.Mock).mockResolvedValueOnce({
        id: 1, userId: 2, killSwitch: true,
        totalProfitUsd: mockDecimal('0'),
        perCoinMinUsd: mockDecimal('10'),
        perCoinMaxUsd: mockDecimal('500'),
      });

      await postKillswitch(req as AuthRequest, res as Response, next);

      expect(arbService.setKillSwitch).toHaveBeenCalledWith(2, true);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ killSwitch: true }));
    });

    it('enable=false 시 setKillSwitch(userId, false)를 호출한다', async () => {
      req = { userId: 2, body: { enable: false } } as any;
      const mockDecimal = (v: string) => ({ toString: () => v });
      (arbService.setKillSwitch as jest.Mock).mockResolvedValueOnce({
        id: 1, userId: 2, killSwitch: false,
        totalProfitUsd: mockDecimal('0'),
        perCoinMinUsd: mockDecimal('10'),
        perCoinMaxUsd: mockDecimal('500'),
      });

      await postKillswitch(req as AuthRequest, res as Response, next);

      expect(arbService.setKillSwitch).toHaveBeenCalledWith(2, false);
    });

    it('enable이 boolean이 아닌 경우 400 에러를 next로 전달한다', async () => {
      req = { userId: 2, body: { enable: 'true' } } as any;

      await postKillswitch(req as AuthRequest, res as Response, next);

      const err = (next as jest.Mock).mock.calls[0][0];
      expect(err.statusCode).toBe(400);
    });

    it('Prisma P2025 (Record not found) 시 404를 반환한다', async () => {
      req = { userId: 2, body: { enable: true } } as any;
      const prismaErr: any = new Error('not found');
      prismaErr.code = 'P2025';
      (arbService.setKillSwitch as jest.Mock).mockRejectedValueOnce(prismaErr);

      await postKillswitch(req as AuthRequest, res as Response, next);

      const err = (next as jest.Mock).mock.calls[0][0];
      expect(err.statusCode).toBe(404);
    });
  });
});
