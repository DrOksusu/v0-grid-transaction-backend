# 빗썸 신규상장 모니터 — 설계 문서

**작성일**: 2026-06-21
**상태**: Draft — 사용자 검토 대기
**관련 모듈**: `bithumb-listing-monitor-agent`, `bithumb-listing-monitor.service`, `listing-auto-trader.service`, `listing-auto-seller.service`

---

## 1. 목적

기존 업비트 신규상장 모니터(`upbit-listing-monitor-agent`)와 동일 패턴으로, 빗썸 신규 상장 공지를 자동 감지하여 글로벌 거래소(Binance/MEXC/Gate.io)에서 시장가 매수하고 익절/손절/시간초과/트레일링 조건에 따라 자동 매도한다.

업비트 모니터와 별개로 동작하되, source별 config 분리를 통해 빗썸은 작은 금액 + 보수적 매도 조건으로 시작해서 운영 데이터를 보며 조정한다.

## 2. 결정된 사항 (Brainstorming 결과)

| 결정 사항 | 값 |
|----------|----|
| 출시 phasing | **B**: 감지 + 자동매매 동시 출시 (단, default `enabled=false`로 admin이 수동 ON) |
| 감지 채널 | **Tier 1**: 텔레그램 + 마켓 diff (`/v1/market/all`). 공지 페이지/트위터는 drop |
| 매수 대상 거래소 | **A'**: Binance/MEXC/Gate.io (업비트 모니터와 동일) — 빗썸 자체 매수 제외 |
| 매도 조건 | **C**: source별 분리, 빗썸 default는 보수적 값. Admin UI에서 자유 조정 |
| Admin 권한 | Admin email 1명만 (`ok4192@hanmail.net`) — 기존 패턴 재사용 |
| DB 구조 | **B**: 통합 테이블 + `source` enum 컬럼 + composite unique |
| Admin UI | `/admin/listings` 통합 페이지 (소스 탭 UI). `/admin/upbit-listings`는 302 리다이렉트 |
| 마이그레이션 | 1단계 (다운타임 사실상 0 — 운영 row 1개) |

## 3. 데이터 흐름

```
[BithumbListingMonitorAgent]  cycle = 5초
    ├─ pollBithumbTelegram()         ─→ https://t.me/s/BithumbExchange (공개 HTML 스크레이핑)
    └─ checkNewBithumbMarkets()      ─→ GET https://api.bithumb.com/v1/market/all
                ↓
        ListingAnnouncement DB insert (source='BITHUMB')
                ↓
        listingAutoTraderService.trigger(announcement)   ← 기존 코드 재사용 + source 분기
                ├─ source='BITHUMB' config 로드
                ├─ enabled=true 인 거래소(Binance/MEXC/Gate.io)에서 시장가 매수
                └─ ListingOrder DB insert (source='BITHUMB', status='pending')
                ↓
        ListingSnapshotScheduler (+1h/+2h/+4h/+6h 가격 스냅샷, 업비트 패턴 동일)
                ↓
        listingAutoSellerService.checkAndSell()  ← 5초마다, source 분기
                ├─ order.source='BITHUMB' config 로드 (TP/SL/maxHold/trailing)
                └─ 매도 실행 → ListingOrder status='closed'
                ↓
        kakaoNotify (감지/매수/매도 각 단계, `[빗썸]` prefix)
```

## 4. 신규 / 수정 파일

### 백엔드 신규
- `src/agents/bithumb-listing-monitor-agent.ts` — `BaseAgent` 상속, 5초 cycle
- `src/services/bithumb-listing-monitor.service.ts` — 텔레그램 + 마켓 diff 폴링 로직
- `prisma/migrations/<timestamp>_add_listing_source_column/migration.sql` — 아래 §7 참조

### 백엔드 수정
- `prisma/schema.prisma` — `ListingAutoTradeConfig`, `ListingAnnouncement`, `ListingOrder`에 `source ListingSource` 추가, unique 제약 교체
- `src/services/listing-auto-trader.service.ts` — `getConfig(source)`, `updateConfig(source, data)`, `trigger(announcement)` (announcement.source 기반 분기)
- `src/services/listing-auto-seller.service.ts` — order.source별 config 로드 분기
- `src/controllers/upbit-listing-admin.controller.ts` → `listing-admin.controller.ts` 리네임, `source` 쿼리 파라미터 받음
- `src/routes/index.ts` — `/api/admin/listings/*` 신규 라우트 마운트, `/api/admin/upbit-listings/*`는 1주일 별칭 유지 후 제거
- `src/agents/index.ts` — `BithumbListingMonitorAgent` 등록

### 프론트엔드 신규
- `app/admin/listings/page.tsx` — 통합 페이지 (소스 탭 UI)

### 프론트엔드 수정
- `app/admin/upbit-listings/page.tsx` — Next.js `redirect()`로 `/admin/listings?source=UPBIT` 즉시 리다이렉트 (단일 라인)
- `lib/api.ts` — listing API 호출에 `source` 파라미터 추가, 함수명 `list*`/`get*` 패턴 유지

## 5. 감지 채널 세부

### 5-1. 텔레그램 채널 스크레이핑 (Primary)

| 항목 | 값 |
|------|----|
| URL | `https://t.me/s/BithumbExchange` |
| 인증 | 없음 (공개 채널 HTML) |
| 클라이언트 | `axios.get` + 일반 User-Agent |
| 파싱 | `node-html-parser` — `div.tgme_widget_message` 셀렉터 |
| 폴링 간격 | 5초 (에이전트 cycle과 동일) |
| 캐시 | `seenTelegramMsgIds: Set<string>` (data-post 속성 기반) |

**메시지 패턴**:
```
[마켓 추가] 리프로토콜(RE) 원화 마켓 추가
https://feed.bithumb.com/notice/1653785
```

**필터링 정규식**:
```typescript
const TELEGRAM_LISTING_PREFIX = /^\[마켓 추가\]/;
const BITHUMB_LISTING_PATTERN = /([가-힣\w\d]+?)\(([A-Z0-9]+)\)\s*원화\s*마켓\s*추가/;
const NOTICE_URL_PATTERN = /feed\.bithumb\.com\/notice\/(\d+)/;
const TICKER_EXCLUDES = new Set(['KRW', 'BTC', 'USDT', 'ETH', 'BNB', 'USDC']);
```

**동작**:
1. 채널 HTML fetch → 메시지 박스 추출
2. 신규 메시지 (캐시에 없는 data-post)만 처리
3. `[마켓 추가]` prefix 통과 → ticker/name 추출 → noticeId 추출
4. `ListingAnnouncement` insert with `source='BITHUMB'`, `noticeId={실제 빗썸 글번호}`
5. `listingAutoTraderService.trigger(announcement)` 호출
6. 캐시에 messageId 추가

### 5-2. 마켓 목록 diff (Secondary, 백업)

| 항목 | 값 |
|------|----|
| API | `GET https://api.bithumb.com/v1/market/all` |
| 인증 | 없음 (Public API) |
| 응답 | `[{market: "KRW-BTC", korean_name, english_name, market_warning}, ...]` |
| 폴링 간격 | 5초 |
| 캐시 | `bithumbMarkets: Set<string>` (KRW-XXX 마켓명) |

**동작**:
1. 부팅 직후 첫 fetch → 전체 마켓을 baseline으로 캐시 저장 (이때 announcement 생성 안 함)
2. 이후 fetch마다 diff → 신규 KRW 마켓 등장 시
3. 합성 noticeId 생성: `SYNTHETIC_BASE_MARKET + (Date.now() % BAND)` (대역은 §8 참조)
4. `ListingAnnouncement` insert with `source='BITHUMB'`, `snapshotType='MARKET_DIFF'`
5. 단, 같은 ticker가 이미 최근 24h 내 텔레그램 채널로 감지됐다면 중복 방지로 매수 트리거 스킵 (announcement만 기록)

**가치**: 거래 개시 시점 정확 감지 — 텔레그램이 실패해도 backup으로 동작.

**안전장치**:
- `lastMarketRefreshOkAt` baseline 부팅 시 `Date.now()`로 초기화 (부팅 직후 첫 fetch에서 모든 마켓을 "신규"로 오인 방지)
- 마켓 조회 10분 연속 실패 → 카카오 blind 경고 (한 번만, 복구 시 자동 reset)

## 6. 매수 트리거 + 매도 안전장치

### 매수 트리거

`listingAutoTraderService.trigger(announcement)`에서 `announcement.source` 기반으로 분기:

```typescript
async trigger(announcement: ListingAnnouncement): Promise<void> {
  const config = await this.getConfig(announcement.source);  // source별 config 로드
  if (!config.enabled || config.killSwitch) return;

  // 중복 방지: 같은 ticker + 같은 source의 announcement가 최근 24h 내 이미 매수 트리거됐으면 스킵
  const duplicate = await prisma.listingOrder.findFirst({
    where: {
      source: announcement.source,
      ticker: announcement.ticker,
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
  if (duplicate) return;

  // 거래소별 시장가 매수 (best-effort, 한 거래소 실패가 다른 거래소 매수 막지 않음)
  const targets = this.resolveTargetExchanges(config);  // Binance/Bithumb/MEXC/Gate.io 중 true인 것만
  for (const exchange of targets) {
    try {
      await this.balancePrecheck(exchange, config.amountKrw);
      const order = await this.placeMarketOrder(exchange, announcement.ticker, config.amountKrw);
      await this.recordOrder(announcement, exchange, order);
      await this.checkMinBalanceGuard(exchange, config);  // 잔고 가드
    } catch (e) {
      kakaoNotifyService.notify(`❌ [${announcement.source === 'BITHUMB' ? '빗썸' : '업비트'}→${exchange}] ${announcement.ticker} 매수 실패: ${e.message}`);
    }
  }
}
```

### 매도 안전장치

`listingAutoSellerService.checkAndSell()`은 5초마다 `status='pending'` 또는 `status='holding'` 모든 order를 검사:

```typescript
async checkAndSell(): Promise<void> {
  const openOrders = await prisma.listingOrder.findMany({
    where: { status: { in: ['pending', 'holding'] } },
  });
  for (const order of openOrders) {
    const config = await listingAutoTraderService.getConfig(order.source);  // order의 source로 분기
    if (!config.autoSellEnabled || config.killSwitch) continue;
    // ... TP/SL/maxHold/trailing 조건 체크 (기존 로직)
  }
}
```

### Per-source Kill Switch + Min Balance Guard

- `killSwitch=true` → 해당 source의 매수/매도 즉시 정지
- `minTakerBalance` 미만 → 해당 source의 `enabled=false`로 자동 변경 (업비트는 그대로 동작)

## 7. DB 스키마 변경

### 실제 기존 모델 (변경 전)

현재 `prisma/schema.prisma`에 다음 모델이 존재한다 (이 spec 작성 후 실측 확인):

- `UpbitListingAnnouncement` (table `upbit_listing_announcements`) — `noticeId Int @unique`
- `ListingAutoTradeConfig` (table `listing_auto_trade_config`) — **싱글톤 패턴 (id=1 고정)**, 코드에서 `findUnique({ where: { id: 1 } })`로 접근. `userId`/`killSwitch`/`minTakerBalance` 컬럼은 **존재하지 않음**
- `ListingAutoOrder` (table `listing_auto_orders`) — `announcementId` FK to `UpbitListingAnnouncement`
- `ListingPriceSnapshot` (table `listing_price_snapshots`) — `announcementId` FK to `UpbitListingAnnouncement`

### 변경 원칙

1. **모델/테이블명은 유지** — `UpbitListingAnnouncement`, `ListingAutoOrder` 그대로. production 데이터 손실 위험 회피 (CLAUDE.md destructive 쿼리 금지 원칙)
2. **싱글톤 → source별 row** — `ListingAutoTradeConfig`에 `source` enum 추가 + `@unique`. `userId` 추가 안 함 (코드가 이미 `ADMIN_USER_ID = 2` 하드코딩, 멀티유저 요구사항 없음)
3. **신규 컬럼은 신규로 명시** — `killSwitch`, `minTakerBalance`는 NEW

### Prisma 모델 (변경 후)

```prisma
enum ListingSource {
  UPBIT
  BITHUMB
}

// 모델명은 "Upbit*" 그대로 유지 (production 테이블 보존 위해)
// 빗썸 데이터도 같은 테이블에 source='BITHUMB'로 저장
model UpbitListingAnnouncement {
  id          Int           @id @default(autoincrement())
  source      ListingSource @default(UPBIT)              // NEW
  noticeId    Int                                        // @unique 제거 (composite로 교체)
  title       String
  ticker      String?
  url         String
  announcedAt DateTime      @default(now())
  listedAt    DateTime?
  status      String        @default("announced")
  snapshots   ListingPriceSnapshot[]
  autoOrders  ListingAutoOrder[]

  @@unique([source, noticeId])                           // NEW (기존 noticeId @unique 교체)
  @@index([announcedAt])
  @@index([ticker])
  @@index([status])
  @@index([source, announcedAt])                         // NEW
  @@map("upbit_listing_announcements")
}

model ListingAutoTradeConfig {
  id              Int           @id @default(autoincrement())
  source          ListingSource @unique @default(UPBIT)  // NEW (싱글톤 패턴 폐기, source가 unique key)
  enabled         Boolean       @default(false)
  killSwitch      Boolean       @default(false)          // NEW
  amountKrw       Int           @default(100000)
  useBinance      Boolean       @default(true)
  useBithumb      Boolean       @default(true)
  useMexc         Boolean       @default(false)
  useGateio       Boolean       @default(false)
  autoSellEnabled Boolean       @default(true)
  takeProfitPct   Float         @default(20)
  stopLossPct     Float         @default(10)
  maxHoldMinutes  Int           @default(30)
  useTrailingStop Boolean       @default(false)
  trailingStopPct Float         @default(20)
  minTakerBalance Float?                                 // NEW
  updatedAt       DateTime      @updatedAt

  @@map("listing_auto_trade_config")
}

model ListingAutoOrder {
  // 기존 필드 그대로 + source 추가
  // ...
  source         ListingSource @default(UPBIT)           // NEW
  // ...

  @@index([source, createdAt])                           // NEW
  // 기존 @@unique([announcementId, exchange])는 유지 — announcement.source 따라가므로 자동 분리
}
```

**중요 — Default 값 정책**:
- 기존 row(id=1)는 마이그레이션의 `DEFAULT 'UPBIT'`로 자동 백필됨 → 위 default 값(`takeProfitPct: 20` 등)이 적용되지 않음 (기존 row의 실제 값 유지)
- 빗썸 신규 row 생성 시에는 위 default가 적용되지 않고, **코드에서 source별 default를 분기 처리** (Task 6에서 구현):
  ```typescript
  if (source === 'BITHUMB') {
    return { source, enabled: false, amountKrw: 10000, takeProfitPct: 10, stopLossPct: 5, maxHoldMinutes: 15, useTrailingStop: true, trailingStopPct: 10, ... };
  }
  ```

### 마이그레이션 SQL (단순화됨)

```sql
-- 1) 컬럼 추가 (DEFAULT로 기존 row 자동 백필)
ALTER TABLE `upbit_listing_announcements`
  ADD COLUMN `source` ENUM('UPBIT', 'BITHUMB') NOT NULL DEFAULT 'UPBIT';

ALTER TABLE `listing_auto_trade_config`
  ADD COLUMN `source` ENUM('UPBIT', 'BITHUMB') NOT NULL DEFAULT 'UPBIT',
  ADD COLUMN `killSwitch` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `minTakerBalance` DOUBLE NULL;

ALTER TABLE `listing_auto_orders`
  ADD COLUMN `source` ENUM('UPBIT', 'BITHUMB') NOT NULL DEFAULT 'UPBIT';

-- 2) Unique 제약 교체 (UpbitListingAnnouncement.noticeId @unique → composite)
ALTER TABLE `upbit_listing_announcements`
  DROP INDEX `upbit_listing_announcements_noticeId_key`,
  ADD UNIQUE INDEX `upbit_listing_announcements_source_noticeId_key` (`source`, `noticeId`);

-- 3) ListingAutoTradeConfig: 기존 id=1 row에 source='UPBIT' 백필 후 source @unique 추가
ALTER TABLE `listing_auto_trade_config`
  ADD UNIQUE INDEX `listing_auto_trade_config_source_key` (`source`);

-- 4) source별 빠른 조회 인덱스
ALTER TABLE `upbit_listing_announcements`
  ADD INDEX `upbit_listing_announcements_source_announcedAt_idx` (`source`, `announcedAt`);

ALTER TABLE `listing_auto_orders`
  ADD INDEX `listing_auto_orders_source_createdAt_idx` (`source`, `createdAt`);
```

**실행 순서 (CLAUDE.md production DB 안전 규칙 준수)**:
1. 운영 DB 수동 스냅샷: `aws lightsail create-relational-database-snapshot --relational-database-name <db> --relational-database-snapshot-name pre-bithumb-listing-$(date -u +%Y%m%d-%H%M%S) --profile route53`
2. 로컬 dev DB에서 마이그레이션 dry-run → 기존 row 정상 백필 확인
3. **사전 검증** (advisor 권고): dev DB에서 `SELECT COUNT(*) FROM upbit_listing_announcements WHERE noticeId IS NULL` → 0 확인 (NULL이면 unique 제약 변경 시 에러). production도 동일 확인.
4. Production: `npx prisma migrate deploy` (`migrate dev` 금지)
5. 백엔드 재시작 → `BithumbListingMonitorAgent` 자동 시작 (단, `enabled=false`라 매수 안 함)

### 정확한 인덱스명은 마이그레이션 생성 후 확인

Prisma가 자동 생성한 unique key 이름은 환경마다 다를 수 있다. `DROP INDEX` 이름은 dev DB에서 `SHOW INDEX FROM upbit_listing_announcements` 확인 후 실제 이름으로 교체한다.

## 8. 합성 noticeId 대역

업비트 모니터와 충돌하지 않도록 `@@unique([source, noticeId])` 복합 제약을 사용하므로 빗썸도 업비트와 같은 대역을 재사용한다 (source가 다르면 같은 noticeId 허용).

| Source | 채널 | 대역 |
|--------|------|------|
| UPBIT | 마켓 diff | `1_500_000_000 + (Date.now() % 200_000_000)` |
| UPBIT | 트위터 | `1_700_000_000 + ...` |
| UPBIT | 텔레그램 | `1_900_000_000 + ...` |
| **BITHUMB** | **공지 (실제 글번호)** | **1 ~ 수십만** (실제 noticeId 사용) |
| **BITHUMB** | **마켓 diff** | **`1_500_000_000 + (Date.now() % 200_000_000)`** (UPBIT와 같은 대역, source가 다르므로 충돌 없음) |

빗썸 텔레그램은 메시지 본문에 실제 noticeId URL이 있으므로 그것을 그대로 사용한다 (합성 불필요).

## 9. Admin UI 통합

### 라우트

| 라우트 | 동작 |
|--------|------|
| `/admin/listings` | 통합 페이지 (default 탭 = UPBIT) |
| `/admin/listings?source=UPBIT` | 업비트 탭 |
| `/admin/listings?source=BITHUMB` | 빗썸 탭 |
| `/admin/upbit-listings` | Next.js `redirect()` → `/admin/listings?source=UPBIT` |

### API 라우트 변경

| 기존 | 신규 |
|------|------|
| `GET /api/admin/upbit-listings` | `GET /api/admin/listings?source={UPBIT|BITHUMB}` |
| `GET /api/admin/upbit-listings/:id` | `GET /api/admin/listings/:id?source=...` |
| `PUT /api/admin/upbit-listings/auto-trade/config` | `PUT /api/admin/listings/auto-trade/config?source=...` |
| `POST /api/admin/upbit-listings/manual` | `POST /api/admin/listings/manual?source=...` |
| `GET /api/admin/upbit-listings/auto-trade/orders` | `GET /api/admin/listings/auto-trade/orders?source=...` |

기존 `/api/admin/upbit-listings/*` 라우트는 신규 라우트로 내부 위임 (1주일 유지 후 제거).

### UI 구조

```
┌─ 헤더 + 탭 ──────────────────────────┐
│  [ 업비트 ]  [ 빗썸 ]                  │
├──────────────────────────────────────┤
│  ┌─ 자동매수/매도 설정 (per-source) ─┐
│  │  Kill Switch [OFF]                  │
│  │  Enabled toggle                     │
│  │  매수금액 (KRW), 거래소 체크박스    │
│  │  자동매도 활성화, TP/SL/maxHold/trail│
│  │  [ 저장 ]                            │
│  └──────────────────────────────────────┘
│  ┌─ 상장 공지 목록 (per-source) ────┐
│  ┌─ 최근 자동매수 주문 (per-source)─┐
│  ┌─ 수동 공지 등록 (per-source) ────┐
└──────────────────────────────────────┘
```

Admin email gating은 기존 `ADMIN_EMAIL` 상수 패턴 유지.

## 10. 알림 (카카오톡)

기존 `kakaoNotifyService` 재사용. 메시지에 `[빗썸]` / `[업비트]` prefix.

| 이벤트 | 메시지 예시 |
|--------|------------|
| 신규 상장 감지 | `🆕 [빗썸] 리프로토콜(RE) 신규 상장 감지 (텔레그램)` |
| 자동매수 성공 | `✅ [빗썸→Binance] RE 시장가 매수 ₩10,000 (filled)` |
| 자동매수 실패 | `❌ [빗썸→MEXC] RE 매수 실패: insufficient balance` |
| 자동매도 성공 | `💰 [빗썸] RE 매도 (+15.3%, +1,530원, 트레일링)` |
| 자동매도 손절 | `📉 [빗썸] RE 손절 (-9.8%, -980원)` |
| 자동매도 시간초과 | `⏰ [빗썸] RE 시간초과 매도 (+2.1%, +210원)` |
| Min Balance Guard 발동 | `🚫 [빗썸] 잔고 부족으로 자동매수 비활성화` |
| 마켓 감지 blind 경고 | `⚠️ [빗썸] 마켓 목록 조회 10분 연속 실패 — 감지 blind 가능성` |

## 11. 에러 처리 + 채널 격리

```typescript
async onCycle(): Promise<void> {
  await Promise.allSettled([
    this.pollBithumbTelegram().catch(e => this.logChannelError('telegram', e)),
    this.checkNewBithumbMarkets().catch(e => this.logChannelError('market_diff', e)),
  ]);
  await listingAutoSellerService.checkAndSell().catch(e => this.logSellerError(e));
}
```

- 채널별 실패 카운터 (`channelFailCount: Map<string, number>`)
- 연속 실패 10분 이상 → 카카오 blind 경고 (한 번만, 복구 시 reset)
- 일시적 네트워크 에러는 `console.error`만, critical error만 카카오 알림
- 업비트 자동매수 실패가 빗썸 자동매수에 영향 주지 않도록 try/catch 격리

## 12. 테스트 전략

### Unit Test (jest)

| 대상 | 검증 |
|------|------|
| `parseBithumbListing` | §5-1 sample 15개 제목으로 ticker/name 추출 정확성 (100% 일치 기준) |
| `BITHUMB_LISTING_PATTERN` regex | edge case — 한글+숫자 이름, 괄호 부가정보(`(거래 오픈 X시 예정)`, `(심볼명 변경)`) |
| `TICKER_EXCLUDES` 필터 | KRW/BTC/USDT 등 제외 코인 차단 |
| 텔레그램 메시지 파서 | `[마켓 추가]` prefix 필터링 + noticeId URL 추출 |
| 마켓 diff 부팅 baseline | 부팅 직후 첫 fetch에서 announcement 0건 생성 |

### Integration Test

| 대상 | 검증 |
|------|------|
| `bithumbListingMonitorService.checkNewBithumbMarkets()` | mock `/v1/market/all` 응답으로 신규 마켓 detect |
| `listingAutoTraderService.trigger(source='BITHUMB', ...)` | source별 config 정확히 로드, 매수 거래소 분기 정상 |
| `ListingAutoTradeConfig` per-source CRUD | `(userId, source)` 복합 unique 동작 |
| 24h 중복 매수 방지 | 같은 ticker + 같은 source로 두 번 announcement → 첫 번째만 매수 트리거 |

### Manual Test (출시 전 1회)

| 단계 | 방법 | 통과 기준 |
|------|------|----------|
| 텔레그램 채널 fetch | `axios.get('https://t.me/s/BithumbExchange')` | 200 OK + `tgme_widget_message` div 존재 |
| 마켓 diff | `GET https://api.bithumb.com/v1/market/all` | 200 OK + KRW 마켓 약 200개 |
| Admin UI 탭 전환 | `/admin/listings` 접속 → 업비트/빗썸 탭 클릭 | 각 탭의 데이터/config가 격리되어 표시 |
| Kill switch | 빗썸 탭에서 ON 토글 | 다음 cycle에서 빗썸 자동매수 정지 (업비트는 계속 동작) |
| 수동 공지 등록 dry-run | 빗썸 source로 수동 공지 등록 (`enabled=false`) | announcement 기록되되 매수 시도 없음 |

### Production Canary

1. 빗썸 `enabled=false` 상태로 1주일 운영
   - 텔레그램 감지 false positive/negative 0건 검증
   - 마켓 diff 감지 정확도 검증
2. 1주일 후 `enabled=true`, `amountKrw=10000` (1만원)로 첫 매수 시도
3. 첫 5건 자동매수 결과 모니터링
4. 결과 좋으면 amountKrw 증액 검토, 결과 나쁘면 매도 조건 조정 후 재시도

## 13. 출시 전 검증 체크리스트

- [ ] 텔레그램 채널 동작: `axios.get('https://t.me/s/BithumbExchange')` 200 OK, `tgme_widget_message` div 파싱 가능
- [ ] 마켓 API 동작: `axios.get('https://api.bithumb.com/v1/market/all')` 200 OK, KRW 마켓 정상 응답
- [ ] DB 마이그레이션 dry-run (로컬 dev DB): 기존 row `source='UPBIT'` 백필 확인
- [ ] 회귀 테스트: 업비트 자동매수/매도가 빗썸 추가 후에도 정상 동작
- [ ] 빗썸 source로 매수 트리거 시 Binance/MEXC/Gate.io에서 매수가 의도대로 동작 (이미 listing-auto-trader에 통합되어 있음, source 분기만 추가)
- [ ] `kakaoNotifyService`가 `[빗썸]` prefix로 정상 발송
- [ ] 운영 DB 수동 스냅샷 생성 (`pre-bithumb-listing-...`)
- [ ] Admin email gating 동작 (비-admin 접근 시 차단)

## 14. 롤백 전략

| 단계 | 방법 | 영향 |
|------|------|------|
| Soft rollback | Admin UI에서 빗썸 `killSwitch=true` | 즉시 자동매수/매도 정지, 코드 변경 없음 |
| Agent 중지 | Admin agents 페이지에서 `BithumbListingMonitorAgent` stop | 감지 중단 (업비트는 계속) |
| Hard rollback | Docker tag 직전 release로 롤백 | DB는 forward-compatible (`source='BITHUMB'` row만 무시) |
| DB 롤백 (최후) | 사전 스냅샷에서 복원 | 운영 데이터 손실 가능 — 최후 수단 |

## 15. 관측성

`BithumbListingMonitorAgent.getExtraInfo()`에서 `BaseAgent` metrics 페이지에 다음 노출:

- 채널별 마지막 폴링 시각 (`lastTelegramPollAt`, `lastMarketRefreshOkAt`)
- 채널별 실패 카운터 (`telegramFailCount`, `marketRefreshFailCount`)
- 최근 24h 감지 건수 (텔레그램/마켓 diff 각각)
- 최근 24h 매수 트리거 건수
- 합성 noticeId 충돌 발생 횟수 (이론상 0이어야 함)

## 16. 위험 / 미해결 항목

| 항목 | 위험도 | 대응 |
|------|--------|------|
| 빗썸 텔레그램 메시지 패턴 변경 가능성 | 중 | 정규식 mismatch 시 announcement 생성 안 함 → 마켓 diff가 backup으로 동작 |
| 빗썸 텔레그램 차단 (Cloudflare 등 도입 시) | 중 | 차단 발생 시 마켓 diff만 남음 → 공지 페이지 Playwright 도입 검토 (Phase 1.5) |
| `t.me/s/{channel}` 웹뷰 deprecation | 낮음 | Telegram이 공식적으로 제공하는 안정 엔드포인트, 단기 deprecation 가능성 낮음 |
| 신규 마켓 추가가 신규 상장이 아닌 경우 (마켓 재오픈 등) | 낮음 | `ListingAnnouncement` 기록은 되지만 24h 중복 방지로 매수 트리거 안 됨 |
| 마이그레이션 시 unique index 이름 mismatch | 중 | 운영 DB에서 `SHOW INDEX` 확인 후 SQL 수정 |

## 17. Out of Scope (이번 spec 제외)

- 빗썸 자체 매수 (`useBithumb=true`로 빗썸에서 사기) — default `false`. 필요 시 admin UI에서 ON 가능하나, 거래 개시 전엔 매수 불가하므로 의미 제한적
- 빗썸 공지 페이지 스크래핑 (Playwright 필요) — Phase 1.5로 deferred
- 빗썸 트위터 모니터링 — signal/noise 비율 낮아 drop
- 코인원/OKX 등 다른 거래소 추가 — `ListingSource` enum 확장만으로 가능하나 별도 spec 필요

## 18. 후속 작업

1. **이 spec 사용자 승인**
2. **writing-plans 스킬로 구현 계획 작성** (atomic task 분해)
3. **executing-plans 스킬로 단계별 구현 + 검증**
4. **출시 후 1주일 canary 결과 정리** → 매수 활성화 결정

---

**문의/수정**: 위 §16 위험 항목 중 하나라도 추가 검증이 필요하다고 판단되면 본 spec 수정 후 재검토.
