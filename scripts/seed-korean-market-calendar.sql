-- 2026년 KRX 공식 휴장일 시드. 토스 휴장일 sync 동작 시점까지 fallback.
-- 실행: npx prisma db execute --file scripts/seed-korean-market-calendar.sql --schema prisma/schema.prisma
INSERT INTO `korean_market_calendar` (`date`, `isOpen`, `reason`) VALUES
  ('2026-01-01', 0, '신정'),
  ('2026-02-16', 0, '설날 연휴'),
  ('2026-02-17', 0, '설날'),
  ('2026-02-18', 0, '설날 연휴'),
  ('2026-03-01', 0, '삼일절'),
  ('2026-05-05', 0, '어린이날'),
  ('2026-05-25', 0, '석가탄신일'),
  ('2026-06-06', 0, '현충일'),
  ('2026-08-15', 0, '광복절'),
  ('2026-09-25', 0, '추석 연휴'),
  ('2026-09-26', 0, '추석'),
  ('2026-09-27', 0, '추석 연휴'),
  ('2026-10-03', 0, '개천절'),
  ('2026-10-09', 0, '한글날'),
  ('2026-12-25', 0, '성탄절'),
  ('2026-12-31', 0, '연말 마지막 거래일 (조기 폐장)')
ON DUPLICATE KEY UPDATE
  `isOpen` = VALUES(`isOpen`),
  `reason` = VALUES(`reason`);
