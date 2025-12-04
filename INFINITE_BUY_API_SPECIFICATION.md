# 무한매수법 (Infinite-Buy) API 명세서

## 개요

라오어의 무한매수법을 구현하기 위한 백엔드 API 명세서입니다.
기존 그리드 봇 API 패턴을 따르며, 한국투자증권(KIS) API를 통해 미국주식을 자동 매매합니다.

---

## 데이터베이스 스키마 추가 (Prisma)

```prisma
// prisma/schema.prisma에 추가

// 무한매수 종목
model InfiniteBuyStock {
  id              String   @id @default(cuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id])

  // 종목 정보
  ticker          String                // 티커 (예: AAPL, TSLA)
  name            String                // 종목명 (예: Apple Inc.)
  exchange        String   @default("NAS")  // 거래소 (NAS, NYS, AMS)

  // 무한매수 설정
  buyAmount       Float                 // 1회 매수금액 (USD)
  totalRounds     Int      @default(40) // 총 분할 횟수
  targetProfit    Float    @default(10) // 목표 수익률 (%)

  // 현재 상태
  status          InfiniteBuyStatus @default(buying)
  currentRound    Int      @default(0)  // 현재 회차
  totalInvested   Float    @default(0)  // 총 투자금
  totalQuantity   Float    @default(0)  // 총 보유수량
  avgPrice        Float    @default(0)  // 평균단가

  // 자동매수 설정
  autoEnabled     Boolean  @default(true)
  buyTime         String?              // 매수 시간 (예: "09:30")
  buyCondition    String   @default("daily") // daily, weekly, condition

  // 타임스탬프
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  completedAt     DateTime?            // 익절 완료 시간

  // 관계
  buyRecords      InfiniteBuyRecord[]

  @@unique([userId, ticker])
  @@index([userId])
  @@index([status])
}

// 매수 기록
model InfiniteBuyRecord {
  id              String   @id @default(cuid())
  stockId         String
  stock           InfiniteBuyStock @relation(fields: [stockId], references: [id], onDelete: Cascade)

  // 거래 정보
  type            TradeType             // buy, sell
  round           Int?                  // 회차 (매수시)
  price           Float                 // 체결 가격
  quantity        Float                 // 체결 수량
  amount          Float                 // 체결 금액

  // 매도시 수익 정보
  profit          Float?                // 실현 손익
  profitPercent   Float?                // 실현 수익률

  // KIS 주문 정보
  orderId         String?               // KIS 주문번호
  orderStatus     String   @default("filled") // pending, filled, cancelled

  // 타임스탬프
  executedAt      DateTime @default(now())

  @@index([stockId])
  @@index([type])
}

enum InfiniteBuyStatus {
  buying      // 매수 진행중
  completed   // 익절 완료
  stopped     // 중단됨
}
```

---

## API 엔드포인트

### 기본 경로: `/api/infinite-buy`

---

### 1. 종목 생성 (새 종목 추가)

**POST** `/api/infinite-buy/stocks`

#### Request Body
```json
{
  "ticker": "AAPL",
  "name": "Apple Inc.",
  "exchange": "NAS",
  "buyAmount": 100,
  "totalRounds": 40,
  "targetProfit": 10,
  "autoEnabled": true,
  "buyTime": "09:30",
  "buyCondition": "daily",
  "autoStart": true
}
```

#### Response (201 Created)
```json
{
  "success": true,
  "data": {
    "id": "clx1234567890",
    "ticker": "AAPL",
    "name": "Apple Inc.",
    "exchange": "NAS",
    "status": "buying",
    "buyAmount": 100,
    "totalRounds": 40,
    "targetProfit": 10,
    "currentRound": 0,
    "totalInvested": 0,
    "totalQuantity": 0,
    "avgPrice": 0,
    "targetPrice": 0,
    "autoEnabled": true,
    "buyTime": "09:30",
    "buyCondition": "daily",
    "createdAt": "2024-01-15T00:00:00.000Z"
  },
  "message": "종목이 추가되었습니다"
}
```

---

### 2. 전체 종목 조회

**GET** `/api/infinite-buy/stocks`

#### Query Parameters
| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| status | string | N | 상태 필터 (buying, completed, stopped) |

#### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "stocks": [
      {
        "id": "clx1234567890",
        "ticker": "AAPL",
        "name": "Apple Inc.",
        "exchange": "NAS",
        "status": "buying",
        "currentPrice": 178.50,
        "avgPrice": 185.30,
        "targetPrice": 203.83,
        "currentRound": 12,
        "totalRounds": 40,
        "totalInvested": 1200,
        "totalQuantity": 6.45,
        "currentValue": 1156.33,
        "profitLoss": -43.67,
        "profitLossPercent": -3.64,
        "priceChangePercent": 1.2,
        "autoEnabled": true,
        "createdAt": "2024-01-01T00:00:00.000Z"
      }
    ],
    "summary": {
      "totalStocks": 5,
      "buyingCount": 3,
      "completedCount": 1,
      "stoppedCount": 1,
      "totalInvested": 8500,
      "totalValue": 8920,
      "totalProfitLoss": 420,
      "totalProfitLossPercent": 4.94
    }
  }
}
```

---

### 3. 종목 상세 조회

**GET** `/api/infinite-buy/stocks/:id`

#### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": "clx1234567890",
    "ticker": "AAPL",
    "name": "Apple Inc.",
    "exchange": "NAS",
    "status": "buying",
    "buyAmount": 100,
    "totalRounds": 40,
    "targetProfit": 10,
    "currentRound": 12,
    "totalInvested": 1200,
    "totalQuantity": 6.45,
    "avgPrice": 185.30,
    "targetPrice": 203.83,
    "currentPrice": 178.50,
    "currentValue": 1156.33,
    "profitLoss": -43.67,
    "profitLossPercent": -3.64,
    "priceChangePercent": 1.2,
    "autoEnabled": true,
    "buyTime": "09:30",
    "buyCondition": "daily",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-15T09:30:00.000Z"
  }
}
```

---

### 4. 종목 설정 수정

**PUT** `/api/infinite-buy/stocks/:id`

#### Request Body
```json
{
  "buyAmount": 150,
  "targetProfit": 15,
  "autoEnabled": false,
  "buyTime": "10:00",
  "buyCondition": "weekly"
}
```

#### Response (200 OK)
```json
{
  "success": true,
  "data": { /* 업데이트된 종목 정보 */ },
  "message": "설정이 업데이트되었습니다"
}
```

---

### 5. 종목 삭제

**DELETE** `/api/infinite-buy/stocks/:id`

#### Response (200 OK)
```json
{
  "success": true,
  "message": "종목이 삭제되었습니다"
}
```

---

### 6. 수동 매수 실행

**POST** `/api/infinite-buy/stocks/:id/buy`

#### Request Body (선택)
```json
{
  "amount": 100,
  "price": null
}
```
- `amount`: 매수 금액 (기본값: 설정된 buyAmount)
- `price`: 지정가 (null이면 현재가로 시장가 주문)

#### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "record": {
      "id": "rec123",
      "type": "buy",
      "round": 13,
      "price": 178.50,
      "quantity": 0.56,
      "amount": 100,
      "executedAt": "2024-01-15T09:30:00.000Z"
    },
    "stock": {
      "currentRound": 13,
      "totalInvested": 1300,
      "totalQuantity": 7.01,
      "avgPrice": 185.45
    }
  },
  "message": "13회차 매수가 완료되었습니다"
}
```

---

### 7. 익절 (전량 매도)

**POST** `/api/infinite-buy/stocks/:id/sell`

#### Request Body (선택)
```json
{
  "price": null,
  "quantity": null
}
```
- `price`: 지정가 (null이면 현재가로 시장가 주문)
- `quantity`: 매도 수량 (null이면 전량 매도)

#### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "record": {
      "id": "rec124",
      "type": "sell",
      "price": 205.00,
      "quantity": 7.01,
      "amount": 1437.05,
      "profit": 137.05,
      "profitPercent": 10.54,
      "executedAt": "2024-01-20T10:00:00.000Z"
    },
    "stock": {
      "status": "completed",
      "completedAt": "2024-01-20T10:00:00.000Z"
    }
  },
  "message": "익절이 완료되었습니다. 수익: +$137.05 (+10.54%)"
}
```

---

### 8. 종목 중단/재개

**POST** `/api/infinite-buy/stocks/:id/stop`

#### Response (200 OK)
```json
{
  "success": true,
  "data": { "status": "stopped" },
  "message": "종목이 중단되었습니다"
}
```

**POST** `/api/infinite-buy/stocks/:id/resume`

#### Response (200 OK)
```json
{
  "success": true,
  "data": { "status": "buying" },
  "message": "종목이 재개되었습니다"
}
```

---

### 9. 매수 기록 조회

**GET** `/api/infinite-buy/stocks/:id/records`

#### Query Parameters
| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| type | string | N | 거래 유형 (buy, sell) |
| limit | number | N | 조회 개수 (기본: 50) |

#### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "records": [
      {
        "id": "rec123",
        "type": "buy",
        "round": 12,
        "price": 178.50,
        "quantity": 0.56,
        "amount": 100,
        "cumulative": 1200,
        "executedAt": "2024-01-15T09:30:00.000Z"
      }
    ],
    "total": 12
  }
}
```

---

### 10. 전체 매수/매도 기록 조회 (히스토리)

**GET** `/api/infinite-buy/history`

#### Query Parameters
| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| ticker | string | N | 티커 필터 |
| type | string | N | 거래 유형 (buy, sell) |
| startDate | string | N | 시작 날짜 (YYYY-MM-DD) |
| endDate | string | N | 종료 날짜 (YYYY-MM-DD) |
| limit | number | N | 조회 개수 (기본: 100) |
| offset | number | N | 오프셋 (기본: 0) |

#### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "records": [
      {
        "id": "rec123",
        "stockId": "clx123",
        "ticker": "AAPL",
        "name": "Apple Inc.",
        "type": "buy",
        "round": 12,
        "price": 178.50,
        "quantity": 0.56,
        "amount": 100,
        "profit": null,
        "profitPercent": null,
        "executedAt": "2024-01-15T09:30:00.000Z"
      }
    ],
    "total": 150,
    "summary": {
      "totalBuys": 120,
      "totalSells": 30,
      "totalBuyAmount": 12000,
      "totalSellAmount": 15000,
      "realizedProfit": 3000
    }
  }
}
```

---

### 11. 오늘의 매수 예정 조회

**GET** `/api/infinite-buy/today`

#### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "scheduledBuys": [
      {
        "stockId": "clx123",
        "ticker": "AAPL",
        "name": "Apple Inc.",
        "nextRound": 13,
        "amount": 100,
        "scheduledTime": "09:30",
        "condition": "daily"
      }
    ],
    "totalAmount": 300
  }
}
```

---

### 12. 대시보드 요약 정보

**GET** `/api/infinite-buy/summary`

#### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "totalStocks": 5,
    "buyingCount": 3,
    "completedCount": 1,
    "stoppedCount": 1,
    "totalInvested": 8500,
    "totalValue": 8920,
    "totalProfitLoss": 420,
    "totalProfitLossPercent": 4.94,
    "realizedProfit": 1500,
    "todayScheduledBuys": 3,
    "todayScheduledAmount": 300
  }
}
```

---

## 에러 코드

| 코드 | HTTP Status | 설명 |
|------|-------------|------|
| STOCK_NOT_FOUND | 404 | 종목을 찾을 수 없음 |
| STOCK_ALREADY_EXISTS | 409 | 이미 등록된 종목 |
| INVALID_TICKER | 400 | 유효하지 않은 티커 |
| KIS_NOT_CONNECTED | 400 | 한투 API 연결 안됨 |
| INSUFFICIENT_BALANCE | 400 | 잔고 부족 |
| ORDER_FAILED | 500 | 주문 실패 |
| ALREADY_COMPLETED | 400 | 이미 익절 완료된 종목 |
| ALREADY_STOPPED | 400 | 이미 중단된 종목 |

---

## 구현 파일 구조

```
src/
├── routes/
│   └── infinite-buy.ts          # 라우트 정의
├── controllers/
│   └── infinite-buy.controller.ts  # 컨트롤러
├── services/
│   └── infinite-buy.service.ts     # 비즈니스 로직
└── types/
    └── infinite-buy.ts          # 타입 정의
```

---

## 프론트엔드 API 함수 (lib/api.ts에 추가)

```typescript
// ============ 무한매수 API ============

// 종목 목록 조회
export const getInfiniteBuyStocks = async (status?: string) => {
  const url = status
    ? `${API_BASE_URL}/api/infinite-buy/stocks?status=${status}`
    : `${API_BASE_URL}/api/infinite-buy/stocks`;
  const response = await fetch(url, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error('Failed to fetch stocks');
  return (await response.json()).data;
};

// 종목 상세 조회
export const getInfiniteBuyStock = async (id: string) => {
  const response = await fetch(`${API_BASE_URL}/api/infinite-buy/stocks/${id}`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to fetch stock');
  return (await response.json()).data;
};

// 종목 생성
export const createInfiniteBuyStock = async (data: CreateInfiniteBuyRequest) => {
  const response = await fetch(`${API_BASE_URL}/api/infinite-buy/stocks`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error('Failed to create stock');
  return (await response.json()).data;
};

// 종목 삭제
export const deleteInfiniteBuyStock = async (id: string) => {
  const response = await fetch(`${API_BASE_URL}/api/infinite-buy/stocks/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to delete stock');
  return true;
};

// 수동 매수
export const buyInfiniteBuyStock = async (id: string, amount?: number) => {
  const response = await fetch(`${API_BASE_URL}/api/infinite-buy/stocks/${id}/buy`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ amount }),
  });
  if (!response.ok) throw new Error('Failed to buy');
  return (await response.json()).data;
};

// 익절 (전량 매도)
export const sellInfiniteBuyStock = async (id: string) => {
  const response = await fetch(`${API_BASE_URL}/api/infinite-buy/stocks/${id}/sell`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to sell');
  return (await response.json()).data;
};

// 종목 중단
export const stopInfiniteBuyStock = async (id: string) => {
  const response = await fetch(`${API_BASE_URL}/api/infinite-buy/stocks/${id}/stop`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to stop');
  return (await response.json()).data;
};

// 종목 재개
export const resumeInfiniteBuyStock = async (id: string) => {
  const response = await fetch(`${API_BASE_URL}/api/infinite-buy/stocks/${id}/resume`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to resume');
  return (await response.json()).data;
};

// 매수 기록 조회
export const getInfiniteBuyRecords = async (id: string) => {
  const response = await fetch(`${API_BASE_URL}/api/infinite-buy/stocks/${id}/records`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to fetch records');
  return (await response.json()).data;
};

// 전체 히스토리 조회
export const getInfiniteBuyHistory = async (params?: {
  ticker?: string;
  type?: 'buy' | 'sell';
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}) => {
  const query = new URLSearchParams();
  if (params?.ticker) query.append('ticker', params.ticker);
  if (params?.type) query.append('type', params.type);
  if (params?.startDate) query.append('startDate', params.startDate);
  if (params?.endDate) query.append('endDate', params.endDate);
  if (params?.limit) query.append('limit', params.limit.toString());
  if (params?.offset) query.append('offset', params.offset.toString());

  const response = await fetch(`${API_BASE_URL}/api/infinite-buy/history?${query}`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to fetch history');
  return (await response.json()).data;
};

// 대시보드 요약
export const getInfiniteBuySummary = async () => {
  const response = await fetch(`${API_BASE_URL}/api/infinite-buy/summary`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to fetch summary');
  return (await response.json()).data;
};

// 오늘의 매수 예정
export const getInfiniteBuyToday = async () => {
  const response = await fetch(`${API_BASE_URL}/api/infinite-buy/today`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to fetch today');
  return (await response.json()).data;
};
```

---

## 타입 정의

```typescript
// types/infinite-buy.ts

export interface InfiniteBuyStock {
  id: string;
  ticker: string;
  name: string;
  exchange: string;
  status: 'buying' | 'completed' | 'stopped';
  buyAmount: number;
  totalRounds: number;
  targetProfit: number;
  currentRound: number;
  totalInvested: number;
  totalQuantity: number;
  avgPrice: number;
  targetPrice: number;
  currentPrice?: number;
  currentValue?: number;
  profitLoss?: number;
  profitLossPercent?: number;
  priceChangePercent?: number;
  autoEnabled: boolean;
  buyTime?: string;
  buyCondition: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface InfiniteBuyRecord {
  id: string;
  stockId: string;
  ticker?: string;
  name?: string;
  type: 'buy' | 'sell';
  round?: number;
  price: number;
  quantity: number;
  amount: number;
  profit?: number;
  profitPercent?: number;
  cumulative?: number;
  executedAt: string;
}

export interface CreateInfiniteBuyRequest {
  ticker: string;
  name: string;
  exchange?: string;
  buyAmount: number;
  totalRounds?: number;
  targetProfit?: number;
  autoEnabled?: boolean;
  buyTime?: string;
  buyCondition?: string;
  autoStart?: boolean;
}

export interface InfiniteBuySummary {
  totalStocks: number;
  buyingCount: number;
  completedCount: number;
  stoppedCount: number;
  totalInvested: number;
  totalValue: number;
  totalProfitLoss: number;
  totalProfitLossPercent: number;
  realizedProfit: number;
  todayScheduledBuys: number;
  todayScheduledAmount: number;
}
```
