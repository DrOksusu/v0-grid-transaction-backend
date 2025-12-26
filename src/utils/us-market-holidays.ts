/**
 * 미국 주식 시장 휴일 및 거래일 계산 유틸리티
 *
 * NYSE/NASDAQ 휴일:
 * - New Year's Day (1월 1일)
 * - Martin Luther King Jr. Day (1월 셋째 월요일)
 * - Presidents' Day (2월 셋째 월요일)
 * - Good Friday (부활절 전 금요일)
 * - Memorial Day (5월 마지막 월요일)
 * - Juneteenth (6월 19일)
 * - Independence Day (7월 4일)
 * - Labor Day (9월 첫째 월요일)
 * - Thanksgiving Day (11월 넷째 목요일)
 * - Christmas Day (12월 25일)
 *
 * 조기 마감일 (Early Close - 1:00 PM ET):
 * - 7월 3일 (독립기념일 전날, 평일인 경우)
 * - 추수감사절 다음날 (11월 넷째 금요일)
 * - 12월 24일 (크리스마스 이브, 평일인 경우)
 */

// 특정 월의 n번째 특정 요일 계산
function getNthDayOfMonth(year: number, month: number, dayOfWeek: number, n: number): Date {
  const firstDay = new Date(year, month, 1);
  const firstDayOfWeek = firstDay.getDay();
  let offset = dayOfWeek - firstDayOfWeek;
  if (offset < 0) offset += 7;
  const day = 1 + offset + (n - 1) * 7;
  return new Date(year, month, day);
}

// 특정 월의 마지막 특정 요일 계산
function getLastDayOfMonth(year: number, month: number, dayOfWeek: number): Date {
  const lastDay = new Date(year, month + 1, 0);
  const lastDayOfWeek = lastDay.getDay();
  let offset = lastDayOfWeek - dayOfWeek;
  if (offset < 0) offset += 7;
  return new Date(year, month + 1, -offset);
}

// 부활절 계산 (Anonymous Gregorian algorithm)
function getEasterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

// Good Friday (부활절 2일 전)
function getGoodFriday(year: number): Date {
  const easter = getEasterSunday(year);
  return new Date(easter.getTime() - 2 * 24 * 60 * 60 * 1000);
}

// 휴일이 주말인 경우 대체휴일 적용
function observedHoliday(date: Date): Date {
  const day = date.getDay();
  if (day === 0) { // 일요일 -> 월요일
    return new Date(date.getTime() + 24 * 60 * 60 * 1000);
  }
  if (day === 6) { // 토요일 -> 금요일
    return new Date(date.getTime() - 24 * 60 * 60 * 1000);
  }
  return date;
}

// 특정 연도의 모든 미국 주식 시장 휴일 반환
export function getUSMarketHolidays(year: number): Date[] {
  const holidays: Date[] = [];

  // New Year's Day (1월 1일)
  holidays.push(observedHoliday(new Date(year, 0, 1)));

  // Martin Luther King Jr. Day (1월 셋째 월요일)
  holidays.push(getNthDayOfMonth(year, 0, 1, 3));

  // Presidents' Day (2월 셋째 월요일)
  holidays.push(getNthDayOfMonth(year, 1, 1, 3));

  // Good Friday (부활절 전 금요일)
  holidays.push(getGoodFriday(year));

  // Memorial Day (5월 마지막 월요일)
  holidays.push(getLastDayOfMonth(year, 4, 1));

  // Juneteenth (6월 19일) - 2021년부터 연방 휴일
  holidays.push(observedHoliday(new Date(year, 5, 19)));

  // Independence Day (7월 4일)
  holidays.push(observedHoliday(new Date(year, 6, 4)));

  // Labor Day (9월 첫째 월요일)
  holidays.push(getNthDayOfMonth(year, 8, 1, 1));

  // Thanksgiving Day (11월 넷째 목요일)
  holidays.push(getNthDayOfMonth(year, 10, 4, 4));

  // Christmas Day (12월 25일)
  holidays.push(observedHoliday(new Date(year, 11, 25)));

  return holidays;
}

// 로컬 날짜를 YYYY-MM-DD 형식으로 변환 (타임존 변환 없이)
function toLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 날짜가 휴일인지 확인
export function isUSMarketHoliday(date: Date): boolean {
  const year = date.getFullYear();
  const holidays = getUSMarketHolidays(year);

  const dateStr = toLocalDateString(date);
  return holidays.some(h => toLocalDateString(h) === dateStr);
}

// 특정 연도의 조기 마감일 반환 (1:00 PM ET 마감)
export function getUSMarketEarlyCloseDays(year: number): Date[] {
  const earlyCloseDays: Date[] = [];

  // 7월 3일 (독립기념일 전날) - 평일인 경우만
  const july3 = new Date(year, 6, 3);
  const july3Day = july3.getDay();
  if (july3Day >= 1 && july3Day <= 5) {
    earlyCloseDays.push(july3);
  }

  // 추수감사절 다음날 (11월 넷째 금요일)
  const thanksgiving = getNthDayOfMonth(year, 10, 4, 4); // 넷째 목요일
  const blackFriday = new Date(thanksgiving.getTime() + 24 * 60 * 60 * 1000);
  earlyCloseDays.push(blackFriday);

  // 12월 24일 (크리스마스 이브) - 평일인 경우만
  const dec24 = new Date(year, 11, 24);
  const dec24Day = dec24.getDay();
  if (dec24Day >= 1 && dec24Day <= 5) {
    earlyCloseDays.push(dec24);
  }

  return earlyCloseDays;
}

// 날짜가 조기 마감일인지 확인
export function isUSMarketEarlyCloseDay(date: Date): boolean {
  const year = date.getFullYear();
  const earlyCloseDays = getUSMarketEarlyCloseDays(year);

  const dateStr = toLocalDateString(date);
  return earlyCloseDays.some(d => toLocalDateString(d) === dateStr);
}

// 조기 마감일 이름 반환
export function getEarlyCloseDayName(date: Date): string | null {
  const year = date.getFullYear();
  const dateStr = toLocalDateString(date);

  // 7월 3일
  const july3 = new Date(year, 6, 3);
  if (toLocalDateString(july3) === dateStr) {
    return '독립기념일 전날';
  }

  // 추수감사절 다음날
  const thanksgiving = getNthDayOfMonth(year, 10, 4, 4);
  const blackFriday = new Date(thanksgiving.getTime() + 24 * 60 * 60 * 1000);
  if (toLocalDateString(blackFriday) === dateStr) {
    return '블랙 프라이데이';
  }

  // 12월 24일
  const dec24 = new Date(year, 11, 24);
  if (toLocalDateString(dec24) === dateStr) {
    return '크리스마스 이브';
  }

  return null;
}

// 날짜가 거래일인지 확인 (주말 + 휴일 제외)
export function isUSMarketOpen(date: Date): boolean {
  const day = date.getDay();
  // 주말 체크
  if (day === 0 || day === 6) return false;
  // 휴일 체크
  return !isUSMarketHoliday(date);
}

// 다음 거래일 계산
export function getNextTradingDay(fromDate: Date = new Date()): Date {
  const result = new Date(fromDate);
  result.setHours(0, 0, 0, 0);

  // 다음 날부터 시작
  result.setDate(result.getDate() + 1);

  // 거래일을 찾을 때까지 반복 (최대 10일)
  let count = 0;
  while (!isUSMarketOpen(result) && count < 10) {
    result.setDate(result.getDate() + 1);
    count++;
  }

  return result;
}

// 미국 동부시간이 일광절약시간(DST)인지 확인
function isUSEasternDST(date: Date): boolean {
  // 미국 DST: 3월 둘째 일요일 ~ 11월 첫째 일요일
  const year = date.getFullYear();

  // 3월 둘째 일요일
  const marchSecondSunday = getNthDayOfMonth(year, 2, 0, 2);
  // 11월 첫째 일요일
  const novFirstSunday = getNthDayOfMonth(year, 10, 0, 1);

  return date >= marchSecondSunday && date < novFirstSunday;
}

// 스킵된 날짜 정보
interface SkippedDay {
  date: string;      // MM/DD 형식
  dayOfWeek: string;
  reason: string;    // 휴일명 또는 '주말', '조기마감'
  type: 'holiday' | 'weekend' | 'early_close';
}

// LOC 주문 체결 예정 시간 (미국 동부 기준 오후 4시)
export function getNextLOCExecutionTime(fromDate: Date = new Date()): {
  date: Date;
  dateStr: string;
  dayOfWeek: string;
  isToday: boolean;
  daysUntil: number;
  executionTimeKST: string;  // 한국시간 체결 예정 시간
  executionTimeET: string;   // 미국 동부시간 체결 예정 시간
  isEarlyClose: boolean;     // 조기 마감일 여부
  earlyCloseName: string | null;  // 조기 마감일 이름
  skippedDays: SkippedDay[]; // 스킵된 날짜들 (휴일, 주말, 조기마감)
} {
  const now = new Date();
  const koreaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const usEasternTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

  // 현재 미국 동부 시간 기준으로 장 마감 전인지 확인
  const usHour = usEasternTime.getHours();
  const usMinutes = usEasternTime.getMinutes();

  let checkDate = new Date(fromDate);
  checkDate.setHours(0, 0, 0, 0);

  // 오늘이 거래일이고 장 마감 전(오후 4시 전)이면 오늘 체결
  const todayIsTradingDay = isUSMarketOpen(checkDate);
  const todayIsEarlyClose = isUSMarketEarlyCloseDay(checkDate);
  // 조기 마감일은 1:00 PM ET 마감이므로 beforeMarketClose 기준이 다름
  const beforeMarketClose = todayIsEarlyClose
    ? (usHour < 13 || (usHour === 13 && usMinutes === 0))
    : (usHour < 16 || (usHour === 16 && usMinutes === 0));

  let targetDate: Date;
  let isToday = false;
  const skippedDays: SkippedDay[] = [];
  const days = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

  // 스킵되는 날짜들 수집 (오늘부터 다음 거래일까지)
  const collectSkippedDays = (start: Date, end: Date) => {
    const current = new Date(start);
    current.setDate(current.getDate() + 1); // 시작일 다음날부터

    while (current < end) {
      const dayOfWeekNum = current.getDay();
      const dateStr = `${current.getMonth() + 1}/${current.getDate()}`;

      if (dayOfWeekNum === 0 || dayOfWeekNum === 6) {
        skippedDays.push({
          date: dateStr,
          dayOfWeek: days[dayOfWeekNum],
          reason: '주말',
          type: 'weekend',
        });
      } else if (isUSMarketHoliday(current)) {
        skippedDays.push({
          date: dateStr,
          dayOfWeek: days[dayOfWeekNum],
          reason: getHolidayName(current) || '미국 휴일',
          type: 'holiday',
        });
      }
      current.setDate(current.getDate() + 1);
    }
  };

  if (todayIsTradingDay && beforeMarketClose && !todayIsEarlyClose) {
    targetDate = checkDate;
    isToday = true;
  } else {
    // 오늘이 조기 마감일이고 이미 장이 마감된 경우
    if (todayIsEarlyClose && !beforeMarketClose) {
      const earlyName = getEarlyCloseDayName(checkDate);
      skippedDays.push({
        date: `${checkDate.getMonth() + 1}/${checkDate.getDate()}`,
        dayOfWeek: days[checkDate.getDay()],
        reason: earlyName ? `${earlyName} (조기마감)` : '조기마감',
        type: 'early_close',
      });
    }
    // 오늘이 휴일인 경우
    if (!todayIsTradingDay && checkDate.getDay() !== 0 && checkDate.getDay() !== 6) {
      const holidayName = getHolidayName(checkDate);
      if (holidayName) {
        skippedDays.push({
          date: `${checkDate.getMonth() + 1}/${checkDate.getDate()}`,
          dayOfWeek: days[checkDate.getDay()],
          reason: holidayName,
          type: 'holiday',
        });
      }
    }

    targetDate = getNextTradingDay(checkDate);
    collectSkippedDays(checkDate, targetDate);
  }

  const dayOfWeek = days[targetDate.getDay()];

  // 오늘부터 며칠 후인지
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysUntil = Math.round((targetDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));

  // 날짜 포맷 (예: 12/16)
  const dateStr = `${targetDate.getMonth() + 1}/${targetDate.getDate()}`;

  // 체결 시간 계산 (미국 동부시간 16:00 장 마감)
  // DST 여부에 따라 한국시간 계산
  // - DST (3월~11월): ET = UTC-4, KST = UTC+9 → 차이 13시간
  // - 표준시 (11월~3월): ET = UTC-5, KST = UTC+9 → 차이 14시간
  const isDST = isUSEasternDST(targetDate);

  // 대상 날짜가 조기 마감일인지 확인
  const targetIsEarlyClose = isUSMarketEarlyCloseDay(targetDate);
  const earlyCloseName = targetIsEarlyClose ? getEarlyCloseDayName(targetDate) : null;

  // 조기 마감일은 1:00 PM ET 마감
  let executionTimeET: string;
  let executionTimeKST: string;

  if (targetIsEarlyClose) {
    executionTimeET = '13:00 ET (조기마감)';
    const kstHour = isDST ? 2 : 3; // 다음날 새벽 2시 또는 3시
    executionTimeKST = `${kstHour}:00 (다음날 새벽)`;
  } else {
    executionTimeET = '16:00 ET';
    const kstHour = isDST ? 5 : 6; // 다음날 새벽 5시 또는 6시
    executionTimeKST = `${kstHour}:00 (다음날 새벽)`;
  }

  return {
    date: targetDate,
    dateStr,
    dayOfWeek,
    isToday,
    daysUntil,
    executionTimeKST,
    executionTimeET,
    isEarlyClose: targetIsEarlyClose,
    earlyCloseName,
    skippedDays,
  };
}

// 휴일 이름 반환
export function getHolidayName(date: Date): string | null {
  const year = date.getFullYear();
  const dateStr = toLocalDateString(date);

  // 각 휴일 체크
  if (toLocalDateString(observedHoliday(new Date(year, 0, 1))) === dateStr) {
    return '새해 첫날';
  }
  if (toLocalDateString(getNthDayOfMonth(year, 0, 1, 3)) === dateStr) {
    return '마틴 루터 킹 주니어의 날';
  }
  if (toLocalDateString(getNthDayOfMonth(year, 1, 1, 3)) === dateStr) {
    return '대통령의 날';
  }
  if (toLocalDateString(getGoodFriday(year)) === dateStr) {
    return '성금요일';
  }
  if (toLocalDateString(getLastDayOfMonth(year, 4, 1)) === dateStr) {
    return '현충일';
  }
  if (toLocalDateString(observedHoliday(new Date(year, 5, 19))) === dateStr) {
    return '준틴스 독립기념일';
  }
  if (toLocalDateString(observedHoliday(new Date(year, 6, 4))) === dateStr) {
    return '독립기념일';
  }
  if (toLocalDateString(getNthDayOfMonth(year, 8, 1, 1)) === dateStr) {
    return '노동절';
  }
  if (toLocalDateString(getNthDayOfMonth(year, 10, 4, 4)) === dateStr) {
    return '추수감사절';
  }
  if (toLocalDateString(observedHoliday(new Date(year, 11, 25))) === dateStr) {
    return '크리스마스';
  }

  return null;
}
