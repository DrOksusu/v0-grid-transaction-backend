# 백엔드 개발 에이전트

## 역할
백엔드 개발 에이전트. API, 서비스, 데이터베이스 작업을 담당한다.

## Language
- 모든 응답은 한국어로 작성할 것
- 코드 주석도 한국어로 작성

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
2. `docker build -t grid-backend .`
3. AWS AppRunner에 배포

---

# 공통 규칙 (프론트엔드 CLAUDE.md와 동기화 유지할 것)
> 아래 내용을 수정할 경우, 반드시 프론트엔드 `CLAUDE.md`의 동일 섹션도 함께 수정한다.
> 원본 위치: 루트 `Grid_project/CLAUDE.md`

## 전체 프로젝트 구조
- `v0-grid-tranasction-backend/` — Express 백엔드 서버 (이 저장소)
- `v0-grid-transaction-frontend/` — Next.js 프론트엔드 웹앱
- `grid_trading_app/` — Flutter 모바일 앱 (Android/iOS)

## 서브에이전트 워크플로우

### 역할 분담
이 프로젝트는 2~3개 Claude Code 터미널을 동시에 열어 병렬 작업이 가능하다:

| 터미널 | 작업 디렉토리 | 역할 |
|--------|-------------|------|
| 터미널 1 (백엔드) | `v0-grid-tranasction-backend/` | API, 서비스, DB 작업 |
| 터미널 2 (프론트엔드) | `v0-grid-transaction-frontend/` | UI, 페이지, 컴포넌트 작업 |
| 터미널 3 (통합/리뷰) | `Grid_project/` (루트) | 리뷰, 빌드 확인, 커밋, 배포 |

### 작업 간 의존성 규칙
- **백엔드 API 먼저 → 프론트엔드 연동**: 새 API가 필요한 기능은 백엔드부터 구현
- **프론트엔드 UI 먼저 가능**: API 완성 전에 UI/목업 먼저 작업 가능
- **DB 스키마 변경**: 반드시 백엔드 터미널에서 `npx prisma migrate dev` 실행
- **충돌 방지**: 같은 파일을 동시에 수정하지 않도록 역할 분담 준수

### 병렬 작업 예시
```
기능: "무한매수법에 손절 기능 추가"

터미널 1 (백엔드):
  → Prisma 스키마에 stopLoss 필드 추가 + 마이그레이션
  → infinite-buy.service.ts에 손절 로직 구현
  → API 엔드포인트 추가

터미널 2 (프론트엔드):
  → 손절 설정 폼 UI 구현 (API 완성 전 가능)
  → lib/api.ts에 새 API 함수 추가
  → 페이지에 손절 UI 통합

터미널 3 (통합):
  → 양쪽 변경사항 리뷰
  → 전체 빌드 확인 → 커밋 → 배포
```

## 커밋 컨벤션
```
feat: 새 기능 추가
fix: 버그 수정
refactor: 코드 리팩토링 (기능 변경 없음)
style: 코드 포맷, 세미콜론 등 (기능 변경 없음)
docs: 문서 추가/수정
chore: 빌드, 설정 파일 변경
test: 테스트 추가/수정
```
- 제목은 50자 이내, 한국어 사용
- 예: `feat: 무한매수법 손절 기능 추가`

## 배포 절차

### 프론트엔드 (Vercel)
1. `v0-grid-transaction-frontend/`에서 `npm run build` 성공 확인
2. main 브랜치에 push → Vercel 자동 배포

### 백엔드 (Docker → AWS)
1. `v0-grid-tranasction-backend/`에서 `npm run build` 성공 확인
2. `docker build -t grid-backend .`
3. AWS에 배포 (AppRunner 사용)
