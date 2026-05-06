-- CrossExchangeArbBot 에 skip 이유 저장 컬럼 추가
-- lastSkipReason: 스킵 원인 문자열 (orderbook null, spread gate, precheck 등)
-- lastSkipAt: 마지막 스킵 시각
-- IF NOT EXISTS: 수동 ALTER TABLE 선적용 시 중복 에러 방지 (MySQL 8.0+ 지원)
ALTER TABLE `cross_exchange_arb_bots`
  ADD COLUMN IF NOT EXISTS `lastSkipReason` VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS `lastSkipAt` DATETIME(3) NULL;
