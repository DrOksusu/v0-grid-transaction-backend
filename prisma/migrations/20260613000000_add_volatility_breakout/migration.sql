-- CreateTable
CREATE TABLE `volatility_breakout_bots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `market` VARCHAR(191) NOT NULL,
    `buy_amount_krw` DOUBLE NOT NULL,
    `k` DOUBLE NOT NULL DEFAULT 0.65,
    `stop_loss_pct` DOUBLE NOT NULL DEFAULT 3,
    `live` BOOLEAN NOT NULL DEFAULT false,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `volatility_breakout_bots_user_id_market_key`(`user_id`, `market`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `volatility_breakout_trades` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `bot_id` INTEGER NOT NULL,
    `trade_date` VARCHAR(191) NOT NULL,
    `target_price` DOUBLE NOT NULL,
    `entry_price` DOUBLE NOT NULL,
    `entry_at` DATETIME(3) NOT NULL,
    `qty` DOUBLE NOT NULL,
    `exit_price` DOUBLE NULL,
    `exit_at` DATETIME(3) NULL,
    `exit_reason` VARCHAR(191) NULL,
    `pnl_krw` DOUBLE NULL,
    `pnl_pct` DOUBLE NULL,
    `is_live` BOOLEAN NOT NULL,
    `status` VARCHAR(191) NOT NULL,

    INDEX `volatility_breakout_trades_bot_id_trade_date_idx`(`bot_id`, `trade_date`),
    INDEX `volatility_breakout_trades_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `volatility_breakout_bots` ADD CONSTRAINT `volatility_breakout_bots_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `volatility_breakout_trades` ADD CONSTRAINT `volatility_breakout_trades_bot_id_fkey` FOREIGN KEY (`bot_id`) REFERENCES `volatility_breakout_bots`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

