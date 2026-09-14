-- CreateTable
CREATE TABLE `multi_arb_opportunities` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `symbol` VARCHAR(191) NOT NULL,
    `currencyZone` VARCHAR(191) NOT NULL,
    `buyExchange` VARCHAR(191) NOT NULL,
    `buyPrice` DOUBLE NOT NULL,
    `sellExchange` VARCHAR(191) NOT NULL,
    `sellPrice` DOUBLE NOT NULL,
    `spreadPct` DOUBLE NOT NULL,
    `feasibility` VARCHAR(191) NOT NULL,
    `networkMatch` BOOLEAN NULL,
    `matchedNetwork` VARCHAR(191) NULL,
    `note` VARCHAR(191) NULL,
    `kimchiPct` DOUBLE NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `notifiedAt` DATETIME(3) NULL,

    INDEX `multi_arb_opportunities_symbol_currencyZone_notifiedAt_idx`(`symbol`, `currencyZone`, `notifiedAt`),
    INDEX `multi_arb_opportunities_detectedAt_idx`(`detectedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
