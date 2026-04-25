import type { Response } from 'express';
import type { AuthRequest } from '../../src/types';
import * as arbService from '../../src/services/stablecoin-arb.service';
import * as priceManager from '../../src/services/upbit-price-manager';
import {
  getBot,
  getOrderbooks,
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
      (arbService.getBot as jest.Mock).mockResolvedValueOnce({
        id: 1, userId: 2, enabled: true, killSwitch: false,
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
  });

  describe('getOrderbooks', () => {
    it('upbit-price-manager 캐시 결과를 updatedAt과 함께 반환한다', async () => {
      (priceManager.getAllStablecoinOrderbooks as jest.Mock).mockReturnValueOnce({
        USDT: { bid: 1486, ask: 1487, bidSize: 100, askSize: 200 },
        USDC: { bid: 1486, ask: 1487, bidSize: 50, askSize: 75 },
      });

      await getOrderbooks(req as AuthRequest, res as Response, next);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          updatedAt: expect.any(String),
          books: expect.objectContaining({
            USDT: expect.objectContaining({ bid: 1486 }),
          }),
        })
      );
    });

    it('캐시가 빈 객체여도 정상 응답한다', async () => {
      (priceManager.getAllStablecoinOrderbooks as jest.Mock).mockReturnValueOnce({});

      await getOrderbooks(req as AuthRequest, res as Response, next);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ books: {} })
      );
    });
  });
});
