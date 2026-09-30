-- 재고 되돌림 리컨실러 설정 (빗썸→업비트 재장전, 순차익≥임계 시 자동 체결)
CREATE TABLE `arb_reclaim_configs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `minNetPct` DOUBLE NOT NULL DEFAULT 0,
    `maxOrderKrw` DOUBLE NOT NULL DEFAULT 50000,
    `dailyMaxCount` INTEGER NULL DEFAULT 50,
    `dailyMaxKrw` DOUBLE NULL DEFAULT 1000000,
    `withdrawFeePctThreshold` DOUBLE NOT NULL DEFAULT 0.3,
    `imbalanceCapKrw` DOUBLE NOT NULL DEFAULT 100000,
    `killSwitch` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `arb_reclaim_configs_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 재고 되돌림 리컨실러 체결 이력
CREATE TABLE `arb_reclaim_trades` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `symbol` VARCHAR(191) NOT NULL,
    `qty` DOUBLE NOT NULL,
    `bithumbSellPrice` DOUBLE NOT NULL,
    `upbitBuyPrice` DOUBLE NOT NULL,
    `sellFilled` DOUBLE NOT NULL DEFAULT 0,
    `buyFilled` DOUBLE NOT NULL DEFAULT 0,
    `grossKrw` DOUBLE NOT NULL DEFAULT 0,
    `feeKrw` DOUBLE NOT NULL DEFAULT 0,
    `netKrw` DOUBLE NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `arb_reclaim_trades_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
