// 거래소 BTC 보유량(Exchange Reserve) 모니터 설정
// 데이터: CoinMetrics Community API (무료, 키 불필요) — SplyExNtv/FlowInExNtv/FlowOutExNtv

export const EXCHANGE_RESERVE_CONFIG = {
  coinmetricsBase: process.env.COINMETRICS_API_BASE ?? 'https://community-api.coinmetrics.io/v4',
  metrics: ['SplyExNtv', 'FlowInExNtv', 'FlowOutExNtv'] as const,
  // node-cron은 { timezone: 'UTC' }로 등록. 02:30 UTC = KST 11:30 (메인), 04:30 UTC = KST 13:30 (재시도)
  // CoinMetrics는 D일 값을 D+1일 UTC 01:15~01:45경 공개한다
  cronMain: process.env.EXCHANGE_RESERVE_CRON ?? '30 2 * * *',
  cronRetry: process.env.EXCHANGE_RESERVE_RETRY_CRON ?? '30 4 * * *',
  fetchTimeoutMs: 10_000,
  maxPages: 20,              // 페이지네이션 무한루프 방지
  backfillDays: 730,         // 부팅 백필 범위
  backfillMinRows: 400,      // 이 행 수 미만이면 백필 실행
  recollectDays: 7,          // 일일 수집 시 재조회 구간 (잠정치 수정 반영)
  staleDays: 2,              // 최신 일자가 오늘(UTC)보다 이만큼 초과 경과하면 지연
  viewLookbackDays: 400,     // 조회 API가 요약 계산용으로 읽는 범위
  lookbackDays: 365,         // 1년 최저/최고 기준
} as const

// 조회 API가 허용하는 기간(일)
export const ALLOWED_VIEW_DAYS = [90, 365] as const
