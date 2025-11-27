# Grid Trading Bot Backend

Express + TypeScript + Prisma + MySQL 기반 그리드 트레이딩 봇 백엔드 API

## 기술 스택

- **Runtime**: Node.js
- **Framework**: Express.js
- **Language**: TypeScript
- **ORM**: Prisma
- **Database**: MySQL (AWS RDS)
- **Authentication**: JWT
- **Encryption**: AES-256-GCM
- **Password Hashing**: bcrypt

## 프로젝트 구조

```
src/
├── config/          # 설정 파일
│   ├── database.ts  # Prisma 클라이언트
│   └── env.ts       # 환경변수 설정
├── controllers/     # 컨트롤러
│   ├── auth.controller.ts
│   ├── bot.controller.ts
│   ├── credential.controller.ts
│   └── exchange.controller.ts
├── middlewares/     # 미들웨어
│   ├── auth.ts      # JWT 인증 미들웨어
│   └── errorHandler.ts  # 에러 핸들러
├── routes/          # 라우트
│   ├── auth.ts
│   ├── bots.ts
│   ├── credentials.ts
│   ├── exchange.ts
│   └── index.ts
├── types/           # TypeScript 타입 정의
│   └── index.ts
├── utils/           # 유틸리티 함수
│   ├── encryption.ts
│   └── response.ts
├── app.ts           # Express 앱 설정
└── index.ts         # 서버 엔트리 포인트
```

## 시작하기

### 1. 환경변수 설정

`.env` 파일이 이미 구성되어 있습니다.

### 2. Prisma 설정

```bash
# Prisma Client 생성
npm run prisma:generate

# 데이터베이스 마이그레이션
npm run prisma:migrate

# Prisma Studio 실행 (데이터베이스 GUI)
npm run prisma:studio
```

### 3. 개발 서버 실행

```bash
# 개발 모드 (hot reload)
npm run dev

# 빌드
npm run build

# 프로덕션 모드
npm start
```

## API 엔드포인트

### Base URL
```
http://localhost:3010/api
```

### 1. 인증 (Authentication)

#### POST /api/auth/register
사용자 회원가입

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "securePassword123",
  "name": "홍길동"
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "회원가입이 완료되었습니다",
  "data": {
    "userId": 1,
    "email": "user@example.com",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

#### POST /api/auth/login
사용자 로그인

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "securePassword123"
}
```

#### POST /api/auth/logout
사용자 로그아웃 (인증 필요)

### 2. 봇 관리 (Bot Management)

#### POST /api/bots
새로운 그리드 봇 생성 (인증 필요)

**Request Body:**
```json
{
  "exchange": "upbit",
  "ticker": "KRW-BTC",
  "lowerPrice": 50000000,
  "upperPrice": 70000000,
  "priceChangePercent": 2,
  "orderAmount": 10000,
  "stopAtMax": false,
  "autoStart": true
}
```

#### GET /api/bots
모든 봇 조회 (인증 필요)

**Query Parameters:**
- `status` (optional): "running" | "stopped" | "error"
- `exchange` (optional): "upbit" | "binance"

#### GET /api/bots/:id
특정 봇 상세 조회 (인증 필요)

#### PUT /api/bots/:id
봇 설정 수정 (인증 필요)

#### POST /api/bots/:id/start
봇 시작 (인증 필요)

#### POST /api/bots/:id/stop
봇 중지 (인증 필요)

#### DELETE /api/bots/:id
봇 삭제 (인증 필요)

#### GET /api/bots/:id/grid-levels
그리드 레벨 조회 (인증 필요)

#### GET /api/bots/:id/trades
거래 내역 조회 (인증 필요)

#### GET /api/bots/:id/performance
봇 성과 통계 조회 (인증 필요)

### 3. 거래소 연동 (Exchange)

#### GET /api/exchange/tickers/:exchange
거래소 티커 목록 조회 (인증 필요)

#### GET /api/exchange/price/:exchange/:ticker
현재 가격 조회 (인증 필요)

#### POST /api/exchange/validate-credentials
API 인증 정보 검증 (인증 필요)

### 4. 인증 정보 관리 (Credentials)

#### POST /api/credentials
거래소 API 인증 정보 저장 (인증 필요)

**Request Body:**
```json
{
  "exchange": "upbit",
  "apiKey": "user-api-key",
  "secretKey": "user-secret-key",
  "ipWhitelist": "123.456.789.0"
}
```

#### GET /api/credentials
저장된 인증 정보 목록 조회 (인증 필요)

#### GET /api/credentials/:exchange
특정 거래소 인증 정보 조회 (인증 필요)

#### PUT /api/credentials/:exchange
인증 정보 수정 (인증 필요)

#### DELETE /api/credentials/:exchange
인증 정보 삭제 (인증 필요)

## 데이터베이스 모델

### User
- 사용자 기본 정보
- 이메일, 비밀번호(bcrypt 해싱), 이름

### Bot
- 그리드 트레이딩 봇 설정
- 거래소, 티커, 가격 범위, 그리드 설정, 상태, 통계

### GridLevel
- 그리드 레벨 정보
- 가격, 타입(buy/sell), 상태, 주문 ID

### Trade
- 거래 내역
- 타입, 가격, 수량, 수익, 실행 시간

### Credential
- 거래소 API 인증 정보 (AES-256 암호화)
- API 키, 시크릿 키, IP 화이트리스트

## 보안

- **JWT 인증**: Bearer 토큰 방식
- **비밀번호 해싱**: bcrypt (salt rounds: 10)
- **API 키 암호화**: AES-256-GCM
- **CORS**: 프론트엔드 포트(3009) 허용
- **에러 처리**: 표준화된 에러 응답

## 스크립트

- `npm run dev` - 개발 서버 실행 (hot reload)
- `npm run build` - TypeScript 빌드
- `npm start` - 프로덕션 서버 실행
- `npm run prisma:generate` - Prisma Client 생성
- `npm run prisma:migrate` - 데이터베이스 마이그레이션
- `npm run prisma:studio` - Prisma Studio 실행

## 환경변수

`.env` 파일 참조:
- `DATABASE_URL`: MySQL 연결 URL
- `PORT`: 서버 포트 (기본값: 3010)
- `JWT_SECRET`: JWT 시크릿 키
- `AWS_*`: AWS S3 설정 (선택사항)

## 다음 단계

1. 실제 거래소 API 연동 (Upbit, Binance)
2. 그리드 트레이딩 엔진 구현
3. 백그라운드 작업 스케줄러
4. WebSocket 실시간 통신
5. 로깅 시스템 (Winston)
6. 단위 테스트 작성
