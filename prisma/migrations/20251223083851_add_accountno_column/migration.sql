-- DropIndex
DROP INDEX `infinite_buy_stocks_userId_ticker_idx` ON `infinite_buy_stocks`;

-- AlterTable
ALTER TABLE `infinite_buy_stocks` ADD COLUMN `accountNo` VARCHAR(191) NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX `infinite_buy_stocks_userId_accountNo_idx` ON `infinite_buy_stocks`(`userId`, `accountNo`);

-- CreateIndex
CREATE INDEX `infinite_buy_stocks_userId_accountNo_ticker_idx` ON `infinite_buy_stocks`(`userId`, `accountNo`, `ticker`);
