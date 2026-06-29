import prisma from '../config/database';

// KST는 DST 없이 UTC+9 고정
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MARKET_OPEN_MINUTES = 9 * 60;         // 09:00
const MARKET_CLOSE_MINUTES = 15 * 60 + 30;  // 15:30
const CANCEL_WINDOW_MINUTES = 1;            // 마감 후 1분 윈도우

interface KSTInfo {
  date: Date;        // KST 기준 Date 객체 (UTC 시각 + 9h 보정한 임시 표현)
  minutes: number;   // 0~1439 (시 * 60 + 분)
  weekday: number;   // 0=일, 6=토 (KST 기준)
  dateOnly: string;  // 'YYYY-MM-DD' (KST 기준)
}

/**
 * UTC Date를 KST 기준 시각/요일/날짜로 변환.
 * (KST timezone에 DST가 없으므로 +9h 고정 오프셋으로 처리)
 */
function toKST(now: Date): KSTInfo {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    date: kst,
    minutes: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
    weekday: kst.getUTCDay(),
    dateOnly: kst.toISOString().slice(0, 10),
  };
}

/**
 * 한국 주식시장이 현재 열려있는지 판단.
 * - 평일 09:00 <= KST 시각 < 15:30
 * - 주말 false
 * - KoreanMarketCalendar에 isOpen=false 등록된 날 false
 */
export async function isMarketOpen(now: Date = new Date()): Promise<boolean> {
  const kst = toKST(now);

  // 주말 체크
  if (kst.weekday === 0 || kst.weekday === 6) return false;

  // 휴장일 체크 (DB 조회)
  const cal = await prisma.koreanMarketCalendar.findUnique({
    where: { date: new Date(kst.dateOnly) },
  });
  if (cal && !cal.isOpen) return false;

  // 정규장 시간 체크
  return kst.minutes >= MARKET_OPEN_MINUTES && kst.minutes < MARKET_CLOSE_MINUTES;
}

/**
 * 다음 영업일 09:00 KST 시각 반환.
 * - 같은 날 08:59 이전이면서 평일/영업일이면 같은 날 09:00
 * - 그 외엔 다음 영업일 09:00
 * - 최대 7일 lookahead (휴장 연속 방어)
 */
export async function getNextMarketOpenTime(from: Date = new Date()): Promise<Date> {
  for (let i = 0; i < 7; i++) {
    const candidate = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const kst = toKST(candidate);

    // 주말이면 다음 날 시도
    if (kst.weekday === 0 || kst.weekday === 6) continue;

    // 휴장일이면 다음 날 시도
    const cal = await prisma.koreanMarketCalendar.findUnique({
      where: { date: new Date(kst.dateOnly) },
    });
    if (cal && !cal.isOpen) continue;

    // 같은 날인데 이미 09:00 지났으면 다음 영업일로
    if (i === 0 && kst.minutes >= MARKET_OPEN_MINUTES) continue;

    // KST 09:00 = UTC 00:00 (같은 날짜)
    return new Date(`${kst.dateOnly}T00:00:00.000Z`);
  }
  throw new Error('다음 7일 내 영업일 없음 (휴장 연속)');
}

/**
 * 장 마감 직후 1분 윈도우(15:30:00 ~ 15:30:59) 동안만 true.
 * 봇 cycle에서 미체결 주문 일괄 취소 트리거에 사용.
 */
export async function shouldCancelPendingOrders(now: Date = new Date()): Promise<boolean> {
  const kst = toKST(now);
  if (kst.weekday === 0 || kst.weekday === 6) return false;
  return kst.minutes >= MARKET_CLOSE_MINUTES && kst.minutes < MARKET_CLOSE_MINUTES + CANCEL_WINDOW_MINUTES;
}
