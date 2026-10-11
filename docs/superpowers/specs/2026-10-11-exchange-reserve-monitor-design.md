# 거래소 BTC 보유량 모니터 — 설계

- 작성일: 2026-10-11
- 범위: 백엔드(`v0-grid-tranasction-backend`) + 프론트엔드(`v0-grid-transaction-frontend`)
- 목적: 전 세계 거래소 BTC 보유량(Exchange Reserve)의 추세를 **대시보드 차트로 상시 확인**하고, **1년 최저 갱신 시 카톡 알림**(7일 쿨다운)을 받는다.

## 1. 배경과 데이터 소스

2026-10 기준 거래소 BTC 보유량이 약 267만 개로 3년 만의 최저치라는 보도가 이어졌다. 이를 직접 추적한다.

**데이터 소스: CoinMetrics Community API (무료, 키 불필요)** — 설계 전 실제 호출로 검증 완료(2026-10-11).

| metric | 의미 | 검증 결과 |
|---|---|---|
| `SplyExNtv` | 전체 거래소 BTC 보유량 | ✅ 2026-10-09 = 2,672,865.56 BTC. 2023-01-01 등 과거 조회 가능 |
| `FlowInExNtv` | 일별 거래소 입금량 | ✅ |
| `FlowOutExNtv` | 일별 거래소 출금량 | ✅ |
| 거래소별(`exchange-asset-metrics`) | 바이낸스 등 개별 보유량 | ❌ 유료 — **범위 제외** |

호출 예:
```
GET https://community-api.coinmetrics.io/v4/timeseries/asset-metrics
    ?assets=btc&metrics=SplyExNtv,FlowInExNtv,FlowOutExNtv&frequency=1d
    &start_time=YYYY-MM-DD&page_size=10000
```

제약:
- **일 단위**. D일 값은 D+1일 UTC 01:15~01:45경 공개된다.
- 초기값은 `-status: "flash"`(잠정치)이며 이후 소폭 수정될 수 있다 → 최근 구간 재수집으로 대응.
- 응답은 페이지네이션(`next_page_token`)될 수 있다 → 토큰이 있으면 이어서 조회.
- 교훈(BTC LTH 사례): community tier 권한 가정 금지. 위 3개 metric만 사용한다.

## 2. 결정 사항 (사용자 확정)

| 항목 | 결정 |
|---|---|
| 용도 | 차트 + 알림 |
| 알림 조건 | **1년(365일) 최저 갱신** 한 가지 |
| 알림 빈도 | **7일 쿨다운**. 쿨다운 중 갱신분은 다음 알림에 묶어서 요약 |
| 차트 위치 | **메인 대시보드(`/`) 카드** + **관리자 페이지 `/admin/exchange-reserve`** |
| 저장 방식 | **DB 저장(접근 A)** — 쿨다운 상태가 재시작 후에도 유지되어야 하므로 |

범위 제외(YAGNI): 거래소별 분해, 실시간 데이터, 매매 봇 연동, 순유출 급증·주간 변화율 알림.

## 3. 데이터 모델 (Prisma, MySQL)

```prisma
// 거래소 BTC 보유량 일별 데이터 (CoinMetrics SplyExNtv/FlowInExNtv/FlowOutExNtv)
model ExchangeReserveDaily {
  id         Int      @id @default(autoincrement())
  date       DateTime @unique @db.Date        // UTC 기준 일자
  supplyBtc  Decimal  @db.Decimal(20, 8)      // 거래소 보유량
  inflowBtc  Decimal? @db.Decimal(20, 8)      // 입금량
  outflowBtc Decimal? @db.Decimal(20, 8)      // 출금량
  fetchedAt  DateTime @default(now()) @updatedAt

  @@map("exchange_reserve_daily")
}

// 알림 설정 (단일 행 id=1)
model ExchangeReserveAlertConfig {
  id           Int      @id @default(1)
  enabled      Boolean  @default(true)
  cooldownDays Int      @default(7)
  lookbackDays Int      @default(365)
  updatedAt    DateTime @updatedAt

  @@map("exchange_reserve_alert_config")
}

// 발송된 알림 이력 (쿨다운 판정 기준)
model ExchangeReserveAlert {
  id            Int      @id @default(autoincrement())
  dataDate      DateTime @db.Date               // 알림 근거 데이터 일자
  supplyBtc     Decimal  @db.Decimal(20, 8)
  prevLowBtc    Decimal  @db.Decimal(20, 8)     // 직전 lookback 최저치
  newLowCount   Int                             // 지난 알림 이후 갱신 횟수(묶음)
  message       String   @db.Text
  sentAt        DateTime @default(now())

  @@index([sentAt])
  @@map("exchange_reserve_alerts")
}
```

- 설정 행이 없으면 서비스가 기본값으로 upsert 한다(시드 누락 방지).
- 마이그레이션은 `prisma migrate dev --create-only`로 생성 후 SQL 검사(박스문자 혼입 버그 주의), production은 배포 워크플로우의 `migrate deploy`.

## 4. 백엔드 구성요소

기존 `market-regime` / `btc-rsi-monitor` 패턴을 따른다.

| 파일 | 책임 |
|---|---|
| `src/config/exchange-reserve.ts` | 상수: API URL, metric 목록, cron 식, 타임아웃, 백필 기간(730일), 재수집 기간(7일), 지연 판정(2일) |
| `src/services/exchange-reserve.client.ts` | CoinMetrics 호출 + 응답 파싱(zod 검증, 페이지네이션). 외부 경계 |
| `src/services/exchange-reserve-alert.ts` | **순수 함수** `decideAlert()` — DB/네트워크 없음 |
| `src/services/exchange-reserve.service.ts` | 백필·일일 수집(upsert)·요약 계산·알림 실행·설정 조회/수정 |
| `src/services/exchange-reserve-scheduler.service.ts` | 부팅 백필 + cron 등록/중지 |
| `src/controllers/exchange-reserve.controller.ts` | req/res 처리 |
| `src/routes/exchange-reserve.ts`, `src/routes/exchange-reserve-admin.ts` | 라우트 |

`src/index.ts`에서 `startMarketRegimeScheduler()` 옆에 `startExchangeReserveScheduler()` 호출.

## 5. 데이터 흐름

### 5.1 백필 (부팅 시, 비동기)
1. `ExchangeReserveDaily` 행 수가 400 미만이면 최근 730일을 조회해 upsert.
2. **백필은 알림을 판정하지 않는다.**
3. 실패 시 로그만 남기고 다음 cron에서 재시도(일일 수집이 동일 로직으로 빈 구간을 채움).

### 5.2 일일 수집 (cron)
- 서버 timezone과 무관하게 node-cron `{ timezone: 'UTC' }` 명시.
- `30 2 * * *` (UTC 02:30 = **KST 11:30**) 메인 실행, `30 4 * * *` (UTC 04:30 = **KST 13:30**) 재시도 실행.
- 실행 절차:
  1. 실행 전 DB의 최신 일자 `prevLatest` 기록.
  2. 최근 7일 조회 → upsert(잠정치 수정 반영).
  3. 수집 성공 시 매 실행 알림 판정(5.3) — 새 일자가 없어도 판정해 메인 실행의 발송 실패를 재시도 실행이 복구한다. 중복 발송은 이력·쿨다운이 막는다(2026-10-11 리뷰 반영).
- 동시 실행 방지: 모듈 내 실행 중 플래그.

### 5.3 알림 판정 `decideAlert(input) → { send, newLowCount, prevLow, reason }`

입력:
- `series`: 일자 오름차순 `{date, supply}` (최소 lookback+최근 구간)
- `latestDate`: 이번에 새로 들어온 최신 일자
- `lastAlertDataDate`: 마지막 알림의 `dataDate` (없으면 null)
- `cooldownDays`, `lookbackDays`, `enabled`

규칙:
1. `enabled=false` → `send=false`.
2. 어떤 일자 d가 **갱신일**인 조건: `supply(d) < min(supply over (d−lookbackDays, d−1])`. 비교 구간 데이터가 lookbackDays의 90% 미만이면 갱신으로 보지 않는다(데이터 부족 시 오탐 방지).
3. `pending` = `max(lastAlertDataDate, latestDate − cooldownDays)` 이후 ~ `latestDate`까지의 갱신일 목록 — 최초 가동·장기 미발송(OFF, 발송 실패 지속) 후 오래된 갱신을 몰아서 보내지 않기 위함(2026-10-11 리뷰 반영).
4. 쿨다운 경과 = `lastAlertDataDate`가 null 이거나 `latestDate − lastAlertDataDate ≥ cooldownDays`.
5. `send = 쿨다운 경과 && pending.length > 0`.
   - 오늘이 갱신일이 아니어도 쿨다운이 막 끝났고 묶인 갱신이 있으면 발송(요약).
6. `prevLow` = 묶음 첫 갱신일 직전 lookback 최저치, `newLowCount = pending.length`.

쿨다운 기준을 발송 시각이 아닌 **데이터 일자**로 두어, 재시도·재시작 시각 차이에 영향받지 않게 한다.

### 5.4 발송
- 메시지(예):
  ```
  📉 거래소 BTC 1년 최저 갱신
  현재 2,665,392 BTC (이전 최저 2,672,865)
  지난 알림 이후 4회 갱신, 누적 -18,240 BTC
  전일 순유출 4,261 BTC (입금 27,171 / 출금 31,432)
  기준일 2026-10-08 (UTC)
  ```
- `kakaoNotifyService.sendToMe(msg)` 호출. **발송 성공 후에만** `ExchangeReserveAlert` 기록(실패 시 다음 실행에서 재판정 → 재시도).
- 카톡 토큰 미연결 등 실패는 로그만 남긴다.

## 6. API

| Method | Path | 권한 | 응답 |
|---|---|---|---|
| GET | `/api/exchange-reserve?days=90\|365` | `authenticate` | `{ series: [{date, supply, inflow, outflow}], summary }` |
| GET | `/api/admin/exchange-reserve/config` | `authenticate`+`requireAdmin` | 설정 |
| PUT | `/api/admin/exchange-reserve/config` | 동일 | 설정 수정. zod: `enabled` boolean, `cooldownDays` 1~30 정수, `lookbackDays` 30~730 정수 |
| GET | `/api/admin/exchange-reserve/alerts?limit=50` | 동일 | 알림 이력 최신순 |

`summary`:
```ts
{
  latestDate: string | null,      // 'YYYY-MM-DD'
  supply: number | null,
  change1d / change7d / change30d: { abs: number, pct: number } | null,
  low1y / high1y: { date: string, supply: number } | null,
  isNewLow1y: boolean,            // 최신 일자가 1년 최저 갱신일인가
  netFlow1d: number | null,       // inflow - outflow (음수=순유출)
  stale: boolean,                 // 최신 일자가 오늘(UTC) 기준 2일 초과 경과
  status: 'ok' | 'backfilling'    // 데이터 0건이면 backfilling
}
```
- `days`는 90 또는 365만 허용(그 외 400). 숫자는 JSON number로 직렬화(소수 8자리 정밀도는 표시에 충분).

## 7. 프론트엔드

| 파일 | 내용 |
|---|---|
| `lib/api.ts` | `getExchangeReserve(days)`, `getExchangeReserveConfig()`, `updateExchangeReserveConfig()`, `getExchangeReserveAlerts()` + 타입 |
| `components/exchange-reserve/exchange-reserve-chart.tsx` | Recharts 면적 차트(보유량). 선택적으로 순유입/유출 막대 |
| `components/exchange-reserve/exchange-reserve-card.tsx` | 대시보드 카드 |
| `app/page.tsx` | 카드 삽입(기존 카드 그리드 하단, 파일 비대화 방지 위해 컴포넌트만 import) |
| `app/admin/exchange-reserve/page.tsx` | 관리자 페이지 |
| 관리자 메뉴 | `/admin` 목록에 링크 추가 |

**대시보드 카드**
- 제목 "거래소 BTC 보유량" + 기준일.
- 큰 숫자 현재 보유량(예: `2,672,866 BTC`), 7일 변화 배지(감소=빨강 ▼, 증가=초록 ▲), `isNewLow1y`면 "1년 최저" 배지.
- 면적 차트, 90일/1년 토글(기본 1년), 툴팁에 일자·보유량.
- `stale`이면 "데이터 지연" 표시, `backfilling`이면 "데이터 준비 중" 안내, 오류 시 카드 내부 에러 문구(대시보드 전체를 깨뜨리지 않음).

**관리자 페이지**
- 동일 차트 + 일별 순유입/유출 막대.
- 알림 설정 폼(ON/OFF, 쿨다운 일수, 비교 기간) 저장.
- 알림 이력 테이블(발송 시각, 기준일, 보유량, 갱신 횟수, 메시지).

다크/라이트 모드 모두 기존 테마 토큰 사용.

## 8. 오류 처리

- CoinMetrics 타임아웃(10초)/HTTP 오류/스키마 불일치 → 로그 후 해당 실행 종료. DB 데이터 유지.
- 부분 응답(일부 metric 누락) → `supplyBtc` 없는 행은 저장하지 않음, 유입/유출은 null 허용.
- 카톡 실패 → 알림 미기록(다음 실행 재시도).
- 프론트는 API 실패를 카드 단위로 격리.

## 9. 테스트 (jest)

- `exchange-reserve-alert.test.ts` (핵심):
  - 갱신 없음 → 미발송
  - 첫 가동 + 오늘 갱신 → 발송, count=1
  - 첫 가동 시 과거(쿨다운 이전) 갱신만 존재 → 미발송
  - 쿨다운 중 갱신 → 미발송
  - 쿨다운 만료일 + 오늘 비갱신 + 묶인 갱신 3건 → 발송, count=3
  - 쿨다운 만료 + 오늘 갱신 + 묶인 2건 → count=3
  - lookback 데이터 부족 → 갱신 아님
  - `enabled=false` → 미발송
- `exchange-reserve.client.test.ts`: 정상 응답 파싱, 페이지네이션 이어 받기, 스키마 불일치 시 throw.
- `exchange-reserve.service.test.ts`: 요약 계산(변화율, 1년 최저/최고, stale, backfilling), 최신 일자 미변경 시 알림 판정 생략.
- 검증: `npx tsc --noEmit`, `npm run build`, jest 통과. 프론트 `npm run build`.

## 10. 배포

1. 백엔드 PR(스키마+마이그레이션+서비스+API) → 머지 전 Grid-bot-DB-v2 스냅샷 → 머지 → 배포 → `migrate status` 확인 → 로그에서 백필 건수 확인 → `GET /api/exchange-reserve` 데이터 확인.
2. 프론트 PR(카드+관리자 페이지) → 머지 → 배포 → 대시보드 표시 확인.
3. 첫 알림 판정은 다음 날 KST 11:30 cron에서 발생 — 로그로 판정 결과 확인.

## 11. 롤백

- 알림만 끄기: 관리자 페이지에서 OFF(또는 `exchange_reserve_alert_config.enabled=0`).
- 기능 전체: 스케줄러 미기동으로 revert 배포. 새 테이블은 기존 기능과 독립이라 남겨두어도 무해.
