# 그리드 코인 중립(현금 누적) 모드 구현 계획

> **For agentic workers: REQUIRED SUB-SKILL: superpowers:subagent-driven-development**
>
> 각 Task 시작 전 해당 프로젝트 디렉토리의 `CLAUDE.md`를 먼저 읽고 그 규칙을 따를 것.
> 백엔드 Task(1~5)는 `v0-grid-tranasction-backend/`, 프론트 Task(6)는 `v0-grid-transaction-frontend/`에서 수행하며 **두 저장소는 별개 git repo**다 (각각 브랜치/커밋).

- 근거 설계서: `docs/superpowers/specs/2026-09-18-grid-coin-neutral-mode-design.md` (승인 완료)
- 작성일: 2026-09-18

## Goal

그리드 봇 생성 시 손익 방식을 토글로 선택할 수 있게 한다 — 코인 쌓임(`fixed_amount`, 디폴트=기존 동작 그대로) vs 코인 중립(`coin_neutral`, 산 수량만큼만 팔아 코인 수량 불변 + 차익 원화 실현).

## Architecture

`Bot.profitMode`(String, 디폴트 `"fixed_amount"`)와 `GridLevel.filledQty`(Float?, 매수 실제 체결 수량)를 추가한다. 매수 체결 처리(`processFilledOrder` / 레거시 `checkFilledOrders`)에서 체결 수량을 `filledQty`에 기록하고, 매도 수량 계산 2곳(주기 매도 `executeTrade`, 즉시 반대주문 `executeOppositeOrder`)을 새 헬퍼 `resolveSellVolume`으로 분기한다 — `coin_neutral`이면 대응 매수의 `filledQty`(또는 방금 체결된 수량 인자), 아니면 기존 `orderAmount/매도가` 그대로. 기존 정액 경로는 `if (bot.profitMode === 'coin_neutral')` 분기로만 추가되어 **비파괴**다.

## Tech Stack

- 백엔드: Express 5 + TypeScript + Prisma(MySQL) — Controller → Service → Prisma 패턴
- 테스트: jest + ts-jest (`__tests__/`, prisma mock은 `__mocks__/database.ts` moduleNameMapper 자동 매핑)
- 프론트: Next.js 16 + React 19 + shadcn/ui

## 파일 구조 맵

| 파일 (저장소 기준 상대경로) | 작업 | 단일 책임 |
|---|---|---|
| **백엔드** `prisma/schema.prisma` | 수정 | Bot.profitMode(L50-79), GridLevel.filledQty(L81-104) 필드 추가 |
| **백엔드** `prisma/migrations/<ts>_add_profit_mode_and_filled_qty/migration.sql` | 생성 | ALTER TABLE 2건 |
| **백엔드** `src/services/trading.service.ts` | 수정 | ① `resolveSellVolume` 헬퍼 ② 매수 체결 시 filledQty 저장 ③ 매도 수량 분기 2곳 + 호출부 |
| **백엔드** `src/controllers/bot.controller.ts` | 수정 | createBot: profitMode 수신·검증·저장 |
| **백엔드** `__tests__/services/trading.coin-neutral.test.ts` | 생성 | 코인 중립 단위 테스트 (매도 수량 분기·폴백·filledQty 저장·회귀) |
| **백엔드** `__tests__/controllers/bot.controller.profit-mode.test.ts` | 생성 | createBot profitMode 검증 테스트 |
| **프론트** `lib/api.ts` | 수정 | CreateBotRequest에 profitMode 타입(L97-106) |
| **프론트** `app/bot/new/page.tsx` | 수정 | 손익 방식 토글 UI + createBot 호출 전달 |

> 아래 라인 번호는 2026-09-18 main 기준. 앞 Task 적용 후 ±수 라인 이동 가능 — 라인이 어긋나면 인용된 기존 코드 원문으로 검색해서 위치를 찾을 것.

## 사전 준비 (Task 0)

```bash
cd D:\ExpressProject\Grid_project\v0-grid-tranasction-backend
git checkout main && git pull origin main
git checkout -b feat/grid-coin-neutral-mode

cd D:\ExpressProject\Grid_project\v0-grid-transaction-frontend
git checkout main && git pull origin main
git checkout -b feat/grid-coin-neutral-mode
```

---

## Task 1: DB 스키마 — Bot.profitMode + GridLevel.filledQty

**Files:**
- 수정: `prisma/schema.prisma` (Bot 모델 L50-79, GridLevel 모델 L81-104)
- 생성: `prisma/migrations/<timestamp>_add_profit_mode_and_filled_qty/migration.sql`

### Step 1.1: 스키마 수정

`prisma/schema.prisma` Bot 모델 — L60 `stopAtMax Boolean @default(false)` 바로 아래에 추가:

```prisma
  profitMode         String      @default("fixed_amount")
```

GridLevel 모델 — L92 `sellPrice Float?` 바로 아래에 추가:

```prisma
  filledQty Float?
```

(설계서 §4(a): enum 대신 String + 기본값 — 기존 마이그레이션 스타일 정합·비파괴. `profitMode`는 `"fixed_amount" | "coin_neutral"` 두 값만 허용하며 검증은 컨트롤러에서 수행.)

### Step 1.2: DATABASE_URL 로컬 가드 (2026-06-21 사고 규칙 — production 마이그레이션 절대 금지)

```bash
cd D:\ExpressProject\Grid_project\v0-grid-tranasction-backend
# 값을 출력하지 않고 카운트만 확인 (시크릿 노출 금지)
MATCH=$(grep -cE '^DATABASE_URL="?mysql://[^"[:space:]]*@(localhost|127\.0\.0\.1)' .env)
if [ "$MATCH" -lt 1 ]; then echo "STOP: DATABASE_URL이 로컬 DB가 아님 — 마이그레이션 중단, 사용자 확인 필요"; fi
```

기대 출력: 아무것도 출력되지 않음(= 로컬 DB 확인). `STOP`이 출력되면 **즉시 중단하고 사용자에게 보고**.

### Step 1.3: 마이그레이션 생성 (`--create-only`) + 박스문자 검사

```bash
npx prisma migrate dev --create-only --name add_profit_mode_and_filled_qty
# Prisma CLI garbage 버그 검사: 비ASCII(박스문자) 혼입 시 파일 폐기 후 재생성
grep -nP '[^\x00-\x7F]' prisma/migrations/*_add_profit_mode_and_filled_qty/migration.sql
cat prisma/migrations/*_add_profit_mode_and_filled_qty/migration.sql
```

- `grep` 기대 출력: **0줄** (한 줄이라도 나오면 migration.sql이 오염된 것 — 폴더 삭제 후 Step 1.3-대안으로 진행)
- `cat` 기대 출력 (이 두 문장 외 DDL이 더 있으면 스키마 드리프트 의심 — 중단 후 보고):

```sql
-- AlterTable
ALTER TABLE `bots` ADD COLUMN `profitMode` VARCHAR(191) NOT NULL DEFAULT 'fixed_amount';

-- AlterTable
ALTER TABLE `grid_levels` ADD COLUMN `filledQty` DOUBLE NULL;
```

**Step 1.3-대안 (이 프로젝트는 기존 broken migration 이력으로 `--create-only`가 P3009 등으로 실패할 수 있음):** `migrate diff`로 ALTER 문만 추출해 수동 폴더 생성.

```bash
git show HEAD:prisma/schema.prisma > ../schema.base.prisma
DIR="prisma/migrations/$(date +%Y%m%d%H%M%S)_add_profit_mode_and_filled_qty"
mkdir -p "$DIR"
npx prisma migrate diff \
  --from-schema-datamodel ../schema.base.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > "$DIR/migration.sql"
rm ../schema.base.prisma
grep -nP '[^\x00-\x7F]' "$DIR/migration.sql"   # 기대: 0줄
cat "$DIR/migration.sql"                        # 기대: 위와 동일한 ALTER 2건
```

### Step 1.4: dev DB 적용 + 클라이언트 재생성 + 타입 체크

```bash
npx prisma migrate dev     # 로컬 dev DB에만 적용 (Step 1.2 가드 통과가 전제)
npx prisma migrate status  # 기대: "Database schema is up to date!"
npx prisma generate
npx tsc --noEmit           # 기대: 에러 0개
```

> production 적용은 이 계획에서 하지 않는다. PR 머지 → GitHub Actions 배포 워크플로우의 `prisma migrate deploy`가 자동 수행 (프로젝트 자동 진행 정책).

### Step 1.5: 커밋

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: Bot.profitMode·GridLevel.filledQty 스키마 추가"
```

---

## Task 2: `resolveSellVolume` 헬퍼 — 매도 수량 계산 분기 (TDD)

**Files:**
- 생성: `__tests__/services/trading.coin-neutral.test.ts`
- 수정: `src/services/trading.service.ts` (getCachedBotInfo 끝 L213 부근 뒤에 헬퍼 추가)

### Step 2.1: 실패 테스트 작성

`__tests__/services/trading.coin-neutral.test.ts` 생성 (mock 패턴은 `__tests__/services/trading.service.chunk-1.test.ts`와 동일 — database/encryption은 jest.config.ts의 moduleNameMapper가 `__mocks__/`로 자동 매핑):

```typescript
/**
 * 그리드 코인 중립(coin_neutral) 모드 테스트
 * - resolveSellVolume: 매도 수량 계산 분기 (설계서 §8)
 * - processFilledOrder: 매수 체결 시 GridLevel.filledQty 저장 (Task 3)
 * - executeOppositeOrder: coin_neutral 매도 수량 (Task 4)
 */
jest.mock('../../src/services/upbit.service', () => ({
  UpbitService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../src/services/exchange/bithumb-client', () => ({
  BithumbClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../src/services/grid.service', () => ({
  GridService: { findExecutableGrids: jest.fn(), updateGridLevel: jest.fn() },
}));
jest.mock('../../src/services/socket.service', () => ({
  socketService: {
    emitNewTrade: jest.fn(),
    emitTradeFilled: jest.fn(),
    emitBotUpdate: jest.fn(),
    emitError: jest.fn(),
    emitBalanceUpdate: jest.fn(),
  },
}));
jest.mock('../../src/services/upbit-price-manager', () => ({
  priceManager: { getPriceWithFallback: jest.fn() },
}));
jest.mock('../../src/services/bithumb-grid-price-manager', () => ({
  bithumbPriceManager: { getPriceWithFallback: jest.fn() },
}));
jest.mock('../../src/services/profit.service', () => ({
  ProfitService: { recordProfit: jest.fn() },
}));

let prisma: any;
let TradingService: any;

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
});

async function loadTradingService() {
  const dbMock = await import('../../__mocks__/database');
  prisma = dbMock.default;
  const mod = await import('../../src/services/trading.service');
  TradingService = mod.TradingService;
}

describe('resolveSellVolume — 매도 수량 계산 분기', () => {
  it('fixed_amount: orderAmount / 매도가 (기존 동작 회귀 고정)', async () => {
    await loadTradingService();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'fixed_amount' },
      { price: 1008, buyPrice: 1000 }
    );
    expect(volume).toBeCloseTo(10000 / 1008, 10);
    expect(prisma.gridLevel.findFirst).not.toHaveBeenCalled();
  });

  it('profitMode 미지정(undefined)이어도 기존 동작 유지', async () => {
    await loadTradingService();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000 },
      { price: 1008, buyPrice: 1000 }
    );
    expect(volume).toBeCloseTo(10000 / 1008, 10);
    expect(prisma.gridLevel.findFirst).not.toHaveBeenCalled();
  });

  it('coin_neutral + directFilledQty: 전달된 체결 수량 사용 (DB 조회 없음)', async () => {
    await loadTradingService();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'coin_neutral' },
      { price: 1008, buyPrice: 1000 },
      9.995
    );
    expect(volume).toBe(9.995);
    expect(prisma.gridLevel.findFirst).not.toHaveBeenCalled();
  });

  it('coin_neutral: 대응 매수 GridLevel.filledQty 사용 (주기 매도 경로)', async () => {
    await loadTradingService();
    prisma.gridLevel.findFirst.mockResolvedValue({ filledQty: 10.005 });
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'coin_neutral' },
      { price: 1008, buyPrice: 1000 }
    );
    expect(volume).toBe(10.005);
    expect(prisma.gridLevel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: 1,
          type: 'buy',
          filledQty: { not: null },
        }),
      })
    );
  });

  it('coin_neutral + filledQty 미존재: 정액 방식 폴백 + console.warn', async () => {
    await loadTradingService();
    prisma.gridLevel.findFirst.mockResolvedValue(null);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'coin_neutral' },
      { price: 1008, buyPrice: 1000 }
    );
    expect(volume).toBeCloseTo(10000 / 1008, 10);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('폴백'));
    warnSpy.mockRestore();
  });

  it('coin_neutral + filledQty=0: 0 수량 매도 방지 → 폴백 + 경고', async () => {
    await loadTradingService();
    prisma.gridLevel.findFirst.mockResolvedValue({ filledQty: 0 });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'coin_neutral' },
      { price: 1008, buyPrice: 1000 }
    );
    expect(volume).toBeCloseTo(10000 / 1008, 10);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('coin_neutral + buyPrice null: DB 조회 없이 폴백 + 경고', async () => {
    await loadTradingService();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const volume = await TradingService.resolveSellVolume(
      { id: 1, orderAmount: 10000, profitMode: 'coin_neutral' },
      { price: 1008, buyPrice: null }
    );
    expect(volume).toBeCloseTo(10000 / 1008, 10);
    expect(prisma.gridLevel.findFirst).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
```

### Step 2.2: 실패 확인 (RED)

```bash
npx jest __tests__/services/trading.coin-neutral.test.ts
```

기대 출력: 전 케이스 실패 — `TypeError: TradingService.resolveSellVolume is not a function`

### Step 2.3: 최소 구현

`src/services/trading.service.ts` — `getCachedBotInfo` 메서드 끝(L213 `}` ) 바로 아래에 추가:

```typescript
  /**
   * 매도 주문 수량 계산 (profitMode 분기)
   * - fixed_amount(디폴트, 코인 쌓임): orderAmount / 매도가 — 기존 동작 그대로
   * - coin_neutral(코인 중립): 대응 매수의 실제 체결 수량으로 매도 → 코인 수량 불변
   *   1) directFilledQty(방금 체결된 매수 수량)가 있으면 그 값 사용 (즉시 반대주문 경로)
   *   2) 없으면 대응 매수 GridLevel.filledQty 조회 (주기 매도 경로)
   *   3) 둘 다 없으면 기존 정액 방식 폴백 + 경고 (매도 자체가 막히면 안 됨 — 설계서 §6)
   */
  static async resolveSellVolume(
    bot: { id: number; orderAmount: number; profitMode?: string | null },
    sell: { price: number; buyPrice: number | null },
    directFilledQty?: number | null
  ): Promise<number> {
    const fallbackVolume = bot.orderAmount / sell.price;

    if (bot.profitMode !== 'coin_neutral') {
      return fallbackVolume;
    }

    // 1) 즉시 반대주문 경로: 방금 체결된 매수 수량
    if (directFilledQty != null && directFilledQty > 0) {
      return directFilledQty;
    }

    // 2) 주기 매도 경로: 대응 매수 GridLevel의 filledQty 조회
    //    (가격 범위 검색은 executeOppositeOrder의 기존 priceMargin 패턴과 동일)
    if (sell.buyPrice != null) {
      const priceMargin = Math.max(sell.buyPrice * 0.001, 0.000001);
      const buyGrid = await prisma.gridLevel.findFirst({
        where: {
          botId: bot.id,
          type: 'buy',
          price: { gte: sell.buyPrice - priceMargin, lte: sell.buyPrice + priceMargin },
          filledQty: { not: null },
        },
        orderBy: { filledAt: 'desc' },
        select: { filledQty: true },
      });
      if (buyGrid?.filledQty != null && buyGrid.filledQty > 0) {
        return buyGrid.filledQty;
      }
    }

    // 3) 폴백: filledQty 미존재 (구 데이터/리컨사일 경로) — 코인 중립은 일시적으로 안 지켜지지만 매도는 정상 수행
    console.warn(
      `[Trading] Bot ${bot.id}: coin_neutral 매도인데 filledQty 없음 → 정액 방식 폴백 (매도가 ${sell.price}, 매수가 ${sell.buyPrice ?? '-'})`
    );
    return fallbackVolume;
  }
```

### Step 2.4: 통과 확인 (GREEN)

```bash
npx jest __tests__/services/trading.coin-neutral.test.ts   # 기대: 7 passed
npx tsc --noEmit                                           # 기대: 에러 0개
```

### Step 2.5: 커밋

```bash
git add src/services/trading.service.ts __tests__/services/trading.coin-neutral.test.ts
git commit -m "feat: 매도 수량 계산 resolveSellVolume 헬퍼 추가"
```

---

## Task 3: 매수 체결 시 GridLevel.filledQty 저장 (TDD)

**Files:**
- 수정: `__tests__/services/trading.coin-neutral.test.ts` (describe 블록 추가)
- 수정: `src/services/trading.service.ts` — `processFilledOrder`(L995-1001 `filledVolume` 계산 직후) + 레거시 `checkFilledOrders`(L1230-1234 `filledVolume` 계산 직후) 2곳

> 설계서 §4(b)는 `processFilledOrder`만 명시하지만, 레거시 경로 `checkFilledOrders`(L1139, "개별 봇용 호환성 유지")도 동일하게 매수 체결을 처리하고 반대주문(L1289)을 호출하므로 **같은 저장 로직을 넣어야 coin_neutral 봇이 어느 경로로 체결돼도 filledQty가 기록**된다. 폴백이 있어 누락돼도 사고는 아니지만 경고 로그가 반복되므로 함께 처리한다.

### Step 3.1: 실패 테스트 작성

`__tests__/services/trading.coin-neutral.test.ts` 파일 끝에 추가:

```typescript
describe('processFilledOrder — 매수 체결 시 filledQty 저장', () => {
  function setupFilledOrderMocks() {
    prisma.gridLevel.updateMany.mockResolvedValue({ count: 1 }); // pending→filled 원자 전이 성공
    prisma.gridLevel.update.mockResolvedValue({});
    prisma.bot.update.mockResolvedValue({});
    prisma.trade.findFirst.mockResolvedValue({ id: 77 });
    prisma.trade.update.mockResolvedValue({});
    prisma.bot.findUnique.mockResolvedValue(null); // updatedBot null → 반대주문 스킵 (테스트 격리)
  }

  it('buy 체결이면 GridLevel.filledQty에 실제 체결 수량 저장', async () => {
    await loadTradingService();
    setupFilledOrderMocks();

    const grid = {
      id: 10, botId: 1, type: 'buy', price: 1000,
      orderId: 'uuid-1', buyPrice: null, sellPrice: 1008,
    };
    const order = { state: 'done', avg_price: '999.5', executed_volume: '10.005', trades: [] };

    await (TradingService as any).processFilledOrder(grid, order, {}, 5, 'upbit');

    expect(prisma.gridLevel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10 },
        data: { filledQty: 10.005 },
      })
    );
  });

  it('sell 체결이면 filledQty를 저장하지 않음', async () => {
    await loadTradingService();
    setupFilledOrderMocks();

    const grid = {
      id: 11, botId: 1, type: 'sell', price: 1008,
      orderId: 'uuid-2', buyPrice: 1000, sellPrice: null,
    };
    const order = { state: 'done', avg_price: '1008', executed_volume: '10.005', trades: [] };

    await (TradingService as any).processFilledOrder(grid, order, {}, 5, 'upbit');

    const filledQtyCalls = prisma.gridLevel.update.mock.calls.filter(
      ([arg]: any[]) => arg?.data && 'filledQty' in arg.data
    );
    expect(filledQtyCalls).toHaveLength(0);
  });
});
```

### Step 3.2: 실패 확인 (RED)

```bash
npx jest __tests__/services/trading.coin-neutral.test.ts -t "filledQty 저장"
```

기대 출력: `buy 체결이면...` 케이스 실패 — `Expect(prisma.gridLevel.update).toHaveBeenCalledWith(...)` 불일치 (`data: { filledQty: 10.005 }` 호출 없음). `sell 체결이면...`은 통과.

### Step 3.3: 최소 구현

**(1) `processFilledOrder`** — L1001 `const filledTotal = filledPrice * filledVolume;` 바로 아래에 추가:

```typescript
    // coin_neutral 매도 수량 산정용: 매수 실제 체결 수량을 GridLevel에 기록 (설계서 §4(b))
    if (grid.type === 'buy' && filledVolume > 0) {
      await prisma.gridLevel.update({
        where: { id: grid.id },
        data: { filledQty: filledVolume },
      });
    }
```

**(2) 레거시 `checkFilledOrders`** — L1234 `const filledTotal = filledPrice * filledVolume;` 바로 아래에 동일 코드 추가:

```typescript
          // coin_neutral 매도 수량 산정용: 매수 실제 체결 수량을 GridLevel에 기록
          if (grid.type === 'buy' && filledVolume > 0) {
            await prisma.gridLevel.update({
              where: { id: grid.id },
              data: { filledQty: filledVolume },
            });
          }
```

> 부분 체결 안전성: 두 경로 모두 `state === 'done'`(완전 체결)만 처리하므로 `filledQty`는 항상 확정값 (설계서 §6).

### Step 3.4: 통과 확인 (GREEN)

```bash
npx jest __tests__/services/trading.coin-neutral.test.ts   # 기대: 9 passed
npx tsc --noEmit                                           # 기대: 에러 0개
```

### Step 3.5: 커밋

```bash
git add src/services/trading.service.ts __tests__/services/trading.coin-neutral.test.ts
git commit -m "feat: 매수 체결 시 GridLevel.filledQty 저장"
```

---

## Task 4: 매도 수량 분기 적용 — executeTrade + executeOppositeOrder (TDD)

**Files:**
- 수정: `__tests__/services/trading.coin-neutral.test.ts` (describe 블록 추가)
- 수정: `src/services/trading.service.ts`
  - `CachedBotInfo` 인터페이스(L33-39) + `getCachedBotInfo` select(L197)·객체 생성(L204-210)
  - `executeTrade` 봇 select(L222) + 매도 수량(L442) + 매도 Trade total(L465, L476)
  - `executeOppositeOrder` 시그니처(L1411-1417) + 매도 수량(L1442) + 매도 Trade total(L1509, L1520) + 재시도 재귀(L1688, L1707)
  - 호출부 2곳: `processFilledOrder` 내(L1123-1127), 레거시 `checkFilledOrders` 내(L1289-1293)

> 매도→매수 재진입(L1546 `const volume = bot.orderAmount / buyPrice`)은 **변경하지 않는다** — 설계서 §2 "매수 로직 변경 없음 (항상 orderAmount/매수가)".

### Step 4.1: 실패 테스트 작성

`__tests__/services/trading.coin-neutral.test.ts` 파일 끝에 추가:

```typescript
describe('executeOppositeOrder — 매수 체결 직후 매도 수량', () => {
  function setupOppositeMocks() {
    // 매도 그리드 검색 → 발견
    prisma.gridLevel.findFirst.mockResolvedValue({ id: 20, price: 1008, status: 'inactive' });
    prisma.gridLevel.updateMany.mockResolvedValue({ count: 1 }); // inactive→pending 전이 성공
    prisma.gridLevel.update.mockResolvedValue({});
    prisma.trade.create.mockResolvedValue({ id: 1, createdAt: new Date() });
    return { sellLimit: jest.fn().mockResolvedValue({ uuid: 'sell-1' }) };
  }

  const filledBuyGrid = {
    id: 10, type: 'buy', price: 1000, sellPrice: 1008, buyPrice: null, botId: 1,
  };

  it('coin_neutral: 매도 수량 = 전달된 매수 체결 수량', async () => {
    await loadTradingService();
    const upbit = setupOppositeMocks();

    await (TradingService as any).executeOppositeOrder(
      upbit,
      { id: 1, ticker: 'KRW-USDT', orderAmount: 10000, profitMode: 'coin_neutral' },
      filledBuyGrid,
      0,
      'upbit',
      9.995 // buyFilledQty: 방금 체결된 매수 수량
    );

    expect(upbit.sellLimit).toHaveBeenCalledWith('KRW-USDT', 1008, 9.995);
    // coin_neutral Trade 기록: amount/total이 실제 매도 수량 기준
    expect(prisma.trade.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'sell', amount: 9.995, total: 9.995 * 1008 }),
      })
    );
  });

  it('fixed_amount 회귀: 매도 수량 = orderAmount / sellPrice, total = orderAmount', async () => {
    await loadTradingService();
    const upbit = setupOppositeMocks();

    await (TradingService as any).executeOppositeOrder(
      upbit,
      { id: 1, ticker: 'KRW-USDT', orderAmount: 10000, profitMode: 'fixed_amount' },
      filledBuyGrid,
      0,
      'upbit',
      9.995 // coin_neutral이 아니므로 무시되어야 함
    );

    expect(upbit.sellLimit).toHaveBeenCalledWith('KRW-USDT', 1008, 10000 / 1008);
    expect(prisma.trade.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'sell', total: 10000 }),
      })
    );
  });
});
```

### Step 4.2: 실패 확인 (RED)

```bash
npx jest __tests__/services/trading.coin-neutral.test.ts -t "executeOppositeOrder"
```

기대 출력: `coin_neutral: ...` 실패 — `sellLimit`이 `(…, 1008, 9.995)`가 아니라 `(…, 1008, 9.920634920634921)`(=10000/1008)로 호출됨. `fixed_amount 회귀`는 통과.

### Step 4.3: 구현

**(1) `CachedBotInfo`(L33-39)에 profitMode 추가** (profitMode는 생성 후 불변 → TTL 캐시 안전):

```typescript
interface CachedBotInfo {
  userId: number;
  ticker: string;
  orderAmount: number;
  profitMode: string;
  exchange: string;
  expireAt: number;
}
```

**(2) `getCachedBotInfo`** — select(L197)와 객체 생성(L204-210) 수정:

```typescript
        select: { userId: true, ticker: true, orderAmount: true, profitMode: true, exchange: true },
```

```typescript
    const botInfo: CachedBotInfo = {
      userId: bot.userId,
      ticker: bot.ticker,
      orderAmount: bot.orderAmount,
      profitMode: bot.profitMode,
      exchange: bot.exchange as string,
      expireAt: now + BOT_INFO_CACHE_TTL,
    };
```

**(3) `executeTrade` 봇 select(L222)** — `profitMode: true` 추가 (설계서 §4(c): 현재 status 위주 select라 profitMode 조회 추가 필요):

```typescript
          select: { id: true, status: true, ticker: true, orderAmount: true, profitMode: true, errorMessage: true, userId: true },
```

**(4) `executeTrade` 주기 매도 수량(L442)** — 기존:

```typescript
            const volume = bot.orderAmount / executableGrids.sell.price;
```

교체 (`findExecutableGrids`의 sell은 `prisma.gridLevel.findMany` 전체 row라 `id`·`buyPrice` 포함 — `grid.service.ts` L191-200 확인 완료):

```typescript
            // 주문 수량 계산: coin_neutral이면 대응 매수의 실제 체결 수량, 아니면 정액(기존)
            const volume = await this.resolveSellVolume(
              { id: botId, orderAmount: bot.orderAmount, profitMode: bot.profitMode },
              { price: executableGrids.sell.price, buyPrice: executableGrids.sell.buyPrice ?? null }
            );
```

**(5) `executeTrade` 매도 Trade 기록(L458-468)·소켓(L471-480)의 `total`** — coin_neutral은 매도 금액이 orderAmount와 다르므로 분기 (fixed_amount는 기존 값 그대로 → 무회귀):

```typescript
            const sellTotal = bot.profitMode === 'coin_neutral'
              ? volume * executableGrids.sell.price
              : bot.orderAmount;
```

를 `const order = await upbit.sellLimit(...)` 위에 선언하고, Trade.create의 `total: bot.orderAmount`(L465)와 emitNewTrade의 `total: bot.orderAmount`(L476)를 `total: sellTotal`로 교체.

**(6) `executeOppositeOrder` 시그니처(L1411-1417)** — bot에 profitMode, 마지막 인자 buyFilledQty 추가:

```typescript
  private static async executeOppositeOrder(
    upbit: GridTradeClient,
    bot: { id: number; ticker: string; orderAmount: number; profitMode?: string },
    filledGrid: { id: number; type: string; price: number; sellPrice: number | null; buyPrice: number | null; botId: number; _processStartTime?: number; _actualFilledAt?: Date },
    retryCount: number = 0,
    exchange: string = 'upbit',
    buyFilledQty?: number // 방금 체결된 매수 수량 (coin_neutral 매도 수량 소스, 설계서 §4(c))
  ): Promise<void> {
```

**(7) `executeOppositeOrder` 매도 수량(L1442)** — 기존:

```typescript
        const volume = bot.orderAmount / sellPrice;
```

교체 (대응 매수 = 방금 체결된 `filledGrid` 자신이므로 `buyPrice: filledGrid.price`):

```typescript
        // 매도 수량: coin_neutral이면 방금 체결된 매수 수량(buyFilledQty), 아니면 정액(기존)
        const volume = await this.resolveSellVolume(
          { id: bot.id, orderAmount: bot.orderAmount, profitMode: bot.profitMode },
          { price: sellPrice, buyPrice: filledGrid.price },
          buyFilledQty
        );
```

**(8) `executeOppositeOrder` 매도 Trade 기록(L1502-1512)·소켓(L1515-1524)의 `total`** — (5)와 동일 패턴:

```typescript
        const sellTotal = bot.profitMode === 'coin_neutral' ? volume * sellPrice : bot.orderAmount;
```

를 `const order = await upbit.sellLimit(...)` 위에 선언하고, `total: bot.orderAmount` 2곳(L1509, L1520)을 `total: sellTotal`로 교체.
(매도→매수 재진입 블록 L1536-1638의 `total: bot.orderAmount`는 **변경 금지** — 매수는 항상 정액.)

**(9) 재시도 재귀 호출(L1688, L1707)** — buyFilledQty 관통 전달:

```typescript
        return this.executeOppositeOrder(upbit, bot, filledGrid, retryCount + 1, exchange, buyFilledQty);
```

(2곳 동일하게 교체)

**(10) 호출부 1 — `processFilledOrder` 내(L1123-1127)** — 기존:

```typescript
          await this.executeOppositeOrder(upbit, {
            id: botId,
            ticker: botInfo.ticker,
            orderAmount: botInfo.orderAmount,
          }, grid, 0, exchange);
```

교체 (`filledVolume`은 이 함수 L998-1000에서 이미 계산된 실제 체결 수량):

```typescript
          await this.executeOppositeOrder(upbit, {
            id: botId,
            ticker: botInfo.ticker,
            orderAmount: botInfo.orderAmount,
            profitMode: botInfo.profitMode,
          }, grid, 0, exchange, grid.type === 'buy' ? filledVolume : undefined);
```

**(11) 호출부 2 — 레거시 `checkFilledOrders` 내(L1289-1293)** — 동일 패턴 (`filledVolume`은 L1233에서 계산됨):

```typescript
                await this.executeOppositeOrder(upbit, {
                  id: botId,
                  ticker: botInfo.ticker,
                  orderAmount: botInfo.orderAmount,
                  profitMode: botInfo.profitMode,
                }, grid, 0, botExchange, grid.type === 'buy' ? filledVolume : undefined);
```

### Step 4.4: 통과 확인 (GREEN) + 전체 회귀

```bash
npx jest __tests__/services/trading.coin-neutral.test.ts   # 기대: 11 passed
npx jest                                                   # 기대: 기존 전체 스위트 통과 (fixed_amount 회귀 0)
npx tsc --noEmit                                           # 기대: 에러 0개
```

> 기존 chunk 테스트가 `getCachedBotInfo`의 select 인자를 정확히 assert하고 있다면 `profitMode: true` 추가로 실패할 수 있다. 그 경우 **테스트의 기대 select에 profitMode를 추가하는 수정만** 허용 (동작 변경 아님, 스냅샷 갱신 수준).

### Step 4.5: 커밋

```bash
git add src/services/trading.service.ts __tests__/services/trading.coin-neutral.test.ts
git commit -m "feat: 코인 중립 모드 매도 수량 분기 적용"
```

---

## Task 5: createBot 컨트롤러 — profitMode 수신·검증 (TDD)

**Files:**
- 생성: `__tests__/controllers/bot.controller.profit-mode.test.ts`
- 수정: `src/controllers/bot.controller.ts` createBot(L13-107, 파라미터 구조분해 L20-29)

### Step 5.1: 실패 테스트 작성

`__tests__/controllers/bot.controller.profit-mode.test.ts` 생성:

```typescript
/**
 * createBot profitMode 파라미터 테스트 (설계서 §4(d))
 * - 미전달 → 'fixed_amount' 디폴트 저장
 * - 'coin_neutral' → 그대로 저장
 * - 허용 외 값 → 400 VALIDATION_ERROR
 */
jest.mock('../../src/services/grid.service', () => ({
  GridService: { createGridLevels: jest.fn() },
  calculateBuyPrices: jest.fn(() => []),
}));
jest.mock('../../src/services/upbit.service', () => ({ UpbitService: jest.fn() }));
jest.mock('../../src/services/exchange/bithumb-client', () => ({ BithumbClient: jest.fn() }));
jest.mock('../../src/services/upbit-price-manager', () => ({ priceManager: {} }));
jest.mock('../../src/services/bot-engine.service', () => ({ botEngine: { onBotStarted: jest.fn() } }));
jest.mock('../../src/services/profit.service', () => ({ ProfitService: {} }));

import prisma from '../../__mocks__/database';
import { createBot } from '../../src/controllers/bot.controller';

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const validBody = {
  exchange: 'upbit',
  ticker: 'KRW-USDT',
  lowerPrice: 1000,
  upperPrice: 1100,
  priceChangePercent: 0.8,
  orderAmount: 10000,
};

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.bot.create as jest.Mock).mockResolvedValue({
    id: 1, exchange: 'upbit', ticker: 'KRW-USDT', gridCount: 12,
    investmentAmount: 120000, status: 'stopped', profitMode: 'fixed_amount',
    createdAt: new Date(),
  });
});

describe('createBot — profitMode', () => {
  it('미전달 시 fixed_amount 디폴트로 저장', async () => {
    const req: any = { userId: 1, body: { ...validBody } };
    const res = mockRes();
    await createBot(req, res, jest.fn());

    expect(prisma.bot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ profitMode: 'fixed_amount' }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('coin_neutral 전달 시 그대로 저장', async () => {
    const req: any = { userId: 1, body: { ...validBody, profitMode: 'coin_neutral' } };
    const res = mockRes();
    await createBot(req, res, jest.fn());

    expect(prisma.bot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ profitMode: 'coin_neutral' }),
      })
    );
  });

  it('허용 외 값이면 400 + bot.create 미호출', async () => {
    const req: any = { userId: 1, body: { ...validBody, profitMode: 'invalid_mode' } };
    const res = mockRes();
    await createBot(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.bot.create).not.toHaveBeenCalled();
  });
});
```

### Step 5.2: 실패 확인 (RED)

```bash
npx jest __tests__/controllers/bot.controller.profit-mode.test.ts
```

기대 출력: 3 케이스 모두 실패 — ① `data`에 `profitMode` 없음 ② 동일 ③ `res.status(400)` 미호출(생성이 그냥 성공해버림).

### Step 5.3: 최소 구현

`src/controllers/bot.controller.ts` — 구조분해(L20-29)에 추가:

```typescript
    const {
      exchange,
      ticker,
      lowerPrice,
      upperPrice,
      priceChangePercent,
      orderAmount,
      stopAtMax = false,
      autoStart = false,
      profitMode = 'fixed_amount',
    } = req.body;
```

필수 필드 검증(L31-33) 바로 아래에 허용값 검증 추가:

```typescript
    // 손익 방식 검증: 코인 쌓임(fixed_amount) | 코인 중립(coin_neutral)
    if (!['fixed_amount', 'coin_neutral'].includes(profitMode)) {
      return errorResponse(res, 'VALIDATION_ERROR', 'profitMode는 fixed_amount 또는 coin_neutral만 허용됩니다', 400);
    }
```

`prisma.bot.create`(L60-74) data에 추가:

```typescript
        stopAtMax,
        profitMode,
```

successResponse(L90-103) data에 추가:

```typescript
        investmentAmount: bot.investmentAmount,
        profitMode: bot.profitMode,
```

### Step 5.4: 통과 확인 (GREEN)

```bash
npx jest __tests__/controllers/bot.controller.profit-mode.test.ts   # 기대: 3 passed
npx jest                                                            # 기대: 전체 통과
npx tsc --noEmit && npm run build                                   # 기대: 에러 0개, 빌드 성공
```

### Step 5.5: 커밋

```bash
git add src/controllers/bot.controller.ts __tests__/controllers/bot.controller.profit-mode.test.ts
git commit -m "feat: createBot에 profitMode 파라미터 추가"
```

---

## Task 6: 프론트 — API 타입 + 봇 생성 폼 토글

> **저장소 전환**: `D:\ExpressProject\Grid_project\v0-grid-transaction-frontend` (별개 git repo, 브랜치 `feat/grid-coin-neutral-mode`). 백엔드 파일 수정 금지.
> 프론트에는 테스트 인프라가 없으므로 검증은 `npm run build` + `npm run lint`.

**Files:**
- 수정: `lib/api.ts` `CreateBotRequest`(L97-106)
- 수정: `app/bot/new/page.tsx` (상태 L56-62 부근, createBot 호출 L249-258, "그리드 설정" 카드 L457-559)

### Step 6.1: `lib/api.ts` 타입 추가

`CreateBotRequest`(L97-106)를 다음으로 교체:

```typescript
interface CreateBotRequest {
  exchange: string;
  ticker: string;
  lowerPrice: number;
  upperPrice: number;
  priceChangePercent: number;
  orderAmount: number;
  stopAtMax?: boolean;
  autoStart?: boolean;
  profitMode?: 'fixed_amount' | 'coin_neutral'; // 손익 방식 (디폴트: fixed_amount = 코인 쌓임)
}
```

(`createBot` 함수(L207-221)는 `data`를 그대로 직렬화하므로 함수 본문 수정 불필요.)

### Step 6.2: `app/bot/new/page.tsx` 상태 + 호출 + UI

**(1) 상태 추가** — L61 `const [autoStart, setAutoStart] = useState(true)` 아래에:

```tsx
  const [profitMode, setProfitMode] = useState<'fixed_amount' | 'coin_neutral'>('fixed_amount')
```

**(2) createBot 호출(L249-258)에 전달** — `autoStart: autoStart,` 아래에:

```tsx
        profitMode,
```

**(3) 토글 UI** — "그리드 설정" 카드 내 `stop-at-upper` 체크박스 블록(L520) **바로 위**에 삽입 (신규 shadcn 컴포넌트 설치 없이 기존 border-card 패턴 사용, 디폴트 = 코인 쌓임 — 설계서 §4(d)·§5):

```tsx
            <div className="space-y-2">
              <Label>손익 방식</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setProfitMode("fixed_amount")}
                  className={`rounded-lg border p-4 text-left transition-colors ${
                    profitMode === "fixed_amount" ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
                  }`}
                >
                  <p className="text-sm font-medium">코인 쌓임 (기본)</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    매매를 반복하며 코인을 축적합니다. 하락장에 코인이 쌓여 반등 시 유리합니다.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setProfitMode("coin_neutral")}
                  className={`rounded-lg border p-4 text-left transition-colors ${
                    profitMode === "coin_neutral" ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
                  }`}
                >
                  <p className="text-sm font-medium">코인 중립 (현금 누적)</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    산 수량만큼만 팔아 코인 수량은 유지하고, 차익을 원화로 실현합니다. 횡보·고점 판단 시 유리합니다.
                  </p>
                </button>
              </div>
            </div>
```

### Step 6.3: 검증

```bash
cd D:\ExpressProject\Grid_project\v0-grid-transaction-frontend
npm run build   # 기대: 빌드 성공 (타입 에러 0)
npm run lint    # 기대: 에러 0개
```

### Step 6.4: 커밋

```bash
git add lib/api.ts app/bot/new/page.tsx
git commit -m "feat: 봇 생성 폼에 손익 방식 토글 추가"
```

---

## 최종 검증 (증거 기반 완료)

1. **백엔드**: `npx jest` 전체 통과 수치 보고 + `npx tsc --noEmit` 에러 0 + `npm run build` 성공
2. **프론트**: `npm run build` 성공 + `npm run lint` 에러 0
3. **마이그레이션**: `npx prisma migrate status` → "up to date" (로컬 dev DB)
4. **기존 봇 격리 확인(비파괴)**: 마이그레이션 후 기존 Bot row는 전부 `profitMode='fixed_amount'`(컬럼 DEFAULT) → 런타임 분기 `!== 'coin_neutral'`이 전부 기존 경로 → 기존 봇 손익 영향 0 (설계서 §4(e))
5. **PR**: 백엔드 먼저 머지·배포(마이그레이션 `migrate deploy` 자동) → production 헬스체크 → 프론트 머지 (프로젝트 자동 진행 정책에 따라 진행하되, 배포 전 RDS 수동 스냅샷 `--profile route53` 실행)

## Spec 커버리지 매트릭스 (설계서 §4~§8)

| 설계서 항목 | 커버 Task |
|---|---|
| §4(a) Bot.profitMode / GridLevel.filledQty 스키마 | Task 1 |
| §4(b) processFilledOrder에서 filledQty 저장 | Task 3 (+레거시 checkFilledOrders 보강) |
| §4(c) executeTrade L442 분기 + profitMode select 추가 | Task 4 (3)(4) |
| §4(c) executeOppositeOrder L1442 — filledVolume 인자 전달 | Task 4 (6)(7)(9)(10)(11) |
| §4(c) filledQty 미존재 폴백 + 경고 | Task 2 (resolveSellVolume 3단계 폴백) |
| §4(d) controller profitMode 수신·검증 | Task 5 |
| §4(d) lib/api.ts CreateBotRequest + 폼 토글(디폴트 코인 쌓임, 모드별 설명) | Task 6 |
| §4(e) 기존 봇 격리 (DEFAULT + coin_neutral 분기만) | Task 1 + Task 4 + 최종 검증 4 |
| §5 트레이드오프 문구 폼 반영 | Task 6 Step 6.2(3) |
| §6 부분 체결 안전(완전체결만 처리) / 폴백 시 매도 정상 수행 / 기존 경로 유지 | Task 3(state done만) / Task 2 / Task 4(분기 추가만) |
| §7 범위 밖(소급 전환·비대칭 비율·자동 전환) | 미포함 (YAGNI 준수) |
| §8 테스트: coin_neutral filledQty / fixed_amount 회귀 / 폴백+경고 / filledQty 저장 검증 | Task 2·3·4 테스트 + `npx jest` 전체 회귀 |
