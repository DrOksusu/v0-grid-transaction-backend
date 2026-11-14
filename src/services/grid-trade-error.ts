// 그리드 거래 사이클(executeTrade) 실패가 다음 사이클에 저절로 풀리는 일시적 오류인지 판별.
// 일시적이면 봇을 error로 바꾸지 않고 running을 유지한다(에러 메시지만 기록).

// 기존 판별 문구: 거래소 레이트리밋, 현재가 조회 실패, Prisma 커넥션 풀 타임아웃
const TEMPORARY_MESSAGES = [
  '429',
  '현재가 조회 실패',
  'Too Many Requests',
  'connection pool',
  'Timed out fetching',
  'P2024',
  // DB 연결 끊김: 몇 초짜리 순간 끊김에도 봇이 영구 정지되던 문제(2026-08~10 STORJ·BTC·WLFI·ONDO·VVV)
  "Can't reach database server",
  'Server has closed the connection',
];

// Prisma 연결 계열 코드: P1001 서버 연결 불가, P1002 연결 시간 초과, P1008 작업 시간 초과,
// P1017 서버가 연결을 닫음, P2024 커넥션 풀 타임아웃.
// 요청 오류는 code, 초기화 오류는 errorCode에 담긴다.
const TEMPORARY_PRISMA_CODES = ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'];

export function isTemporaryTradeError(error: unknown): boolean {
  const e = error as { message?: unknown; code?: unknown; errorCode?: unknown } | null | undefined;
  const message = typeof e?.message === 'string' ? e.message : '';
  const code = String(e?.code ?? e?.errorCode ?? '');
  return TEMPORARY_PRISMA_CODES.includes(code) || TEMPORARY_MESSAGES.some((m) => message.includes(m));
}
