// 빗썸 텔레그램 메시지 파서 단위 테스트 (TDD RED 단계)
// Task 4에서 구현될 src/services/bithumb-listing-monitor.service.ts의 spec 명문화.
// 현재는 모듈이 존재하지 않으므로 import 실패로 RED 상태가 됨.
import {
  parseBithumbListing,
  parseTelegramMessage,
} from '../../src/services/bithumb-listing-monitor.service';

describe('parseBithumbListing', () => {
  const cases: Array<{
    title: string;
    expected: { name: string; ticker: string } | null;
  }> = [
    {
      title: '리프로토콜(RE) 원화 마켓 추가',
      expected: { name: '리프로토콜', ticker: 'RE' },
    },
    {
      title: '에스피엑스6900(SPX) 원화 마켓 추가',
      expected: { name: '에스피엑스6900', ticker: 'SPX' },
    },
    {
      title: '시트레아(CTR) 원화 마켓 추가(거래 오픈 오후 6시 예정)',
      expected: { name: '시트레아', ticker: 'CTR' },
    },
    {
      title: '젠신(AI) 원화 마켓 추가(심볼명 변경)',
      expected: { name: '젠신', ticker: 'AI' },
    },
    {
      title: '엣지엑스(EDGEX) 원화 마켓 추가(거래 오픈 오후 4시 예정)',
      expected: { name: '엣지엑스', ticker: 'EDGEX' },
    },
    // 스테이블/기축(BTC) 재상장 노이즈는 제외해야 함
    { title: '비트코인(BTC) 원화 마켓 추가', expected: null },
    // 매칭 안 되는 잡 공지
    { title: '랜덤 공지 제목', expected: null },
  ];

  it.each(cases)('parses "$title"', ({ title, expected }) => {
    expect(parseBithumbListing(title)).toEqual(expected);
  });
});

describe('parseTelegramMessage', () => {
  it('extracts ticker + noticeId from valid 마켓 추가 message', () => {
    const text =
      '[마켓 추가] 리프로토콜(RE) 원화 마켓 추가\nhttps://feed.bithumb.com/notice/1653785';
    expect(parseTelegramMessage(text)).toEqual({
      ticker: 'RE',
      name: '리프로토콜',
      noticeId: 1653785,
    });
  });

  it('returns null for non-listing message', () => {
    const text =
      '[입출금] POL 입출금 일시 중지 안내\nhttps://feed.bithumb.com/notice/1653791';
    expect(parseTelegramMessage(text)).toBeNull();
  });

  it('returns null for listing message without notice URL', () => {
    const text = '[마켓 추가] 리프로토콜(RE) 원화 마켓 추가';
    expect(parseTelegramMessage(text)).toBeNull();
  });
});
