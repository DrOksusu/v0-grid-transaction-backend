-- AlterTable
ALTER TABLE `maker_taker_sim_bots` ADD COLUMN `live` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `maker_taker_sim_trades` ADD COLUMN `live` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `makerOrderUuid` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `stablecoin_arb_bots` ADD COLUMN `live` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `stablecoin_arb_trades` ADD COLUMN `krwFlowNetKrw` DECIMAL(18, 4) NULL;
