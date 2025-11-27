# AWS ECR + App Runner 배포 가이드

## 사전 준비

1. **AWS CLI 설치**: https://aws.amazon.com/cli/
2. **Docker Desktop 설치**: https://www.docker.com/products/docker-desktop/

## 1단계: AWS CLI 설정

```bash
aws configure
```
- AWS Access Key ID: [your-access-key]
- AWS Secret Access Key: [your-secret-key]
- Default region: ap-northeast-2
- Default output format: json

## 2단계: ECR 레포지토리 생성

```bash
# ECR 레포지토리 생성
aws ecr create-repository \
  --repository-name grid-transaction-backend \
  --region ap-northeast-2
```

## 3단계: Docker 이미지 빌드 및 푸시

```bash
# ECR 로그인
aws ecr get-login-password --region ap-northeast-2 | docker login --username AWS --password-stdin [YOUR_AWS_ACCOUNT_ID].dkr.ecr.ap-northeast-2.amazonaws.com

# Docker 이미지 빌드
docker build -t grid-transaction-backend .

# 이미지 태그
docker tag grid-transaction-backend:latest [YOUR_AWS_ACCOUNT_ID].dkr.ecr.ap-northeast-2.amazonaws.com/grid-transaction-backend:latest

# ECR에 푸시
docker push [YOUR_AWS_ACCOUNT_ID].dkr.ecr.ap-northeast-2.amazonaws.com/grid-transaction-backend:latest
```

> **참고**: `[YOUR_AWS_ACCOUNT_ID]`는 12자리 AWS 계정 ID로 교체하세요.
> 확인 방법: `aws sts get-caller-identity --query Account --output text`

## 4단계: App Runner 서비스 생성

### AWS 콘솔에서 생성

1. AWS Console → App Runner 접속
2. **Create service** 클릭
3. **Source**: Container registry → Amazon ECR
4. **Container image URI**: 위에서 푸시한 이미지 URI 선택
5. **ECR access role**: Create new service role (자동)

### 서비스 설정

- **Service name**: grid-transaction-backend
- **CPU**: 1 vCPU
- **Memory**: 2 GB
- **Port**: 3010

### 환경 변수 설정 (중요!)

| Key | Value |
|-----|-------|
| `DATABASE_URL` | mysql://dbmasteruser:Ok2010ok!!@ls-1ec41c8ce559af427653b60e97baaa3f70f60df3.c0zy4csz1exi.ap-northeast-2.rds.amazonaws.com:3306/grid_transaction?charset=utf8mb4 |
| `NODE_ENV` | production |
| `PORT` | 3010 |
| `JWT_SECRET` | 7trYeHeuSTnOev+Guqzu6zYKyFO8PqjLIOhm/qjUXl0= |
| `JWT_ACCESS_EXPIRY` | 1h |
| `JWT_REFRESH_EXPIRY` | 7d |
| `CORS_ORIGIN` | https://your-frontend-domain.com |
| `ENCRYPTION_KEY` | (32바이트 랜덤 키 생성 필요) |

### Health Check 설정

- **Protocol**: HTTP
- **Path**: /api/health
- **Interval**: 10 seconds
- **Timeout**: 5 seconds

## 5단계: 배포 확인

App Runner 서비스가 생성되면 자동으로 URL이 발급됩니다:
```
https://xxxxxxxx.ap-northeast-2.awsapprunner.com
```

Health check 확인:
```bash
curl https://xxxxxxxx.ap-northeast-2.awsapprunner.com/api/health
```

## 자동 배포 설정 (선택)

ECR에 새 이미지가 푸시되면 자동 배포하려면:
1. App Runner 서비스 설정 → Deployment settings
2. **Deployment trigger**: Automatic

## 비용 참고

- **App Runner**: 사용한 만큼만 과금 (vCPU-시간, GB-시간)
- **ECR**: 스토리지 GB당 $0.10/월
- 프리티어: 첫 12개월간 일정량 무료

## 문제 해결

### RDS 연결 오류
App Runner와 RDS가 같은 VPC에 있어야 합니다.
- App Runner → Networking → Custom VPC 선택
- RDS 보안 그룹에서 App Runner의 보안 그룹 인바운드 허용

### Prisma 마이그레이션
프로덕션 DB 마이그레이션:
```bash
npx prisma migrate deploy
```
