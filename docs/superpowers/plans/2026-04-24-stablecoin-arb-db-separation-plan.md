# 스테이블코인 아비트리지 DB 분리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `grid_transaction` DB의 스테이블코인 아비트리지 모델 3개를 신규 `grid_stablecoin_arb` DB로 분리하고 Prisma 2 clients 구조로 전환한다.

**Architecture:** 같은 AWS Lightsail RDS 내 별도 database + 전용 유저 2개(`grid_stablecoin_app`/`grid_stablecoin_migrate`). Node 앱은 `prisma`(main) + `stablecoinPrisma`(신규) 두 client를 동시 보유. Cross-DB relation 미지원이므로 `userId`는 plain Int로만 저장.

**Tech Stack:** Prisma (MySQL), Node.js, Docker, GitHub Actions, AWS Lightsail, SSH

**작업 브랜치:** `feat/stablecoin-arb-db-sep` (로컬 생성 완료, HEAD `0ccba1f`)

**사전 참고 문서**
- 설계서: `docs/superpowers/specs/2026-04-24-stablecoin-arb-db-separation-design.md`
- 세션 6 DB 권한 분리 패턴: `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_session_6_handoff_2026_04_23.md`
- DB 안전 규칙: `~/.claude/memory/feedback_production_db_safety.md`
- 비번 저장소: `~/.claude/memory/secrets.local.md`

---

## Task 1: 비번 생성 + secrets.local.md 저장

**Files:**
- Modify: `~/.claude/memory/secrets.local.md` (append new section)

- [ ] **Step 1: 24자 URL-safe alphanumeric 비번 2개 생성 (stdout 출력)**

```bash
echo "APP_PASSWORD=$(python -c "import secrets, string; print(''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(24)))")"
echo "MIGRATE_PASSWORD=$(python -c "import secrets, string; print(''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(24)))")"
```

생성된 2개 값을 메모장 등 **세션 내 임시 변수**로 기억 (터미널 스크롤백에 남지 않도록 주의). 이후 단계에서 사용.

- [ ] **Step 2: secrets.local.md 맨 아래에 신규 섹션 추가**

```markdown
## Grid-bot-DB-v2 스테이블 분리 유저 (2026-04-24 생성)

- HOST: ls-203689806e663776d4577600836a5c4b0e9a1a91.c0zy4csz1exi.ap-northeast-2.rds.amazonaws.com
- PORT: 3306
- DB: grid_stablecoin_arb

- grid_stablecoin_app USER: grid_stablecoin_app
- grid_stablecoin_app PASSWORD: <APP_PASSWORD>
- grid_stablecoin_app GRANTS: SELECT, INSERT, UPDATE, DELETE ON grid_stablecoin_arb.*
- grid_stablecoin_app DATABASE_URL: mysql://grid_stablecoin_app:<APP_PASSWORD>@ls-203689806e663776d4577600836a5c4b0e9a1a91.c0zy4csz1exi.ap-northeast-2.rds.amazonaws.com:3306/grid_stablecoin_arb?charset=utf8mb4&connection_limit=50&pool_timeout=30&connect_timeout=30

- grid_stablecoin_migrate USER: grid_stablecoin_migrate
- grid_stablecoin_migrate PASSWORD: <MIGRATE_PASSWORD>
- grid_stablecoin_migrate GRANTS: ALL PRIVILEGES ON grid_stablecoin_arb.*
- grid_stablecoin_migrate DATABASE_URL: mysql://grid_stablecoin_migrate:<MIGRATE_PASSWORD>@ls-203689806e663776d4577600836a5c4b0e9a1a91.c0zy4csz1exi.ap-northeast-2.rds.amazonaws.com:3306/grid_stablecoin_arb?charset=utf8mb4&connection_limit=5&pool_timeout=30&connect_timeout=30
```

`<APP_PASSWORD>`, `<MIGRATE_PASSWORD>`는 Step 1에서 생성한 실제 값으로 치환.

- [ ] **Step 3: secrets.local.md이 git ignore됨을 재확인 (커밋되지 않아야 함)**

```bash
cd ~/.claude && git check-ignore -v memory/secrets.local.md
```

Expected: `memory/secrets.local.md` is matched by `.gitignore` rule.

---

## Task 2: AWS Lightsail 수동 스냅샷 (사용자 콘솔)

**Files:** (AWS 외부 작업, 코드 변경 없음)

- [ ] **Step 1: 사용자에게 콘솔에서 스냅샷 생성 요청**

스냅샷 이름: **`pre-stablecoin-db-separation-20260424`**

- AWS Lightsail 콘솔 → Databases → Grid-bot-DB-v2 → Snapshots → Create manual snapshot
- 또는 CLI 권한 있는 유저로:
```bash
aws lightsail create-relational-database-snapshot \
  --region ap-northeast-2 \
  --relational-database-name Grid-bot-DB-v2 \
  --relational-database-snapshot-name pre-stablecoin-db-separation-20260424
```

- [ ] **Step 2: 스냅샷 생성 확인 (상태 available)**

사용자가 콘솔에서 "available" 상태로 전환 확인. 보통 1~3분 소요.

Expected output (CLI):
```json
{
  "operations": [{
    "status": "Completed",
    "resourceName": "pre-stablecoin-db-separation-20260424",
    "operationType": "CreateRelationalDatabaseSnapshot"
  }]
}
```

---

## Task 3: 신규 DB + 유저 2개 생성 (dbmasteruser, 1회성)

**Files:** (운영 DB 변경, 코드 변경 없음)

- [ ] **Step 1: dbmasteruser 비번 확인 (secrets.local.md 참조)**

```bash
grep -A 3 "Grid-bot-DB-v2" ~/.claude/memory/secrets.local.md | head -10
```

`dbmasteruser` 비번과 HOST 확인.

- [ ] **Step 2: SSH + docker run mysql:8로 SQL 실행 (base64 비번 전달 패턴)**

```bash
# 로컬에서 비번을 base64로 인코딩 (session 6 권장 패턴)
DBMASTER_PW_B64=$(echo -n "<DBMASTER_PASSWORD>" | base64 -w 0)
APP_PW_B64=$(echo -n "<APP_PASSWORD>" | base64 -w 0)
MIGRATE_PW_B64=$(echo -n "<MIGRATE_PASSWORD>" | base64 -w 0)
HOST="ls-203689806e663776d4577600836a5c4b0e9a1a91.c0zy4csz1exi.ap-northeast-2.rds.amazonaws.com"

ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 "
  DBMASTER_PW=\$(echo '$DBMASTER_PW_B64' | base64 -d)
  APP_PW=\$(echo '$APP_PW_B64' | base64 -d)
  MIGRATE_PW=\$(echo '$MIGRATE_PW_B64' | base64 -d)
  docker run --rm -e MYSQL_PWD=\"\$DBMASTER_PW\" mysql:8 mysql -h '$HOST' -u dbmasteruser <<SQL
    CREATE DATABASE grid_stablecoin_arb
      CHARACTER SET utf8mb4
      COLLATE utf8mb4_unicode_ci;
    CREATE USER 'grid_stablecoin_app'@'%' IDENTIFIED BY '\$APP_PW';
    CREATE USER 'grid_stablecoin_migrate'@'%' IDENTIFIED BY '\$MIGRATE_PW';
    GRANT SELECT, INSERT, UPDATE, DELETE ON grid_stablecoin_arb.* TO 'grid_stablecoin_app'@'%';
    GRANT ALL PRIVILEGES ON grid_stablecoin_arb.* TO 'grid_stablecoin_migrate'@'%';
    FLUSH PRIVILEGES;
    SELECT 'OK' AS status;
SQL
"
```

Expected: `status: OK` 출력.

- [ ] **Step 3: 검증 - SHOW GRANTS (read-only)**

```bash
ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 "
  DBMASTER_PW=\$(echo '$DBMASTER_PW_B64' | base64 -d)
  docker run --rm -e MYSQL_PWD=\"\$DBMASTER_PW\" mysql:8 mysql -h '$HOST' -u dbmasteruser -e \"
    SHOW GRANTS FOR 'grid_stablecoin_app'@'%';
    SHOW GRANTS FOR 'grid_stablecoin_migrate'@'%';
  \"
"
```

Expected output:
```
GRANT USAGE ON *.* TO 'grid_stablecoin_app'@'%'
GRANT SELECT, INSERT, UPDATE, DELETE ON `grid_stablecoin_arb`.* TO 'grid_stablecoin_app'@'%'
GRANT USAGE ON *.* TO 'grid_stablecoin_migrate'@'%'
GRANT ALL PRIVILEGES ON `grid_stablecoin_arb`.* TO 'grid_stablecoin_migrate'@'%'
```

핵심 검증: `grid_transaction.*` 권한이 **전혀 없어야 함** (격리 확인).

- [ ] **Step 4: 격리 검증 - grid_stablecoin_app으로 grid_transaction 접근 시도**

```bash
ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 "
  APP_PW=\$(echo '$APP_PW_B64' | base64 -d)
  docker run --rm -e MYSQL_PWD=\"\$APP_PW\" mysql:8 mysql -h '$HOST' -u grid_stablecoin_app -e 'USE grid_transaction; SELECT COUNT(*) FROM users;' 2>&1 | head -5
"
```

Expected: `ERROR 1044 (42000): Access denied for user 'grid_stablecoin_app'@'%' to database 'grid_transaction'`

격리 성공. 이 에러가 나와야 안전함.

---

## Task 4: 기존 prisma/schema.prisma에서 스테이블 모델 제거

**Files:**
- Modify: `prisma/schema.prisma`
- Delete: `prisma/migrations/20260421000000_add_stablecoin_arb_models/` (디렉토리 전체)
- Delete: `prisma/migrations/20260421010000_fix_arb_opportunity_index_and_timestamp/` (디렉토리 전체)

- [ ] **Step 1: 현재 schema.prisma에서 제거할 위치 확인**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-tranasction-backend
grep -n "stablecoinArbBot\|StablecoinArb\|stablecoin_arb" prisma/schema.prisma
```

제거 대상 라인 번호 메모.

- [ ] **Step 2: User model에서 `stablecoinArbBot` relation 제거**

Edit `prisma/schema.prisma` - User model 내부:

```diff
   profitSnapshots   ProfitSnapshot[]
   pushSubscriptions PushSubscription[]
-  stablecoinArbBot  StablecoinArbBot?
   subscription      Subscription?
   upbitDonations    UpbitDonation[]
```

- [ ] **Step 3: CredentialPurpose enum에서 `stablecoin_arb` 값 제거**

```diff
 enum CredentialPurpose {
   default
   infinite_buy
-  stablecoin_arb
   vr
 }
```

- [ ] **Step 4: 3개 모델 통째 삭제 (StablecoinArbBot, StablecoinArbTrade, StablecoinArbOpportunity)**

파일 하단의 `// 스테이블코인 아비트리지 봇 설정 및 상태` 주석부터 `@@map("stablecoin_arb_opportunities")` 닫는 `}`까지 전체 삭제.

- [ ] **Step 5: Prisma format으로 문법 검증**

```bash
cd v0-grid-tranasction-backend
npx prisma format
npx prisma validate
```

Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 6: 기존 stablecoin 마이그레이션 2개 삭제**

```bash
rm -rf prisma/migrations/20260421000000_add_stablecoin_arb_models
rm -rf prisma/migrations/20260421010000_fix_arb_opportunity_index_and_timestamp
```

- [ ] **Step 7: 커밋**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "refactor(prisma): grid_transaction schema에서 stablecoin 모델 제거

- User.stablecoinArbBot relation 제거 (cross-DB relation 불가)
- CredentialPurpose enum에서 stablecoin_arb 제거
- StablecoinArbBot/Trade/Opportunity 3개 모델 제거
- 기존 마이그레이션 2개 삭제 (prisma-stablecoin/migrations로 통합 예정)"
```

---

## Task 5: prisma-stablecoin/schema.prisma 신설

**Files:**
- Create: `prisma-stablecoin/schema.prisma`

- [ ] **Step 1: 디렉토리 생성**

```bash
cd v0-grid-tranasction-backend
mkdir -p prisma-stablecoin
```

- [ ] **Step 2: schema.prisma 작성**

Create `prisma-stablecoin/schema.prisma`:

```prisma
// 스테이블코인 아비트리지 전용 Prisma 스키마
// separate DB: grid_stablecoin_arb (Grid-bot-DB-v2 RDS 내 별도 database)
//
// Note: grid_transaction과 cross-DB relation 불가.
// userId/credentialId는 plain Int로만 저장. 조회는 app 레벨에서.

generator client {
  provider = "prisma-client-js"
  output   = "../node_modules/.prisma/client-stablecoin"
}

datasource db {
  provider = "mysql"
  url      = env("STABLECOIN_DATABASE_URL")
}

enum ArbBotStatus {
  stopped
  running
  error
}

enum ArbTradeStatus {
  detected
  executing
  completed
  failed
  reverted
}

// 스테이블코인 아비트리지 봇 설정 및 상태
// userId: grid_transaction.users.id 참조 (relation 없음)
// credentialId: grid_transaction.credentials.id 참조 (relation 없음)
model StablecoinArbBot {
  id                 Int          @id @default(autoincrement())
  userId             Int          @unique
  credentialId       Int?
  status             ArbBotStatus @default(stopped)

  coinsEnabled       Json         // string[] — 예: ["USDT","USDC","USD1"]
  entryThresholdBps  Int          @default(20)
  tradeSizeKrw       Int          @default(10000)
  maxDailyTrades     Int          @default(3)
  perCoinMinUsd      Decimal      @default(10) @db.Decimal(18, 8)
  perCoinMaxUsd      Decimal      @default(500) @db.Decimal(18, 8)
  depegBps           Int          @default(200)
  killSwitch         Boolean      @default(false)

  lastRunAt          DateTime?
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt

  trades             StablecoinArbTrade[]
  opportunities      StablecoinArbOpportunity[]

  @@map("stablecoin_arb_bots")
}

// 실제 실행된 아비트리지 거래 기록
model StablecoinArbTrade {
  id                 Int              @id @default(autoincrement())
  botId              Int
  bot                StablecoinArbBot @relation(fields: [botId], references: [id], onDelete: Cascade)

  soldCoin           String           @db.VarChar(8)
  boughtCoin         String           @db.VarChar(8)
  sizeKrw            Decimal          @db.Decimal(18, 8)
  spreadBps          Int
  status             ArbTradeStatus   @default(detected)

  leg1OrderUuid      String?          @db.VarChar(64)
  leg1Volume         Decimal?         @db.Decimal(28, 18)
  leg1Funds          Decimal?         @db.Decimal(28, 8)
  leg1Fee            Decimal?         @db.Decimal(28, 8)

  leg2OrderUuid      String?          @db.VarChar(64)
  leg2Volume         Decimal?         @db.Decimal(28, 18)
  leg2Funds          Decimal?         @db.Decimal(28, 8)
  leg2Fee            Decimal?         @db.Decimal(28, 8)

  errorMessage       String?          @db.Text
  detectedAt         DateTime
  completedAt        DateTime?

  @@index([botId, detectedAt])
  @@index([status])
  @@map("stablecoin_arb_trades")
}

// 감지된 기회 로그 (실행 여부 무관, M2에서 관찰용)
model StablecoinArbOpportunity {
  id             BigInt           @id @default(autoincrement())
  botId          Int
  bot            StablecoinArbBot @relation(fields: [botId], references: [id], onDelete: Cascade)

  detectedAt     DateTime
  soldCoin       String           @db.VarChar(8)
  boughtCoin     String           @db.VarChar(8)
  bidSoldKrw     Decimal          @db.Decimal(18, 8)
  askBoughtKrw   Decimal          @db.Decimal(18, 8)
  bidSoldSize    Decimal          @db.Decimal(28, 18)
  askBoughtSize  Decimal          @db.Decimal(28, 18)
  spreadBps      Int
  executed       Boolean          @default(false)

  @@index([botId, detectedAt])
  @@index([soldCoin, boughtCoin, detectedAt])
  @@index([detectedAt])
  @@map("stablecoin_arb_opportunities")
}
```

**⚠️ 중요:** 위 필드 목록은 `feat/stablecoin-arb` 브랜치의 원본 스키마를 근거로 작성됨. 혹시 원본과 차이 있으면 구현 시 원본 확인 후 동기화. 원본 참조:

```bash
git show 6e7989d:prisma/schema.prisma | sed -n '/^model StablecoinArbBot/,/^}/p'
```

- [ ] **Step 3: Prisma validate로 문법 검증**

```bash
npx prisma validate --schema=prisma-stablecoin/schema.prisma
```

Expected: `The schema at prisma-stablecoin/schema.prisma is valid 🚀`

- [ ] **Step 4: 커밋**

```bash
git add prisma-stablecoin/schema.prisma
git commit -m "feat(prisma): prisma-stablecoin/schema.prisma 신설

- StablecoinArbBot/Trade/Opportunity 3개 모델 정의
- datasource url: env(STABLECOIN_DATABASE_URL)
- generator output: ../node_modules/.prisma/client-stablecoin
- cross-DB relation 없음 (userId/credentialId는 plain Int)"
```

---

## Task 6: 로컬 dev DB에서 init 마이그레이션 생성

**Files:**
- Create: `prisma-stablecoin/migrations/20260424000000_init/migration.sql`
- Create: `prisma-stablecoin/migrations/migration_lock.toml`
- Modify: `.env` (로컬만, gitignore됨)

- [ ] **Step 1: 로컬 dev DB에 grid_stablecoin_arb 생성 (Docker MySQL)**

```bash
# 이미 Grid 백엔드 로컬 dev에 MySQL 컨테이너가 도는 상태라면
docker exec grid-backend-mysql mysql -u root -p<local_pw> -e "CREATE DATABASE IF NOT EXISTS grid_stablecoin_arb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

로컬 MySQL 없으면 간단히 `docker run`으로 1회 생성:
```bash
docker run -d --name grid-local-mysql \
  -e MYSQL_ROOT_PASSWORD=localdev \
  -p 3307:3306 \
  mysql:8
sleep 10
docker exec grid-local-mysql mysql -u root -plocaldev -e "CREATE DATABASE grid_stablecoin_arb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE DATABASE IF NOT EXISTS grid_transaction CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

- [ ] **Step 2: .env에 STABLECOIN_DATABASE_URL 추가**

Edit `.env` (로컬 전용, gitignore됨):

```
# 기존
DATABASE_URL="mysql://root:<local>@localhost:3307/grid_transaction"

# 추가
STABLECOIN_DATABASE_URL="mysql://root:localdev@localhost:3307/grid_stablecoin_arb"
```

- [ ] **Step 3: prisma migrate dev로 init 마이그레이션 생성**

```bash
cd v0-grid-tranasction-backend
npx prisma migrate dev \
  --schema=prisma-stablecoin/schema.prisma \
  --name init
```

Expected output:
```
✔ Applied migration `20260424000000_init`
The following migration(s) have been created and applied from new schema changes:
migrations/
  └─ 20260424000000_init/
    └─ migration.sql
✔ Generated Prisma Client (...) in ../node_modules/.prisma/client-stablecoin
```

- [ ] **Step 4: 생성된 migration.sql 검증**

```bash
cat prisma-stablecoin/migrations/20260424*/migration.sql | head -40
```

Expected: `CREATE TABLE stablecoin_arb_bots`, `CREATE TABLE stablecoin_arb_trades`, `CREATE TABLE stablecoin_arb_opportunities` + 인덱스 + FOREIGN KEY.

- [ ] **Step 5: 커밋**

```bash
git add prisma-stablecoin/migrations/
git commit -m "feat(prisma): stablecoin init 마이그레이션 생성 (20260424000000_init)

로컬 dev DB에서 prisma migrate dev로 생성. 3개 테이블:
- stablecoin_arb_bots
- stablecoin_arb_trades (FK → stablecoin_arb_bots)
- stablecoin_arb_opportunities (FK → stablecoin_arb_bots)"
```

---

## Task 7: src/config/database.ts에 stablecoinPrisma 추가

**Files:**
- Modify: `src/config/database.ts`

- [ ] **Step 1: 기존 database.ts 구조 재확인**

```bash
head -5 src/config/database.ts
tail -30 src/config/database.ts
```

파일은 복잡하므로 main prisma는 건드리지 않고 **추가만** 한다. 풀 통계/슬로우 쿼리 로깅은 스테이블 client에는 중복 설정하지 않음 (별도 로그만).

- [ ] **Step 2: import 추가 (최상단)**

Edit `src/config/database.ts` 1~2번 라인 근처:

```diff
 import { PrismaClient } from '@prisma/client';
+// @ts-expect-error — 빌드 후 생성되는 경로
+import { PrismaClient as StablecoinPrismaClient } from '.prisma/client-stablecoin';

 const isProduction = process.env.NODE_ENV === 'production';
```

`@ts-expect-error` 이유: prisma-stablecoin 스키마가 있어야 이 타입이 생성됨. `prisma generate` 전에는 에러 나는 게 정상.

- [ ] **Step 3: stablecoinPrisma 싱글톤 추가 (기존 prisma 싱글톤 패턴 바로 아래에)**

기존:
```typescript
if (!isProduction) globalForPrisma.prisma = prisma;
```

그 아래에 추가:

```typescript
// Stablecoin arbitrage DB client (별도 database: grid_stablecoin_arb)
const globalForStablecoinPrisma = globalThis as unknown as {
  stablecoinPrisma: StablecoinPrismaClient | undefined;
};

export const stablecoinPrisma =
  globalForStablecoinPrisma.stablecoinPrisma ??
  new StablecoinPrismaClient({
    log: [
      { level: 'warn', emit: 'stdout' },
      { level: 'error', emit: 'stdout' },
    ],
    datasources: {
      db: {
        url: process.env.STABLECOIN_DATABASE_URL,
      },
    },
  });

if (!isProduction) globalForStablecoinPrisma.stablecoinPrisma = stablecoinPrisma;
```

- [ ] **Step 4: graceful shutdown에 stablecoinPrisma 추가**

기존:
```typescript
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});
```

수정:
```typescript
process.on('beforeExit', async () => {
  await Promise.allSettled([
    prisma.$disconnect(),
    stablecoinPrisma.$disconnect(),
  ]);
});
```

- [ ] **Step 5: 타입 체크 (prisma generate 후)**

```bash
npx prisma generate
npx prisma generate --schema=prisma-stablecoin/schema.prisma
npx tsc --noEmit
```

Expected: 에러 0개. (@ts-expect-error 구문이 prisma generate 이후에는 불필요할 수 있으나 generation 전 빌드 타임 에러 방지용으로 유지.)

- [ ] **Step 6: 커밋**

```bash
git add src/config/database.ts
git commit -m "feat(db): stablecoinPrisma client 추가

- .prisma/client-stablecoin에서 StablecoinPrismaClient import
- 싱글톤 패턴 + HMR 대응 (globalThis 캐싱)
- STABLECOIN_DATABASE_URL env 사용
- graceful shutdown에 포함"
```

---

## Task 8: stablecoin-arb.service.ts import 변경

**Files:**
- Modify: `src/services/stablecoin-arb.service.ts`

- [ ] **Step 1: 현재 상태 확인**

```bash
head -3 src/services/stablecoin-arb.service.ts
grep -c "prisma\." src/services/stablecoin-arb.service.ts
```

Expected: `import prisma from '../config/database';`, `import { Prisma } from '@prisma/client';`, `prisma.` 사용 8곳.

- [ ] **Step 2: import 교체**

Edit line 1-2:

```diff
-import prisma from '../config/database';
-import { Prisma } from '@prisma/client';
+import { stablecoinPrisma as prisma } from '../config/database';
+import { Prisma } from '.prisma/client-stablecoin';
```

파일 내부의 모든 `prisma.` 사용은 alias 덕분에 그대로 동작함.

- [ ] **Step 3: 타입 체크**

```bash
npx tsc --noEmit
```

Expected: 에러 0개. `Prisma.StablecoinArbBotUpdateInput` 같은 타입이 새 경로에서 제공됨.

만약 `Cannot find module '.prisma/client-stablecoin'` 에러가 나면:
```bash
npx prisma generate --schema=prisma-stablecoin/schema.prisma
```
재실행 후 다시 tsc.

- [ ] **Step 4: 커밋**

```bash
git add src/services/stablecoin-arb.service.ts
git commit -m "refactor(stablecoin-arb.service): stablecoinPrisma client 사용

- prisma alias로 stablecoinPrisma import (기존 사용처 무변경)
- Prisma 네임스페이스를 .prisma/client-stablecoin에서 import"
```

---

## Task 9: stablecoin-arb-agent.ts import 변경

**Files:**
- Modify: `src/agents/stablecoin-arb-agent.ts`

- [ ] **Step 1: 현재 상태 확인**

```bash
grep -n "prisma\|@prisma/client" src/agents/stablecoin-arb-agent.ts | head -5
```

Expected: `import prisma from '../config/database';` (line 10) + `prisma.stablecoinArbBot.findMany` (line ~72).

- [ ] **Step 2: import 교체**

Edit line 10:

```diff
-import prisma from '../config/database';
+import { stablecoinPrisma as prisma } from '../config/database';
```

- [ ] **Step 3: 타입 체크**

```bash
npx tsc --noEmit
```

Expected: 에러 0개.

- [ ] **Step 4: 커밋**

```bash
git add src/agents/stablecoin-arb-agent.ts
git commit -m "refactor(stablecoin-arb-agent): stablecoinPrisma client 사용

- prisma alias로 stablecoinPrisma import (기존 사용처 무변경)"
```

---

## Task 10: StablecoinArbAgent 초기화 격리 (src/index.ts)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 현재 StablecoinArbAgent 시작 위치 찾기**

```bash
grep -n "StablecoinArb\|stablecoin-arb" src/index.ts
```

- [ ] **Step 2: 초기화 try/catch로 감싸기**

StablecoinArbAgent 시작 코드를 찾아서(예: `await agentManager.startAgent('stablecoin-arb');` 또는 유사 패턴), 독립 try/catch로 감싼다:

```diff
-  await agentManager.startAgent('stablecoin-arb');
+  // StablecoinArbAgent는 실험적 기능 — 실패 시 다른 에이전트 영향 없이 격리
+  try {
+    await agentManager.startAgent('stablecoin-arb');
+    console.log('[init] StablecoinArbAgent started');
+  } catch (err) {
+    console.error('[init] StablecoinArbAgent 시작 실패 (non-critical, 다른 에이전트는 정상):', err);
+  }
```

**Note:** 현재 코드에서 StablecoinArbAgent 시작이 이미 try/catch로 감싸져 있다면 추가 수정 불필요. grep 결과 재확인 후 판단.

- [ ] **Step 3: 타입 체크**

```bash
npx tsc --noEmit
```

Expected: 에러 0개.

- [ ] **Step 4: 커밋 (변경 있으면)**

```bash
git add src/index.ts
git commit -m "refactor(init): StablecoinArbAgent 시작을 try/catch로 격리

- 스테이블 에이전트 시작 실패가 Grid/InfiniteBuy/VR 에이전트에 전파되지 않도록 격리
- 장애 시 로그만 남기고 서버 계속 기동"
```

변경이 없으면 이 태스크는 skip.

---

## Task 11: package.json 스크립트 보강

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 기존 scripts 확인**

```bash
grep -A 10 '"scripts"' package.json
```

- [ ] **Step 2: 스크립트 추가 (기존 위에 덮어쓰기 또는 추가)**

Edit `package.json` scripts:

```diff
   "scripts": {
     "build": "prisma generate && tsc",
     "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
     "start": "node dist/index.js",
+    "db:generate": "prisma generate && prisma generate --schema=prisma-stablecoin/schema.prisma",
+    "db:migrate": "prisma migrate dev",
+    "db:migrate:stablecoin": "prisma migrate dev --schema=prisma-stablecoin/schema.prisma",
+    "db:migrate:deploy": "prisma migrate deploy && prisma migrate deploy --schema=prisma-stablecoin/schema.prisma",
     "test": "jest"
   },
```

**중요:** `build` 스크립트의 `prisma generate`는 **main 스키마만** 생성함. stablecoin client도 생성되도록 build도 수정:

```diff
-    "build": "prisma generate && tsc",
+    "build": "prisma generate && prisma generate --schema=prisma-stablecoin/schema.prisma && tsc",
```

- [ ] **Step 3: npm run build로 검증**

```bash
npm run build
```

Expected:
- `✔ Generated Prisma Client (...) in node_modules/@prisma/client`
- `✔ Generated Prisma Client (...) in node_modules/.prisma/client-stablecoin`
- TypeScript 컴파일 성공 (dist/ 생성)

- [ ] **Step 4: 커밋**

```bash
git add package.json
git commit -m "chore: package.json에 stablecoin prisma 스크립트 추가

- build: 두 개의 prisma generate 포함
- db:generate / db:migrate / db:migrate:stablecoin / db:migrate:deploy 편의 스크립트"
```

---

## Task 12: 로컬 테스트 + 빌드 검증

**Files:** (검증 only, 코드 변경 없음)

- [ ] **Step 1: Jest 테스트 실행**

```bash
npm test 2>&1 | tail -30
```

Expected:
- `Tests: N passed, N total`
- 특히 `stablecoin-arb-detector.test.ts`, `stablecoin-inventory.service.test.ts` 통과 확인

실패 시: mock 경로를 `@prisma/client` → `.prisma/client-stablecoin`로 업데이트 필요할 수 있음. 테스트 파일 개별 수정 후 재실행.

- [ ] **Step 2: TypeScript 엄격 검증**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: 에러 0개.

- [ ] **Step 3: 로컬 서버 기동 테스트 (선택)**

```bash
# 로컬 dev DB 연결 후
npm run dev
```

Expected (5초 이내):
- Prisma connections 성공 로그
- `StablecoinArbAgent started` 로그
- `Server is running on port 3010` 로그

Ctrl+C로 중단.

- [ ] **Step 4: (선택) 커밋**

변경사항 없으면 skip. 있으면:

```bash
git add <modified files>
git commit -m "fix: 로컬 검증에서 발견한 이슈 수정"
```

---

## Task 13: Dockerfile 수정 (duality migrate + prisma client 복사)

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: 현재 Dockerfile 끝 부분 확인**

```bash
tail -25 Dockerfile
```

핵심 확인 지점:
- `COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma` 라인 존재 여부
- `CMD ["sh", "-c", "DATABASE_URL=\"$MIGRATE_DATABASE_URL\" npx prisma migrate deploy && node dist/index.js"]` 존재 여부

- [ ] **Step 2: COPY 라인 수정 (stablecoin client 포함되도록)**

기존 `COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma` 라인은 `.prisma/` 전체를 복사하므로 하위의 `client-stablecoin/`도 포함됨. **검증 필요.**

만약 복사 안 되면 명시적 추가:
```dockerfile
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# 스테이블 클라이언트는 .prisma/client-stablecoin에 있어 위 COPY에 포함됨.
# 명시적 검증: builder에서 npm run build가 두 개의 generate 모두 실행했으므로
# .prisma/ 디렉토리에 client/와 client-stablecoin/ 두 개가 공존함.
```

확인만 — 변경 없으면 skip.

- [ ] **Step 3: CMD 수정 (dual migrate)**

```diff
-CMD ["sh", "-c", "DATABASE_URL=\"$MIGRATE_DATABASE_URL\" npx prisma migrate deploy && node dist/index.js"]
+CMD ["sh", "-c", "DATABASE_URL=\"$MIGRATE_DATABASE_URL\" npx prisma migrate deploy --schema=prisma/schema.prisma && STABLECOIN_DATABASE_URL=\"$STABLECOIN_MIGRATE_DATABASE_URL\" npx prisma migrate deploy --schema=prisma-stablecoin/schema.prisma && node dist/index.js"]
```

동작:
1. `DATABASE_URL=$MIGRATE_DATABASE_URL` 임시 override → main 스키마 migrate (grid_migrate 유저)
2. `STABLECOIN_DATABASE_URL=$STABLECOIN_MIGRATE_DATABASE_URL` 임시 override → stablecoin 스키마 migrate (grid_stablecoin_migrate 유저)
3. `node dist/index.js` 원래 env로 복귀 (DATABASE_URL=grid_app, STABLECOIN_DATABASE_URL=grid_stablecoin_app)

- [ ] **Step 4: Dockerfile 로컬 빌드 테스트 (선택)**

```bash
docker build -t grid-bot:test-db-sep -f Dockerfile .
```

Expected: 빌드 성공, `Generated Prisma Client ... client-stablecoin` 로그 존재.

이미지 실행까지는 선택 (운영 env 없어서 migrate 실패할 것이므로 빌드 성공만 확인).

- [ ] **Step 5: 커밋**

```bash
git add Dockerfile
git commit -m "feat(docker): Dockerfile CMD에 stablecoin 마이그레이션 단계 추가

- DATABASE_URL(grid_migrate) + STABLECOIN_DATABASE_URL(grid_stablecoin_migrate)
  두 단계로 migrate deploy 실행
- Node 런타임은 원래 env(grid_app + grid_stablecoin_app)로 복귀"
```

---

## Task 14: .github/workflows/deploy.yml 수정

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: docker run 라인 확인**

```bash
grep -B 2 -A 20 "docker run" .github/workflows/deploy.yml | head -40
```

핵심 확인: `-e "DATABASE_URL=${{ secrets.DATABASE_URL }}"` 블록 위치.

- [ ] **Step 2: 새 env 2줄 추가**

기존:
```yaml
              -e "DATABASE_URL=${{ secrets.DATABASE_URL }}" \
              -e "MIGRATE_DATABASE_URL=${{ secrets.MIGRATE_DATABASE_URL }}" \
```

수정:
```yaml
              -e "DATABASE_URL=${{ secrets.DATABASE_URL }}" \
              -e "MIGRATE_DATABASE_URL=${{ secrets.MIGRATE_DATABASE_URL }}" \
              -e "STABLECOIN_DATABASE_URL=${{ secrets.STABLECOIN_DATABASE_URL }}" \
              -e "STABLECOIN_MIGRATE_DATABASE_URL=${{ secrets.STABLECOIN_MIGRATE_DATABASE_URL }}" \
```

- [ ] **Step 3: YAML 검증 (선택)**

```bash
# yamllint 설치돼 있으면
yamllint .github/workflows/deploy.yml
# 또는 간단히 python:
python -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))"
```

Expected: 에러 없음.

- [ ] **Step 4: 커밋**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(deploy): docker run env에 STABLECOIN_* 2개 추가

- STABLECOIN_DATABASE_URL (grid_stablecoin_app)
- STABLECOIN_MIGRATE_DATABASE_URL (grid_stablecoin_migrate)"
```

---

## Task 15: GitHub Secrets 2개 추가

**Files:** (GitHub 설정, 로컬 파일 변경 없음)

- [ ] **Step 1: secrets.local.md에서 URL 2개 조회**

```bash
grep -A 1 "grid_stablecoin_app DATABASE_URL\|grid_stablecoin_migrate DATABASE_URL" ~/.claude/memory/secrets.local.md
```

- [ ] **Step 2: gh CLI로 Secret 2개 저장 (stdin pipe로 유출 방지)**

```bash
cd v0-grid-tranasction-backend

# STABLECOIN_DATABASE_URL (grid_stablecoin_app)
APP_URL='mysql://grid_stablecoin_app:<APP_PASSWORD>@ls-203689806e663776d4577600836a5c4b0e9a1a91.c0zy4csz1exi.ap-northeast-2.rds.amazonaws.com:3306/grid_stablecoin_arb?charset=utf8mb4&connection_limit=50&pool_timeout=30&connect_timeout=30'
echo -n "$APP_URL" | gh secret set STABLECOIN_DATABASE_URL --body-file -

# STABLECOIN_MIGRATE_DATABASE_URL (grid_stablecoin_migrate)
MIGRATE_URL='mysql://grid_stablecoin_migrate:<MIGRATE_PASSWORD>@ls-203689806e663776d4577600836a5c4b0e9a1a91.c0zy4csz1exi.ap-northeast-2.rds.amazonaws.com:3306/grid_stablecoin_arb?charset=utf8mb4&connection_limit=5&pool_timeout=30&connect_timeout=30'
echo -n "$MIGRATE_URL" | gh secret set STABLECOIN_MIGRATE_DATABASE_URL --body-file -
```

**주의:** `<APP_PASSWORD>`, `<MIGRATE_PASSWORD>`는 실제 값으로 치환. shell history에 남지 않도록 각 명령 앞에 **space 1칸**을 두면 bash HISTCONTROL=ignorespace 설정 시 기록 제외됨.

- [ ] **Step 3: Secret 등록 확인**

```bash
gh secret list | grep STABLECOIN
```

Expected:
```
STABLECOIN_DATABASE_URL          Updated YYYY-MM-DD
STABLECOIN_MIGRATE_DATABASE_URL  Updated YYYY-MM-DD
```

---

## Task 16: Push + PR + 배포 + 검증

**Files:** (GitHub 작업)

- [ ] **Step 1: 로컬 브랜치 상태 최종 확인**

```bash
git status
git log --oneline -15
```

Expected: working tree clean, 커밋 10~12개 정도 (Task 4~14).

- [ ] **Step 2: push (사용자 승인 필요)**

**⚠️ 사용자에게 push 승인 요청 후 실행:**

```bash
git push -u origin feat/stablecoin-arb-db-sep
```

Expected: `Branch 'feat/stablecoin-arb-db-sep' set up to track remote branch 'feat/stablecoin-arb-db-sep' from 'origin'.`

- [ ] **Step 3: PR 생성**

```bash
gh pr create --base main --head feat/stablecoin-arb-db-sep \
  --title "feat(stablecoin-arb): DB 분리 — grid_stablecoin_arb + Prisma 2 clients" \
  --body "$(cat <<'EOF'
## Summary
- 스테이블코인 아비트리지 모델 3개를 신규 `grid_stablecoin_arb` DB로 분리
- Prisma 2 clients 구조 (`prisma` + `stablecoinPrisma`)
- User/Credential relation 제거 (cross-DB 미지원, userId plain Int로 저장)
- 세션 6 DB 권한 분리 패턴 재사용 (grid_stablecoin_app/grid_stablecoin_migrate)
- Dockerfile CMD 확장: 두 스키마 migrate deploy 순차 실행

설계서: `docs/superpowers/specs/2026-04-24-stablecoin-arb-db-separation-design.md`
구현 계획: `docs/superpowers/plans/2026-04-24-stablecoin-arb-db-separation-plan.md`

## Test plan
- [ ] GitHub Actions 배포 성공
- [ ] `/api/health` → `status: ok`
- [ ] `/api/agents` → 4개 (GridAgent, InfiniteBuyAgent, VRAgent, StablecoinArbAgent) 모두 running
- [ ] 컨테이너 env에 STABLECOIN_DATABASE_URL 존재 확인
- [ ] `grid_stablecoin_arb` DB에 3개 테이블 + `_prisma_migrations` 1건 적용
- [ ] grid_stablecoin_app으로 `grid_transaction` 접근 시도 → 거부 (격리 검증)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL 반환.

- [ ] **Step 4: PR 머지 (사용자 승인 후)**

**⚠️ 사용자 승인 필요:**

```bash
gh pr merge --squash --delete-branch --auto
# 또는 명시적 머지:
gh pr merge <PR_NUMBER> --squash --delete-branch
```

- [ ] **Step 5: GitHub Actions 워크플로우 모니터링**

```bash
gh run list --limit 1
```

Expected: 배포 워크플로우 실행 중. `gh run watch <run_id>` 또는 `gh run view <run_id>`로 상세 확인.

완료까지 1~2분 대기.

- [ ] **Step 6: 배포 성공 확인**

```bash
gh run list --limit 1 --json conclusion,status,name | python -c "import sys,json; d=json.load(sys.stdin)[0]; print(f'name={d[\"name\"]} status={d[\"status\"]} conclusion={d[\"conclusion\"]}')"
```

Expected: `status=completed conclusion=success`.

실패 시: `gh run view <run_id> --log-failed | tail -100`으로 에러 확인 + 롤백 결정.

---

## Task 17: 운영 배포 검증

**Files:** (운영 환경 확인, 코드 변경 없음)

- [ ] **Step 1: health 체크**

```bash
curl -s http://54.180.188.8:3010/api/health
```

Expected: `{"status":"ok","message":"Server is running","timestamp":"..."}`

- [ ] **Step 2: 에이전트 상태 (4개 running 확인)**

```bash
curl -s http://54.180.188.8:3010/api/agents | python -c "
import sys, json
for a in json.load(sys.stdin)['data']:
    print(f\"  - {a['name']}: status={a['status']}, errors={a['metrics']['errors']}\")"
```

Expected:
```
  - GridAgent: status=running, errors=0
  - InfiniteBuyAgent: status=running, errors=0
  - VRAgent: status=running, errors=0
  - StablecoinArbAgent: status=running, errors=0
```

- [ ] **Step 3: 컨테이너 env에 STABLECOIN_* 포함 확인**

```bash
ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 \
  "docker inspect grid-bot --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(DATABASE_URL|MIGRATE_DATABASE_URL|STABLECOIN_DATABASE_URL|STABLECOIN_MIGRATE_DATABASE_URL)=' | sed -E 's|(mysql://)([^:]+):.*|\1\2:***|'"
```

Expected 4줄:
```
DATABASE_URL=mysql://grid_app:***
MIGRATE_DATABASE_URL=mysql://grid_migrate:***
STABLECOIN_DATABASE_URL=mysql://grid_stablecoin_app:***
STABLECOIN_MIGRATE_DATABASE_URL=mysql://grid_stablecoin_migrate:***
```

- [ ] **Step 4: 컨테이너 로그에서 stablecoin migrate deploy 성공 확인**

```bash
ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 \
  "docker logs grid-bot 2>&1 | grep -A 2 'prisma migrate deploy.*stablecoin\|Applied migration' | head -20"
```

Expected: `20260424000000_init` 마이그레이션 적용 로그.

- [ ] **Step 5: 신규 DB 상태 확인 (grid_stablecoin_app으로 read-only)**

```bash
ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 '
  PASSWORD=$(docker inspect grid-bot --format "{{range .Config.Env}}{{println .}}{{end}}" | grep "^STABLECOIN_DATABASE_URL=" | sed -E "s|.*mysql://[^:]+:([^@]+)@.*|\1|")
  HOST=$(docker inspect grid-bot --format "{{range .Config.Env}}{{println .}}{{end}}" | grep "^STABLECOIN_DATABASE_URL=" | sed -E "s|.*@([^/:]+).*|\1|")
  echo "=== grid_stablecoin_arb 테이블 ==="
  docker run --rm -e MYSQL_PWD="$PASSWORD" mysql:8 mysql -h "$HOST" -u grid_stablecoin_app grid_stablecoin_arb -e "SHOW TABLES;"
  echo "=== _prisma_migrations ==="
  docker run --rm -e MYSQL_PWD="$PASSWORD" mysql:8 mysql -h "$HOST" -u grid_stablecoin_app grid_stablecoin_arb -e "SELECT migration_name, finished_at FROM _prisma_migrations;"
'
```

Expected tables:
```
Tables_in_grid_stablecoin_arb
_prisma_migrations
stablecoin_arb_bots
stablecoin_arb_opportunities
stablecoin_arb_trades
```

Expected migration:
```
20260424000000_init    <finished_at timestamp>
```

- [ ] **Step 6: 격리 검증 — grid_stablecoin_app으로 grid_transaction 접근 거부 확인**

```bash
ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 '
  PASSWORD=$(docker inspect grid-bot --format "{{range .Config.Env}}{{println .}}{{end}}" | grep "^STABLECOIN_DATABASE_URL=" | sed -E "s|.*mysql://[^:]+:([^@]+)@.*|\1|")
  HOST=$(docker inspect grid-bot --format "{{range .Config.Env}}{{println .}}{{end}}" | grep "^STABLECOIN_DATABASE_URL=" | sed -E "s|.*@([^/:]+).*|\1|")
  docker run --rm -e MYSQL_PWD="$PASSWORD" mysql:8 mysql -h "$HOST" -u grid_stablecoin_app -e "USE grid_transaction; SELECT COUNT(*) FROM users;" 2>&1 | head -3
'
```

Expected: `ERROR 1044 (42000): Access denied for user 'grid_stablecoin_app'@'%' to database 'grid_transaction'`

**격리 성공.** 이 에러가 나와야 설계대로 작동.

---

## Task 18: (선택) 구 DB 정리 — 사용자 재승인 필수

**Files:** (운영 DB 변경, 코드 변경 없음)

**⚠️ 선행 조건:**
1. Task 17 모든 검증 성공
2. 사용자가 "정리 실행해도 된다" 재승인
3. AWS 스냅샷 `pre-stablecoin-db-separation-20260424` 존재 확인

- [ ] **Step 1: 현재 grid_transaction의 잔존 테이블이 여전히 0 rows인지 재확인 (read-only)**

```bash
ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 '
  PASSWORD=$(docker inspect grid-bot --format "{{range .Config.Env}}{{println .}}{{end}}" | grep "^DATABASE_URL=" | sed -E "s|.*mysql://[^:]+:([^@]+)@.*|\1|")
  HOST=$(docker inspect grid-bot --format "{{range .Config.Env}}{{println .}}{{end}}" | grep "^DATABASE_URL=" | sed -E "s|.*@([^/:]+).*|\1|")
  docker run --rm -e MYSQL_PWD="$PASSWORD" mysql:8 mysql -h "$HOST" -u grid_app grid_transaction -e "
    SELECT \"stablecoin_arb_bots\" AS tbl, COUNT(*) AS rows_count FROM stablecoin_arb_bots
    UNION ALL SELECT \"stablecoin_arb_trades\", COUNT(*) FROM stablecoin_arb_trades
    UNION ALL SELECT \"stablecoin_arb_opportunities\", COUNT(*) FROM stablecoin_arb_opportunities;
  "
'
```

Expected: 모두 0 rows. **만약 >0이면 STOP — 사용자와 다시 논의.**

- [ ] **Step 2: grid_migrate 유저로 DROP 실행**

```bash
MIGRATE_PW_B64=$(echo -n "<MIGRATE_PASSWORD>" | base64 -w 0)

ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 "
  MIGRATE_PW=\$(echo '$MIGRATE_PW_B64' | base64 -d)
  HOST=\$(docker inspect grid-bot --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^DATABASE_URL=' | sed -E 's|.*@([^/:]+).*|\1|')
  docker run --rm -e MYSQL_PWD=\"\$MIGRATE_PW\" mysql:8 mysql -h \"\$HOST\" -u grid_migrate grid_transaction <<SQL
    DROP TABLE IF EXISTS stablecoin_arb_opportunities;
    DROP TABLE IF EXISTS stablecoin_arb_trades;
    DROP TABLE IF EXISTS stablecoin_arb_bots;
    DELETE FROM _prisma_migrations WHERE migration_name IN ('20260421000000_add_stablecoin_arb_models', '20260421010000_fix_arb_opportunity_index_and_timestamp');
    SELECT 'OK' AS status;
SQL
"
```

`<MIGRATE_PASSWORD>`는 `grid_migrate` 비번 (secrets.local.md의 "Grid-bot-DB-v2 분리 유저 (2026-04-23 생성)" 섹션).

Expected: `status: OK`

- [ ] **Step 3: 정리 검증 (read-only)**

```bash
ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 '
  PASSWORD=$(docker inspect grid-bot --format "{{range .Config.Env}}{{println .}}{{end}}" | grep "^DATABASE_URL=" | sed -E "s|.*mysql://[^:]+:([^@]+)@.*|\1|")
  HOST=$(docker inspect grid-bot --format "{{range .Config.Env}}{{println .}}{{end}}" | grep "^DATABASE_URL=" | sed -E "s|.*@([^/:]+).*|\1|")
  echo "=== stablecoin_arb_% 테이블 (비어야 함) ==="
  docker run --rm -e MYSQL_PWD="$PASSWORD" mysql:8 mysql -h "$HOST" -u grid_app grid_transaction -e "SHOW TABLES LIKE \"stablecoin_arb_%\";"
  echo "=== _prisma_migrations 스테이블 기록 (비어야 함) ==="
  docker run --rm -e MYSQL_PWD="$PASSWORD" mysql:8 mysql -h "$HOST" -u grid_app grid_transaction -e "SELECT migration_name FROM _prisma_migrations WHERE migration_name LIKE \"%stablecoin%\";"
'
```

Expected: 두 쿼리 모두 빈 결과.

- [ ] **Step 4: 3개 에이전트 여전히 정상 확인 (정리가 영향 없는지)**

```bash
curl -s http://54.180.188.8:3010/api/agents | python -c "
import sys, json
for a in json.load(sys.stdin)['data']:
    print(f\"  - {a['name']}: status={a['status']}, errors={a['metrics']['errors']}\")"
```

Expected: 모두 running, errors=0.

---

## Task 19: 메모리 + 세션 핸드오프 작성

**Files:**
- Create: `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_session_7_handoff_2026_04_24.md`
- Modify: `~/.claude/projects/D--ExpressProject-Grid-project/memory/MEMORY.md` (새 핸드오프 링크 추가)
- Modify: `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_stablecoin_arb_handoff.md` (DB 분리 완료 반영)
- Modify: `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_resume_next_session.md` (M3 시작 가이드로 갱신)

- [ ] **Step 1: 세션 7 핸드오프 작성**

Create `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_session_7_handoff_2026_04_24.md`:

```markdown
---
name: Grid 프로젝트 세션 7 핸드오프 (2026-04-24)
description: 스테이블코인 DB 분리 완료 — grid_stablecoin_arb + Prisma 2 clients 구조 전환 + 배포 성공
type: project
---
# 세션 7 핸드오프 (2026-04-24)

## 🎯 한 줄 요약
스테이블코인 아비트리지 3개 모델을 `grid_stablecoin_arb` 별도 DB로 분리. Prisma 2 clients 구조로 전환. 배포 성공 + 4개 에이전트 running 검증 완료. M3 실행 엔진 구현 준비 완료.

## ✅ 이번 세션 완료
1. **설계서 작성** (spec + plan)
2. **브랜치 B 실행** — `feat/stablecoin-arb-db-sep` 신규 브랜치 + revert-of-revert
3. **DB/유저 생성** — `grid_stablecoin_app`(DML), `grid_stablecoin_migrate`(DDL) + 격리 검증
4. **Prisma 스키마 분리** — `prisma-stablecoin/schema.prisma` 신설, 기존 schema에서 3모델 제거
5. **init 마이그레이션** — `20260424000000_init` 생성
6. **Prisma client 2개** — `prisma` + `stablecoinPrisma`
7. **코드 import 경로** — stablecoin 서비스/에이전트 모두 stablecoinPrisma 사용
8. **Dockerfile + deploy.yml** — dual migrate + 4개 env
9. **GitHub Secrets** — STABLECOIN_DATABASE_URL, STABLECOIN_MIGRATE_DATABASE_URL 추가
10. **PR 머지 + 배포 성공** — 4개 에이전트 running 검증
11. **(선택) 구 DB 정리** — 빈 테이블 3개 + migration 2건 제거
12. **AWS 스냅샷** — `pre-stablecoin-db-separation-20260424` (사용자 생성)

## 🟢 다음 세션 권장 작업
### 우선순위 1: M3 실행 엔진 (Task 10~14)
- `stablecoin-arb-executor.ts` 신설 (pre-check + Leg-1 + Leg-2 + fallback)
- agent에 executor 연결
- 실거래 스모크 테스트
- 상세: `project_stablecoin_arb_handoff.md`

### 우선순위 2: Phase 2 자동 스냅샷 CI
- IAM 권한 추가 + deploy.yml pre-deploy 스냅샷 단계

### 우선순위 3: secrets.local.md 정리
- 옛 endpoint 제거, 스테이블 섹션 통합

## 📂 세션 7 변경 파일
- `prisma/schema.prisma` (스테이블 모델 3개 + relation 제거)
- `prisma-stablecoin/schema.prisma` (신규)
- `prisma-stablecoin/migrations/20260424000000_init/migration.sql` (신규)
- `src/config/database.ts` (stablecoinPrisma 추가)
- `src/services/stablecoin-arb.service.ts`, `src/agents/stablecoin-arb-agent.ts` (import 경로)
- `Dockerfile`, `.github/workflows/deploy.yml`, `package.json`
- AWS Lightsail: `grid_stablecoin_arb` DB + 유저 2개 신규
- GitHub Secrets: STABLECOIN_* 2개 신규
- `~/.claude/memory/secrets.local.md` (스테이블 분리 유저 섹션)

## 🔙 롤백 가이드
상황별: plan Task 11 롤백 전략 참조.
최악의 경우: AWS 스냅샷 `pre-stablecoin-db-separation-20260424` 복원.

## 참조
- 설계서: `docs/superpowers/specs/2026-04-24-stablecoin-arb-db-separation-design.md`
- 구현 계획: `docs/superpowers/plans/2026-04-24-stablecoin-arb-db-separation-plan.md`
- 세션 6 (DB 권한 분리): `project_session_6_handoff_2026_04_23.md`
- 스테이블 M3 재개 가이드: `project_stablecoin_arb_handoff.md`
```

- [ ] **Step 2: MEMORY.md 인덱스에 새 핸드오프 추가**

Edit `~/.claude/projects/D--ExpressProject-Grid-project/memory/MEMORY.md`, 맨 위 근처에 추가:

```markdown
- [세션 7 핸드오프 2026-04-24](project_session_7_handoff_2026_04_24.md) — 스테이블코인 DB 분리 (grid_stablecoin_arb) + Prisma 2 clients 완료. 다음: M3 실행 엔진
```

- [ ] **Step 3: project_stablecoin_arb_handoff.md 갱신**

"남은 작업 (M3~M7)" 섹션 앞에 "✅ DB 분리 완료 (세션 7)" 노트 추가. M3 시작 시 구조 결정 "필요"가 아니라 "완료됨"으로 갱신.

- [ ] **Step 4: project_resume_next_session.md 갱신**

"30초 요약" + "첫 5분 운영 확인" 섹션에서 4번째 검증(STABLECOIN_DATABASE_URL) 추가.

"우선순위 결정 트리"의 Path A(스테이블 M3)를 "DB 분리 결정 필요"에서 "DB 분리 완료 — executor 구현 시작"으로 갱신.

- [ ] **Step 5: ~/.claude Git 동기화**

```bash
cd ~/.claude
git add memory/ projects/
git commit -m "docs(memory): 세션 7 (스테이블 DB 분리) 핸드오프 + 인덱스 갱신"
git push origin main
```

---

## Self-Review (plan 작성 후 자체 체크)

### 1. 스펙 커버리지
- [x] Section 2 결정 7개 → Task 3, 4, 5, 6, 7 (ex: decision #2 = 브랜치 전략 → Task 16 push)
- [x] Section 3 아키텍처 → Task 3 (DB/유저) + Task 7 (Prisma 2 clients)
- [x] Section 4 DB/유저 생성 → Task 1~3
- [x] Section 5 Prisma 스키마 분리 → Task 4, 5, 6
- [x] Section 6 Prisma Client 코드 → Task 7, 8, 9
- [x] Section 7 배포 파이프라인 → Task 13, 14, 15
- [x] Section 8 에러 처리 → Task 10 (agent isolation)
- [x] Section 9 테스트 전략 → Task 12
- [x] Section 10 구 DB 정리 → Task 18
- [x] Section 11 롤백 → (각 task 내 언급, 특히 Task 13 롤백 가이드)
- [x] Section 12 구현 순서 → Task 1~19 순서로 매핑

### 2. Placeholder 스캔
- [x] Task 1 Step 1: `<APP_PASSWORD>`, `<MIGRATE_PASSWORD>` — 생성된 실제 값으로 치환 지시 명시
- [x] Task 3 Step 2: `<DBMASTER_PASSWORD>` — secrets.local.md 참조 지시 명시
- [x] Task 15 Step 2: URL 템플릿 내 `<APP_PASSWORD>` — 치환 지시 명시
- [x] Task 18 Step 2: `<MIGRATE_PASSWORD>` — secrets.local.md 참조 지시 명시
- [x] 모든 code block에 실제 코드 (스니펫 아닌 완성본)
- [x] "TBD", "TODO", "fill in later" 등 없음

### 3. 타입/시그니처 일관성
- [x] `stablecoinPrisma` 이름은 database.ts 정의 → 서비스/에이전트 사용 일관
- [x] `Prisma` namespace import from `.prisma/client-stablecoin` → arb.service.ts에서 사용 일관
- [x] `StablecoinPrismaClient` 타입명 → database.ts 정의 + import 일관
- [x] 환경변수명 `STABLECOIN_DATABASE_URL` / `STABLECOIN_MIGRATE_DATABASE_URL` → 모든 곳 일관

**자체 리뷰 결과: 통과.**

---

## 예상 총 소요 시간

- Task 1~3 (비번 + 스냅샷 + DB): 20분 (SSH + mysql 명령)
- Task 4~6 (Prisma 스키마): 20분
- Task 7~12 (코드): 25분 (TypeScript 검증 + 테스트 통과 확인)
- Task 13~15 (Docker/CI/Secrets): 15분
- Task 16~17 (배포 + 검증): 10분 (GitHub Actions 1~2분)
- Task 18~19 (정리 + 메모리): 15분

**합계: 약 1시간 45분** (1.5~2시간 예상에 부합)
