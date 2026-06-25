-- 24h 중복 매수 체크 쿼리 (source + ticker + createdAt gte) 인덱스 추가
-- listing-auto-trader.executeBuy() 핫 path 최적화
CREATE INDEX `listing_auto_orders_source_ticker_createdAt_idx` ON `listing_auto_orders`(`source`, `ticker`, `createdAt`);
