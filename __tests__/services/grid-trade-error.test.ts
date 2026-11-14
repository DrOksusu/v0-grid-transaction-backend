import { isTemporaryTradeError } from '../../src/services/grid-trade-error';

describe('isTemporaryTradeError (그리드 거래 실패가 일시적인지)', () => {
  it('DB 서버 연결 불가(P1001)는 일시적 — 봇을 error로 바꾸지 않는다', () => {
    // 실제 운영 메시지 형태 (2026-10-31 ONDO·VVV 정지)
    const e = new Error(
      "\nInvalid `prisma.gridLevel.count()` invocation:\n\n\nCan't reach database server at `db.example:3306`\n\nPlease make sure your database server is running at `db.example:3306`."
    );
    expect(isTemporaryTradeError(e)).toBe(true);
  });

  it('Prisma 에러 코드로 오는 DB 연결 끊김(P1001·P1002·P1008·P1017)도 일시적', () => {
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017']) {
      expect(isTemporaryTradeError(Object.assign(new Error('db'), { code }))).toBe(true);
      expect(isTemporaryTradeError(Object.assign(new Error('db'), { errorCode: code }))).toBe(true);
    }
  });

  it('서버가 연결을 닫음 메시지도 일시적', () => {
    expect(isTemporaryTradeError(new Error('Server has closed the connection.'))).toBe(true);
  });

  it('기존 일시적 오류(429·현재가 조회 실패·커넥션 풀 타임아웃)는 그대로 일시적', () => {
    expect(isTemporaryTradeError(new Error('Request failed with status code 429'))).toBe(true);
    expect(isTemporaryTradeError(new Error('현재가 조회 실패: KRW-XRP'))).toBe(true);
    expect(isTemporaryTradeError(new Error('Timed out fetching a new connection from the connection pool'))).toBe(true);
    expect(isTemporaryTradeError(Object.assign(new Error('x'), { code: 'P2024' }))).toBe(true);
  });

  it('잔고 부족 같은 진짜 오류는 일시적이 아니다 — 기존대로 error', () => {
    expect(isTemporaryTradeError(new Error('insufficient_funds_bid'))).toBe(false);
    expect(isTemporaryTradeError(new Error('Unique constraint failed'))).toBe(false);
  });

  it('message가 없는 값도 안전하게 false', () => {
    expect(isTemporaryTradeError(undefined)).toBe(false);
    expect(isTemporaryTradeError('문자열 오류')).toBe(false);
  });
});
