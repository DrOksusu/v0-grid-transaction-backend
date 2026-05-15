-- AlterTable: MakerTakerSimBot에 takerUpgradeBps 컬럼 추가
-- PENDING 중 spread >= 이 값(bp)이면 maker 취소 후 taker IOC 매수. null=비활성
ALTER TABLE `maker_taker_sim_bots` ADD COLUMN `takerUpgradeBps` INT NULL;
