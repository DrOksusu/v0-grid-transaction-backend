-- 월별 수익 조회 쿼리 최적화용 복합 인덱스
-- 느린 쿼리: WHERE type='sell' AND status='filled' AND exchange=? AND createdAt BETWEEN ? AND ?
CREATE INDEX `idx_trades_exchange_type_status_createdAt` ON `trades`(`exchange`, `type`, `status`, `createdAt`);
