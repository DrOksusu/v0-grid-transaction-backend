// 빗썸 신규상장 모니터 통합 테스트 (mock 기반)
// pollBithumbTelegram + checkNewBithumbMarkets 호출 흐름 검증
//
// 패턴: top-level jest.mock + mock-prefix 클로저 변수 (jest 호이스팅 규칙 회피).
// jest.config의 moduleNameMapper가 '^../config/database$' → __mocks__/database.ts로 매핑하므로
// 동일 mock 인스턴스를 보려면 __mocks__/database.ts를 직접 import한다.

const mockAxiosGet = jest.fn();
const mockExecuteBuy = jest.fn();
const mockSendToMe = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: mockAxiosGet },
}));
jest.mock('../../src/services/listing-auto-trader.service', () => ({
  listingAutoTraderService: { executeBuy: mockExecuteBuy },
}));
jest.mock('../../src/services/kakao-notify.service', () => ({
  kakaoNotifyService: { sendToMe: mockSendToMe },
}));

// fire-and-forget 핸들이 마이크로태스크 큐에서 풀리도록 잠깐 양보
const flushAsync = () => new Promise(resolve => setImmediate(resolve));

const prisma = require('../../__mocks__/database').default;
const {
  bithumbListingMonitorService: service,
  stableHash,
} = require('../../src/services/bithumb-listing-monitor.service');

beforeEach(() => {
  jest.clearAllMocks();
  mockExecuteBuy.mockResolvedValue([]);
  mockSendToMe.mockResolvedValue(undefined);
  // prisma mock 기본 resolve 값 재설정
  prisma.upbitListingAnnouncement.findUnique.mockResolvedValue(null);
  prisma.upbitListingAnnouncement.findFirst.mockResolvedValue(null);
  prisma.upbitListingAnnouncement.create.mockResolvedValue({
    id: 1,
    source: 'BITHUMB',
    ticker: 'RE',
  });
  // singleton state 격리
  service._resetForTests();
});

describe('bithumbListingMonitorService.pollBithumbTelegram', () => {
  it('신규 상장 메시지를 감지해 announcement 생성 + 자동매수 + 카카오 알림 트리거', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: `
        <div class="tgme_widget_message" data-post="BithumbExchange/12345">
          <div class="tgme_widget_message_text">[마켓 추가] 리프로토콜(RE) 원화 마켓 추가
https://feed.bithumb.com/notice/1653785</div>
        </div>
      `,
    });

    await service.pollBithumbTelegram();
    await flushAsync();

    // 정방향 검증: prisma create가 실제로 호출되었는지 (silent-catch 회귀 방지)
    expect(prisma.upbitListingAnnouncement.create).toHaveBeenCalledTimes(1);
    expect(prisma.upbitListingAnnouncement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'BITHUMB',
          noticeId: 1653785,
          ticker: 'RE',
        }),
      }),
    );
    expect(mockExecuteBuy).toHaveBeenCalledWith(1, 'RE', 'BITHUMB');
    expect(mockSendToMe).toHaveBeenCalledTimes(1);
  });

  it('비-상장 메시지는 캐시만 하고 prisma / 알림 호출 안 함', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: `
        <div class="tgme_widget_message" data-post="BithumbExchange/99999">
          <div class="tgme_widget_message_text">안녕하세요 빗썸 공지입니다.</div>
        </div>
      `,
    });

    await service.pollBithumbTelegram();
    await flushAsync();

    expect(prisma.upbitListingAnnouncement.findFirst).not.toHaveBeenCalled();
    expect(prisma.upbitListingAnnouncement.create).not.toHaveBeenCalled();
    expect(mockExecuteBuy).not.toHaveBeenCalled();
    expect(mockSendToMe).not.toHaveBeenCalled();
  });

  it('이미 본 메시지(data-post)는 재처리하지 않는다', async () => {
    const html = `
      <div class="tgme_widget_message" data-post="BithumbExchange/55555">
        <div class="tgme_widget_message_text">[마켓 추가] 더미코인(DUM) 원화 마켓 추가
https://feed.bithumb.com/notice/9999999</div>
      </div>
    `;
    mockAxiosGet.mockResolvedValue({ data: html });

    await service.pollBithumbTelegram();
    await flushAsync();
    await service.pollBithumbTelegram();
    await flushAsync();

    // 첫 호출에만 prisma create / 자동매수 — 두 번째는 seenTelegramMsgIds 캐시로 차단
    expect(prisma.upbitListingAnnouncement.create).toHaveBeenCalledTimes(1);
    expect(mockExecuteBuy).toHaveBeenCalledTimes(1);
  });

  it('I5 회귀: 24h 내 같은 ticker로 처리됐으면 create / 자동매수 호출 안 함 (텔레그램)', async () => {
    prisma.upbitListingAnnouncement.findFirst.mockResolvedValueOnce({
      id: 999,
      source: 'BITHUMB',
      ticker: 'RE',
    });
    mockAxiosGet.mockResolvedValueOnce({
      data: `
        <div class="tgme_widget_message" data-post="BithumbExchange/77777">
          <div class="tgme_widget_message_text">[마켓 추가] 리프로토콜(RE) 원화 마켓 추가
https://feed.bithumb.com/notice/1653785</div>
        </div>
      `,
    });

    await service.pollBithumbTelegram();
    await flushAsync();

    expect(prisma.upbitListingAnnouncement.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.upbitListingAnnouncement.create).not.toHaveBeenCalled();
    expect(mockExecuteBuy).not.toHaveBeenCalled();
    expect(mockSendToMe).not.toHaveBeenCalled();
  });

  it('P2002 발생 시 createAnnouncementSafe로 기존 레코드 사용 + 부작용 skip', async () => {
    const p2002Err: any = new Error('Unique constraint failed');
    p2002Err.code = 'P2002';
    prisma.upbitListingAnnouncement.create.mockRejectedValueOnce(p2002Err);
    prisma.upbitListingAnnouncement.findUnique.mockResolvedValueOnce({
      id: 555,
      source: 'BITHUMB',
      noticeId: 1653785,
    });
    mockAxiosGet.mockResolvedValueOnce({
      data: `
        <div class="tgme_widget_message" data-post="BithumbExchange/88888">
          <div class="tgme_widget_message_text">[마켓 추가] 리프로토콜(RE) 원화 마켓 추가
https://feed.bithumb.com/notice/1653785</div>
        </div>
      `,
    });

    await service.pollBithumbTelegram();
    await flushAsync();

    expect(prisma.upbitListingAnnouncement.create).toHaveBeenCalledTimes(1);
    expect(prisma.upbitListingAnnouncement.findUnique).toHaveBeenCalledTimes(1);
    // created=false이므로 매수/알림 skip
    expect(mockExecuteBuy).not.toHaveBeenCalled();
    expect(mockSendToMe).not.toHaveBeenCalled();
  });

  it('한 메시지 처리 실패가 다른 메시지 처리를 막지 않는다 (격리)', async () => {
    // 첫 메시지 findFirst가 throw → 같은 cycle의 두 번째 메시지는 정상 처리되어야 함
    prisma.upbitListingAnnouncement.findFirst
      .mockRejectedValueOnce(new Error('일시 DB 오류'))
      .mockResolvedValueOnce(null);
    prisma.upbitListingAnnouncement.create.mockResolvedValueOnce({
      id: 200,
      source: 'BITHUMB',
      ticker: 'OK2',
    });
    mockAxiosGet.mockResolvedValueOnce({
      data: `
        <div class="tgme_widget_message" data-post="BithumbExchange/A1">
          <div class="tgme_widget_message_text">[마켓 추가] 첫코인(FAIL) 원화 마켓 추가
https://feed.bithumb.com/notice/100001</div>
        </div>
        <div class="tgme_widget_message" data-post="BithumbExchange/A2">
          <div class="tgme_widget_message_text">[마켓 추가] 둘코인(OK2) 원화 마켓 추가
https://feed.bithumb.com/notice/100002</div>
        </div>
      `,
    });

    await service.pollBithumbTelegram();
    await flushAsync();

    // 두 번째 메시지는 정상 처리되어야
    expect(mockExecuteBuy).toHaveBeenCalledWith(200, 'OK2', 'BITHUMB');
  });
});

describe('bithumbListingMonitorService.checkNewBithumbMarkets', () => {
  it('silent baseline 호출은 스냅샷만 갱신하고 알림/자동매수 호출 안 함', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
      ],
    });

    await service.checkNewBithumbMarkets({ silent: true });
    await flushAsync();

    expect(prisma.upbitListingAnnouncement.create).not.toHaveBeenCalled();
    expect(mockExecuteBuy).not.toHaveBeenCalled();
    expect(mockSendToMe).not.toHaveBeenCalled();
  });

  it('baseline 이후 새 KRW 마켓 등장 시 announcement 생성 + 자동매수 + 카카오 알림', async () => {
    prisma.upbitListingAnnouncement.create.mockResolvedValueOnce({
      id: 42,
      source: 'BITHUMB',
      ticker: 'NEW',
    });

    // 1차: baseline (BTC, ETH만)
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
      ],
    });
    await service.checkNewBithumbMarkets({ silent: true });

    // 2차: 새 마켓 NEW 등장
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
        { market: 'KRW-NEW', korean_name: '뉴코인', english_name: 'NewCoin' },
      ],
    });
    await service.checkNewBithumbMarkets();
    await flushAsync();

    expect(prisma.upbitListingAnnouncement.create).toHaveBeenCalledTimes(1);
    expect(prisma.upbitListingAnnouncement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'BITHUMB',
          ticker: 'NEW',
        }),
      }),
    );
    expect(mockExecuteBuy).toHaveBeenCalledWith(42, 'NEW', 'BITHUMB');
    expect(mockSendToMe).toHaveBeenCalledTimes(1);
  });

  it('TICKER_EXCLUDES에 포함된 새 마켓(USDT)은 prisma create / 알림 안 함', async () => {
    // 1차: baseline
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
      ],
    });
    await service.checkNewBithumbMarkets({ silent: true });

    // 2차: USDT 추가됨 (재상장 노이즈)
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-USDT', korean_name: '테더', english_name: 'Tether' },
      ],
    });
    await service.checkNewBithumbMarkets();
    await flushAsync();

    expect(prisma.upbitListingAnnouncement.create).not.toHaveBeenCalled();
    expect(mockExecuteBuy).not.toHaveBeenCalled();
    expect(mockSendToMe).not.toHaveBeenCalled();
  });

  it('I5 회귀: 24h 내 텔레그램 처리됐으면 create / 알림 / 자동매수 모두 skip (마켓 diff)', async () => {
    // 1차: baseline
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
      ],
    });
    await service.checkNewBithumbMarkets({ silent: true });

    // 2차: NEW 등장하지만 24h 내 텔레그램에서 이미 처리됨
    prisma.upbitListingAnnouncement.findFirst.mockResolvedValueOnce({
      id: 100,
      source: 'BITHUMB',
      ticker: 'NEW',
    });
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-NEW', korean_name: '뉴코인', english_name: 'NewCoin' },
      ],
    });
    await service.checkNewBithumbMarkets();
    await flushAsync();

    // create / 매수 / 알림 모두 skip
    expect(prisma.upbitListingAnnouncement.create).not.toHaveBeenCalled();
    expect(mockExecuteBuy).not.toHaveBeenCalled();
    expect(mockSendToMe).not.toHaveBeenCalled();
  });

  it('한 마켓 처리 실패가 다른 마켓 처리를 막지 않는다 (격리)', async () => {
    // 1차: baseline
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
      ],
    });
    await service.checkNewBithumbMarkets({ silent: true });

    // 2차: NEW1 처리 시 findFirst가 throw, NEW2는 정상 처리되어야
    prisma.upbitListingAnnouncement.findFirst
      .mockRejectedValueOnce(new Error('일시 DB 오류'))
      .mockResolvedValueOnce(null);
    prisma.upbitListingAnnouncement.create.mockResolvedValueOnce({
      id: 300,
      source: 'BITHUMB',
      ticker: 'NEW2',
    });
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-NEW1', korean_name: '실패코인', english_name: 'Fail' },
        { market: 'KRW-NEW2', korean_name: '성공코인', english_name: 'OK' },
      ],
    });
    await service.checkNewBithumbMarkets();
    await flushAsync();

    expect(mockExecuteBuy).toHaveBeenCalledWith(300, 'NEW2', 'BITHUMB');
  });
});

describe('stableHash (I1 회귀: 결정적 합성 noticeId)', () => {
  const SYNTHETIC_BAND = 200_000_000;

  it('같은 ticker는 항상 같은 해시값을 반환한다 (멱등성)', () => {
    expect(stableHash('NEW', SYNTHETIC_BAND)).toBe(
      stableHash('NEW', SYNTHETIC_BAND),
    );
    expect(stableHash('RE', SYNTHETIC_BAND)).toBe(
      stableHash('RE', SYNTHETIC_BAND),
    );
  });

  it('다른 ticker는 다른 해시값을 반환한다 (충돌 회피)', () => {
    expect(stableHash('NEW', SYNTHETIC_BAND)).not.toBe(
      stableHash('OLD', SYNTHETIC_BAND),
    );
  });

  it('해시값은 [0, mod) 범위 안에 있다', () => {
    for (const ticker of ['BTC', 'ETH', 'NEW', 'XRP', 'A', 'VERYLONGTICKER']) {
      const h = stableHash(ticker, SYNTHETIC_BAND);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(SYNTHETIC_BAND);
    }
  });

  it('같은 ticker로 마켓 diff를 두 번 호출해도 같은 noticeId를 만든다', async () => {
    // 1차: baseline
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
      ],
    });
    await service.checkNewBithumbMarkets({ silent: true });

    // 2차: NEW 등장 — create 호출 데이터 캡처
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-NEW', korean_name: '뉴코인', english_name: 'NewCoin' },
      ],
    });
    await service.checkNewBithumbMarkets();
    await flushAsync();
    const firstNoticeId =
      prisma.upbitListingAnnouncement.create.mock.calls[0][0].data.noticeId;

    // state 초기화 후 같은 ticker로 두 번째 사이클 시뮬레이션
    service._resetForTests();
    prisma.upbitListingAnnouncement.create.mockClear();
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
      ],
    });
    await service.checkNewBithumbMarkets({ silent: true });
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-NEW', korean_name: '뉴코인', english_name: 'NewCoin' },
      ],
    });
    await service.checkNewBithumbMarkets();
    await flushAsync();
    const secondNoticeId =
      prisma.upbitListingAnnouncement.create.mock.calls[0][0].data.noticeId;

    // 같은 ticker → 같은 noticeId (Date.now 기반이면 다를 것)
    expect(secondNoticeId).toBe(firstNoticeId);
  });
});

describe('_resetForTests production 가드', () => {
  it('NODE_ENV !== "test"에서 호출 시 throw', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => service._resetForTests()).toThrow(/test-only/);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});
