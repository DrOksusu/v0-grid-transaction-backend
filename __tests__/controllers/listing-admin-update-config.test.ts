// listing-admin.controller updateAutoTradeConfig 핸들러 회귀 테스트
// — Task 11 frontend review에서 발견된 누락 4필드 (killSwitch/useTrailingStop/trailingStopPct/minTakerBalance)
//   가 destructure 후 service.updateConfig 호출까지 정상 전달되는지 잠금.
//   회귀 발생 시 프론트가 PUT body로 보낸 값이 silent하게 무시되어 UI/DB 불일치 사고 재발.

import type { Response } from 'express';
import type { AuthRequest } from '../../src/types';
import * as autoTraderModule from '../../src/services/listing-auto-trader.service';
import { updateAutoTradeConfig } from '../../src/controllers/listing-admin.controller';

jest.mock('../../src/services/listing-auto-trader.service', () => ({
  listingAutoTraderService: {
    updateConfig: jest.fn(),
  },
}));

describe('listing-admin.controller / updateAutoTradeConfig', () => {
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

  it('Task 11 누락 4필드 (killSwitch/useTrailingStop/trailingStopPct/minTakerBalance) 가 service.updateConfig 인자에 모두 포함된다', async () => {
    req = {
      body: {
        source: 'UPBIT',
        enabled: true,
        killSwitch: true,                    // ← 회귀 방지 대상
        amountKrw: 200000,
        useBinance: true,
        useBithumb: false,
        useMexc: false,
        useGateio: false,
        autoSellEnabled: true,
        takeProfitPct: 15,
        stopLossPct: 8,
        maxHoldMinutes: 20,
        useTrailingStop: true,               // ← 회귀 방지 대상
        trailingStopPct: 5,                  // ← 회귀 방지 대상
        minTakerBalance: 1000,               // ← 회귀 방지 대상
      },
    };
    (autoTraderModule.listingAutoTraderService.updateConfig as jest.Mock)
      .mockResolvedValueOnce({ source: 'UPBIT', enabled: true, killSwitch: true });

    await updateAutoTradeConfig(req as AuthRequest, res as Response, next);

    // service 호출 인자에 4개 누락 필드 모두 포함 확인
    expect(autoTraderModule.listingAutoTraderService.updateConfig).toHaveBeenCalledWith(
      'UPBIT',
      expect.objectContaining({
        enabled: true,
        killSwitch: true,
        amountKrw: 200000,
        useBinance: true,
        useBithumb: false,
        useMexc: false,
        useGateio: false,
        autoSellEnabled: true,
        takeProfitPct: 15,
        stopLossPct: 8,
        maxHoldMinutes: 20,
        useTrailingStop: true,
        trailingStopPct: 5,
        minTakerBalance: 1000,
      }),
    );
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('source=BITHUMB 분기 — service.updateConfig 첫 번째 인자가 BITHUMB로 전달된다', async () => {
    req = {
      body: { source: 'BITHUMB', killSwitch: false, useTrailingStop: false },
    };
    (autoTraderModule.listingAutoTraderService.updateConfig as jest.Mock)
      .mockResolvedValueOnce({ source: 'BITHUMB' });

    await updateAutoTradeConfig(req as AuthRequest, res as Response, next);

    expect(autoTraderModule.listingAutoTraderService.updateConfig).toHaveBeenCalledWith(
      'BITHUMB',
      expect.objectContaining({ killSwitch: false, useTrailingStop: false }),
    );
  });

  it('서비스 에러 시 next(error)를 호출한다', async () => {
    req = { body: { source: 'UPBIT', killSwitch: true } };
    const err = new Error('DB down');
    (autoTraderModule.listingAutoTraderService.updateConfig as jest.Mock)
      .mockRejectedValueOnce(err);

    await updateAutoTradeConfig(req as AuthRequest, res as Response, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});
