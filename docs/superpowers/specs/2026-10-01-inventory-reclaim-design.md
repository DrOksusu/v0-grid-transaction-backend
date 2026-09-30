# 재고 되돌림 리컴실러 (Inventory Reclaim) 설계

- 작성일: 2026-10-01
- 상태: 설계 승인됨 (구현 대기)
- 관련: `project_arb_rotation_strategy_probe_2026_09_30`, `project_bithumb_inventory_transfer_fee_classify_2026_09_30`

## 1. 배경 & 목적

재고형 아비 운영으로 빗썸에 코인 재고가 쏠려 있다("업비트 매도 / 빗썸 매수"를 반복한 결과).
이 묶인 재고를 업비트로 되돌려(재장전) 다시 "업비트 비쌈" 수확 기회를 잡으려 한다.

되돌리는 방법은 둘:
- **전송(출금)**: 빗썸 출금 → 업비트 입금. 확실하나 출금수수료. 정액 저비용 코인(HBAR·AVAX·XLM 등)은 거의 공짜라 전송이 답.
- **아비-되돌림(이 스펙)**: 빗썸 매도 + 업비트 매수 동시 체결. **전송이 비싼(정률 1% 등) 코인**은 전송하면 손해라, 되돌림 방향 스프레드가 순차익 ≥0일 때 체결해 **손해 없이** 재장전.

**목적**: 전송이 비싼 재고를, 되돌림 순차익 ≥0인 순간에 자동 실행해 손해 없이 업비트로 회수.

## 2. 스코프

### 대상 코인 (자동 선별)
- 빗썸 보유량 > 0
- 업비트 KRW 마켓 공통 상장 (업비트에서 매수 가능해야 함)
- **출금수수료율 > `withdrawFeePctThreshold`** (전송이 비싼 코인만 — 전송 싼 코인은 전송이 답이므로 제외)
  - 출금수수료율은 기존 `getWithdrawFeeInfo`(빗썸 `/v1/withdraws/chance`)로 조회, 코인별 캐시(예: 1시간)
- 관리자는 대상 목록·스프레드를 현황에서 확인 (개별 제외 목록은 초기 범위 밖 — 후속 v2)

### 비대상
- 전송 싼 코인(정액 저비용) — 전송 권장
- 업비트 미상장 코인 — 되돌림 불가

## 3. 아키텍처

**신규 전용 서비스** `inventory-reclaim.service.ts` — 기존 재고형 아비(`inventory-arb.service`)·로밍과 **완전 격리**. 기존 봇 로직에 조건을 얽지 않는다(기존 봇 영향 0).

주문 로우레벨(빗썸/업비트 IOC 주문 실행 함수)만 기존 코드에서 재사용하고, 상위 정책(방향 잠금·min 사이징·no-flatten·순차익≥0)은 신규 작성.

구성 단위:
- **대상 선별기**: 빗썸 보유 × 업비트 공통상장 × 출금수수료율 필터 → 대상 코인 목록 (캐시)
- **스캐너**: 주기(30초)마다 대상별 되돌림 스프레드 계산 + 실행 판정
- **집행기(executor)**: min 사이징 → 빗썸 매도 IOC + 업비트 매수 IOC 동시 → 결과 기록 (flatten 없음)
- **안전 게이트**: enabled/killSwitch/일한도/불균형 한도
- **컨트롤러 + 라우트**: 관리자 전용 config/status API

## 4. 동작 흐름 (주기 스캔, 30초)

1. 대상 코인마다 **빗썸 최우선 매수호가(bid) + 물량**, **업비트 최우선 매도호가(ask) + 물량** 조회
2. 되돌림 스프레드 `d1 = (빗썸bid − 업비트ask) / 업비트ask`
   순차익 `netPct = d1 − 수수료(빗썸 taker 0.04% + 업비트 taker 0.05% = 0.09%)`
3. `netPct ≥ minNetPct`(기본 0) 이면 실행 후보
4. **사이징** `qty = min(빗썸 bid 물량, 업비트 ask 물량, 빗썸 보유재고, maxOrderKrw/업비트ask)`
   - 최우선호가 물량 이내 → 양쪽 완전체결 목표, **슬리피지 0**
   - `qty × 업비트ask < MIN_ORDER_KRW`(5,000원) 이면 스킵
5. **집행**: 빗썸 매도(IOC, bid 지정가) + 업비트 매수(IOC, ask 지정가) 동시 요청
6. **부분체결 처리 — flatten 안 함**:
   - 두 주문의 실제 체결량(sellFilled, buyFilled)을 기록
   - 불균형(sellFilled ≠ buyFilled)은 상쇄하지 않고 그대로 둠 → 다음 사이클에 자연 재조정
   - 순손익 KRW = 체결 기준 (빗썸 매도대금 − 업비트 매수대금 − 수수료)

## 5. 데이터 모델

### 신규 config: `ArbReclaimConfig`
```
userId                    Int @unique
enabled                   Boolean @default(false)   // 기본 OFF
minNetPct                 Float @default(0)          // 순차익 임계(%) 기본 0=본전
maxOrderKrw               Float @default(50000)      // 1회 한도(canary 소액)
dailyMaxCount             Int? @default(50)
dailyMaxKrw               Float? @default(1000000)   // 일 누적 거래대금 한도
withdrawFeePctThreshold   Float @default(0.3)        // 대상 선별: 출금수수료율(%) 이상만
imbalanceCapKrw           Float @default(100000)     // 누적 부분체결 불균형 한도 → 초과 시 스캔 정지
killSwitch                Boolean @default(false)
```

### 신규 거래 기록: `ArbReclaimTrade`
```
id, userId, symbol, qty,
bithumbSellPrice, upbitBuyPrice,
sellFilled, buyFilled,        // 실제 체결량 (부분체결 추적)
grossKrw, feeKrw, netKrw,
status,                        // filled | partial | failed
createdAt
```

## 6. 안전장치

- **기본 OFF** + killSwitch (관리자 토글)
- **관리자 전용** (라우터 authenticate + requireAdmin — 기존 재고형 아비와 동일)
- **일한도**: dailyMaxCount, dailyMaxKrw (KST 자정 기준)
- **순차익 ≥ 0** → 개별 거래는 손해 없음 (min 사이징으로 슬리피지 0이라 계산대로 실현)
- **불균형 누적 한도**: 부분체결 잔여(|Σ sellFilled − Σ buyFilled| × 가격)가 `imbalanceCapKrw` 초과 시 스캔 일시정지 + 카톡 알림 (방향 노출 폭주 방지)
- **canary**: maxOrderKrw 소액으로 시작 → 관찰하며 확대

## 7. API & 관리자 UI

- `GET  /api/inventory-reclaim/config` — 설정 조회
- `PUT  /api/inventory-reclaim/config` — 설정 수정 (enabled/minNetPct/maxOrderKrw/일한도/threshold/killSwitch), validation
- `GET  /api/inventory-reclaim/status` — 현황(대상 코인 목록+스프레드, 오늘 건수/순손익, 누적 불균형, 최근 거래)
- 프론트: 관리자 페이지에 "재고 되돌림" 패널 (토글 + 수치 설정 + 현황). 기존 재고형 아비 페이지에 섹션 추가 또는 신규 페이지.

## 8. 엣지케이스

- 업비트 KRW 잔고 부족 → 사이징에서 업비트 매수 가능액으로 제한, 부족하면 스킵
- 빗썸 보유재고 0 → 대상에서 제외
- 최우선호가 물량/금액이 MIN_ORDER_KRW 미만 → 스킵
- 호가 조회 실패 → 해당 코인 스킵 (다음 사이클)
- 한쪽 주문 API 실패 → 나머지 한쪽만 체결된 상태 = 부분체결로 기록(남기기), 불균형 추적에 반영
- 재고형 아비는 입출금 무관(양쪽 매매만) → 입출금 동결 여부는 되돌림에 영향 없음 (전송과 달리)

## 9. 측정 통합

canary(소액)로 켜는 것 자체가 **"전송 비싼 그룹에 실제로 순차익≥0 되돌림이 오는가"** 를 실측한다. 손해가 없어(본전) 관찰과 실행을 겸한다. 안 오면 재고는 그대로(안전), 오면 조금씩 재장전. 별도 며칠 수집 없이 canary 관찰로 판정.

## 10. 테스트 전략

- 순수함수 단위테스트: 사이징(min 로직), 순차익 판정, 불균형 한도 판정, 일한도 판정
- 집행기 통합: 부분체결 시 flatten 안 함 + 체결량만 기록 (mock 주문)
- 안전 게이트: enabled=false/killSwitch/한도초과 시 미실행
- 회귀: 기존 재고형 아비/로밍 테스트 영향 없음(격리 확인)

## 11. 미해결 / 후속

- **수수료 가정 검증 (CRITICAL)**: 순차익 계산의 수수료 0.09%(빗썸 0.04% + 업비트 0.05%)는 코드 기본값이다. 빗썸 실제 taker 등급이 이보다 높으면(0.04~0.24% 변동) **순차익≥0이 실제로는 음수(손해)**가 된다. 배포 전 실제 taker 등급을 확인해 수수료 상수에 반영하고, minNetPct 기본값에 안전 버퍼를 둘지 재검토.
- 대상 선별의 출금수수료 캐시 주기·갱신 트리거 (구현 시 결정)
- 개별 코인 제외 목록 UI (v2)
- 불균형 자연 재조정이 실제로 수렴하는지 canary 관찰
- 되돌림 후 업비트 재장전분으로 "업비트 비쌈 수확"을 재개하는 연결(별도, 기존 재고형 아비가 담당)
