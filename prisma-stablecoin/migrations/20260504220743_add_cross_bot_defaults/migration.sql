-- AlterTable
ALTER TABLE `arb_auto_config` ADD COLUMN `crossBotDailyCountLimit` INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN `crossBotDailyLossLimitKrw` INTEGER NOT NULL DEFAULT 50000,
    ADD COLUMN `crossBotMinSpreadBps` INTEGER NOT NULL DEFAULT 50;
