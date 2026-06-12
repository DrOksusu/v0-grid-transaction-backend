import { calcAlertErrorRate, ALERT_ERROR_RATE_MIN_SAMPLE } from '../../src/utils/alert-error-rate';

// 헬퍼: statusCode 배열을 메트릭 배열로 변환
const metrics = (codes: number[]) => codes.map((statusCode) => ({ statusCode }));

describe('calcAlertErrorRate (과부하 알림용 에러율)', () => {
  test('4xx(401/404)는 에러율에 포함하지 않는다 — 클라이언트 원인 오탐 방지', () => {
    // 2026-06-11 실제 오탐 사례: 저트래픽 새벽 10건 중 401 2건 = 20% 알림
    const codes = [200, 200, 200, 200, 200, 200, 200, 200, 401, 401];
    // 샘플 30건 이상이어도 4xx는 집계 제외
    const padded = [...codes, ...Array(25).fill(200)];
    expect(calcAlertErrorRate(metrics(padded))).toBe(0);
  });

  test('최소 샘플(30건) 미만이면 0을 반환한다 — 저트래픽 비율 부풀림 방지', () => {
    // 29건 중 5xx 10건 = 34.5%지만 샘플 부족으로 0
    const codes = [...Array(10).fill(500), ...Array(19).fill(200)];
    expect(codes.length).toBeLessThan(ALERT_ERROR_RATE_MIN_SAMPLE);
    expect(calcAlertErrorRate(metrics(codes))).toBe(0);
  });

  test('샘플 30건 이상 + 5xx만 에러로 집계한다', () => {
    // 30건 중 500 3건 = 10%
    const codes = [...Array(3).fill(500), ...Array(27).fill(200)];
    expect(calcAlertErrorRate(metrics(codes))).toBe(10);
  });

  test('5xx와 4xx 혼재 시 5xx만 집계한다', () => {
    // 40건: 502 2건(5%) + 401 4건(제외) + 200 34건
    const codes = [502, 502, 401, 401, 401, 401, ...Array(34).fill(200)];
    expect(calcAlertErrorRate(metrics(codes))).toBe(5);
  });

  test('빈 배열이면 0을 반환한다', () => {
    expect(calcAlertErrorRate([])).toBe(0);
  });
});
