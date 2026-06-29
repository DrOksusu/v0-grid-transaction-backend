import {
  isMarketOpen,
  getNextMarketOpenTime,
  shouldCancelPendingOrders,
} from '../../src/services/korean-stock-market-hours.service';

jest.mock('../../src/config/database', () => require('../../__mocks__/database'));

const dbMock = require('../../__mocks__/database').default;

describe('isMarketOpen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbMock.koreanMarketCalendar.findUnique.mockResolvedValue(null);
  });

  it('평일 09:30 KST → true', async () => {
    // UTC 00:30 = KST 09:30 월요일 (2026-06-29)
    const result = await isMarketOpen(new Date('2026-06-29T00:30:00Z'));
    expect(result).toBe(true);
  });

  it('평일 15:30 KST 정시 → false (장 마감 시점 포함 X)', async () => {
    // UTC 06:30 = KST 15:30
    const result = await isMarketOpen(new Date('2026-06-29T06:30:00Z'));
    expect(result).toBe(false);
  });

  it('평일 08:59 KST → false (장 시작 1분 전)', async () => {
    // UTC 2026-06-28 23:59 = KST 2026-06-29 08:59 월요일
    const result = await isMarketOpen(new Date('2026-06-28T23:59:00Z'));
    expect(result).toBe(false);
  });

  it('평일 15:29 KST → true (장 마감 1분 전)', async () => {
    const result = await isMarketOpen(new Date('2026-06-29T06:29:00Z'));
    expect(result).toBe(true);
  });

  it('토요일 → false', async () => {
    // 2026-06-27 토요일 KST 09:30 = UTC 00:30
    const result = await isMarketOpen(new Date('2026-06-27T00:30:00Z'));
    expect(result).toBe(false);
  });

  it('일요일 → false', async () => {
    const result = await isMarketOpen(new Date('2026-06-28T00:30:00Z'));
    expect(result).toBe(false);
  });

  it('휴장일 (DB isOpen=false) → false', async () => {
    dbMock.koreanMarketCalendar.findUnique.mockResolvedValueOnce({
      date: new Date('2026-01-01'),
      isOpen: false,
      reason: '신정',
    });
    // 2026-01-01 KST 09:30 = UTC 2026-01-01 00:30 (목요일)
    const result = await isMarketOpen(new Date('2026-01-01T00:30:00Z'));
    expect(result).toBe(false);
  });
});

describe('shouldCancelPendingOrders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('평일 15:30:30 KST → true (장 마감 직후 1분 윈도우)', async () => {
    const result = await shouldCancelPendingOrders(new Date('2026-06-29T06:30:30Z'));
    expect(result).toBe(true);
  });

  it('평일 15:35 KST → false (1분 윈도우 벗어남)', async () => {
    const result = await shouldCancelPendingOrders(new Date('2026-06-29T06:35:00Z'));
    expect(result).toBe(false);
  });

  it('주말 → false', async () => {
    const result = await shouldCancelPendingOrders(new Date('2026-06-27T06:30:30Z'));
    expect(result).toBe(false);
  });
});

describe('getNextMarketOpenTime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbMock.koreanMarketCalendar.findUnique.mockResolvedValue(null);
  });

  it('금요일 16:00 KST → 다음 월요일 09:00 KST (3일 후)', async () => {
    // 금 2026-06-26 16:00 KST = UTC 07:00
    const next = await getNextMarketOpenTime(new Date('2026-06-26T07:00:00Z'));
    // 월 2026-06-29 KST 09:00 = UTC 00:00 (yyyy-mm-dd start)
    expect(next.toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('평일 08:00 KST → 같은 날 09:00 KST', async () => {
    // 월 08:00 KST = UTC 일 23:00
    const next = await getNextMarketOpenTime(new Date('2026-06-28T23:00:00Z'));
    expect(next.toISOString().slice(0, 10)).toBe('2026-06-29');
  });
});
