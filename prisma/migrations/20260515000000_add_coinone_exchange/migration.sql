-- AlterEnum: Exchange에 coinone 추가
ALTER TABLE `bots` MODIFY COLUMN `exchange` ENUM('upbit','binance','kis','bithumb','mexc','gateio','coinone') NOT NULL;
ALTER TABLE `credentials` MODIFY COLUMN `exchange` ENUM('upbit','binance','kis','bithumb','mexc','gateio','coinone') NOT NULL;
ALTER TABLE `profit_snapshots` MODIFY COLUMN `exchange` ENUM('upbit','binance','kis','bithumb','mexc','gateio','coinone') NOT NULL DEFAULT 'upbit';
ALTER TABLE `monthly_profits` MODIFY COLUMN `exchange` ENUM('upbit','binance','kis','bithumb','mexc','gateio','coinone') NOT NULL DEFAULT 'upbit';
