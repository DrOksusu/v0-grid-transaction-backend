// 빗썸 신규상장 모니터 통합 테스트 (mock 기반)
// pollBithumbTelegram + checkNewBithumbMarkets 호출 흐름 검증
//
// 패턴: top-level jest.mock + mock-prefix 클로저 변수 (jest 호이스팅 규칙 회피).
// prisma는 jest.config.ts의 moduleNameMapper로 __mocks__/database.ts로 강제 매핑됨.
// 매 테스트마다 jest.resetModules() → 새 singleton instance를 require하여 state 격리.

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

// jest.config의 moduleNameMapper가 '^../config/database$'를 __mocks__/database.ts로 매핑하므로
// 동일 mock 인스턴스를 보려면 __mocks__/database.ts를 직접 import해야 한다.
// (테스트 파일에서 '../../src/config/database'로 import하면 매핑 안 되어 real Prisma client가 옴)
const prisma = require('../../__mocks__/database').default;
const {
  bithumbListingMonitorService: service,
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
    expect(mockExecuteBuy).toHaveBeenCalledWith(1, 'RE');
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

    expect(prisma.upbitListingAnnouncement.findUnique).not.toHaveBeenCalled();
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

  it('이미 announcement가 존재하는 noticeId는 create / 자동매수 호출 안 함', async () => {
    prisma.upbitListingAnnouncement.findUnique.mockResolvedValueOnce({
      id: 999,
      source: 'BITHUMB',
      noticeId: 1653785,
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

    expect(prisma.upbitListingAnnouncement.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.upbitListingAnnouncement.create).not.toHaveBeenCalled();
    expect(mockExecuteBuy).not.toHaveBeenCalled();
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
    expect(mockExecuteBuy).toHaveBeenCalledWith(42, 'NEW');
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
});
