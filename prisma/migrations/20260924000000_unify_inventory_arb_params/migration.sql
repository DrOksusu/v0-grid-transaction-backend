-- USDT 봇과 파라미터 통일: net% 임계·고정 규모·손실 한도 컬럼 추가 (기존 컬럼 보존)
ALTER TABLE `inventory_arb_bots`
  ADD COLUMN `thresholdPct` DOUBLE NOT NULL DEFAULT 2,
  ADD COLUMN `orderKrw` DOUBLE NOT NULL DEFAULT 100000,
  ADD COLUMN `dailyMaxLossKrw` DOUBLE NULL;

-- 백필: 기존 봇의 gross bps → % 환산(/100), 주문 규모 이관. (net 의미 전환은 코드에서 처리)
UPDATE `inventory_arb_bots` SET `thresholdPct` = `minSpreadBps` / 100, `orderKrw` = `maxOrderKrw`;
