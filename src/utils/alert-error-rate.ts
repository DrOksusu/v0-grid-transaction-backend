/**
 * 과부하 알림용 API 에러율 계산
 *
 * 4xx는 집계하지 않는다 — 401(JWT 만료 폴링), 404(외부 스캐너) 등 클라이언트 원인이
 * 저트래픽 새벽 시간대에 비율을 부풀려 오탐을 유발했음 (2026-06-11 사례: 10건 중 401 2건 = 20% 알림).
 * 서버 과부하 경고의 목적에 맞게 5xx(서버 장애)만 집계한다.
 */

// 최소 샘플 수 — 미만이면 에러율 0으로 처리 (소수 에러의 비율 부풀림 방지)
export const ALERT_ERROR_RATE_MIN_SAMPLE = 30;

export function calcAlertErrorRate(metrics: Array<{ statusCode: number }>): number {
  if (metrics.length < ALERT_ERROR_RATE_MIN_SAMPLE) return 0;
  const serverErrorCount = metrics.filter((m) => m.statusCode >= 500).length;
  return (serverErrorCount / metrics.length) * 100;
}
