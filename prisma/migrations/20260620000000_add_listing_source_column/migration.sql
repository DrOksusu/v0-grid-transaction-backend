-- DropIndex
DROP INDEX `upbit_listing_announcements_noticeId_key` ON `upbit_listing_announcements`;

-- AlterTable
ALTER TABLE `listing_auto_orders` ADD COLUMN `source` ENUM('UPBIT', 'BITHUMB') NOT NULL DEFAULT 'UPBIT';

-- AlterTable
ALTER TABLE `listing_auto_trade_config` ADD COLUMN `killSwitch` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `minTakerBalance` DOUBLE NULL,
    ADD COLUMN `source` ENUM('UPBIT', 'BITHUMB') NOT NULL DEFAULT 'UPBIT';

-- AlterTable
ALTER TABLE `upbit_listing_announcements` ADD COLUMN `source` ENUM('UPBIT', 'BITHUMB') NOT NULL DEFAULT 'UPBIT';

-- CreateIndex
CREATE INDEX `listing_auto_orders_source_createdAt_idx` ON `listing_auto_orders`(`source`, `createdAt`);

-- CreateIndex
CREATE UNIQUE INDEX `listing_auto_trade_config_source_key` ON `listing_auto_trade_config`(`source`);

-- CreateIndex
CREATE INDEX `upbit_listing_announcements_source_announcedAt_idx` ON `upbit_listing_announcements`(`source`, `announcedAt`);

-- CreateIndex
CREATE UNIQUE INDEX `upbit_listing_announcements_source_noticeId_key` ON `upbit_listing_announcements`(`source`, `noticeId`);
