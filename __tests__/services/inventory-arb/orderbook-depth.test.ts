import {
  fetchOrderbookDepth,
  fetchUpbitDepthBatch,
  MAX_BOOK_AGE_MS,
} from '../../../src/services/inventory-arb/orderbook-depth';

// 거래소 점검 중 멈춘 호가로 가짜 차익을 거래한 사고(이슈 #107: 10-19 DKA, 11-09 NEAR) 재발 방지
const originalFetch = global.fetch;
const NOW = Date.parse('2026-11-08T19:56:27Z');

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as any;
}

function upbitEntry(symbol: string, timestamp: number) {
  return {
    market: `KRW-${symbol}`,
    timestamp,
    orderbook_units: [{ ask_price: 4933, bid_price: 4932, ask_size: 100, bid_size: 100 }],
  };
}

function bithumbBody(timestamp: number) {
  return {
    status: '0000',
    data: {
      timestamp: String(timestamp),
      bids: [{ price: '4983', quantity: '100' }],
      asks: [{ price: '4984', quantity: '100' }],
    },
  };
}

describe('orderbook-depth 호가 신선도 검사', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('업비트 배치: 3시간 멈춘 호가(점검 중)는 결과에서 빠지고 최신 호가만 남는다', async () => {
    const stale = NOW - 3 * 60 * 60 * 1000; // 01:59 KST 이후 멈춤
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse([upbitEntry('NEAR', stale), upbitEntry('XRP', NOW - 2_000)]),
    ) as any;

    const books = await fetchUpbitDepthBatch(['NEAR', 'XRP']);

    expect(books.has('NEAR')).toBe(false);
    expect(books.has('XRP')).toBe(true);
  });

  it('업비트 단건: 멈춘 호가는 null (실행 직전 재확인에서도 차단)', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse([upbitEntry('NEAR', NOW - MAX_BOOK_AGE_MS - 1)]),
    ) as any;

    expect(await fetchOrderbookDepth('upbit', 'NEAR')).toBeNull();
  });

  it('빗썸 단건: 멈춘 호가는 null', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(bithumbBody(NOW - MAX_BOOK_AGE_MS - 1))) as any;

    expect(await fetchOrderbookDepth('bithumb', 'NEAR')).toBeNull();
  });

  it('평상시 조용한 마켓 수준(2.5분 전 갱신)의 호가는 그대로 통과한다', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse([upbitEntry('MED', NOW - 150_000)]),
    ) as any;

    const book = await fetchOrderbookDepth('upbit', 'MED');
    expect(book).not.toBeNull();
    expect(book!.ask).toBe(4933);
  });

  it('빗썸 최신 호가는 통과한다', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(bithumbBody(NOW - 1_000))) as any;

    const book = await fetchOrderbookDepth('bithumb', 'NEAR');
    expect(book).not.toBeNull();
    expect(book!.bid).toBe(4983);
  });
});
