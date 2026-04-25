// 모든 테스트 실행 전 환경변수 주입.
// env.ts가 import 시점에 ADMIN_EMAIL 미설정이면 throw하므로,
// 테스트 환경에서는 더미 값으로 채워둔다.
// 개별 테스트가 미설정 동작을 검증할 때는 헬퍼에서 명시적으로 unset.
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'test-admin@example.com';
