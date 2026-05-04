-- AlterTable
ALTER TABLE `arb_auto_config` MODIFY `bithumbEnabled` BOOLEAN NOT NULL DEFAULT true,
    MODIFY `upbitEnabled` BOOLEAN NOT NULL DEFAULT true,
    MODIFY `crossEnabled` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `cross_exchange_arb_bots` ADD COLUMN `buyCoin` VARCHAR(191) NULL,
    ADD COLUMN `sellCoin` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `cross_exchange_arb_trades` ADD COLUMN `legACoin` VARCHAR(191) NULL,
    ADD COLUMN `legBCoin` VARCHAR(191) NULL;
