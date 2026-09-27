-- KRW 로밍 자동실행 설정 (전 종목 후보 스캔→자동 실행)
CREATE TABLE `arb_roam_configs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `autoExecute` BOOLEAN NOT NULL DEFAULT false,
    `minNetPct` DOUBLE NOT NULL DEFAULT 1,
    `orderKrw` DOUBLE NOT NULL DEFAULT 100000,
    `cooldownSec` INTEGER NOT NULL DEFAULT 300,
    `dailyMaxCount` INTEGER NULL DEFAULT 50,
    `dailyMaxLossKrw` DOUBLE NULL DEFAULT 50000,
    `killSwitch` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `arb_roam_configs_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
