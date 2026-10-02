// 쿨다운(30분) + 발송 성공 시에만 notifiedAt 갱신 검증 (spec §5 step 6, §8, §9, §11)
import prisma from '../../__mocks__/database';
import { multiArbNotifierService, buildAlertMessage, evaluateInventoryGate } from '../../src/services/multi-arb-notifier.service';
import { kakaoNotifyService } from '../../src/services/kakao-notify.service';
import { SpreadCandidate, FeasibilityResult, NetResult } from '../../src/services/multi-arb-types';

jest.mock('../../src/services/kakao-notify.service', () => ({
  kakaoNotifyService: { sendToMe: jest.fn() },
}));
const mockedSend = kakaoNotifyService.sendToMe as jest.Mock;
const db = prisma as any;

const cand: SpreadCandidate = {
  symbol: 'WLD',
  currencyZone: 'KRW',
  buyExchange: 'bithumb',
  buyPrice: 4200,
  askPrice: 4200,
  sellExchange: 'upbit',
  sellPrice: 4340,
  bidPrice: 4340,
  spreadPct: 3.33,
};

const feasible: FeasibilityResult = {
  feasibility: 'feasible',
  networkMatch: true,
  matchedNetwork: 'ETH',
  note: '네트워크 일치(ETH) · 양쪽 입출금 정상',
};

// 순차익 결과 픽스처 (2026-09-22 개편) — 정상 케이스: 깊이 충족 + 출금료 정률 1% 확인
const net: NetResult = {
  filledNotional: 100000,
  depthOk: true,
  buyVwap: 4200,
  sellVwap: 4340,
  grossSpreadPct: 3.33,
  tradingFeePct: 0.1,
  withdrawFeePct: 1,
  withdrawFeeKnown: true,
  netSpreadPct: 2.23,
  maxExecBuyNotional: 1500000,
  maxExecSellNotional: 1533450,
  maxExecDepthLimited: false,
};

describe('multiArbNotifierService.notify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.multiArbOpportunity.findFirst.mockResolvedValue(null);
    db.multiArbOpportunity.create.mockResolvedValue({ id: 1 });
    db.multiArbOpportunity.update.mockResolvedValue({ id: 1 });
    mockedSend.mockResolvedValue(undefined);
  });

  it('쿨다운 없음 → DB 기록 + 카톡 발송 + notifiedAt 갱신', async () => {
    const sent = await multiArbNotifierService.notify(cand, feasible, 0.8, net);
    expect(sent).toBe(true);
    expect(db.multiArbOpportunity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        symbol: 'WLD',
        currencyZone: 'KRW',
        buyExchange: 'bithumb',
        buyPrice: 4200,
        sellExchange: 'upbit',
        sellPrice: 4340,
        spreadPct: 3.33,
        feasibility: 'feasible',
        networkMatch: true,
        matchedNetwork: 'ETH',
        kimchiPct: 0.8,
        notifiedAt: null,
      }),
    });
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(db.multiArbOpportunity.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { notifiedAt: expect.any(Date) },
    });
  });

  it('30분 이내 동일 (symbol, currencyZone) 발송 이력 → 스킵 (기록/발송 안 함)', async () => {
    db.multiArbOpportunity.findFirst.mockResolvedValue({ id: 99, notifiedAt: new Date() });
    const sent = await multiArbNotifierService.notify(cand, feasible, null, net);
    expect(sent).toBe(false);
    expect(db.multiArbOpportunity.create).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    // 쿨다운 조회 조건 검증: notifiedAt 30분 윈도우 (첫 번째 findFirst 호출)
    expect(db.multiArbOpportunity.findFirst).toHaveBeenNthCalledWith(1, {
      where: {
        symbol: 'WLD',
        currencyZone: 'KRW',
        notifiedAt: { gte: expect.any(Date) },
      },
    });
  });

  // 기록 dedup: 알림 off라 notifiedAt이 채워지지 않는 기간에도 detectedAt 기준 30분 내 기존 행이 있으면 재사용
  it('detectedAt 30분 내 기존 행(notifiedAt=null) 있음 → create 없이 재사용, 발송/notifiedAt 갱신은 그 행에 적용', async () => {
    db.multiArbOpportunity.findFirst
      .mockResolvedValueOnce(null) // 1) 쿨다운 확인: 없음
      .mockResolvedValueOnce({ id: 42, notifiedAt: null }); // 2) 기록 dedup: 기존 행 재사용
    const sent = await multiArbNotifierService.notify(cand, feasible, 0.8, net);
    expect(sent).toBe(true);
    expect(db.multiArbOpportunity.create).not.toHaveBeenCalled();
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(db.multiArbOpportunity.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { notifiedAt: expect.any(Date) },
    });
    // 기록 dedup 조회 조건: price_anomaly 제외, detectedAt 30분 윈도우
    expect(db.multiArbOpportunity.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        symbol: 'WLD',
        currencyZone: 'KRW',
        feasibility: { not: 'price_anomaly' },
        detectedAt: { gte: expect.any(Date) },
      },
    });
  });

  it('detectedAt 30분 지난 경우(기존 행 없음) → create 호출', async () => {
    db.multiArbOpportunity.findFirst
      .mockResolvedValueOnce(null) // 쿨다운 확인: 없음
      .mockResolvedValueOnce(null); // 기록 dedup: 없음 → create 필요
    const sent = await multiArbNotifierService.notify(cand, feasible, 0.8, net);
    expect(sent).toBe(true);
    expect(db.multiArbOpportunity.create).toHaveBeenCalledTimes(1);
  });

  it('카톡 발송 실패 → notifiedAt 미갱신 (다음 사이클 재시도, spec §9)', async () => {
    mockedSend.mockRejectedValue(new Error('kakao down'));
    const sent = await multiArbNotifierService.notify(cand, feasible, null, net);
    expect(sent).toBe(false);
    expect(db.multiArbOpportunity.create).toHaveBeenCalled();      // 기회 이력은 남김
    expect(db.multiArbOpportunity.update).not.toHaveBeenCalled();  // notifiedAt은 갱신 안 함
  });

  // I-1: 발송 게이트 — 게이트는 "카톡 발송"에만 적용, DB 기록·쿨다운 로직은 종전 유지
  it('send=false: 쿨다운 확인 + DB 기록은 수행, 카톡 발송·notifiedAt 갱신은 안 함 (I-1)', async () => {
    const sent = await multiArbNotifierService.notify(cand, feasible, 0.8, net, { send: false });
    expect(sent).toBe(false);
    expect(db.multiArbOpportunity.findFirst).toHaveBeenCalledTimes(2); // 쿨다운 확인 + 기록 dedup 확인(신규)
    expect(db.multiArbOpportunity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ symbol: 'WLD', feasibility: 'feasible', notifiedAt: null }),
    });
    expect(mockedSend).not.toHaveBeenCalled();                     // 카톡만 스킵
    expect(db.multiArbOpportunity.update).not.toHaveBeenCalled();  // notifiedAt=null 유지
  });

  it('send=false여도 쿨다운 이내면 DB 기록도 스킵 (쿨다운 로직 종전 유지)', async () => {
    db.multiArbOpportunity.findFirst.mockResolvedValue({ id: 99, notifiedAt: new Date() });
    const sent = await multiArbNotifierService.notify(cand, feasible, null, net, { send: false });
    expect(sent).toBe(false);
    expect(db.multiArbOpportunity.create).not.toHaveBeenCalled();
  });
});

// 재고 미보유 배제 게이트 판정 (순수함수)
describe('evaluateInventoryGate', () => {
  const MIN = 5000; // KRW권 최소주문

  it('토글 OFF면 재고와 무관하게 발송(exclude=false)', () => {
    expect(evaluateInventoryGate({ sellHeldValue: 0 }, false, MIN)).toEqual({ exclude: false, reason: 'toggle-off' });
    expect(evaluateInventoryGate(null, false, MIN)).toEqual({ exclude: false, reason: 'toggle-off' });
  });

  it('조회 실패(null)면 fail-open으로 발송 유지(exclude=false)', () => {
    expect(evaluateInventoryGate(null, true, MIN)).toEqual({ exclude: false, reason: 'query-failed' });
  });

  it('매도측 재고 가치가 최소주문 이상이면 발송(exclude=false)', () => {
    expect(evaluateInventoryGate({ sellHeldValue: 54250 }, true, MIN)).toEqual({ exclude: false, reason: 'has-sell-inventory' });
    expect(evaluateInventoryGate({ sellHeldValue: MIN }, true, MIN)).toEqual({ exclude: false, reason: 'has-sell-inventory' }); // 경계 포함
  });

  it('매도측 재고 없음(0)이고 토글 ON이면 제외(exclude=true)', () => {
    expect(evaluateInventoryGate({ sellHeldValue: 0 }, true, MIN)).toEqual({ exclude: true, reason: 'no-sell-inventory' });
  });

  it('dust 재고(가치 < 최소주문)는 제외 — 실행 불가라 카톡 노이즈 제거 (예: ARK 0.00000001×326≈0원)', () => {
    expect(evaluateInventoryGate({ sellHeldValue: 0.0000033 }, true, MIN)).toEqual({ exclude: true, reason: 'no-sell-inventory' });
    expect(evaluateInventoryGate({ sellHeldValue: 4999 }, true, MIN)).toEqual({ exclude: true, reason: 'no-sell-inventory' });
  });
});

// 재고 게이트가 notify() 발송 여부에 반영되는지 (기본 ON) — resolveHolding을 spy로 주입
describe('multiArbNotifierService.notify 재고 게이트', () => {
  let holdingSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    db.multiArbOpportunity.findFirst.mockResolvedValue(null);
    db.multiArbOpportunity.create.mockResolvedValue({ id: 1 });
    db.multiArbOpportunity.update.mockResolvedValue({ id: 1 });
    mockedSend.mockResolvedValue(undefined);
    delete process.env.MULTI_ARB_EXCLUDE_NO_INVENTORY; // 기본 ON
    holdingSpy = jest.spyOn(multiArbNotifierService as any, 'resolveHolding');
  });
  afterEach(() => {
    holdingSpy.mockRestore();
    delete process.env.MULTI_ARB_EXCLUDE_NO_INVENTORY;
  });

  it('매도측 재고 없음 → 카톡 스킵 + DB 기록은 유지 + notifiedAt 미갱신', async () => {
    holdingSpy.mockResolvedValue({ sellHeld: 0, buyHeld: 0 });
    const sent = await multiArbNotifierService.notify(cand, feasible, null, net);
    expect(sent).toBe(false);
    expect(db.multiArbOpportunity.create).toHaveBeenCalled();      // 기회 이력은 남김
    expect(mockedSend).not.toHaveBeenCalled();                     // 카톡만 스킵
    expect(db.multiArbOpportunity.update).not.toHaveBeenCalled();  // notifiedAt=null 유지 → 재고 생기면 재시도
  });

  it('ARK 시나리오: 매도측 dust(0.00000001) + 반대쪽(매수측) 보유 → 카톡 스킵 (실행 불가)', async () => {
    // 업비트(sell) ARK dust + 빗썸(buy) 다량 보유 → 매도측 가치 ≈ 0.00000001×4340 ≈ 0원 < 5000 → 제외
    holdingSpy.mockResolvedValue({ sellHeld: 0.00000001, buyHeld: 375.9 });
    const sent = await multiArbNotifierService.notify(cand, feasible, null, net);
    expect(sent).toBe(false);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('매도측 재고 보유 → 카톡 발송 + notifiedAt 갱신', async () => {
    holdingSpy.mockResolvedValue({ sellHeld: 10, buyHeld: 0 });
    const sent = await multiArbNotifierService.notify(cand, feasible, null, net);
    expect(sent).toBe(true);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(db.multiArbOpportunity.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { notifiedAt: expect.any(Date) } });
  });

  it('재고 조회 실패(throw) → fail-open으로 발송 유지', async () => {
    holdingSpy.mockRejectedValue(new Error('잔고 API 다운'));
    const sent = await multiArbNotifierService.notify(cand, feasible, null, net);
    expect(sent).toBe(true);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('토글 OFF(MULTI_ARB_EXCLUDE_NO_INVENTORY=false) → 재고 없어도 발송', async () => {
    process.env.MULTI_ARB_EXCLUDE_NO_INVENTORY = 'false';
    holdingSpy.mockResolvedValue({ sellHeld: 0, buyHeld: 0 });
    const sent = await multiArbNotifierService.notify(cand, feasible, null, net);
    expect(sent).toBe(true);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });
});

// I-2: price sanity 제외 건 DB 기록 (분석/티커충돌 수집용)
describe('multiArbNotifierService.recordPriceAnomaly', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.multiArbOpportunity.findFirst.mockResolvedValue(null);
    db.multiArbOpportunity.create.mockResolvedValue({ id: 1 });
    mockedSend.mockResolvedValue(undefined);
  });

  it('price_anomaly 태그 + notifiedAt=null로 기록하고 카톡은 발송하지 않는다', async () => {
    await multiArbNotifierService.recordPriceAnomaly(cand, '기준가 대비 이상(buy=mexc 3.48e-8x)');
    expect(db.multiArbOpportunity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        symbol: 'WLD',
        currencyZone: 'KRW',
        buyExchange: 'bithumb',
        sellExchange: 'upbit',
        spreadPct: 3.33,
        feasibility: 'price_anomaly',
        networkMatch: null,
        matchedNetwork: null,
        note: '기준가 대비 이상(buy=mexc 3.48e-8x)',
        notifiedAt: null,
      }),
    });
    expect(mockedSend).not.toHaveBeenCalled();
    expect(db.multiArbOpportunity.update).not.toHaveBeenCalled();
  });

  it('30분 내 동일 (symbol, zone) price_anomaly 기록이 있으면 중복 기록을 스킵한다', async () => {
    db.multiArbOpportunity.findFirst.mockResolvedValue({ id: 7 });
    await multiArbNotifierService.recordPriceAnomaly(cand, '이상치');
    expect(db.multiArbOpportunity.create).not.toHaveBeenCalled();
    expect(db.multiArbOpportunity.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        symbol: 'WLD',
        currencyZone: 'KRW',
        feasibility: 'price_anomaly',
        detectedAt: { gte: expect.any(Date) },
      }),
    });
  });
});

describe('buildAlertMessage', () => {
  it('feasible: 정상 기회 포맷 (spec §7) — 매수/매도/스프레드/네트워크/김프/면책 문구', () => {
    const msg = buildAlertMessage(cand, feasible, 0.8, net);
    expect(msg).toContain('🔔 차익 후보 (KRW권) · WLD');
    expect(msg).toContain('📉 매수 빗썸 매도호가(ask) 4,200');
    expect(msg).toContain('📈 매도 업비트 매수호가(bid) 4,340');
    expect(msg).toContain('+3.3%');
    expect(msg).toContain('✅ 네트워크 일치(ETH) · 양쪽 입출금 정상');
    expect(msg).toContain('참고 김프: 해외 대비 +0.8%');
    expect(msg).toContain('⚠️ 표시가 기준 · 실제 유동성/체결 확인 필요');
    // 2026-09-22 개편: 순차익/검증규모/출금료/네트워크/스냅샷 주의 문구
    expect(msg).toContain('순차익 +2.23%');
    expect(msg).toContain('10만원 깊이 확인 (충족)');
    expect(msg).toContain('출금료 1.00%');
    expect(msg).toContain('매칭 네트워크: ETH');
    expect(msg).toContain('전송에 수분~수시간 소요');
  });

  it('network_mismatch: 함정 경고 포맷 (spec §7 LSK류)', () => {
    const lsk: SpreadCandidate = {
      symbol: 'LSK', currencyZone: 'KRW',
      buyExchange: 'upbit', buyPrice: 533, askPrice: 533,
      sellExchange: 'bithumb', sellPrice: 1322, bidPrice: 1322,
      spreadPct: 148.03,
    };
    const mismatch: FeasibilityResult = {
      feasibility: 'network_mismatch', networkMatch: false, matchedNetwork: null,
      note: '전송불가: 네트워크 불일치(업비트 LSK망 ↔ 빗썸 ETH망)',
    };
    // 함정 경고 케이스: 출금료 미확인(H1 보수적 폴백 1% 반영) + 깊이 미충족 픽스처 (은폐 금지 문구 검증)
    const unverifiedNet: NetResult = {
      filledNotional: 0, depthOk: false, buyVwap: 0, sellVwap: 0,
      grossSpreadPct: 0, tradingFeePct: 0, withdrawFeePct: 1,
      withdrawFeeKnown: false, netSpreadPct: -1,
      maxExecBuyNotional: 0, maxExecSellNotional: 0, maxExecDepthLimited: false,
    };
    const msg = buildAlertMessage(lsk, mismatch, null, unverifiedNet);
    expect(msg).toContain('⚠️ 차익 후보(주의) · LSK');
    expect(msg).toContain('매수 업비트 매도호가 533 → 매도 빗썸 매수호가 1,322 (+148%)');
    expect(msg).toContain('⛔ 전송불가: 네트워크 불일치');
    expect(msg).toContain('→ 실현 어려움. 정보용 참고');
    expect(msg).toContain('⚠️ 표시가 기준 · 실제 유동성/체결 확인 필요');
    expect(msg).toContain('출금료 미확인 — 보수적 1.00% 가정');
    expect(msg).toContain('⚠️ 미충족');
  });

  it('김프 null이면 김프 줄을 생략한다', () => {
    const msg = buildAlertMessage(cand, feasible, null, net);
    expect(msg).not.toContain('참고 김프');
  });
});

describe('buildAlertMessage extra 라인 (보유/빈도)', () => {
  const { buildAlertMessage } = require('../../src/services/multi-arb-notifier.service');
  const cand: any = {
    symbol: 'META2', currencyZone: 'KRW', buyExchange: 'bithumb', sellExchange: 'upbit',
    buyPrice: 8770, sellPrice: 9000, spreadPct: 2.6,
  };
  const feas: any = { feasibility: 'feasible', note: '네트워크 일치(SOL) · 양쪽 입출금 정상', networkMatch: true, matchedNetwork: 'SOL' };
  const net: any = {
    netSpreadPct: 1.37, depthOk: true, withdrawFeeKnown: true, withdrawFeePct: 1,
    maxExecBuyNotional: 208826, maxExecSellNotional: 213211, maxExecDepthLimited: false,
  };

  it('extra 제공 시 보유/빈도 라인 포함', () => {
    const msg = buildAlertMessage(cand, feas, null, net, {
      holdingLine: '👛 미보유 — 재고형(로밍) 실행 불가, 전송 차익만 가능',
      freqLine: '📊 최근 30일 5회 감지 (평균 +1.4%)',
    });
    expect(msg).toContain('👛 미보유');
    expect(msg).toContain('📊 최근 30일 5회');
  });

  it('extra 없으면 기존 메시지 그대로 (하위호환)', () => {
    const msg = buildAlertMessage(cand, feas, null, net);
    expect(msg).not.toContain('👛');
    expect(msg).not.toContain('📊 최근 30일');
    expect(msg).toContain('차익 후보 (KRW권) · META2');
  });
});
