// 쿨다운(30분) + 발송 성공 시에만 notifiedAt 갱신 검증 (spec §5 step 6, §8, §9, §11)
import prisma from '../../__mocks__/database';
import { multiArbNotifierService, buildAlertMessage } from '../../src/services/multi-arb-notifier.service';
import { kakaoNotifyService } from '../../src/services/kakao-notify.service';
import { SpreadCandidate, FeasibilityResult } from '../../src/services/multi-arb-types';

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
  sellExchange: 'upbit',
  sellPrice: 4340,
  spreadPct: 3.33,
};

const feasible: FeasibilityResult = {
  feasibility: 'feasible',
  networkMatch: true,
  matchedNetwork: 'ETH',
  note: '네트워크 일치(ETH) · 양쪽 입출금 정상',
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
    const sent = await multiArbNotifierService.notify(cand, feasible, 0.8);
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
    const sent = await multiArbNotifierService.notify(cand, feasible, null);
    expect(sent).toBe(false);
    expect(db.multiArbOpportunity.create).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    // 쿨다운 조회 조건 검증: notifiedAt 30분 윈도우
    expect(db.multiArbOpportunity.findFirst).toHaveBeenCalledWith({
      where: {
        symbol: 'WLD',
        currencyZone: 'KRW',
        notifiedAt: { gte: expect.any(Date) },
      },
    });
  });

  it('카톡 발송 실패 → notifiedAt 미갱신 (다음 사이클 재시도, spec §9)', async () => {
    mockedSend.mockRejectedValue(new Error('kakao down'));
    const sent = await multiArbNotifierService.notify(cand, feasible, null);
    expect(sent).toBe(false);
    expect(db.multiArbOpportunity.create).toHaveBeenCalled();      // 기회 이력은 남김
    expect(db.multiArbOpportunity.update).not.toHaveBeenCalled();  // notifiedAt은 갱신 안 함
  });

  // I-1: 발송 게이트 — 게이트는 "카톡 발송"에만 적용, DB 기록·쿨다운 로직은 종전 유지
  it('send=false: 쿨다운 확인 + DB 기록은 수행, 카톡 발송·notifiedAt 갱신은 안 함 (I-1)', async () => {
    const sent = await multiArbNotifierService.notify(cand, feasible, 0.8, { send: false });
    expect(sent).toBe(false);
    expect(db.multiArbOpportunity.findFirst).toHaveBeenCalledTimes(1); // 쿨다운 확인은 종전대로
    expect(db.multiArbOpportunity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ symbol: 'WLD', feasibility: 'feasible', notifiedAt: null }),
    });
    expect(mockedSend).not.toHaveBeenCalled();                     // 카톡만 스킵
    expect(db.multiArbOpportunity.update).not.toHaveBeenCalled();  // notifiedAt=null 유지
  });

  it('send=false여도 쿨다운 이내면 DB 기록도 스킵 (쿨다운 로직 종전 유지)', async () => {
    db.multiArbOpportunity.findFirst.mockResolvedValue({ id: 99, notifiedAt: new Date() });
    const sent = await multiArbNotifierService.notify(cand, feasible, null, { send: false });
    expect(sent).toBe(false);
    expect(db.multiArbOpportunity.create).not.toHaveBeenCalled();
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
    const msg = buildAlertMessage(cand, feasible, 0.8);
    expect(msg).toContain('🔔 차익 후보 (KRW권) · WLD');
    expect(msg).toContain('📉 빗썸 매수 4,200');
    expect(msg).toContain('📈 업비트 매도 4,340');
    expect(msg).toContain('+3.3%');
    expect(msg).toContain('✅ 네트워크 일치(ETH) · 양쪽 입출금 정상');
    expect(msg).toContain('참고 김프: 해외 대비 +0.8%');
    expect(msg).toContain('⚠️ 표시가 기준 · 실제 유동성/체결 확인 필요');
  });

  it('network_mismatch: 함정 경고 포맷 (spec §7 LSK류)', () => {
    const lsk: SpreadCandidate = {
      symbol: 'LSK', currencyZone: 'KRW',
      buyExchange: 'upbit', buyPrice: 533,
      sellExchange: 'bithumb', sellPrice: 1322,
      spreadPct: 148.03,
    };
    const mismatch: FeasibilityResult = {
      feasibility: 'network_mismatch', networkMatch: false, matchedNetwork: null,
      note: '전송불가: 네트워크 불일치(업비트 LSK망 ↔ 빗썸 ETH망)',
    };
    const msg = buildAlertMessage(lsk, mismatch, null);
    expect(msg).toContain('⚠️ 차익 후보(주의) · LSK');
    expect(msg).toContain('빗썸 1,322 / 업비트 533 (+148%)');
    expect(msg).toContain('⛔ 전송불가: 네트워크 불일치');
    expect(msg).toContain('→ 실현 어려움. 정보용 참고');
    expect(msg).toContain('⚠️ 표시가 기준 · 실제 유동성/체결 확인 필요');
  });

  it('김프 null이면 김프 줄을 생략한다', () => {
    const msg = buildAlertMessage(cand, feasible, null);
    expect(msg).not.toContain('참고 김프');
  });
});
