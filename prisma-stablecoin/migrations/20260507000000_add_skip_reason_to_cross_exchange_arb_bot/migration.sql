-- CrossExchangeArbBot 에 skip 이유 저장 컬럼 추가
-- lastSkipReason: 스킵 원인 문자열 (orderbook null, spread gate, precheck 등)
-- lastSkipAt: 마지막 스킵 시각
-- 참고: 이 컬럼들은 이미 수동 ALTER TABLE로 추가됨. 마이그레이션 히스토리 정합용.
SELECT 'columns already applied manually' AS migration_note;
