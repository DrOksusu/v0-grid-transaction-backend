-- AlterTable
ALTER TABLE `bots` ADD COLUMN `feeRate` DOUBLE NULL,
    ADD COLUMN `market` ENUM('CRYPTO', 'KOREAN_STOCK') NOT NULL DEFAULT 'CRYPTO',
    ADD COLUMN `taxRate` DOUBLE NULL,
    MODIFY `exchange` ENUM('upbit', 'binance', 'kis', 'bithumb', 'mexc', 'gateio', 'coinone', 'toss') NOT NULL;

-- AlterTable
ALTER TABLE `credentials` ADD COLUMN `accountSeq` VARCHAR(191) NULL,
    MODIFY `exchange` ENUM('upbit', 'binance', 'kis', 'bithumb', 'mexc', 'gateio', 'coinone', 'toss') NOT NULL;

-- AlterTable
ALTER TABLE `monthly_profits` MODIFY `exchange` ENUM('upbit', 'binance', 'kis', 'bithumb', 'mexc', 'gateio', 'coinone', 'toss') NOT NULL;

-- AlterTable
ALTER TABLE `profit_snapshots` MODIFY `exchange` ENUM('upbit', 'binance', 'kis', 'bithumb', 'mexc', 'gateio', 'coinone', 'toss') NOT NULL;

-- CreateTable
CREATE TABLE `korean_stock_symbols` (
    `code` VARCHAR(10) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `market` VARCHAR(191) NOT NULL,
    `sector` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `korean_stock_symbols_name_idx`(`name`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `korean_market_calendar` (
    `date` DATE NOT NULL,
    `isOpen` BOOLEAN NOT NULL,
    `reason` VARCHAR(191) NULL,

    PRIMARY KEY (`date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `bots_market_idx` ON `bots`(`market`);

-- CreateIndex
CREATE INDEX `bots_userId_market_idx` ON `bots`(`userId`, `market`);

