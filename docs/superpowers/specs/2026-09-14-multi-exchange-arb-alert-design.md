# 멀티 거래소 차익거래 알림 (Multi-Exchange Arbitrage Alert) 설계서

- 작성일: 2026-09-14
- 상태: 설계 승인 완료 → 구현 계획 대기
- 범위: 백엔드(`v0-grid-tranasction-backend`) 신규 서비스. **알림 전용(주문 실행 없음)**

## 1. 목적

여러 거래소 간 같은 코인의 가격 괴리(차익거래 기회)를 상시 감시하고, **실제로 실현 가능한 기회만** 걸러 카카오톡으로 알린다.

핵심 원칙 — **"괴리가 크다 ≠ 먹을 수 있다"**:
- 2026-09-13 LSK 사례에서 업비트↔빗썸 괴리가 142%까지 벌어졌으나, 업비트는 `LISK` 자체망 / 빗썸은 `ETH` 망이라 **전송 불가**로 실현이 불가능했다.
- 따라서 이 기능의 가치는 "큰 괴리 찾기"가 아니라 **"실현 가능한 괴리만 걸러내기"**에 있다.

## 2. 확정된 결정사항 (브레인스토밍 결과)

| 항목 | 결정 |
|---|---|
| 기능 범위 | **알림만** (주문 실행/자동 차익거래 없음) |
| 트리거 | **상시 스프레드 스캔** + 상폐/거래중지 공지는 "함정 경고"로 보조 |
| 스캔 대상 | 거래소 간 **공통 상장 코인 전체** 자동 |
| 비교 방식 | **같은 통화권 우선**(국내 KRW끼리 / 해외 USDT끼리). 국내↔해외 김프는 참고 수치로만 표시 |
| 알림 임계값 | **스프레드 2% 이상** (조정 가능) |
| 쿨다운 | **코인당 30분** (동일 코인 반복 알림 억제) |
| 알림 채널 | **카카오톡 나에게 보내기** (기존 `kakao-notify.service.ts` 재사용) |
| 실현가능성 필터 | **5개 거래소 전부 완전 적용** (네트워크 일치 + 입출금 상태) |

대상 거래소: **업비트, 빗썸, 바이낸스, MEXC, Gate.io**

## 3. 검증된 전제 (구현 전 실측 완료, 2026-09-14)

- userId=2(관리자)의 Credential: upbit·bithumb·binance·mexc 모두 `isValid=true`. Gate.io는 DB에 없으나 env(`GATEWAY_API_KEY`/`GATEWAY_SECRET_KEY`) 존재.
- 입출금·네트워크 조회 권한 실측:
  - 바이낸스 `GET /sapi/v1/capital/config/getall` → 744개 코인, `networkList[{network, depositEnable, withdrawEnable, withdrawFee}]` 정상 반환 (LSK=ETH, 입출금 정상, fee 1.03).
  - MEXC `GET /api/v3/capital/config/getall` → 9,539개 코인, 네트워크별 입출금 상태 반환.
  - 업비트/빗썸 `GET /v1/status/wallet` (인증) → `currency, net_type, wallet_state, block_state` 반환 (앞서 검증).
  - Gate.io `GET /api/v4/wallet/currency_chains` (또는 `/spot/currencies`)로 체인/입출금 상태 조회 예정.
- 기존 서명 인프라: `listing-auto-trader.service.ts`에 HMAC-SHA256(Binance/MEXC), HMAC-SHA512(Gate.io) 서명 함수(`signedGet`, `signedPost`, `mexcPost`, `gateioRequest`)가 이미 존재 → **공용 모듈로 추출해 재사용**.

## 4. 아키텍처

기존 `general-arb-scanner`(업비트↔빗썸 이벤트 드리븐)는 **그대로 유지**하고, 독립된 새 폴링 경로를 추가한다.

```
MultiExchangeArbAgent (BaseAgent, 60초 주기)
        │
        ▼
MultiExchangeArbScanner (오케스트레이터)
   ├─ ExchangePriceSource   : 거래소별 시세 조회 어댑터 (업/빗/바/멕/게)
   ├─ SymbolUniverse        : 거래소별 공통 상장 심볼 교집합 (1시간 캐시)
   ├─ WalletStatusProvider  : 거래소별 코인 입출금 상태 + 네트워크 맵 (5~10분 캐시)
   ├─ SpreadCalculator      : 같은 통화권 그룹 내 최저매수↔최고매도 스프레드
   ├─ FeasibilityFilter     : 네트워크 일치 / 입출금 정상 / 공지 경고 3단
   └─ ArbAlertNotifier      : 쿨다운 + 카카오톡 발송 (kakao-notify 재사용)
        │
        ▼
DB: MultiArbOpportunity (기회 이력 + 쿨다운 근거)
```

각 단위는 단일 책임을 가지며 독립적으로 테스트 가능하다.

- **ExchangePriceSource**: 거래소별 현재가/최우선 호가를 정규화된 형태로 반환. 기존 `upbit-listing-monitor`의 `fetchBinancePrice`/`fetchMexcPrice`/`fetchGateioPrice` 재사용/확장.
- **SymbolUniverse**: 각 거래소 상장 목록을 조회해 base 심볼로 정규화하고 통화권(KRW/USDT)별 교집합을 만든다. 1시간 캐시.
- **WalletStatusProvider**: 거래소별 "코인→{네트워크, 입금가능, 출금가능}" 맵. capital/config·status/wallet은 전체를 한 번에 반환하므로 5~10분 주기로 통째 캐시.
- **SpreadCalculator**: 같은 통화권 안에서 코인별 "최저 매수가 거래소 ↔ 최고 매도가 거래소" 쌍의 스프레드%를 계산.
- **FeasibilityFilter**: 후보에 실현가능성 태그를 부여.
- **ArbAlertNotifier**: 쿨다운 확인 후 카카오톡 발송 + DB 기록.

## 5. 데이터 흐름 (60초 주기)

1. **심볼 교집합 갱신**(1시간 캐시): 5개 거래소 상장 목록 → base 심볼 정규화 → 통화권별 그룹핑
   - KRW권: 업비트·빗썸 / USDT권: 바이낸스·MEXC·Gate.io
2. **시세 배치 조회**: 각 거래소 현재가(또는 최우선 호가) 폴링 (`Promise.allSettled`)
3. **스프레드 계산**: 같은 통화권 내 코인별 최저 매수 거래소 ↔ 최고 매도 거래소 쌍의 괴리% 산출
4. **1차 필터**: 스프레드 2% 초과 후보만 추림
5. **실현가능성 필터**(§6): 각 후보에 태그 부여
6. **쿨다운 확인**(코인+통화권 기준 30분) → 통과분만 **카카오톡 발송** + `MultiArbOpportunity` 기록
7. **김프 첨부**: 해당 코인의 국내↔해외 가격차(업비트 `KRW-USDT` 환율로 환산)를 참고 수치로 메시지에 표시 (알림 트리거 아님)

## 6. 실현가능성 필터 (핵심)

후보 코인마다 3단으로 검증해 태그를 부여한다. 5개 거래소 전부 입출금/네트워크 조회가 가능하므로 완전 적용한다.

| 단계 | 검사 | 실패 시 태그 |
|---|---|---|
| 1. 네트워크 일치 | 매수·매도 두 거래소가 **같은 네트워크**로 해당 코인을 지원하는가 | `network_mismatch` (⛔ 전송불가) |
| 2. 입출금 정상 | 매수 거래소 **출금 가능** + 매도 거래소 **입금 가능** (`wallet_state`/`depositEnable`/`withdrawEnable`) | `deposit_halt` (⚠️ 입출금중단) |
| 3. 공지 경고 | 상폐/거래중지 공지가 뜬 코인인가 (선택적, §10) | `notice_warning` (⚠️ 함정) |

- **모든 단계 통과 = `feasible`** → 정상 알림 발송.
- 하나라도 실패 → 경고 태그와 함께 발송하되, 기본 설정에서는 `network_mismatch`/`deposit_halt`는 **정보용(주의)** 등급으로 낮춰 표시. (LSK류 함정을 "기회"로 오인하지 않도록)
- 네트워크 일치 판정: 두 거래소의 지원 네트워크 집합에 **교집합이 있는지**로 판단(코인이 여러 체인 지원 가능). 교집합 네트워크의 입출금 상태로 2단계 검사.

## 7. 알림 포맷 (카카오톡)

정상 기회:
```
🔔 차익 후보 (KRW권) · WLD
📉 빗썸 매수 4,200
📈 업비트 매도 4,340  → +3.3%
✅ 네트워크 일치(ETH) · 양쪽 입출금 정상
참고 김프: 해외 대비 +0.8%
⚠️ 표시가 기준 · 실제 유동성/체결 확인 필요
```

함정 경고(LSK류):
```
⚠️ 차익 후보(주의) · LSK  빗썸 1,322 / 업비트 533 (+148%)
⛔ 전송불가: 네트워크 불일치(업비트 LISK망 ↔ 빗썸 ETH망)
→ 실현 어려움. 정보용 참고
```

모든 알림에 "표시가 기준이며 실제 체결·유동성은 별도 확인 필요" 문구를 포함한다.

## 8. 데이터 모델

기존 `GeneralArbOpportunity`는 upbit/bithumb 2컬럼 고정 구조라 다거래소에 부적합 → 신규 테이블.

```prisma
model MultiArbOpportunity {
  id           Int      @id @default(autoincrement())
  symbol       String                    // base 심볼 (예: "BTC")
  currencyZone String                    // "KRW" | "USDT"
  buyExchange  String
  buyPrice     Float
  sellExchange String
  sellPrice    Float
  spreadPct    Float
  feasibility  String                    // "feasible" | "network_mismatch" | "deposit_halt" | "notice_warning" | "unverified"
  networkMatch Boolean?                  // 네트워크 일치 여부 (판정 가능한 경우)
  matchedNetwork String?                 // 교집합 네트워크 (예: "ETH")
  note         String?                   // 사람이 읽을 요약/경고
  kimchiPct    Float?                    // 참고 김프(%)
  detectedAt   DateTime @default(now())
  notifiedAt   DateTime?                 // 카톡 발송 시각 (null이면 미발송)

  @@index([symbol, currencyZone, notifiedAt])   // 쿨다운 조회
  @@index([detectedAt])
  @@map("multi_arb_opportunities")
}
```

쿨다운: `(symbol, currencyZone)`의 최근 `notifiedAt`이 30분 이내면 발송 스킵.

## 9. 스케줄링 & 에러 처리

- `MultiExchangeArbAgent`: `BaseAgent` 상속, `cycleIntervalMs = 60000`(60초). `agent-manager`에 등록.
- 거래소 하나가 실패해도 나머지는 진행(`Promise.allSettled`). 실패한 거래소는 이번 사이클에서 제외.
- 심볼 교집합 1시간 캐시, 지갑 상태/네트워크 맵 5~10분 캐시(rate limit 보호).
- capital/config·status/wallet은 전체를 한 번에 반환하므로 후보별 개별 조회하지 않는다.
- 카카오톡 발송 실패는 로깅하고 다음 사이클에서 재시도(쿨다운은 발송 성공 시에만 갱신).

## 10. 범위 밖 (YAGNI) / 후속 과제

- **주문 실행/자동 차익거래**: 이번 범위 아님(알림 전용). 실현은 사용자가 수동 판단.
- **국내↔해외 김프 차익 실현**: 원화↔USDT 환전+외환 리스크로 실현 난이도 높음 → 참고 수치 표시만.
- **상폐/거래중지 공지 감지(필터 3단계)**: 현재 상장 모니터는 신규상장만 감지. 입출금 중단은 §6 2단계(`wallet_state`)로 실시간 감지가 더 정확하므로, 공지 파싱 기반 3단계는 **후속 과제**로 둔다(초기 구현에서는 입출금 상태 기반 경고로 대체).
- **웹 대시보드 UI**: 알림이 카카오톡이므로 초기엔 UI 불필요. 필요 시 후속.

## 11. 테스트 전략

- `SpreadCalculator` 단위테스트: 모킹 시세로 최저매수/최고매도 쌍 선택 및 스프레드 계산 검증.
- `FeasibilityFilter` 단위테스트: **LSK 케이스(업비트 LISK망 ↔ 빗썸 ETH망 → `network_mismatch`)를 회귀 테스트로 고정.** 정상 케이스(양쪽 ETH → `feasible`)도 포함.
- 쿨다운 로직 테스트: 30분 이내 재발송 억제 검증.
- `WalletStatusProvider` 파싱 테스트: 각 거래소 응답 형식 → 정규화 맵 변환 검증(모킹 응답).
- jest 사용.
