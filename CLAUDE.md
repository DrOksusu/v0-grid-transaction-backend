# 백엔드 개발 에이전트

> Language, 커밋 컨벤션, 서브에이전트 규칙은 글로벌 `~/.claude/CLAUDE.md`에 정의되어 있음

## 역할
백엔드 개발 에이전트. API, 서비스, 데이터베이스 작업을 담당한다.

## Tech Stack
- Express 5, TypeScript, Prisma (MySQL), Socket.IO, JWT
- Node.js 런타임, ts-node-dev 개발 서버

## 자주 쓰는 명령
- `npm run dev` — 개발 서버 시작 (ts-node-dev, 핫 리로드)
- `npm run build` — 프로덕션 빌드 (prisma generate + tsc)
- `npx prisma migrate dev` — DB 마이그레이션 실행
- `npx prisma studio` — DB GUI 브라우저
- `npx tsc --noEmit` — 타입 체크 (빌드 없이 검증)

## 코드 컨벤션

### 아키텍처 패턴: Controller → Service → Prisma
```
라우트 → 컨트롤러 (요청 파싱/검증) → 서비스 (비즈니스 로직) → Prisma (DB)
```
- 컨트롤러: `src/controllers/*.controller.ts` — req/res 처리만
- 서비스: `src/services/*.service.ts` — 핵심 비즈니스 로직
- Prisma: `prisma/schema.prisma` — 데이터 모델 정의

### 에러 처리 패턴
```typescript
// 컨트롤러에서 try-catch로 감싸고, 에러는 전역 핸들러에 위임
try {
  const result = await someService.doSomething(req.body);
  res.json(result);
} catch (error) {
  next(error);
}
```

### 새 API 추가 시 체크리스트
1. `prisma/schema.prisma`에 모델 추가/수정 → `npx prisma migrate dev`
2. `src/services/`에 서비스 로직 구현
3. `src/controllers/`에 컨트롤러 구현
4. `src/routes/`에 라우트 등록
5. `npx tsc --noEmit`으로 타입 체크

## 금지 사항
- 프론트엔드(`v0-grid-transaction-frontend/`) 파일 절대 수정 금지
- `.env` 파일 커밋 금지
- `node_modules/`, `dist/` 수정 금지
- 새 ORM이나 DB 라이브러리 설치 금지 (Prisma 사용)

## 검증 방법
- **타입 체크**: `npx tsc --noEmit` — 에러 0개 확인
- **빌드 확인**: `npm run build` — 컴파일 성공 확인
- **서버 시작**: `npm run dev` — 서버 정상 기동 확인

## 주요 파일 경로
- 엔트리포인트: `src/index.ts`
- 앱 설정: `src/app.ts`
- DB 설정: `src/config/database.ts`
- 환경 변수: `src/config/env.ts`
- 전역 에러 핸들러: `src/middlewares/errorHandler.ts`
- JWT 인증: `src/middlewares/auth.ts`

## 배포
1. `npm run build` 성공 확인
2. main 브랜치에 push → GitHub Actions 자동 배포 (Docker → Lightsail)
