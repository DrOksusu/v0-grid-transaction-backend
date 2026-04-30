import { stablecoinPrisma } from '../../__mocks__/database';
import { patchMakerBot } from '../../src/services/stablecoin-arb.service';

describe('patchMakerBot — lastResumeAt 자동 갱신', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseRow = {
    id: 1,
    userId: 100,
    enabled: false,
    killSwitch: false,
    live: false,
    makerCoin: 'USDS',
    takerCoin: 'USDT',
    bidOffsetKrw: 0,
    quantity: 10,
    minSpreadKrw: 12,
    lastResumeAt: null,
  };

  it('enabled false→true 전환 → lastResumeAt 자동 set', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: false,
    });
    (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
      lastResumeAt: new Date('2026-04-30T12:00:00Z'),
    });

    await patchMakerBot(1, 100, { enabled: true });

    const updateCall = (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.enabled).toBe(true);
    expect(updateCall.data.lastResumeAt).toBeInstanceOf(Date);
  });

  it('enabled true→true → lastResumeAt 미갱신', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
    });
    (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
    });

    await patchMakerBot(1, 100, { enabled: true });

    const updateCall = (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.lastResumeAt).toBeUndefined();
  });

  it('enabled true→false → lastResumeAt 미갱신', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
    });
    (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: false,
    });

    await patchMakerBot(1, 100, { enabled: false });

    const updateCall = (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.lastResumeAt).toBeUndefined();
  });

  it('bidOffsetKrw 단독 변경 → lastResumeAt 미갱신', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
    });
    (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
      bidOffsetKrw: 5,
    });

    await patchMakerBot(1, 100, { bidOffsetKrw: 5 });

    const updateCall = (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.lastResumeAt).toBeUndefined();
  });

  it('enabled false→true + bidOffsetKrw 동시 → lastResumeAt set', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: false,
    });
    (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
      bidOffsetKrw: 5,
    });

    await patchMakerBot(1, 100, { enabled: true, bidOffsetKrw: 5 });

    const updateCall = (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.lastResumeAt).toBeInstanceOf(Date);
  });

  it('ownership 미일치 → throw "Bot not found"', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce(null);

    await expect(patchMakerBot(1, 999, { enabled: true })).rejects.toThrow('Bot not found');
  });
});
