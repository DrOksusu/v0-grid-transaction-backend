-- AlterTable
ALTER TABLE `maker_taker_sim_bots` ADD COLUMN `lastResumeAt` DATETIME(3) NULL,
    ADD COLUMN `minSpreadKrw` INTEGER NOT NULL DEFAULT 12;
