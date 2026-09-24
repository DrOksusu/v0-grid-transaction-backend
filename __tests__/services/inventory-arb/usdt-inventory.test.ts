import type { BookLevel } from '../../../src/services/multi-arb-types';

// ── runOnce/reconcile 배선 테스트용 의존성 mock (shouldExecute 순수 테스트엔 무영향) ──
jest.mock('../../../src/config/database', () => ({
  __esModule: true,
  default: {
    usdtInventoryArbTrade: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    usdtInventoryArbBot: { update: jest.fn() },
  },
}));
jest.mock('../../../src/services/kakao-notify.service', () => ({ kakaoNotifyService: { sendToMe: jest.fn() } }));
jest.mock('../../../src/services/admin-credentials', () => ({ getAdminCreds: jest.fn().mockResolvedValue({ apiKey: 'k', secretKey: 's' }) }));
jest.mock('../../../src/services/exchange/mexc-leg', () => ({ MexcLeg: jest.fn().mockImplementation(() => ({ __tag: 'mexc', getBalance: jest.fn().mockResolvedValue(100000) })) }));
jest.mock('../../../src/services/exchange/gate-leg', () => ({ GateLeg: jest.fn().mockImplementation(() => ({ __tag: 'gate', getBalance: jest.fn().mockResolvedValue(1000) })) }));
jest.mock('../../../src/services/multi-arb-depth.service', () => ({
  // vwapForNotional은 computeNet(→shouldExecute)이 실제로 사용하므로 원본 유지, fetch 2개만 mock
  ...jest.requireActual('../../../src/services/multi-arb-depth.service'),
  fetchGateioDepth: jest.fn(),
  fetchMexcDepth: jest.fn(),
}));
jest.mock('../../../src/services/inventory-arb/executor', () => ({ executeArb: jest.fn() }));

import { shouldExecute, GATE_FEE_BPS, MEXC_FEE_BPS, usdtInventoryService } from '../../../src/services/inventory-arb/usdt-inventory.service';
import mainPrisma from '../../../src/config/database';
import { kakaoNotifyService } from '../../../src/services/kakao-notify.service';
import { fetchGateioDepth, fetchMexcDepth } from '../../../src/services/multi-arb-depth.service';
import { executeArb } from '../../../src/services/inventory-arb/executor';

const db = mainPrisma as any;

const bot = {
  symbol: 'ALEO',
  thresholdPct: 2,
  orderUsdt: 10,
  killSwitch: false,
};

// 깊이 충분 + 순차익 넉넉(≈4%): threshold(2) + 수수료(0.3%)를 여유 있게 상회
const DEEP_GATE_ASK: BookLevel[] = [
  { price: 0.017, qty: 1000 },
  { price: 0.0171, qty: 1000 },
];
const DEEP_MEXC_BID: BookLevel[] = [
  { price: 0.0177, qty: 1000 }, // (0.0177-0.017)/0.017 ≈ 4.1% gross
  { price: 0.0176, qty: 1000 },
];

function baseInput(overrides: Partial<Parameters<typeof shouldExecute>[0]> = {}) {
  return {
    gateAsk: 0.017,
    gateBid: 0.0169,
    mexcAsk: 0.0178,
    mexcBid: 0.0177,
    gateAskLevels: DEEP_GATE_ASK,
    gateBidLevels: [{ price: 0.0169, qty: 1000 }],
    mexcAskLevels: [{ price: 0.0178, qty: 1000 }],
    mexcBidLevels: DEEP_MEXC_BID,
    gateAleoBalance: 100000, // dirB 매도측
    gateUsdtBalance: 1000, // dirA 매수측
    mexcAleoBalance: 100000, // dirA 매도측
    mexcUsdtBalance: 1000, // dirB 매수측
    bot,
    ...overrides,
  };
}

describe('shouldExecute (순수 판정 함수)', () => {
  it('정상(방향A, MEXC 비쌈): go:true, direction=buy_gate_sell_mexc, qty/prices 정확', () => {
    const r = shouldExecute(baseInput());
    expect(r.go).toBe(true);
    expect(r.direction).toBe('buy_gate_sell_mexc');
    expect(r.buyExchange).toBe('gateio');
    expect(r.sellExchange).toBe('mexc');
    // qty = floor(orderUsdt / gateAsk) = floor(10 / 0.017) = 588
    expect(r.qty).toBe(Math.floor(10 / 0.017));
    expect(r.buyPrice).toBe(0.017); // Gate ask
    expect(r.sellPrice).toBe(0.0177); // MEXC bid
    expect(r.flattenRefPrice).toBe(0.0178); // MEXC ask
  });

  it('방향B(Gate 비쌈): go:true, direction=buy_mexc_sell_gate — Gate 매도 + MEXC 매수', () => {
    // Gate가 비싸도록: gateBid 0.0177(높음), mexcAsk 0.017(낮음). 매도측=Gate ALEO, 매수측=MEXC USDT.
    const r = shouldExecute(baseInput({
      gateAsk: 0.0181, gateBid: 0.0177, mexcAsk: 0.017, mexcBid: 0.0169,
      gateBidLevels: [{ price: 0.0177, qty: 1000 }, { price: 0.0176, qty: 1000 }],
      mexcAskLevels: [{ price: 0.017, qty: 1000 }, { price: 0.0171, qty: 1000 }],
    }));
    expect(r.go).toBe(true);
    expect(r.direction).toBe('buy_mexc_sell_gate');
    expect(r.buyExchange).toBe('mexc');
    expect(r.sellExchange).toBe('gateio');
    expect(r.qty).toBe(Math.floor(10 / 0.017)); // MEXC ask로 매수
    expect(r.buyPrice).toBe(0.017); // MEXC ask
    expect(r.sellPrice).toBe(0.0177); // Gate bid
    expect(r.flattenRefPrice).toBe(0.0181); // Gate ask
  });

  it('방향 역전(mexcBid <= gateAsk) → go:false, wrong_direction', () => {
    const r = shouldExecute(
      baseInput({
        gateAsk: 0.018,
        mexcBid: 0.0177, // MEXC가 더 쌈 — 재고 배치상 실행 불가 방향
      }),
    );
    expect(r.go).toBe(false);
    expect(r.reason).toBe('no_gap_or_wrong_direction');
  });

  it('방향 동일가(mexcBid === gateAsk) → go:false (경계는 실행 불가)', () => {
    const r = shouldExecute(baseInput({ gateAsk: 0.0177, mexcBid: 0.0177 }));
    expect(r.go).toBe(false);
    expect(r.reason).toBe('no_gap_or_wrong_direction');
  });

  it('순차익 미달(임계 상향) → go:false, net_spread_below_threshold', () => {
    // gross ≈ 4.1%인데 threshold를 10%로 올리면 미달
    const r = shouldExecute(baseInput({ bot: { ...bot, thresholdPct: 10 } }));
    expect(r.go).toBe(false);
    expect(r.reason).toBe('net_spread_below_threshold');
  });

  it('갭이 수수료(0.3%)만 겨우 넘고 임계(2%) 미달인 좁은 스프레드 → go:false', () => {
    // gross ≈ 0.5%: (0.01709-0.017)/0.017 ≈ 0.53% < threshold 2%
    const r = shouldExecute(
      baseInput({
        gateAsk: 0.017,
        gateAskLevels: [{ price: 0.017, qty: 1000 }],
        mexcBid: 0.01709,
        mexcBidLevels: [{ price: 0.01709, qty: 1000 }],
      }),
    );
    expect(r.go).toBe(false);
    expect(r.reason).toBe('net_spread_below_threshold');
  });

  it('깊이 부족(주문 규모를 못 채움) → go:false, depth_insufficient', () => {
    const r = shouldExecute(
      baseInput({
        gateAskLevels: [{ price: 0.017, qty: 0.001 }], // orderUsdt=10 못 채움
        mexcBidLevels: [{ price: 0.0177, qty: 0.001 }],
      }),
    );
    expect(r.go).toBe(false);
    expect(r.reason).toBe('depth_insufficient');
  });

  it('안정 재고량으로 거래량 캡: 안정 ALEO 200 < 목표 588 → qty=200으로 축소 실행', () => {
    // mexcAleoBalance(=매도측 안정 재고량) 200. 목표 qty=floor(10/0.017)=588. min(588,200)=200.
    const r = shouldExecute(baseInput({ mexcAleoBalance: 200 }));
    expect(r.go).toBe(true);
    expect(r.qty).toBe(200); // 안정분까지만
    expect(r.direction).toBe('buy_gate_sell_mexc');
  });

  it('안정 재고 0(60초 관측 전 or 드레인) → go:false, inventory_not_stable', () => {
    const r = shouldExecute(baseInput({ mexcAleoBalance: 0 }));
    expect(r.go).toBe(false);
    expect(r.reason).toBe('inventory_not_stable');
  });

  it('캡 후 규모가 최소주문(3 USDT) 미만 → go:false, notional_below_min_order', () => {
    // 안정 ALEO 10 → qty=10, notional=10*0.017=0.17 USDT < 3
    const r = shouldExecute(baseInput({ mexcAleoBalance: 10 }));
    expect(r.go).toBe(false);
    expect(r.reason).toBe('notional_below_min_order');
  });

  it('매수측 현금 부족(방향A Gate USDT < 실제 규모) → go:false, buy_cash_insufficient (stop 없음)', () => {
    const r = shouldExecute(baseInput({ gateUsdtBalance: 1 })); // notional≈10 > 1
    expect(r.go).toBe(false);
    expect(r.reason).toBe('buy_cash_insufficient');
  });

  it('killSwitch=true → go:false, kill_switch', () => {
    const r = shouldExecute(baseInput({ bot: { ...bot, killSwitch: true } }));
    expect(r.go).toBe(false);
    expect(r.reason).toBe('kill_switch');
  });

  it('qty가 최소 base 단위(1) 미만이면 go:false', () => {
    // orderUsdt=10, gateAsk=20 → floor(10/20)=0 < 1. mexcBid도 방향 게이트를 통과하도록 비례 상향.
    const r = shouldExecute(
      baseInput({
        gateAsk: 20,
        gateAskLevels: [{ price: 20, qty: 1000 }],
        mexcBid: 21,
        mexcBidLevels: [{ price: 21, qty: 1000 }],
      }),
    );
    expect(r.go).toBe(false);
    expect(r.reason).toBe('order_too_small');
  });

  it('수수료 상수 확인 (Gate taker 0.2% / MEXC taker 0.1%)', () => {
    expect(GATE_FEE_BPS).toBe(20);
    expect(MEXC_FEE_BPS).toBe(10);
  });
});

describe('reconcileOrphans (크래시 고아 복구, critic #1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.usdtInventoryArbTrade.updateMany.mockResolvedValue({ count: 0 });
    db.usdtInventoryArbBot.update.mockResolvedValue({});
    (kakaoNotifyService.sendToMe as jest.Mock).mockResolvedValue(undefined);
  });

  it('detected 고아 행 발견 → 해당 봇 killSwitch+정지 + 긴급 카톡 + 터미널 마킹', async () => {
    db.usdtInventoryArbTrade.findMany.mockImplementation(({ where }: any) =>
      where.status === 'detected'
        ? Promise.resolve([{ botId: 1, symbol: 'ALEO' }, { botId: 1, symbol: 'ALEO' }, { botId: 2, symbol: 'ALEO' }])
        : Promise.resolve([]),
    );
    await usdtInventoryService.reconcileOrphans();
    // 봇 1, 2 각각 killSwitch+정지
    const botUpdates = db.usdtInventoryArbBot.update.mock.calls;
    expect(botUpdates).toHaveLength(2);
    expect(botUpdates.every((c: any[]) => c[0].data.killSwitch === true && c[0].data.enabled === false)).toBe(true);
    // 봇별 긴급 카톡 2회
    expect((kakaoNotifyService.sendToMe as jest.Mock)).toHaveBeenCalledTimes(2);
    // 재집계·재알림 방지 마킹
    expect(db.usdtInventoryArbTrade.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'detected' }, data: expect.objectContaining({ status: 'orphan_reconciled' }) }),
    );
  });

  it('고아 없음 → 아무 것도 안 함(정지/알림 없음)', async () => {
    db.usdtInventoryArbTrade.findMany.mockResolvedValue([]);
    await usdtInventoryService.reconcileOrphans();
    expect(db.usdtInventoryArbBot.update).not.toHaveBeenCalled();
    expect(kakaoNotifyService.sendToMe).not.toHaveBeenCalled();
    expect(db.usdtInventoryArbTrade.updateMany).not.toHaveBeenCalled();
  });
});

describe('runOnce 배선 (critic #2 — 방향 보장)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 일일 사용량 조회(fetchTodayUsage) → 빈 값(한도 여유)
    db.usdtInventoryArbTrade.findMany.mockResolvedValue([]);
    db.usdtInventoryArbTrade.create.mockResolvedValue({ id: 99 });
    db.usdtInventoryArbTrade.update.mockResolvedValue({});
    db.usdtInventoryArbBot.update.mockResolvedValue({});
    // 깊이: Gate ask 0.017 / MEXC bid 0.0177 (갭 ≈4%), MEXC ask 0.0178
    (fetchGateioDepth as jest.Mock).mockResolvedValue({ askLevels: DEEP_GATE_ASK, bidLevels: [{ price: 0.0169, qty: 1000 }] });
    (fetchMexcDepth as jest.Mock).mockResolvedValue({ askLevels: [{ price: 0.0178, qty: 1000 }], bidLevels: DEEP_MEXC_BID });
    (executeArb as jest.Mock).mockResolvedValue({ kind: 'filled', buyQty: 588, sellQty: 588, buyGrossKrw: 10, sellGrossKrw: 10.4, feeKrw: 0.03, netKrw: 0.37, note: 'ok' });
  });

  it('executeArb에 buyLeg=Gate, sellLeg=MEXC, flattenBuyRefPrice=mexcAsk 전달', async () => {
    const liveBot = { id: 7, symbol: 'ALEO', thresholdPct: 2, orderUsdt: 10, autoExecute: true, enabled: true, killSwitch: false, dailyMaxCount: 200, dailyMaxLossUsdt: 5, inventoryStableSec: 0 };
    await usdtInventoryService.runOnce(liveBot as any);
    expect(executeArb as jest.Mock).toHaveBeenCalledTimes(1);
    const arg = (executeArb as jest.Mock).mock.calls[0][0];
    expect(arg.buyLeg.__tag).toBe('gate');   // Gate에서 매수(USDT 지출)
    expect(arg.sellLeg.__tag).toBe('mexc');  // MEXC에서 매도(ALEO)
    expect(arg.flattenBuyRefPrice).toBeCloseTo(0.0178, 6); // MEXC ask
    expect(arg.minOrderQuote).toBe(3);
    // 기록 방향 정합
    const created = (db.usdtInventoryArbTrade.create as jest.Mock).mock.calls[0][0].data;
    expect(created.buyExchange).toBe('gateio');
    expect(created.sellExchange).toBe('mexc');
  });

  it('방향B(Gate 비쌈): executeArb에 buyLeg=MEXC, sellLeg=Gate, flattenBuyRefPrice=gateAsk 전달', async () => {
    // Gate가 비싸도록 호가 반전: Gate bid 0.0177(높음) / MEXC ask 0.017(낮음) → 방향B
    (fetchGateioDepth as jest.Mock).mockResolvedValue({
      askLevels: [{ price: 0.0181, qty: 1000 }, { price: 0.0182, qty: 1000 }],
      bidLevels: [{ price: 0.0177, qty: 1000 }, { price: 0.0176, qty: 1000 }],
    });
    (fetchMexcDepth as jest.Mock).mockResolvedValue({
      askLevels: [{ price: 0.017, qty: 1000 }, { price: 0.0171, qty: 1000 }],
      bidLevels: [{ price: 0.0169, qty: 1000 }, { price: 0.0168, qty: 1000 }],
    });
    const liveBot = { id: 9, symbol: 'ALEO', thresholdPct: 2, orderUsdt: 10, autoExecute: true, enabled: true, killSwitch: false, dailyMaxCount: 200, dailyMaxLossUsdt: 5, inventoryStableSec: 0 };
    await usdtInventoryService.runOnce(liveBot as any);
    expect(executeArb as jest.Mock).toHaveBeenCalledTimes(1);
    const arg = (executeArb as jest.Mock).mock.calls[0][0];
    expect(arg.buyLeg.__tag).toBe('mexc');   // MEXC에서 매수(USDT 지출)
    expect(arg.sellLeg.__tag).toBe('gate');  // Gate에서 매도(ALEO)
    expect(arg.flattenBuyRefPrice).toBeCloseTo(0.0181, 6); // Gate ask
    expect(arg.minOrderQuote).toBe(3);
    const created = (db.usdtInventoryArbTrade.create as jest.Mock).mock.calls[0][0].data;
    expect(created.buyExchange).toBe('mexc');
    expect(created.sellExchange).toBe('gateio');
  });

  it('autoExecute=false면 executeArb 절대 호출 안 함(반자동)', async () => {
    const semiBot = { id: 8, symbol: 'ALEO', thresholdPct: 2, orderUsdt: 10, autoExecute: false, enabled: true, killSwitch: false, dailyMaxCount: 200, dailyMaxLossUsdt: 5, inventoryStableSec: 0 };
    await usdtInventoryService.runOnce(semiBot as any);
    expect(executeArb as jest.Mock).not.toHaveBeenCalled();
  });
});
