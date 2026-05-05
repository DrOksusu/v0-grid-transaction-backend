-- 크로스 거래소 지원: makerExchange, takerExchange 컬럼 추가
ALTER TABLE `maker_taker_sim_bots`
  ADD COLUMN `makerExchange` VARCHAR(191) NOT NULL DEFAULT 'upbit',
  ADD COLUMN `takerExchange` VARCHAR(191) NOT NULL DEFAULT 'upbit';
