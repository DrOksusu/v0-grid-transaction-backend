# 빗썸 신규상장 모니터 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 빗썸 신규 상장 공지를 텔레그램 + 마켓 diff로 자동 감지하여 글로벌 거래소(Binance/MEXC/Gate.io)에서 시장가 매수하고 source별 매도 조건으로 자동 매도하는 시스템 구축.

**Architecture:** 기존 `upbit-listing-monitor-agent` 패턴을 그대로 확장. DB는 `source` enum 컬럼으로 통합 테이블, `(userId, source)` 복합 unique. Admin UI는 `/admin/listings` 통합 페이지(소스 탭). 빗썸 자체 매수는 default OFF, Binance/MEXC/Gate.io만 매수.

**Tech Stack:** Express 5 + TypeScript + Prisma(MySQL), Next.js 16 + React 19 + shadcn/ui, axios + node-html-parser, jest

**Related Spec:** `docs/superpowers/specs/2026-06-21-bithumb-listing-monitor-design.md`

---

## 작업 순서 (Phase별)

- **Phase 1 (Task 1~2)**: DB 스키마 + 마이그레이션
- **Phase 2 (Task 3~5)**: 빗썸 메시지 파서 + 모니터 서비스
- **Phase 3 (Task 6~8)**: 백엔드 source 분기 + 에이전트 등록
- **Phase 4 (Task 9~10)**: 컨트롤러/라우트 통합
- **Phase 5 (Task 11~13)**: 프론트엔드 통합 UI
- **Phase 6 (Task 14~16)**: 출시 전 검증 + production 배포 + 카나리 시작

---

## Task 1: Prisma 스키마에 source enum + composite unique 추가

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: 스키마 수정**

`prisma/schema.prisma` 상단(다른 enum들 옆)에 추가:

```prisma
enum ListingSource {
  UPBIT
  BITHUMB
}
```

`ListingAutoTradeConfig` 모델 수정:
```prisma
model ListingAutoTradeConfig {
  id                  Int           @id @default(autoincrement())
  userId              Int           @default(2)        // 기존 단일 row → admin user
  source              ListingSource @default(UPBIT)
  enabled             Boolean       @default(false)
  killSwitch          Boolean       @default(false)
  amountKrw           Int           @default(10000)
  useBinance          Boolean       @default(true)
  useBithumb          Boolean       @default(false)
  useMexc             Boolean       @default(true)
  useGateio           Boolean       @default(true)
  autoSellEnabled     Boolean       @default(true)
  takeProfitPct       Float         @default(10)
  stopLossPct         Float         @default(5)
  maxHoldMinutes      Int           @default(15)
  useTrailingStop     Boolean       @default(true)
  trailingStopPct     Float         @default(10)
  minTakerBalance     Float?
  createdAt           DateTime      @default(now())
  updatedAt           DateTime      @updatedAt

  @@unique([userId, source])
}
```

`ListingAnnouncement` 모델 수정 (기존 필드 유지하고 source만 추가, unique 교체):
```prisma
model ListingAnnouncement {
  // ... 기존 필드들 그대로
  source              ListingSource @default(UPBIT)

  @@unique([source, noticeId])
  @@index([source, announcedAt])
}
```

`ListingOrder` 모델 수정:
```prisma
model ListingOrder {
  // ... 기존 필드들 그대로
  source              ListingSource @default(UPBIT)

  @@index([source, createdAt])
}
```

- [ ] **Step 2: 마이그레이션 SQL 생성 (--create-only)**

Run: `npx prisma migrate dev --create-only --name add_listing_source_column`
Expected: `prisma/migrations/<timestamp>_add_listing_source_column/migration.sql` 생성

- [ ] **Step 3: 마이그레이션 SQL 검사 + 수정**

생성된 `migration.sql` 파일을 열고:
1. CLAUDE.md 글로벌 규칙(Prisma migrate CLI garbage 패턴) 따라 박스 문자 혼입 여부 확인 — `cat migration.sql | tail -20`
2. SQL 내용이 아래와 일치하는지 확인 (Prisma가 자동 생성한 인덱스 이름은 환경마다 다를 수 있음 — DROP INDEX 이름은 실제 생성된 이름으로 사용):

```sql
-- 컬럼 추가 (DEFAULT 'UPBIT'로 기존 row 자동 백필)
ALTER TABLE `ListingAutoTradeConfig` ADD COLUMN `source` ENUM('UPBIT', 'BITHUMB') NOT NULL DEFAULT 'UPBIT';
ALTER TABLE `ListingAnnouncement` ADD COLUMN `source` ENUM('UPBIT', 'BITHUMB') NOT NULL DEFAULT 'UPBIT';
ALTER TABLE `ListingOrder` ADD COLUMN `source` ENUM('UPBIT', 'BITHUMB') NOT NULL DEFAULT 'UPBIT';

-- Unique 제약 교체
ALTER TABLE `ListingAutoTradeConfig` DROP INDEX `ListingAutoTradeConfig_userId_key`, ADD UNIQUE INDEX `ListingAutoTradeConfig_userId_source_key` (`userId`, `source`);
ALTER TABLE `ListingAnnouncement` DROP INDEX `ListingAnnouncement_noticeId_key`, ADD UNIQUE INDEX `ListingAnnouncement_source_noticeId_key` (`source`, `noticeId`);

-- 인덱스 추가
ALTER TABLE `ListingAnnouncement` ADD INDEX `ListingAnnouncement_source_announcedAt_idx` (`source`, `announcedAt`);
ALTER TABLE `ListingOrder` ADD INDEX `ListingOrder_source_createdAt_idx` (`source`, `createdAt`);
```

- [ ] **Step 4: 로컬 dev DB에 마이그레이션 적용**

Run: `npx prisma migrate dev`
Expected: `Applying migration ...add_listing_source_column` + `Already in sync` 메시지

- [ ] **Step 5: Prisma 클라이언트 재생성**

Run: `npx prisma generate`
Expected: 새 `ListingSource` enum + `source` 필드가 타입에 반영

- [ ] **Step 6: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개 (기존 코드는 default `source='UPBIT'` 덕분에 깨지지 않음)

- [ ] **Step 7: 커밋**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: ListingAutoTradeConfig/Announcement/Order에 source enum 컬럼 추가"
```

---

## Task 2: 기존 업비트 코드 회귀 테스트 (수동)

**Files:** 변경 없음 (검증만)

- [ ] **Step 1: dev 서버 시작**

Run: `npm run dev`
Expected: 서버 정상 기동, `UpbitListingMonitorAgent` 시작 로그

- [ ] **Step 2: 기존 업비트 listing API 호출 확인**

Run (다른 터미널): `curl http://localhost:4000/api/admin/upbit-listings -H "Authorization: Bearer <admin-jwt>"`
Expected: 200 OK + 기존 listing 목록 (source='UPBIT' 백필 확인)

- [ ] **Step 3: 자동매수 config 조회**

Run: `curl http://localhost:4000/api/admin/upbit-listings/auto-trade/config -H "Authorization: Bearer <admin-jwt>"`
Expected: 200 OK + 기존 config (source 필드 보임)

- [ ] **Step 4: 회귀 OK 확인 후 다음 task로 진행**

문제 발견 시 Task 1로 돌아가서 마이그레이션 수정.

---

## Task 3: 빗썸 메시지 파서 단위 테스트 작성 (failing)

**Files:**
- Create: `src/services/__tests__/bithumb-listing-parser.test.ts`

- [ ] **Step 1: 테스트 파일 작성**

```typescript
// src/services/__tests__/bithumb-listing-parser.test.ts
import { parseBithumbListing, parseTelegramMessage } from '../bithumb-listing-monitor.service';

describe('parseBithumbListing', () => {
  const cases: Array<{ title: string; expected: { name: string; ticker: string } | null }> = [
    { title: '리프로토콜(RE) 원화 마켓 추가', expected: { name: '리프로토콜', ticker: 'RE' } },
    { title: '에스피엑스6900(SPX) 원화 마켓 추가', expected: { name: '에스피엑스6900', ticker: 'SPX' } },
    { title: '시트레아(CTR) 원화 마켓 추가(거래 오픈 오후 6시 예정)', expected: { name: '시트레아', ticker: 'CTR' } },
    { title: '젠신(AI) 원화 마켓 추가(심볼명 변경)', expected: { name: '젠신', ticker: 'AI' } },
    { title: '엣지엑스(EDGEX) 원화 마켓 추가(거래 오픈 오후 4시 예정)', expected: { name: '엣지엑스', ticker: 'EDGEX' } },
    { title: '비트코인(BTC) 원화 마켓 추가', expected: null },  // exclude
    { title: '랜덤 공지 제목', expected: null },                 // no match
  ];
  it.each(cases)('parses "$title"', ({ title, expected }) => {
    expect(parseBithumbListing(title)).toEqual(expected);
  });
});

describe('parseTelegramMessage', () => {
  it('extracts ticker + noticeId from valid 마켓 추가 message', () => {
    const text = '[마켓 추가] 리프로토콜(RE) 원화 마켓 추가\nhttps://feed.bithumb.com/notice/1653785';
    expect(parseTelegramMessage(text)).toEqual({
      ticker: 'RE',
      name: '리프로토콜',
      noticeId: 1653785,
    });
  });

  it('returns null for non-listing message', () => {
    const text = '[입출금] POL 입출금 일시 중지 안내\nhttps://feed.bithumb.com/notice/1653791';
    expect(parseTelegramMessage(text)).toBeNull();
  });

  it('returns null for listing message without notice URL', () => {
    const text = '[마켓 추가] 리프로토콜(RE) 원화 마켓 추가';
    expect(parseTelegramMessage(text)).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실행 (실패 확인)**

Run: `npx jest src/services/__tests__/bithumb-listing-parser.test.ts`
Expected: FAIL — `parseBithumbListing is not a function` / 모듈 없음

---

## Task 4: 빗썸 모니터 서비스 골격 + 파서 구현

**Files:**
- Create: `src/services/bithumb-listing-monitor.service.ts`

- [ ] **Step 1: 서비스 골격 + 파서 구현**

```typescript
// src/services/bithumb-listing-monitor.service.ts
import axios from 'axios';
import { parse as parseHtml } from 'node-html-parser';
import prisma from '../config/database';
import { listingAutoTraderService } from './listing-auto-trader.service';
import { kakaoNotifyService } from './kakao-notify.service';

// ── 파서 (단위 테스트 대상) ─────────────────────────────────────────────

const BITHUMB_LISTING_PATTERN = /([가-힣\w\d]+?)\(([A-Z0-9]+)\)\s*원화\s*마켓\s*추가/;
const TELEGRAM_LISTING_PREFIX = /^\[마켓 추가\]/;
const NOTICE_URL_PATTERN = /feed\.bithumb\.com\/notice\/(\d+)/;
const TICKER_EXCLUDES = new Set(['KRW', 'BTC', 'USDT', 'ETH', 'BNB', 'USDC']);

export function parseBithumbListing(title: string): { name: string; ticker: string } | null {
  const match = title.match(BITHUMB_LISTING_PATTERN);
  if (!match) return null;
  const [, name, ticker] = match;
  if (TICKER_EXCLUDES.has(ticker)) return null;
  return { name, ticker };
}

export function parseTelegramMessage(text: string): { name: string; ticker: string; noticeId: number } | null {
  if (!TELEGRAM_LISTING_PREFIX.test(text)) return null;
  const listing = parseBithumbListing(text);
  if (!listing) return null;
  const urlMatch = text.match(NOTICE_URL_PATTERN);
  if (!urlMatch) return null;
  return { ...listing, noticeId: parseInt(urlMatch[1], 10) };
}

// ── 모니터 서비스 (Task 5에서 구현) ────────────────────────────────────

class BithumbListingMonitorService {
  private seenTelegramMsgIds: Set<string> = new Set();
  private bithumbMarkets: Set<string> = new Set();
  private lastMarketRefreshOkAt: number = 0;
  private marketRefreshFailCount: number = 0;

  async initialize(): Promise<void> {
    this.lastMarketRefreshOkAt = Date.now();
    await this.checkNewBithumbMarkets({ silent: true });  // baseline
  }

  async pollBithumbTelegram(): Promise<void> {
    // Task 5에서 구현
  }

  async checkNewBithumbMarkets(opts: { silent?: boolean } = {}): Promise<void> {
    // Task 5에서 구현
  }

  getStats(): Record<string, any> {
    return {
      seenTelegramMsgIds: this.seenTelegramMsgIds.size,
      bithumbMarkets: this.bithumbMarkets.size,
      lastMarketRefreshOkAt: this.lastMarketRefreshOkAt,
      marketRefreshFailCount: this.marketRefreshFailCount,
    };
  }
}

export const bithumbListingMonitorService = new BithumbListingMonitorService();
```

- [ ] **Step 2: 파서 테스트 통과 확인**

Run: `npx jest src/services/__tests__/bithumb-listing-parser.test.ts`
Expected: PASS — 모든 테스트 통과 (7개 parseBithumbListing + 3개 parseTelegramMessage = 10개)

- [ ] **Step 3: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개

- [ ] **Step 4: 커밋**

```bash
git add src/services/bithumb-listing-monitor.service.ts src/services/__tests__/bithumb-listing-parser.test.ts
git commit -m "feat: 빗썸 신규상장 메시지 파서 구현 + 단위 테스트"
```

---

## Task 5: 텔레그램 폴링 + 마켓 diff 구현

**Files:**
- Modify: `src/services/bithumb-listing-monitor.service.ts`

- [ ] **Step 1: 텔레그램 폴링 구현**

위 서비스 클래스의 `pollBithumbTelegram` 메소드 구현:

```typescript
async pollBithumbTelegram(): Promise<void> {
  try {
    const res = await axios.get('https://t.me/s/BithumbExchange', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
      timeout: 10_000,
    });
    const root = parseHtml(res.data);
    const messages = root.querySelectorAll('div.tgme_widget_message');

    for (const msg of messages) {
      const dataPost = msg.getAttribute('data-post');
      if (!dataPost || this.seenTelegramMsgIds.has(dataPost)) continue;

      const textNode = msg.querySelector('div.tgme_widget_message_text');
      const text = textNode?.text ?? '';

      const parsed = parseTelegramMessage(text);
      if (!parsed) {
        this.seenTelegramMsgIds.add(dataPost);  // 비-상장 메시지도 캐시에 기록 (중복 처리 방지)
        continue;
      }

      // 중복 announcement 방지
      const existing = await prisma.listingAnnouncement.findUnique({
        where: { source_noticeId: { source: 'BITHUMB', noticeId: parsed.noticeId } },
      });
      if (existing) {
        this.seenTelegramMsgIds.add(dataPost);
        continue;
      }

      // Insert
      const announcement = await prisma.listingAnnouncement.create({
        data: {
          source: 'BITHUMB',
          noticeId: parsed.noticeId,
          title: text.split('\n')[0],
          ticker: parsed.ticker,
          url: `https://feed.bithumb.com/notice/${parsed.noticeId}`,
          announcedAt: new Date(),
          status: 'announced',
        },
      });

      await kakaoNotifyService.notify(`🆕 [빗썸] ${parsed.name}(${parsed.ticker}) 신규 상장 감지 (텔레그램)`);
      await listingAutoTraderService.trigger(announcement as any);

      this.seenTelegramMsgIds.add(dataPost);
    }
  } catch (e: any) {
    console.error('[BithumbListingMonitor] 텔레그램 폴링 실패:', e.message);
  }
}
```

- [ ] **Step 2: 마켓 diff 구현**

같은 파일의 `checkNewBithumbMarkets` 메소드 구현:

```typescript
async checkNewBithumbMarkets(opts: { silent?: boolean } = {}): Promise<void> {
  try {
    const res = await axios.get('https://api.bithumb.com/v1/market/all', { timeout: 10_000 });
    const markets: Array<{ market: string; korean_name: string; english_name: string }> = res.data;
    const krwMarkets = markets.filter(m => m.market.startsWith('KRW-'));

    if (this.bithumbMarkets.size === 0) {
      // 초기 baseline 설정 (announcement 생성 안 함)
      for (const m of krwMarkets) this.bithumbMarkets.add(m.market);
      this.lastMarketRefreshOkAt = Date.now();
      this.marketRefreshFailCount = 0;
      return;
    }

    for (const m of krwMarkets) {
      if (this.bithumbMarkets.has(m.market)) continue;

      const ticker = m.market.replace('KRW-', '');
      if (TICKER_EXCLUDES.has(ticker)) {
        this.bithumbMarkets.add(m.market);
        continue;
      }

      // 24h 내 같은 ticker로 텔레그램 감지된 게 있는지 확인 (중복 매수 방지)
      const recent = await prisma.listingAnnouncement.findFirst({
        where: {
          source: 'BITHUMB',
          ticker,
          announcedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });

      // 합성 noticeId (UPBIT 대역과 같지만 source가 다르므로 충돌 없음)
      const SYNTHETIC_BASE_MARKET = 1_500_000_000;
      const syntheticNoticeId = SYNTHETIC_BASE_MARKET + (Date.now() % 200_000_000);

      const announcement = await prisma.listingAnnouncement.create({
        data: {
          source: 'BITHUMB',
          noticeId: syntheticNoticeId,
          title: `[마켓 추가] ${m.korean_name}(${ticker}) 원화 마켓 추가`,
          ticker,
          url: m.market,
          announcedAt: new Date(),
          status: 'announced',
        },
      });

      if (!opts.silent && !recent) {
        await kakaoNotifyService.notify(`🆕 [빗썸] ${m.korean_name}(${ticker}) 거래 개시 감지 (마켓 diff)`);
        await listingAutoTraderService.trigger(announcement as any);
      }

      this.bithumbMarkets.add(m.market);
    }

    this.lastMarketRefreshOkAt = Date.now();
    this.marketRefreshFailCount = 0;
  } catch (e: any) {
    this.marketRefreshFailCount++;
    const elapsedSinceOk = Date.now() - this.lastMarketRefreshOkAt;
    if (elapsedSinceOk > 10 * 60 * 1000 && this.marketRefreshFailCount % 10 === 1) {
      await kakaoNotifyService.notify('⚠️ [빗썸] 마켓 목록 조회 10분 연속 실패 — 감지 blind 가능성');
    }
    console.error('[BithumbListingMonitor] 마켓 diff 실패:', e.message);
  }
}
```

- [ ] **Step 3: 통합 테스트 (mock)**

Create: `src/services/__tests__/bithumb-listing-monitor.test.ts`
```typescript
import axios from 'axios';
import { bithumbListingMonitorService } from '../bithumb-listing-monitor.service';

jest.mock('axios');
jest.mock('../../config/database', () => ({
  default: {
    listingAnnouncement: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 1, source: 'BITHUMB', ticker: 'RE' }),
    },
  },
}));
jest.mock('../listing-auto-trader.service', () => ({
  listingAutoTraderService: { trigger: jest.fn() },
}));
jest.mock('../kakao-notify.service', () => ({
  kakaoNotifyService: { notify: jest.fn() },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('bithumbListingMonitorService.pollBithumbTelegram', () => {
  beforeEach(() => jest.clearAllMocks());

  it('detects new listing message and triggers auto-trade', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: `
        <div class="tgme_widget_message" data-post="BithumbExchange/12345">
          <div class="tgme_widget_message_text">[마켓 추가] 리프로토콜(RE) 원화 마켓 추가
https://feed.bithumb.com/notice/1653785</div>
        </div>
      `,
    });
    await bithumbListingMonitorService.pollBithumbTelegram();
    const { listingAutoTraderService } = require('../listing-auto-trader.service');
    expect(listingAutoTraderService.trigger).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: 테스트 실행**

Run: `npx jest src/services/__tests__/bithumb-listing-monitor.test.ts`
Expected: PASS

- [ ] **Step 5: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개

- [ ] **Step 6: 커밋**

```bash
git add src/services/bithumb-listing-monitor.service.ts src/services/__tests__/bithumb-listing-monitor.test.ts
git commit -m "feat: 빗썸 텔레그램 + 마켓 diff 폴링 구현"
```

---

## Task 6: listingAutoTraderService에 source 분기 추가

**Files:**
- Modify: `src/services/listing-auto-trader.service.ts`

- [ ] **Step 1: AutoTradeConfig 인터페이스에 source 추가 + getConfig/updateConfig 시그니처 변경**

`src/services/listing-auto-trader.service.ts:14~27` (AutoTradeConfig interface)에 `source: 'UPBIT' | 'BITHUMB'` 추가.

`getConfig` 시그니처 변경:
```typescript
async getConfig(source: 'UPBIT' | 'BITHUMB' = 'UPBIT'): Promise<AutoTradeConfig> {
  const row = await (prisma as any).listingAutoTradeConfig.findUnique({
    where: { userId_source: { userId: 2, source } },
  });
  if (!row) {
    // source별 default (UPBIT는 기존, BITHUMB는 보수적)
    if (source === 'BITHUMB') {
      return {
        source: 'BITHUMB',
        enabled: false, amountKrw: 10000,
        useBinance: true, useBithumb: false, useMexc: true, useGateio: true,
        autoSellEnabled: true,
        takeProfitPct: 10, stopLossPct: 5, maxHoldMinutes: 15,
        useTrailingStop: true, trailingStopPct: 10,
      };
    }
    return {
      source: 'UPBIT',
      enabled: false, amountKrw: 100000,
      useBinance: true, useBithumb: true, useMexc: false, useGateio: false,
      autoSellEnabled: true,
      takeProfitPct: 20, stopLossPct: 10, maxHoldMinutes: 30,
      useTrailingStop: false, trailingStopPct: 20,
    };
  }
  return { source, ...row };  // (전체 매핑은 기존 패턴 유지)
}
```

`updateConfig` 시그니처 변경:
```typescript
async updateConfig(source: 'UPBIT' | 'BITHUMB', data: Partial<AutoTradeConfig>): Promise<AutoTradeConfig> {
  const row = await (prisma as any).listingAutoTradeConfig.upsert({
    where: { userId_source: { userId: 2, source } },
    create: { userId: 2, source, ...defaultsFor(source), ...data },
    update: data,
  });
  return { source, ...row };
}
```

- [ ] **Step 2: trigger 메소드를 announcement.source 기반으로 분기**

```typescript
async trigger(announcement: { source: 'UPBIT' | 'BITHUMB'; ticker: string; ... }): Promise<void> {
  const config = await this.getConfig(announcement.source);
  if (!config.enabled || config.killSwitch) return;

  // 24h 중복 매수 방지
  const duplicate = await (prisma as any).listingOrder.findFirst({
    where: {
      source: announcement.source,
      ticker: announcement.ticker,
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
  if (duplicate) return;

  // 기존 거래소별 매수 로직 (Binance/MEXC/Gate.io) — config.useBinance 등 분기는 기존 코드 유지
  // 단, recordOrder 시 source 필드 함께 저장:
  await (prisma as any).listingOrder.create({
    data: {
      source: announcement.source,  // ← 추가
      announcementId: announcement.id,
      exchange,
      ticker: announcement.ticker,
      // ... 기존 필드
    },
  });
}
```

- [ ] **Step 3: 기존 호출처(`upbit-listing-monitor.service.ts`)가 source 누락된 경우 확인**

Run: `grep -n "listingAutoTraderService.trigger\|listingAutoTraderService.getConfig\|listingAutoTraderService.updateConfig" src/ -r`
Expected: 모든 호출처가 source를 명시하거나 announcement.source를 전달

수정 필요한 위치:
- `src/services/upbit-listing-monitor.service.ts` — `trigger(announcement)`는 announcement에 source='UPBIT' 백필되어 있으니 OK (Task 1에서 default UPBIT)
- `src/controllers/upbit-listing-admin.controller.ts` — `getConfig()` / `updateConfig(data)` → `getConfig('UPBIT')` / `updateConfig('UPBIT', data)` 변경

- [ ] **Step 4: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개 — 모든 호출처 정리됨

- [ ] **Step 5: 회귀: 업비트 listing API 호출**

Run (dev 서버 띄운 상태): `curl http://localhost:4000/api/admin/upbit-listings/auto-trade/config -H "Authorization: Bearer <admin-jwt>"`
Expected: 200 OK + source='UPBIT' config 정상 반환

- [ ] **Step 6: 커밋**

```bash
git add src/services/listing-auto-trader.service.ts src/controllers/upbit-listing-admin.controller.ts
git commit -m "feat: listingAutoTraderService에 source 파라미터 분기 추가"
```

---

## Task 7: listingAutoSellerService에 source 분기 추가

**Files:**
- Modify: `src/services/listing-auto-seller.service.ts`

- [ ] **Step 1: checkAndSell에서 order.source 기반 config 로드**

`src/services/listing-auto-seller.service.ts` 의 `checkAndSell()` 메소드:

```typescript
async checkAndSell(): Promise<void> {
  const openOrders = await (prisma as any).listingOrder.findMany({
    where: { status: { in: ['pending', 'holding'] } },
  });

  for (const order of openOrders) {
    const config = await listingAutoTraderService.getConfig(order.source);  // ← source 분기
    if (!config.autoSellEnabled || config.killSwitch) continue;
    // ... 기존 TP/SL/maxHold/trailing 로직
  }
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개

- [ ] **Step 3: 커밋**

```bash
git add src/services/listing-auto-seller.service.ts
git commit -m "feat: listingAutoSellerService에 source 분기 추가"
```

---

## Task 8: BithumbListingMonitorAgent + 등록

**Files:**
- Create: `src/agents/bithumb-listing-monitor-agent.ts`
- Modify: `src/agents/index.ts`
- Modify: `src/agents/agent-manager.ts` (agent 등록 부분)

- [ ] **Step 1: 에이전트 클래스 작성**

```typescript
// src/agents/bithumb-listing-monitor-agent.ts
import { BaseAgent } from './base-agent';
import { bithumbListingMonitorService } from '../services/bithumb-listing-monitor.service';
import { listingAutoSellerService } from '../services/listing-auto-seller.service';

export class BithumbListingMonitorAgent extends BaseAgent {
  constructor() {
    super({
      id: 'bithumb-listing-monitor',
      name: 'BithumbListingMonitorAgent',
      description: '빗썸 신규 상장 5초 감지 (텔레그램 + 마켓 diff)',
      cycleIntervalMs: 5_000,
    });
  }

  protected async onStart(): Promise<void> {
    await bithumbListingMonitorService.initialize();
    console.log('[BithumbListingMonitorAgent] 시작 — 텔레그램 + 마켓 diff 5초');
  }

  protected async onCycle(): Promise<void> {
    await Promise.allSettled([
      bithumbListingMonitorService.pollBithumbTelegram(),
      bithumbListingMonitorService.checkNewBithumbMarkets(),
    ]);
    await listingAutoSellerService.checkAndSell();
  }

  protected async onStop(): Promise<void> {
    console.log('[BithumbListingMonitorAgent] 종료');
  }

  protected override getExtraInfo(): Record<string, any> {
    return bithumbListingMonitorService.getStats();
  }
}

export const bithumbListingMonitorAgent = new BithumbListingMonitorAgent();
```

- [ ] **Step 2: index.ts에 export 추가**

`src/agents/index.ts` 마지막 줄 추가:
```typescript
export { BithumbListingMonitorAgent, bithumbListingMonitorAgent } from './bithumb-listing-monitor-agent';
```

- [ ] **Step 3: agent-manager에 등록**

`src/agents/agent-manager.ts`에서 다른 agent 등록 패턴 확인 후 동일하게 `bithumbListingMonitorAgent` 등록. (`upbitListingMonitorAgent` 등록 코드 바로 아래)

- [ ] **Step 4: 타입 체크 + dev 서버 재시작**

Run: `npx tsc --noEmit && npm run dev`
Expected: `[BithumbListingMonitorAgent] 시작` 로그 + 에러 0개

- [ ] **Step 5: 텔레그램 폴링 동작 확인 (1분 대기)**

dev 서버 로그 관찰: 1분 동안 텔레그램 폴링 에러 없음 + (가능한 경우) 신규 메시지 detect 로그

- [ ] **Step 6: 커밋**

```bash
git add src/agents/bithumb-listing-monitor-agent.ts src/agents/index.ts src/agents/agent-manager.ts
git commit -m "feat: BithumbListingMonitorAgent 추가 + agent-manager 등록"
```

---

## Task 9: listing-admin 컨트롤러 통합 (source 분기)

**Files:**
- Rename + Modify: `src/controllers/upbit-listing-admin.controller.ts` → `src/controllers/listing-admin.controller.ts`
- Modify: `src/services/upbit-listing-monitor.service.ts` (source 파라미터 받는 메소드 추가 또는 동일 패턴의 빗썸 서비스 메소드 호출 분기)

- [ ] **Step 1: 컨트롤러 리네임 + source 쿼리 파라미터 받기**

```bash
git mv src/controllers/upbit-listing-admin.controller.ts src/controllers/listing-admin.controller.ts
```

각 핸들러에서 `req.query.source` 또는 `req.body.source`를 추출하여 분기:

```typescript
// 예: getAutoTradeConfig
export const getAutoTradeConfig = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const source = (req.query.source as string)?.toUpperCase() === 'BITHUMB' ? 'BITHUMB' : 'UPBIT';
    const config = await listingAutoTraderService.getConfig(source);
    return successResponse(res, config);
  } catch (error) {
    next(error);
  }
};

// 예: listAnnouncements
export const listAnnouncements = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const source = (req.query.source as string)?.toUpperCase() === 'BITHUMB' ? 'BITHUMB' : 'UPBIT';
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const data = source === 'BITHUMB'
      ? await bithumbListingMonitorService.listAnnouncements(limit)
      : await upbitListingMonitorService.listAnnouncements(limit);
    return successResponse(res, data);
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 2: 각 service에 listAnnouncements/getAnnouncement 메소드 추가 (없으면)**

`bithumb-listing-monitor.service.ts`에 `listAnnouncements`/`getAnnouncement` 메소드 추가 — 단순 `prisma.listingAnnouncement.findMany({ where: { source: 'BITHUMB' }, ...})` 패턴.

- [ ] **Step 3: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개

- [ ] **Step 4: 커밋**

```bash
git add src/controllers/listing-admin.controller.ts src/services/bithumb-listing-monitor.service.ts
git commit -m "refactor: upbit-listing-admin → listing-admin 통합 + source 분기"
```

---

## Task 10: 라우트 통합 (/api/admin/listings) + 별칭 유지

**Files:**
- Rename + Modify: `src/routes/upbit-listing-admin.ts` → `src/routes/listing-admin.ts`
- Modify: `src/routes/index.ts`

- [ ] **Step 1: 라우트 파일 리네임 + 컨트롤러 import 경로 수정**

```bash
git mv src/routes/upbit-listing-admin.ts src/routes/listing-admin.ts
```

import 경로:
```typescript
import * as ctrl from '../controllers/listing-admin.controller';
```

(라우트 정의는 동일하게 유지 — `/manual`, `/auto-trade/config` 등)

- [ ] **Step 2: index.ts에서 신규 + 별칭 라우트 마운트**

`src/routes/index.ts`에서:
```typescript
// 기존
import upbitListingAdminRoutes from './upbit-listing-admin';
router.use('/admin/upbit-listings', upbitListingAdminRoutes);

// 변경
import listingAdminRoutes from './listing-admin';
router.use('/admin/listings', listingAdminRoutes);
router.use('/admin/upbit-listings', listingAdminRoutes);  // 1주일 별칭 유지
```

- [ ] **Step 3: 타입 체크 + dev 서버 재시작**

Run: `npx tsc --noEmit && npm run dev`
Expected: 에러 0개

- [ ] **Step 4: 신규 + 기존 라우트 둘 다 동작 확인**

Run:
```bash
curl "http://localhost:4000/api/admin/listings?source=UPBIT" -H "Authorization: Bearer <admin-jwt>"
curl "http://localhost:4000/api/admin/listings?source=BITHUMB" -H "Authorization: Bearer <admin-jwt>"
curl "http://localhost:4000/api/admin/upbit-listings" -H "Authorization: Bearer <admin-jwt>"
```
Expected: 셋 다 200 OK, source 분기 정상 (BITHUMB는 빈 배열, 나머지는 기존 데이터)

- [ ] **Step 5: 커밋**

```bash
git add src/routes/listing-admin.ts src/routes/index.ts
git commit -m "refactor: /api/admin/listings 통합 라우트 + 1주일 별칭 유지"
```

---

## Task 11: 프론트엔드 lib/api.ts에 source 파라미터 추가

**Files (프론트엔드 디렉토리: `v0-grid-transaction-frontend/`)**
- Modify: `lib/api.ts`

- [ ] **Step 1: 모든 listing 관련 API 함수에 source 파라미터 추가**

기존 함수 시그니처:
```typescript
export async function listUpbitListings(): Promise<UpbitListingAnnouncement[]>
export async function getAutoTradeConfig(): Promise<AutoTradeConfig>
export async function updateAutoTradeConfig(data: Partial<AutoTradeConfig>): Promise<AutoTradeConfig>
// ... 등
```

신규:
```typescript
export type ListingSource = 'UPBIT' | 'BITHUMB';

export async function listListings(source: ListingSource = 'UPBIT'): Promise<ListingAnnouncement[]> {
  const res = await fetch(`${API_URL}/api/admin/listings?source=${source}`, { headers: authHeaders() });
  return (await res.json()).data;
}

export async function getAutoTradeConfig(source: ListingSource = 'UPBIT'): Promise<AutoTradeConfig> {
  const res = await fetch(`${API_URL}/api/admin/listings/auto-trade/config?source=${source}`, { headers: authHeaders() });
  return (await res.json()).data;
}

export async function updateAutoTradeConfig(source: ListingSource, data: Partial<AutoTradeConfig>): Promise<AutoTradeConfig> {
  const res = await fetch(`${API_URL}/api/admin/listings/auto-trade/config?source=${source}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return (await res.json()).data;
}

// 기존 listUpbitListings 등은 deprecated 주석 + 내부적으로 listListings('UPBIT') 호출
```

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공 (기존 페이지가 deprecated 함수 사용 중이라 경고는 나오되 에러 0개)

- [ ] **Step 3: 커밋**

```bash
git add lib/api.ts
git commit -m "feat: lib/api.ts에 source 파라미터 + listListings 통합 API 추가"
```

---

## Task 12: 통합 admin 페이지 작성

**Files:**
- Create: `app/admin/listings/page.tsx`

- [ ] **Step 1: 기존 upbit-listings 페이지를 source-agnostic 컴포넌트로 추출**

`app/admin/upbit-listings/page.tsx`를 베이스로:
1. ADMIN_EMAIL gating 그대로 유지
2. 상단에 탭 컴포넌트(shadcn `Tabs`) 추가 — `<TabsTrigger value="UPBIT">업비트</TabsTrigger>` / `<TabsTrigger value="BITHUMB">빗썸</TabsTrigger>`
3. `useState<ListingSource>('UPBIT')` + URL query sync (`?source=UPBIT`)
4. 모든 API 호출에 `source` 전달 (`listListings(source)`, `getAutoTradeConfig(source)`, `updateAutoTradeConfig(source, data)`)
5. 자동매수 설정 폼 동일 구조, 단 source가 바뀌면 config 다시 fetch

```tsx
"use client"
import { useState, useEffect } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { /* ... */ } from "@/lib/api"

export default function ListingsAdminPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [source, setSource] = useState<ListingSource>(
    (searchParams.get('source') as ListingSource) || 'UPBIT'
  )

  useEffect(() => {
    router.replace(`/admin/listings?source=${source}`)
  }, [source, router])

  return (
    <Tabs value={source} onValueChange={(v) => setSource(v as ListingSource)}>
      <TabsList>
        <TabsTrigger value="UPBIT">업비트</TabsTrigger>
        <TabsTrigger value="BITHUMB">빗썸</TabsTrigger>
      </TabsList>
      <TabsContent value="UPBIT">
        <ListingSourcePanel source="UPBIT" />
      </TabsContent>
      <TabsContent value="BITHUMB">
        <ListingSourcePanel source="BITHUMB" />
      </TabsContent>
    </Tabs>
  )
}

function ListingSourcePanel({ source }: { source: ListingSource }) {
  // 기존 upbit-listings 페이지의 카드들 (자동매수 config, 공지 목록, 자동매수 주문) — source prop만 받아서 분기
}
```

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 에러 0개

- [ ] **Step 3: 브라우저에서 동작 확인**

`http://localhost:3009/admin/listings` 접속 → 업비트/빗썸 탭 전환, config 저장, 공지 목록 표시 확인

- [ ] **Step 4: 커밋**

```bash
git add app/admin/listings/
git commit -m "feat: /admin/listings 통합 페이지 (업비트/빗썸 탭)"
```

---

## Task 13: /admin/upbit-listings 리다이렉트

**Files:**
- Modify: `app/admin/upbit-listings/page.tsx` (단일 라인 리다이렉트로 교체)

- [ ] **Step 1: 페이지를 redirect()로 교체**

```tsx
import { redirect } from "next/navigation"

export default function Page() {
  redirect('/admin/listings?source=UPBIT')
}
```

(기존 페이지 내용은 통합 페이지로 이미 옮겨졌으므로 삭제 — git history에 남음)

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 에러 0개

- [ ] **Step 3: 브라우저 확인**

`http://localhost:3009/admin/upbit-listings` 접속 → `/admin/listings?source=UPBIT`로 자동 리다이렉트

- [ ] **Step 4: 커밋**

```bash
git add app/admin/upbit-listings/page.tsx
git commit -m "refactor: /admin/upbit-listings → /admin/listings?source=UPBIT 리다이렉트"
```

---

## Task 14: 출시 전 manual test (체크리스트)

**Files:** 변경 없음

dev 환경(또는 staging)에서 아래 체크리스트 실행. 모두 통과해야 production 배포 가능.

- [ ] 텔레그램 채널 fetch 성공: `curl -s "https://t.me/s/BithumbExchange" | grep -c "tgme_widget_message"` → 결과 1 이상
- [ ] 마켓 API 동작: `curl -s "https://api.bithumb.com/v1/market/all" | jq '. | map(select(.market | startswith("KRW-"))) | length'` → 약 200
- [ ] 로컬 dev DB 마이그레이션 후 기존 row `source='UPBIT'` 백필 확인: `npx prisma studio` → `ListingAutoTradeConfig` row 확인
- [ ] 회귀: `/admin/upbit-listings` 리다이렉트 후 업비트 자동매수 정상 (`enabled` 토글 → DB 반영 확인)
- [ ] 빗썸 탭 진입 → config 보임 (default 값: `enabled=false, amountKrw=10000, TP=10, SL=5`)
- [ ] 빗썸 자동매수 config 저장 → DB에 source='BITHUMB' row 생성 확인
- [ ] 카카오톡 테스트: dev 환경에서 빗썸 신규 상장 mock 트리거 → `[빗썸]` prefix 알림 수신
- [ ] kill switch 동작: 빗썸 `killSwitch=true` → 다음 cycle에서 자동매수 시도 안 함

---

## Task 15: Production 배포

**Files:** 변경 없음 (CI/CD 자동)

- [ ] **Step 1: 운영 DB 수동 스냅샷 (CLAUDE.md 규칙)**

Run:
```bash
NEW_SNAP="pre-bithumb-listing-$(date -u +%Y%m%d-%H%M%S)"
aws lightsail create-relational-database-snapshot \
  --relational-database-name <db-name> \
  --relational-database-snapshot-name "$NEW_SNAP" \
  --region ap-northeast-2 \
  --profile route53
```
Expected: 스냅샷 생성, `available` 상태 대기 (1~3분)

- [ ] **Step 2: main 브랜치에 push**

Run:
```bash
git push origin main
```
Expected: GitHub Actions 워크플로우 시작 — Docker 빌드 + ECR push + Lightsail 배포

- [ ] **Step 3: 배포 진행 모니터링**

Run: `gh run watch`
Expected: 모든 step 성공, deployment 완료

- [ ] **Step 4: production 마이그레이션 자동 실행 확인**

배포 워크플로우에 `prisma migrate deploy`가 포함되어 있는지 확인. 포함되어 있지 않다면 별도로 SSH 접속하여 실행:
```bash
ssh <prod-host> "cd /app && npx prisma migrate deploy"
```

- [ ] **Step 5: production health check**

Run:
```bash
curl https://<prod-domain>/api/health
curl https://<prod-domain>/api/admin/listings?source=BITHUMB -H "Authorization: Bearer <admin-jwt>"
```
Expected: 200 OK + 빈 배열 (빗썸은 아직 데이터 없음)

- [ ] **Step 6: BithumbListingMonitorAgent 동작 확인**

Run: production 서버 로그 확인 (`docker logs <container>` 또는 admin agents 페이지)
Expected: `[BithumbListingMonitorAgent] 시작 — 텔레그램 + 마켓 diff 5초` 로그

- [ ] **Step 7: 기존 업비트 모니터 회귀 확인**

Admin agents 페이지에서 `UpbitListingMonitorAgent` 상태가 `running` + 마지막 cycle 시각이 최근

- [ ] **Step 8: 스냅샷 정리 (CLAUDE.md 규칙)**

배포 정상 확인 후 (1시간 정도 운영) 기존 스냅샷 삭제:
```bash
aws lightsail get-relational-database-snapshots --region ap-northeast-2 --profile route53 \
  --query "relationalDatabaseSnapshots[?fromRelationalDatabaseName=='<db>' && name!='$NEW_SNAP'].name" \
  --output text | tr '\t' '\n' | while read OLD; do
    [ -n "$OLD" ] && aws lightsail delete-relational-database-snapshot \
      --relational-database-snapshot-name "$OLD" --region ap-northeast-2 --profile route53
  done
```

---

## Task 16: Canary 시작 (1주일, enabled=false)

**Files:** 변경 없음 (운영)

- [ ] **Step 1: 빗썸 config enabled=false 확인**

`/admin/listings?source=BITHUMB` 페이지에서 `enabled` 토글이 OFF 인지 확인 (default OFF이므로 그대로 두면 됨)

- [ ] **Step 2: 1주일 관찰 항목**

매일 admin agents 페이지에서 `BithumbListingMonitorAgent.getExtraInfo()` 확인:
- `lastTelegramPollAt`: 최근 5초 이내 (정상 폴링 중)
- `marketRefreshFailCount`: 0 또는 매우 낮음
- `seenTelegramMsgIds`: 시간이 지남에 따라 증가 (메시지 캐시 누적)

`/admin/listings?source=BITHUMB` 페이지에서 신규 공지 목록 확인:
- 실제 빗썸 신규 상장 시 announcement가 자동 기록되는지 (텔레그램 채널 + 마켓 diff 둘 다)
- ticker 추출 정확성 (false positive 0건 목표)

- [ ] **Step 3: 1주일 후 결정**

데이터 검토 후:
- 감지 정확도 OK → `amountKrw=10000`으로 `enabled=true` 토글, 첫 5건 매수 결과 모니터링
- 문제 발견 → spec §16 위험 항목 참조, 필요 시 fix 후 재배포

---

## Self-Review 결과

### Spec coverage
- [x] §3 데이터 흐름 → Task 4~8 (서비스 + 에이전트)
- [x] §4 신규/수정 파일 → Task 1~13 모두 매핑
- [x] §5 감지 채널 → Task 4~5 (텔레그램 + 마켓 diff)
- [x] §6 매수 트리거 + 매도 → Task 6~7 (source 분기)
- [x] §7 DB 스키마 → Task 1 (마이그레이션 + Prisma 모델)
- [x] §8 합성 noticeId → Task 5에서 SYNTHETIC_BASE_MARKET 사용
- [x] §9 Admin UI → Task 9~13 (컨트롤러/라우트/프론트)
- [x] §10 카카오 알림 → Task 5에 `[빗썸]` prefix 메시지 포함
- [x] §11 에러 처리 → Task 8의 `Promise.allSettled` 패턴
- [x] §12 테스트 → Task 3, 5 (unit + integration), Task 14 (manual)
- [x] §13 출시 전 체크리스트 → Task 14
- [x] §14 롤백 → 본 plan에 별도 task 없음 (운영 절차로 인지, killSwitch는 Task 6에 구현)
- [x] §15 관측성 → Task 8의 `getExtraInfo()` 메소드

### Placeholder scan
- "Add appropriate error handling" 류 없음
- 모든 step에 코드 또는 명령어 포함
- "TBD", "TODO" 없음

### Type consistency
- `source: 'UPBIT' | 'BITHUMB'` 타입 일관성 유지 (모든 task에서 동일 표기)
- `userId_source` composite key 이름 일관성 (Prisma 자동 생성 패턴 따름)
- `parseBithumbListing` 함수명/시그니처 Task 3~5에서 일관됨

---

## 실행 옵션 안내

Plan 작성 완료 + Self-review 통과.

**실행 방식 선택**:

1. **Subagent-Driven (권장)** — 각 task마다 fresh subagent dispatch + 사이사이 review. 빠른 iteration, context 격리
2. **Inline Execution** — 현재 세션에서 executing-plans로 batch 실행, checkpoint마다 review

어느 방식으로 진행할까요?
