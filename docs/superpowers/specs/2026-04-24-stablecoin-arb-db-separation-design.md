# 스테이블코인 아비트리지 DB 분리 설계

> **작성일**: 2026-04-24
> **작성자**: Claude (사용자 결정 반영)
> **상태**: 승인됨 (구현 준비)
> **범위**: 세션 스코프 — **DB 분리만** (M3 실행 엔진은 다음 세션)
> **작업 브랜치**: `feat/stablecoin-arb-db-sep` (신규, main에서 분기)
> **스테이블 코드 복구 방식**: Option B — `git revert`로 기존 main의 2개 revert 커밋(`f15c6ea`, `4ed91c5`)을 되돌려 stablecoin 코드 재도입

## 0. 한 줄 요약

`grid_transaction` DB에 얹힌 M1+M2 스테이블코인 아비트리지 모델 3개를 **같은 RDS 내 신규 `grid_stablecoin_arb` database로 분리**하고, Prisma 2 clients 구조로 전환하여 **스테이블 코드 사고가 기존 Grid/InfiniteBuy/VR 봇에 전파되지 않도록 격리**한다.

## 1. 배경과 동기

### 1.1 이전 사건
- 2026-04-22 세션 3에서 스테이블코인 M1+M2 구현 중 DB 파괴 사고 발생 → PITR 복원 + main revert
- 구현물은 `feat/stablecoin-arb` 브랜치에 **원격 보존** (21 커밋)
- 세션 6에서 DB 권한 분리(`grid_app`/`grid_migrate`) 완료 → 앱 런타임 destructive 쿼리 원천 차단
- 안전 인프라가 완성되어 스테이블 코드 재개 조건 충족

### 1.2 DB 분리가 필요한 이유
- 같은 DB 내 혼재 시 스테이블 스키마 변경/데이터 오염이 **운영 중인 Grid 봇 테이블에 영향 가능**
- 별도 database로 분리하면 `grid_stablecoin_arb` 전체가 날아가도 **기존 봇 격리 유지**
- 실험적 기능(아비트리지 감지·실행)을 안정적 기능(그리드 매매)과 물리적으로 분리

### 1.3 현재 운영 DB 조사 결과 (2026-04-23 read-only 확인)

| 항목 | 상태 |
|---|---|
| `stablecoin_arb_bots` | **0 rows** (빈 테이블) |
| `stablecoin_arb_trades` | **0 rows** |
| `stablecoin_arb_opportunities` | **0 rows** |
| `_prisma_migrations` 스테이블 기록 | 2건 (`20260421000000_add_stablecoin_arb_models`, `20260421010000_fix_arb_opportunity_index_and_timestamp`) |
| `cross_exchange%` 테이블 | 없음 (feat 브랜치에만 존재, main 배포 안 됨) |

**결론**: 이전 실패 배포의 잔존물만 존재. 데이터 이전 부담 없음. 분리 후 빈 테이블 3개와 migration 기록 2건만 정리하면 깨끗해짐.

## 2. 확정된 결정 사항

사용자와의 브레인스토밍에서 단계별로 확정:

| # | 결정 항목 | 선택 |
|---|---|---|
| 1 | 세션 범위 | **DB 분리만** (M3는 다음 세션) |
| 2 | 브랜치 전략 | **신규 `feat/stablecoin-arb-db-sep`** (main에서 분기) + `git revert f15c6ea && git revert 4ed91c5`로 stablecoin 코드 복구 (세션 6 인프라 보존을 위해 Option A 대신 B 채택) |
| 3 | User ↔ StablecoinArbBot 관계 | **relation 삭제**, `userId Int @unique`만 유지 (cross-DB relation 불가) |
| 4 | `CrossExchangeSnapshot` 모델 위치 | 기존 `grid_transaction` 유지 (스테이블과 무관한 별개 기능) |
| 5 | Prisma 디렉토리 구조 | 기존 `prisma/` **유지** + `prisma-stablecoin/` 신설 |
| 6 | 마이그레이션 전략 | 기존 2개 마이그레이션 **스쿼시 → `prisma-stablecoin/migrations/20260424000000_init/` 1개로 통합** |
| 7 | 구 DB 잔존 테이블 | 분리 완료 후 사용자 재확인 받고 DROP (사전 스냅샷 + 0 rows) |

## 3. 아키텍처

```
┌────────────────────────────────────────────────────────────────┐
│               Grid-bot-DB-v2 (AWS Lightsail RDS)                │
│                                                                 │
│  ┌──────────────────────────┐    ┌────────────────────────┐   │
│  │ grid_transaction (기존)  │    │ grid_stablecoin_arb    │   │
│  │ ──────────────────────── │    │ ────────────────────── │   │
│  │ users, credentials,      │    │ stablecoin_arb_bots    │   │
│  │ grid_bots, grids,        │    │ stablecoin_arb_trades  │   │
│  │ infinite_buy_*, vr_bots, │    │ stablecoin_arb_        │   │
│  │ whale_*, profit_*,       │    │   opportunities        │   │
│  │ cross_exchange_snapshots,│    │ _prisma_migrations     │   │
│  │ _prisma_migrations       │    │                        │   │
│  └────────────▲─────────────┘    └──────────▲─────────────┘   │
│               │                              │                  │
│       grid_app (DML)             grid_stablecoin_app (DML)     │
│       grid_migrate (DDL)         grid_stablecoin_migrate (DDL) │
│       dbmasteruser (비상)        dbmasteruser (비상)           │
└───────────────┬──────────────────────────────┬─────────────────┘
                │                              │
                └────────────┬─────────────────┘
                             │
                    ┌────────┴────────┐
                    │   grid-bot 앱   │
                    │ (Node + Prisma) │
                    └─┬─────────────┬─┘
                      │             │
              PrismaClient    StablecoinPrismaClient
              (@prisma/client) (.prisma/client-stablecoin)
```

**원칙**
- 같은 RDS, 두 개의 database (물리적 격리)
- 각 DB마다 app/migrate 유저 분리 (세션 6 권한 분리 패턴 재사용)
- Node 앱은 **두 개의 Prisma client를 동시에 보유**
- 두 client는 독립 — 한쪽 장애가 다른쪽에 전파되지 않음

## 4. DB/유저 생성 절차

### 4.1 사전 조건 (필수)
- AWS Lightsail 수동 스냅샷 **`pre-stablecoin-db-separation-20260424`** 생성 (사용자 콘솔)
- Phase 2 자동 스냅샷 CI는 아직 미구축이므로 이번은 수동

### 4.2 SQL 실행 (dbmasteruser, 1회성)

`grid_migrate` 유저는 `ALL PRIVILEGES ON grid_transaction.*` 뿐이라 새 DB 생성 불가 → `dbmasteruser`로만 실행.

```sql
-- 1. DB 생성
CREATE DATABASE grid_stablecoin_arb
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- 2. 전용 유저 2개 생성
CREATE USER 'grid_stablecoin_app'@'%'
  IDENTIFIED BY '<APP_PASSWORD>';   -- 24자 URL-safe alphanumeric
CREATE USER 'grid_stablecoin_migrate'@'%'
  IDENTIFIED BY '<MIGRATE_PASSWORD>';

-- 3. 권한 부여 (DB-scoped, 다른 DB 접근 불가)
GRANT SELECT, INSERT, UPDATE, DELETE ON grid_stablecoin_arb.*
  TO 'grid_stablecoin_app'@'%';
GRANT ALL PRIVILEGES ON grid_stablecoin_arb.*
  TO 'grid_stablecoin_migrate'@'%';

FLUSH PRIVILEGES;
```

### 4.3 검증 (read-only)
```sql
SHOW GRANTS FOR 'grid_stablecoin_app'@'%';
SHOW GRANTS FOR 'grid_stablecoin_migrate'@'%';
-- 각 grant가 grid_stablecoin_arb.* 로만 제한되어 있는지 확인

-- grid_stablecoin_app이 grid_transaction 접근 안 되는지 확인
-- (별도 세션에서 grid_stablecoin_app으로 연결 후 USE grid_transaction; → 거부되어야 함)
```

### 4.4 비번 관리
- `~/.claude/memory/secrets.local.md`에 신규 섹션 "Grid-bot-DB-v2 스테이블 분리 유저 (2026-04-24 생성)" 추가
- Git 저장 절대 금지 (`*.local.md`는 `.gitignore`)
- GitHub Secrets에 URL 형태로 저장 (STABLECOIN_DATABASE_URL, STABLECOIN_MIGRATE_DATABASE_URL)

## 5. Prisma 스키마 분리

### 5.1 `prisma/schema.prisma` 수정 (제거 항목)

```diff
 model User {
   // ...
-  stablecoinArbBot  StablecoinArbBot?
   subscription      Subscription?
   // ...
 }

 enum CredentialPurpose {
   default
   infinite_buy
-  stablecoin_arb
   vr
 }

-model StablecoinArbBot { ... }
-model StablecoinArbTrade { ... }
-model StablecoinArbOpportunity { ... }
```

### 5.2 `prisma-stablecoin/schema.prisma` (신규)

```prisma
// This is your Prisma schema file for the stablecoin arbitrage database.
// separate DB: grid_stablecoin_arb

generator client {
  provider = "prisma-client-js"
  output   = "../node_modules/.prisma/client-stablecoin"
}

datasource db {
  provider = "mysql"
  url      = env("STABLECOIN_DATABASE_URL")
}

// 스테이블코인 아비트리지 봇 설정 및 상태
// Note: userId는 grid_transaction.users.id를 참조하나,
//       Prisma cross-DB relation 미지원이므로 plain Int로만 저장.
//       사용자 조회가 필요할 때는 app 레벨에서 prisma.user.findUnique 호출.
model StablecoinArbBot {
  id                  Int      @id @default(autoincrement())
  userId              Int      @unique
  credentialId        Int?     // grid_transaction.credentials.id 참조 (relation 없음)
  // ... (feat 브랜치의 기존 필드 모두 포함, User/Credential relation만 제거)

  trades              StablecoinArbTrade[]
  opportunities       StablecoinArbOpportunity[]

  @@map("stablecoin_arb_bots")
}

model StablecoinArbTrade {
  // feat 브랜치 그대로 (botId relation은 같은 DB 내 → 유지)
  @@map("stablecoin_arb_trades")
}

model StablecoinArbOpportunity {
  @@map("stablecoin_arb_opportunities")
}
```

### 5.3 마이그레이션

- 기존: `prisma/migrations/20260421000000_add_stablecoin_arb_models/` + `prisma/migrations/20260421010000_fix_arb_opportunity_index_and_timestamp/` **삭제**
- 신규: `prisma-stablecoin/migrations/20260424000000_init/migration.sql` 1개
  - 내용: `CREATE TABLE stablecoin_arb_bots`, `stablecoin_arb_trades`, `stablecoin_arb_opportunities` + 인덱스 (기존 2개 마이그레이션의 최종 상태 그대로)
- 로컬에서 `prisma migrate dev --schema=prisma-stablecoin/schema.prisma --name init` 실행하여 생성

## 6. Prisma Client 코드 구조

### 6.1 `src/config/database.ts` 확장

```typescript
import { PrismaClient } from '@prisma/client'
import { PrismaClient as StablecoinPrismaClient } from '.prisma/client-stablecoin'

// 기존 그대로
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

// 신규
export const stablecoinPrisma = new StablecoinPrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

// graceful shutdown
process.on('beforeExit', async () => {
  await Promise.allSettled([
    prisma.$disconnect(),
    stablecoinPrisma.$disconnect(),
  ])
})
```

### 6.2 import 경로 변경 (영향 파일, feat 브랜치 기준)

| 파일 | 변경 |
|---|---|
| `src/services/stablecoin-inventory.service.ts` | `import { prisma }` → `import { stablecoinPrisma as prisma }` (또는 완전 rename) |
| `src/services/stablecoin-arb.service.ts` | 동일 |
| `src/agents/stablecoin-arb-agent.ts` | 동일 |
| `__tests__/services/stablecoin-inventory.service.test.ts` | mock 설정 업데이트 |
| `__tests__/services/stablecoin-arb-detector.test.ts` | (순수 함수 중심 → 변경 없을 가능성) |

**명명 컨벤션**: 헷갈림 방지를 위해 스테이블 서비스 내부에서는 `stablecoinPrisma`를 `prisma`로 alias하지 않고 명시적으로 `stablecoinPrisma`로 사용 권장.

### 6.3 User 조회 패턴

기존 (relation 사용):
```typescript
const bot = await prisma.stablecoinArbBot.findUnique({
  where: { id },
  include: { user: true },  // ❌ cross-DB relation 불가
})
```

신규 (app-level 조인):
```typescript
const bot = await stablecoinPrisma.stablecoinArbBot.findUnique({ where: { id } })
if (!bot) return null
const user = await prisma.user.findUnique({ where: { id: bot.userId } })
```

feat 브랜치에서 이 패턴을 사용하는 곳이 있는지 grep 후 수정.

## 7. 배포 파이프라인

### 7.1 Dockerfile CMD 확장

```dockerfile
CMD sh -c "\
  DATABASE_URL=\"\$MIGRATE_DATABASE_URL\" npx prisma migrate deploy --schema=prisma/schema.prisma && \
  STABLECOIN_DATABASE_URL=\"\$STABLECOIN_MIGRATE_DATABASE_URL\" npx prisma migrate deploy --schema=prisma-stablecoin/schema.prisma && \
  node dist/index.js"
```

**포인트**
- 첫번째 migrate: grid_migrate URL을 DATABASE_URL로 임시 override (세션 6 패턴)
- 두번째 migrate: grid_stablecoin_migrate URL을 STABLECOIN_DATABASE_URL로 임시 override
- Node 실행은 원래 env(STABLECOIN_DATABASE_URL=app 유저)로 돌아옴

### 7.2 `.github/workflows/deploy.yml` 수정

`docker run` 명령의 `-e` 옵션에 2줄 추가:

```yaml
-e "STABLECOIN_DATABASE_URL=${{ secrets.STABLECOIN_DATABASE_URL }}" \
-e "STABLECOIN_MIGRATE_DATABASE_URL=${{ secrets.STABLECOIN_MIGRATE_DATABASE_URL }}" \
```

### 7.3 GitHub Secrets (gh CLI로 설정)

| Secret | 값 |
|---|---|
| `STABLECOIN_DATABASE_URL` | `mysql://grid_stablecoin_app:<pw>@<host>:3306/grid_stablecoin_arb?charset=utf8mb4&connection_limit=50&pool_timeout=30&connect_timeout=30` |
| `STABLECOIN_MIGRATE_DATABASE_URL` | `mysql://grid_stablecoin_migrate:<pw>@<host>:3306/grid_stablecoin_arb?charset=utf8mb4&connection_limit=5&pool_timeout=30&connect_timeout=30` |

- `connection_limit=50` (app): 기존 100보다 낮게 — 실험 기능이므로
- `connection_limit=5` (migrate): 마이그레이션만 쓰므로 충분
- gh secret set: `--body-file -` stdin pipe (process list 노출 회피)

### 7.4 로컬 `.env` 업데이트

`v0-grid-tranasction-backend/.env`에 추가 (로컬 dev DB 기준):

```
STABLECOIN_DATABASE_URL=mysql://root:<local>@localhost:3306/grid_stablecoin_arb
STABLECOIN_MIGRATE_DATABASE_URL=mysql://root:<local>@localhost:3306/grid_stablecoin_arb
```

로컬은 권한 분리 없이 단일 유저 허용 (세션 6에서 이미 결정된 패턴).

### 7.5 `package.json` 스크립트 보강

```json
{
  "scripts": {
    "db:generate": "prisma generate && prisma generate --schema=prisma-stablecoin/schema.prisma",
    "db:migrate": "prisma migrate dev",
    "db:migrate:stablecoin": "prisma migrate dev --schema=prisma-stablecoin/schema.prisma"
  }
}
```

## 8. 에러 처리 및 격리

### 8.1 Agent 초기화 격리

`src/index.ts` 또는 `src/agents/index.ts`에서 StablecoinArbAgent 초기화를 **독립 try/catch**로 감싼다:

```typescript
// 기존 에이전트들 초기화
try {
  await agentManager.startAgent('GridAgent')
  await agentManager.startAgent('InfiniteBuyAgent')
  await agentManager.startAgent('VRAgent')
} catch (e) {
  console.error('Critical agent failed to start:', e)
  process.exit(1)  // 핵심 기능이라 크래시
}

// 스테이블 에이전트 격리
try {
  await agentManager.startAgent('StablecoinArbAgent')
} catch (e) {
  console.error('[non-critical] StablecoinArbAgent failed to start:', e)
  // 계속 진행 — 다른 봇은 정상 동작
}
```

### 8.2 Client 장애 격리

- stablecoin DB 연결 장애 시 → StablecoinArbAgent만 error 상태, 다른 3개 에이전트 영향 없음
- prisma DB 장애는 기존 동작 유지 (crash or retry 정책 그대로)

### 8.3 Health check 확장 (선택)

`GET /api/health`에 DB 상태 추가 고려:
```json
{
  "status": "ok",
  "databases": {
    "grid_transaction": "connected",
    "grid_stablecoin_arb": "connected"
  }
}
```

현재 세션 스코프 밖 — 기존 health endpoint 유지.

## 9. 테스트 전략

### 9.1 유닛 테스트
- `stablecoin-arb-detector.test.ts` — 순수 함수 중심, DB 접근 없으면 변경 없음
- `stablecoin-inventory.service.test.ts` — Prisma client mock 경로만 업데이트 (`@prisma/client` → `.prisma/client-stablecoin`)
- `npm test` 통과 필수

### 9.2 로컬 통합 검증
- 로컬 MySQL 또는 Docker MySQL에 `grid_stablecoin_arb` DB 생성
- `prisma migrate dev --schema=prisma-stablecoin/schema.prisma --name init` 성공 확인
- `npx ts-node -e "import { stablecoinPrisma } from './src/config/database'; (async () => { console.log(await stablecoinPrisma.stablecoinArbBot.count()); })()"` 로 연결 검증

### 9.3 운영 배포 후 검증
- Grid 백엔드 `/api/health` → 200 OK
- `/api/agents` → 4개 (기존 3 + StablecoinArbAgent) 모두 running, errors=0
- 컨테이너 env 확인: `STABLECOIN_DATABASE_URL=mysql://grid_stablecoin_app:***`
- 컨테이너 로그 확인: `prisma migrate deploy --schema=prisma-stablecoin/schema.prisma` 성공 로그 존재
- 신규 DB `grid_stablecoin_arb`에 3개 테이블 + `_prisma_migrations` 1건 적용 확인 (read-only SELECT)
- grid_stablecoin_app으로 `grid_transaction.users` SELECT 시도 → 거부 확인 (격리 검증)

## 10. 정리 작업 (배포 성공 후, 사용자 재승인 필요)

구 `grid_transaction` DB의 잔존물 제거:

```sql
-- grid_migrate 유저로 실행
DROP TABLE IF EXISTS stablecoin_arb_opportunities;
DROP TABLE IF EXISTS stablecoin_arb_trades;
DROP TABLE IF EXISTS stablecoin_arb_bots;

DELETE FROM _prisma_migrations
WHERE migration_name IN (
  '20260421000000_add_stablecoin_arb_models',
  '20260421010000_fix_arb_opportunity_index_and_timestamp'
);
```

### 안전성 평가
- 테이블 3개 모두 0 rows 확인 (2026-04-23 조사 결과)
- 분리 배포 성공 후 이 테이블을 참조하는 코드 없음 (schema에서 제거됨)
- AWS Lightsail 스냅샷 `pre-stablecoin-db-separation-20260424` 존재
- 실행 전 `SHOW TABLES` 재확인 + 0 rows 재검증 권장

### production DB safety rule 예외 사유
일반 원칙은 "production destructive 쿼리 금지"이나, 이번은:
1. 데이터 없음 (0 rows 사전 검증)
2. 최신 스냅샷 존재
3. 참조 코드 없음 (배포 성공 후)
4. 미정리 시 향후 혼란 발생

→ 사용자 재확인 후 `grid_migrate`로 실행 (master 유저 사용 안 함).

## 11. 롤백 전략

각 단계별 롤백 지점과 방법:

| 단계 | 문제 발생 시 롤백 |
|---|---|
| DB/유저만 생성 상태 | dbmasteruser로 `DROP DATABASE grid_stablecoin_arb; DROP USER 'grid_stablecoin_app'@'%'; DROP USER 'grid_stablecoin_migrate'@'%';` |
| 코드 커밋 후 push 전 | `git reset --soft HEAD~N` (여러 커밋 이면 N 조정) |
| Push 후 배포 실패 | GitHub Actions 실패 시 롤백 불필요 (기존 컨테이너 계속 동작). 커밋 revert: `git revert <hash> && git push origin feat/stablecoin-arb-db-sep` |
| 배포 성공 후 기능 문제 | 새 DB는 건드리지 않음 → revert + redeploy 시 기존 grid_transaction만 사용하는 상태로 복원됨 |
| 치명적 문제 | AWS Lightsail 스냅샷 `pre-stablecoin-db-separation-20260424`로 복원 |

**핵심**: 기존 `grid_transaction` DB는 이 작업 전반에서 **수정되지 않음** (읽기만). 정리 단계(섹션 10)만 제외.

## 12. 구현 순서 (하이레벨)

implementation plan은 별도 문서(writing-plans 결과물)로 작성되지만, 전체 흐름 요약:

1. **사전 안전장치** — AWS 수동 스냅샷 생성 (사용자 콘솔)
2. **DB/유저 생성** — dbmasteruser로 CREATE DATABASE + CREATE USER + GRANT + 검증
3. **브랜치 준비** — `feat/stablecoin-arb-db-sep` 이미 생성됨 (main 기반 + revert-of-revert 2개 적용). 현재 HEAD는 `6e7989d`.
4. **Prisma 스키마 분리** — 기존 schema에서 stablecoin 모델 제거, `prisma-stablecoin/` 신설
5. **마이그레이션 생성** — 기존 2개 삭제, `prisma migrate dev --schema=prisma-stablecoin/...`로 init 1개 생성
6. **Prisma client 생성 + 코드 수정** — `database.ts` 확장, 스테이블 서비스/에이전트 import 경로 변경
7. **로컬 검증** — `prisma generate`, `npm test`, 로컬 DB migrate
8. **Dockerfile + deploy.yml 수정** — CMD에 두번째 migrate 추가, env 2줄 추가
9. **GitHub Secrets 2개 추가** — gh CLI로
10. **Commit + push** → GitHub Actions 배포 트리거
11. **배포 검증** — health, agents, logs, 신규 DB 상태
12. **(선택) 구 DB 정리** — 사용자 재승인 후 빈 테이블 3개 + migration 2건 DROP
13. **메모리 업데이트** — `secrets.local.md` + 새 세션 핸드오프 `project_session_7_handoff_2026_04_24.md`

예상 소요: 1.5~2시간

## 13. 예상 변경 파일 목록

### 신규 (create)
- `prisma-stablecoin/schema.prisma`
- `prisma-stablecoin/migrations/20260424000000_init/migration.sql`
- `prisma-stablecoin/migrations/migration_lock.toml`

### 수정 (modify)
- `prisma/schema.prisma` — 스테이블 모델 3개 제거, User relation 제거, enum 제거
- `src/config/database.ts` — stablecoinPrisma 추가
- `src/services/stablecoin-inventory.service.ts` — prisma import 변경
- `src/services/stablecoin-arb.service.ts` — 동일
- `src/agents/stablecoin-arb-agent.ts` — 동일
- `__tests__/services/stablecoin-inventory.service.test.ts` — mock 경로 업데이트
- `Dockerfile` — CMD 확장
- `.github/workflows/deploy.yml` — env 2줄 추가
- `package.json` — scripts 추가
- `.env` (로컬만, gitignore됨) — STABLECOIN_* 2개

### 삭제 (delete)
- `prisma/migrations/20260421000000_add_stablecoin_arb_models/` (디렉토리 통째)
- `prisma/migrations/20260421010000_fix_arb_opportunity_index_and_timestamp/` (디렉토리 통째)

## 14. 미결 / 이후 세션 이월

- **M3 실행 엔진 구현** — Task 10~14 (executor, pre-check, Leg-1/2, fallback, agent 연결)
- **Phase 2 자동 스냅샷 CI** — IAM 권한 + deploy.yml pre-deploy 스냅샷 단계
- **health endpoint DB 상태 노출** — `/api/health`에 2개 DB 연결 상태 추가 (운영 가시성 개선)
- **secrets.local.md endpoint stale 수정** — HOST 필드 `ls-1ec41c8c...` → `ls-203689806e...`

## 15. 참조

- 메모리: `project_stablecoin_arb_handoff.md`, `project_session_6_handoff_2026_04_23.md`, `feedback_production_db_safety.md`
- feat 브랜치 커밋 이력: `git log --oneline origin/feat/stablecoin-arb -25`
- 세션 6 commit: `5c7963b` (DB 권한 분리의 기준 패턴)
- AWS Lightsail RDS: `Grid-bot-DB-v2` (endpoint `ls-203689806e663776d4577600836a5c4b0e9a1a91.c0zy4csz1exi.ap-northeast-2.rds.amazonaws.com:3306`)
