-- CrossExchangeArbBot 에 skip 이유 저장 컬럼 추가
-- lastSkipReason: 스킵 원인 문자열 (orderbook null, spread gate, precheck 등)
-- lastSkipAt: 마지막 스킵 시각
ALTER TABLE `cross_exchange_arb_bots`
  ADD COLUMN `lastSkipReason` VARCHAR(500) NULL,
  ADD COLUMN `lastSkipAt` DATETIME(3) NULL;
