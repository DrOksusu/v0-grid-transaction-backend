-- AlterTable: maker_taker_sim_trades에 takerOrderUuid 컬럼 추가
-- TAKER_PENDING 상태에서 taker 지정가 매도 주문 UUID 저장용
ALTER TABLE `maker_taker_sim_trades` ADD COLUMN `takerOrderUuid` VARCHAR(64) NULL;
