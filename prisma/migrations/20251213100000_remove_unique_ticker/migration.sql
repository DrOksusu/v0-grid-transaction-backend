-- DropIndex: Remove unique constraint to allow duplicate tickers
DROP INDEX `infinite_buy_stocks_userId_ticker_key` ON `infinite_buy_stocks`;

-- CreateIndex: Add regular index for performance
CREATE INDEX `infinite_buy_stocks_userId_ticker_idx` ON `infinite_buy_stocks`(`userId`, `ticker`);
