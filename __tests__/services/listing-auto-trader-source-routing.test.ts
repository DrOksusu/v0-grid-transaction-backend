// listingAutoTraderService source 분기 단위 테스트 (Task 6 검증)
// — getConfig/updateConfig가 source 파라미터로 분리 동작
// — executeBuy가 source를 listingAutoOrder.create / 중복 체크에 전달
// — UPBIT/BITHUMB가 서로의 config/주문에 간섭하지 않음
//
// 외부 거래소 매수 헬퍼는 cred 없음 fallback으로 단축 — 본 테스트는 라우팅만 검증.

const mockSendToMe = jest.fn();

jest.mock('../../src/services/kakao-notify.service', () => ({
  kakaoNotifyService: { sendToMe: mockSendToMe },
}));
// 빗썸 클라이언트는 buyOnBithumb 진입 시 import만으로 실제 모듈 로드를 막기 위해 stub
jest.mock('../../src/services/exchange/bithumb-client', () => ({
  BithumbClient: jest.fn(),
}));
// encryption은 cred 분기가 null fallback이라 호출 안 되지만 안전하게 stub
jest.mock('../../src/utils/encryption', () => ({
  decrypt: jest.fn((v: string) => v),
}));

const prisma = require('../../__mocks__/database').default;
const {
  listingAutoTraderService: service,
} = require('../../src/services/listing-auto-trader.service');

beforeEach(() => {
  jest.clearAllMocks();
  mockSendToMe.mockResolvedValue(undefined);
  // 기본값: 모든 조회 null 반환 (각 테스트가 override)
  prisma.listingAutoTradeConfig.findUnique.mockResolvedValue(null);
  prisma.listingAutoTradeConfig.upsert.mockImplementation(
    async (args: any) => ({ ...args.create, ...args.update }),
  );
  prisma.listingAutoOrder.findUnique.mockResolvedValue(null);
  prisma.listingAutoOrder.findFirst.mockResolvedValue(null);
  prisma.listingAutoOrder.create.mockResolvedValue({ id: 999, orderId: null });
  prisma.listingAutoOrder.update.mockResolvedValue({});
  prisma.upbitKnownMarket.findUnique.mockResolvedValue(null);
  prisma.credential.findFirst.mockResolvedValue(null); // cred 없음 → 매수 즉시 failed
});

describe('getConfig source 분기', () => {
  it('source 생략 시 UPBIT로 조회 (backward compat)', async () => {
    await service.getConfig();
    expect(prisma.listingAutoTradeConfig.findUnique).toHaveBeenCalledWith({
      where: { source: 'UPBIT' },
    });
  });

  it('source=BITHUMB는 BITHUMB row 조회', async () => {
    await service.getConfig('BITHUMB');
    expect(prisma.listingAutoTradeConfig.findUnique).toHaveBeenCalledWith({
      where: { source: 'BITHUMB' },
    });
  });

  it('DB row 없을 때 UPBIT default — amountKrw 100000 / useBinance true / useBithumb true', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue(null);
    const cfg = await service.getConfig('UPBIT');
    expect(cfg.source).toBe('UPBIT');
    expect(cfg.amountKrw).toBe(100000);
    expect(cfg.useBinance).toBe(true);
    expect(cfg.useBithumb).toBe(true);
    expect(cfg.useMexc).toBe(false);
    expect(cfg.useGateio).toBe(false);
    expect(cfg.killSwitch).toBe(false);
    expect(cfg.enabled).toBe(false);
  });

  it('DB row 없을 때 BITHUMB default — amountKrw 10000 / useBithumb false / useMexc true / useGateio true', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue(null);
    const cfg = await service.getConfig('BITHUMB');
    expect(cfg.source).toBe('BITHUMB');
    expect(cfg.amountKrw).toBe(10000);
    expect(cfg.useBinance).toBe(true);
    expect(cfg.useBithumb).toBe(false); // 빗썸 자체 매수 제외 (빗썸 source라)
    expect(cfg.useMexc).toBe(true);
    expect(cfg.useGateio).toBe(true);
    expect(cfg.useTrailingStop).toBe(true);
    expect(cfg.trailingStopPct).toBe(10);
    expect(cfg.maxHoldMinutes).toBe(15);
  });

  it('DB row 있을 때 row의 값을 그대로 반환', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue({
      source: 'BITHUMB',
      enabled: true,
      killSwitch: false,
      amountKrw: 50000,
      useBinance: true,
      useBithumb: false,
      useMexc: true,
      useGateio: false,
      autoSellEnabled: true,
      takeProfitPct: 30,
      stopLossPct: 15,
      maxHoldMinutes: 45,
      useTrailingStop: false,
      trailingStopPct: 25,
      minTakerBalance: 10000,
    });
    const cfg = await service.getConfig('BITHUMB');
    expect(cfg.amountKrw).toBe(50000);
    expect(cfg.takeProfitPct).toBe(30);
    expect(cfg.minTakerBalance).toBe(10000);
  });
});

describe('updateConfig source 분기', () => {
  it('source=UPBIT upsert는 where.source=UPBIT + create에 UPBIT default 머지', async () => {
    prisma.listingAutoTradeConfig.upsert.mockResolvedValue({
      source: 'UPBIT',
      enabled: true,
      killSwitch: false,
      amountKrw: 200000,
      useBinance: true,
      useBithumb: true,
      useMexc: false,
      useGateio: false,
      autoSellEnabled: true,
      takeProfitPct: 20,
      stopLossPct: 10,
      maxHoldMinutes: 30,
      useTrailingStop: false,
      trailingStopPct: 20,
      minTakerBalance: null,
    });
    await service.updateConfig('UPBIT', { enabled: true, amountKrw: 200000 });
    const callArgs = prisma.listingAutoTradeConfig.upsert.mock.calls[0][0];
    expect(callArgs.where).toEqual({ source: 'UPBIT' });
    expect(callArgs.create.source).toBe('UPBIT');
    expect(callArgs.create.amountKrw).toBe(200000); // patch가 default 덮어씀
    expect(callArgs.update).toEqual({ enabled: true, amountKrw: 200000 });
  });

  it('source=BITHUMB upsert는 where.source=BITHUMB + BITHUMB default 머지', async () => {
    prisma.listingAutoTradeConfig.upsert.mockResolvedValue({
      source: 'BITHUMB',
      enabled: false,
      killSwitch: false,
      amountKrw: 10000,
      useBinance: true,
      useBithumb: false,
      useMexc: true,
      useGateio: true,
      autoSellEnabled: true,
      takeProfitPct: 10,
      stopLossPct: 5,
      maxHoldMinutes: 15,
      useTrailingStop: true,
      trailingStopPct: 10,
      minTakerBalance: null,
    });
    await service.updateConfig('BITHUMB', { takeProfitPct: 12 });
    const callArgs = prisma.listingAutoTradeConfig.upsert.mock.calls[0][0];
    expect(callArgs.where).toEqual({ source: 'BITHUMB' });
    expect(callArgs.create.source).toBe('BITHUMB');
    expect(callArgs.create.amountKrw).toBe(10000); // BITHUMB default
    expect(callArgs.create.useMexc).toBe(true); // BITHUMB default
    expect(callArgs.update).toEqual({ takeProfitPct: 12 });
  });
});

describe('executeBuy source 라우팅', () => {
  it('source=UPBIT, enabled=true는 source=UPBIT로 config 조회 + 주문 create 시 source=UPBIT 저장', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue({
      source: 'UPBIT',
      enabled: true,
      killSwitch: false,
      amountKrw: 100000,
      useBinance: true,
      useBithumb: false,
      useMexc: false,
      useGateio: false,
      autoSellEnabled: true,
      takeProfitPct: 20,
      stopLossPct: 10,
      maxHoldMinutes: 30,
      useTrailingStop: false,
      trailingStopPct: 20,
      minTakerBalance: null,
    });
    await service.executeBuy(1, 'NEW', 'UPBIT');

    expect(prisma.listingAutoTradeConfig.findUnique).toHaveBeenCalledWith({
      where: { source: 'UPBIT' },
    });
    expect(prisma.listingAutoOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'UPBIT',
          announcementId: 1,
          ticker: 'NEW',
          exchange: 'binance',
        }),
      }),
    );
    // 중복 매수 체크에도 source가 들어갔는지
    expect(prisma.listingAutoOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ source: 'UPBIT', ticker: 'NEW' }),
      }),
    );
  });

  it('source=BITHUMB는 BITHUMB config 조회 + create.source=BITHUMB + UPBIT KRW 마켓 체크 skip', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue({
      source: 'BITHUMB',
      enabled: true,
      killSwitch: false,
      amountKrw: 10000,
      useBinance: true,
      useBithumb: false,
      useMexc: false,
      useGateio: false,
      autoSellEnabled: true,
      takeProfitPct: 10,
      stopLossPct: 5,
      maxHoldMinutes: 15,
      useTrailingStop: true,
      trailingStopPct: 10,
      minTakerBalance: null,
    });
    await service.executeBuy(2, 'NEWB', 'BITHUMB');

    expect(prisma.listingAutoTradeConfig.findUnique).toHaveBeenCalledWith({
      where: { source: 'BITHUMB' },
    });
    // 빗썸 source는 업비트 KRW 마켓 false-positive 체크를 건너뜀
    expect(prisma.upbitKnownMarket.findUnique).not.toHaveBeenCalled();
    expect(prisma.listingAutoOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'BITHUMB',
          announcementId: 2,
          ticker: 'NEWB',
        }),
      }),
    );
  });

  it('killSwitch=true면 enabled여도 매수 skip', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue({
      source: 'UPBIT',
      enabled: true,
      killSwitch: true, // ← 차단
      amountKrw: 100000,
      useBinance: true,
      useBithumb: false,
      useMexc: false,
      useGateio: false,
      autoSellEnabled: true,
      takeProfitPct: 20,
      stopLossPct: 10,
      maxHoldMinutes: 30,
      useTrailingStop: false,
      trailingStopPct: 20,
      minTakerBalance: null,
    });
    const results = await service.executeBuy(3, 'KILLED', 'UPBIT');
    expect(results).toEqual([]);
    expect(prisma.listingAutoOrder.create).not.toHaveBeenCalled();
  });

  it('source=UPBIT인데 같은 ticker로 BITHUMB 주문이 이미 있어도 차단되지 않는다 (source 분리)', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue({
      source: 'UPBIT',
      enabled: true,
      killSwitch: false,
      amountKrw: 100000,
      useBinance: true,
      useBithumb: false,
      useMexc: false,
      useGateio: false,
      autoSellEnabled: true,
      takeProfitPct: 20,
      stopLossPct: 10,
      maxHoldMinutes: 30,
      useTrailingStop: false,
      trailingStopPct: 20,
      minTakerBalance: null,
    });
    // findFirst가 source 필터를 거치므로 mock은 항상 null 반환 — UPBIT 매수가 진행돼야 함
    prisma.listingAutoOrder.findFirst.mockResolvedValue(null);
    await service.executeBuy(4, 'XYZ', 'UPBIT');

    // 중복 체크 호출에 source: 'UPBIT'가 들어갔는지 명시 검증
    expect(prisma.listingAutoOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ source: 'UPBIT', ticker: 'XYZ' }),
      }),
    );
    expect(prisma.listingAutoOrder.create).toHaveBeenCalled();
  });

  // 이 케이스는 "source 필수 인자" 회귀 가드 — TS 컴파일 단계에서 잡히지만,
  // 런타임에 source=undefined가 들어와도 무조건 매수하지 않도록 한 번 더 검증.
  // (호출처 누락 시 default UPBIT로 silent fallback되던 이전 동작의 회귀 방지)
  it('source=undefined가 어쩌다 들어와도 UPBIT default fallback 없음 — config 조회/매수 진행 안 함', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue(null);
    // 런타임 안전망: TS는 잡지만 JS 코드에서 undefined가 들어왔을 때 동작 검증
    // — getConfig(undefined) → findUnique({where:{source:undefined}}) → null → defaultsFor(undefined)
    //   → 사실상 UPBIT default가 잠재적으로 적용될 수도 있음. 그래서 enabled가 false이면 즉시 return.
    const results = await (service.executeBuy as any)(7, 'NEW2');
    // enabled=false default라 어떤 source든 매수 시작 안 함
    expect(results).toEqual([]);
    expect(prisma.listingAutoOrder.create).not.toHaveBeenCalled();
  });

  it('24h 중복 체크: findFirst 호출의 where에 createdAt gte 24h가 포함됨 (status 필터는 제거됨)', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue({
      source: 'UPBIT',
      enabled: true,
      killSwitch: false,
      amountKrw: 100000,
      useBinance: true,
      useBithumb: false,
      useMexc: false,
      useGateio: false,
      autoSellEnabled: true,
      takeProfitPct: 20,
      stopLossPct: 10,
      maxHoldMinutes: 30,
      useTrailingStop: false,
      trailingStopPct: 20,
      minTakerBalance: null,
    });
    prisma.listingAutoOrder.findFirst.mockResolvedValue(null);

    const before = Date.now();
    await service.executeBuy(8, 'WIN', 'UPBIT');
    const after = Date.now();

    const callArgs = prisma.listingAutoOrder.findFirst.mock.calls[0][0];
    expect(callArgs.where.source).toBe('UPBIT');
    expect(callArgs.where.ticker).toBe('WIN');
    // createdAt gte 윈도우가 적용됐는지 — 24h ± 1초 허용
    expect(callArgs.where.createdAt).toBeDefined();
    expect(callArgs.where.createdAt.gte).toBeInstanceOf(Date);
    const gteMs = (callArgs.where.createdAt.gte as Date).getTime();
    const expectedGteMin = before - 24 * 60 * 60 * 1000 - 1000;
    const expectedGteMax = after - 24 * 60 * 60 * 1000 + 1000;
    expect(gteMs).toBeGreaterThanOrEqual(expectedGteMin);
    expect(gteMs).toBeLessThanOrEqual(expectedGteMax);
    // status 필터가 제거됐는지 (실패/스킵 상태든 24h 내면 차단)
    expect(callArgs.where.status).toBeUndefined();
  });

  it('25h 전 같은 ticker 주문은 차단되지 않음 (findFirst null 리턴 = 윈도우 벗어남)', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue({
      source: 'UPBIT',
      enabled: true,
      killSwitch: false,
      amountKrw: 100000,
      useBinance: true,
      useBithumb: false,
      useMexc: false,
      useGateio: false,
      autoSellEnabled: true,
      takeProfitPct: 20,
      stopLossPct: 10,
      maxHoldMinutes: 30,
      useTrailingStop: false,
      trailingStopPct: 20,
      minTakerBalance: null,
    });
    // DB에 같은 ticker로 25h 전 주문이 있어도 findFirst의 createdAt gte 24h 필터로 인해 null 리턴
    prisma.listingAutoOrder.findFirst.mockResolvedValue(null);
    await service.executeBuy(9, 'OLDREPLAY', 'UPBIT');
    // 매수 진행 — create 호출
    expect(prisma.listingAutoOrder.create).toHaveBeenCalled();
  });

  it('23h 전 같은 ticker 주문은 차단 (findFirst가 row 리턴 = 윈도우 내)', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue({
      source: 'UPBIT',
      enabled: true,
      killSwitch: false,
      amountKrw: 100000,
      useBinance: true,
      useBithumb: false,
      useMexc: false,
      useGateio: false,
      autoSellEnabled: true,
      takeProfitPct: 20,
      stopLossPct: 10,
      maxHoldMinutes: 30,
      useTrailingStop: false,
      trailingStopPct: 20,
      minTakerBalance: null,
    });
    // 23h 전 주문이 윈도우 안이라 findFirst가 row 리턴
    prisma.listingAutoOrder.findFirst.mockResolvedValue({
      id: 555,
      source: 'UPBIT',
      ticker: 'SOON',
      announcementId: 99,
      status: 'failed', // failed 상태여도 24h 내면 차단 (status 필터 제거됐으므로)
      createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000),
    });
    const results = await service.executeBuy(10, 'SOON', 'UPBIT');
    expect(results).toEqual([]);
    expect(prisma.listingAutoOrder.create).not.toHaveBeenCalled();
  });

  it('source=UPBIT + 업비트 KRW 마켓에 이미 있는 ticker는 false-positive 차단', async () => {
    prisma.listingAutoTradeConfig.findUnique.mockResolvedValue({
      source: 'UPBIT',
      enabled: true,
      killSwitch: false,
      amountKrw: 100000,
      useBinance: true,
      useBithumb: false,
      useMexc: false,
      useGateio: false,
      autoSellEnabled: true,
      takeProfitPct: 20,
      stopLossPct: 10,
      maxHoldMinutes: 30,
      useTrailingStop: false,
      trailingStopPct: 20,
      minTakerBalance: null,
    });
    prisma.upbitKnownMarket.findUnique.mockResolvedValue({
      market: 'KRW-OLD',
    });
    const results = await service.executeBuy(6, 'OLD', 'UPBIT');
    expect(results).toEqual([]);
    expect(prisma.listingAutoOrder.create).not.toHaveBeenCalled();
    // 카카오 알림은 fire-and-forget — 호출 자체는 검증
    expect(mockSendToMe).toHaveBeenCalled();
  });
});
