-- AlterTable: MakerTakerSimBot에 sellStrategy 컬럼 추가
-- TAKER_SELL_FIRST(기본) | MAKER_SELL_FIRST(지정가 ASK 대기 후 IOC 매수)
ALTER TABLE `maker_taker_sim_bots` ADD COLUMN `sellStrategy` VARCHAR(191) NOT NULL DEFAULT 'TAKER_SELL_FIRST';
