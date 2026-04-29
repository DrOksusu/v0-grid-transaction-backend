# Path C — 배포 전 Lightsail DB 자동 스냅샷 (구현 계획)

> 작성일: 2026-04-29 KST
> 관련 메모: project_resume_next_session.md § Path B(자동 스냅샷 CI), project_pr_e2_complete_2026_04_29.md § Path C

## 목적

GitHub Actions 워크플로우(`deploy.yml`)에서 main push 시 Docker 빌드 직전에 Lightsail DB(`Grid-bot-DB-v2`) 스냅샷을 자동 생성한다. PR D 같은 production 사고 발생 시 1-click 롤백 가능하도록.

## 변경 사항

### 1. `.github/workflows/deploy.yml`

`Configure AWS credentials (OIDC)` 다음, `Login to Amazon ECR` 직전에 새 step 추가:

```yaml
- name: Pre-deploy Lightsail DB snapshot
  id: snapshot
  run: |
    SNAP="pre-deploy-${GITHUB_SHA:0:8}-$(date -u +%Y%m%d-%H%M%S)"
    echo "Creating snapshot: $SNAP"
    aws lightsail create-relational-database-snapshot \
      --region ap-northeast-2 \
      --relational-database-name Grid-bot-DB-v2 \
      --relational-database-snapshot-name "$SNAP"
    echo "snapshot_name=$SNAP" >> $GITHUB_OUTPUT
    echo "스냅샷 요청 완료(비동기). 가용 상태가 되기까지 수 분 소요됨."
```

핵심 포인트:
- **`--region ap-northeast-2` 명시 필수**. 워크플로우 `env.AWS_REGION`은 `ap-northeast-1`(도쿄, ECR)이지만 Lightsail DB는 `ap-northeast-2`(서울)에 위치
- 비동기 호출 — 워크플로우는 API 요청만 보내고 return. 실제 스냅샷 가용까지 수 분 소요(보통 ~3분)
- 스냅샷 이름: `pre-deploy-<commit_sha 8자>-<UTC YYYYMMDD-HHMMSS>` (예: `pre-deploy-42e713db-20260429-141500`)

### 2. AWS IAM 정책 추가 (콘솔 작업)

대상 role: `github-actions-ecr-deploy` (account 827899252497)

추가할 inline 정책 (이름 권장: `LightsailSnapshotForDeploy`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LightsailSnapshotForDeploy",
      "Effect": "Allow",
      "Action": [
        "lightsail:CreateRelationalDatabaseSnapshot",
        "lightsail:GetRelationalDatabases",
        "lightsail:GetRelationalDatabaseSnapshot",
        "lightsail:GetRelationalDatabaseSnapshots"
      ],
      "Resource": "*"
    }
  ]
}
```

`Resource: *`인 이유: Lightsail은 ARN 단위 IAM 제어 지원이 제한적(서비스별 차이 있음). 추후 더 좁히려면 `arn:aws:lightsail:ap-northeast-2:827899252497:RelationalDatabase/<UUID>` 형태로 시도해볼 수 있음.

JSON 파일도 별도로 제공: `docs/superpowers/plans/2026-04-29-path-c-iam-policy.json`

## 사용자 콘솔 작업 절차

> 현재 세션의 AWS CLI 자격증명(`tstory-s3-uploader`)에 IAM 변경 권한이 없어 CLI로 진행 불가. 콘솔에서 직접 진행 필요.

1. AWS Console 로그인 → 계정 `827899252497`
2. IAM → Roles → `github-actions-ecr-deploy` 검색 → 클릭
3. **Permissions** 탭 → **Add permissions** → **Create inline policy**
4. JSON 탭 선택 → 위 JSON 붙여넣기
5. **Next** → 정책 이름: `LightsailSnapshotForDeploy` → **Create policy**

## 검증 절차

IAM 정책 적용 후:

1. `v0-grid-tranasction-backend` 브랜치에서 deploy.yml 변경 사항 commit + main push (또는 PR 머지)
2. GitHub Actions 워크플로우 실행 모니터링:
   - `gh run list --limit 1 --repo DrOksusu/v0-grid-transaction-backend`
   - `gh run view <run-id> --log` 또는 웹 UI에서 "Pre-deploy Lightsail DB snapshot" step 확인
3. AWS Console → Lightsail → Snapshots 탭에서 새 스냅샷 `pre-deploy-XXXX-YYYYMMDD-HHMMSS` 확인 (ap-northeast-2 region)
4. 스냅샷이 "Available" 상태로 전환되는지 확인 (보통 3-5분 소요)

## 실패 시 대응

### 권한 부족 (AccessDeniedException)
→ IAM 정책이 적용 안 됐거나 trust policy 변경 필요. 메시지에 "not authorized to perform: lightsail:..." 포함되면 정책 미적용 가능성 높음.

### 스냅샷 이름 충돌 (already exists)
→ 같은 commit으로 재배포 + 같은 분에 push될 때 발생 가능. 현재 이름 패턴(`commit_sha:0:8 + 초 단위`)으로는 거의 안 일어남. 발생 시 워크플로우 fail-fast → 사용자가 수동 재시도.

### Lightsail throttling
→ 짧은 시간에 다수 push 시 발생 가능. 현재 단일 DB라 거의 안 일어남.

## 향후 개선 후보 (이번 PR에는 포함 안 함)

- (a) 스냅샷 가용까지 wait (배포 실패 시 즉시 롤백 가능 보장)
- (b) 30일 이상 된 스냅샷 자동 삭제 (비용 절약)
- (c) ECR도 같은 region(`ap-northeast-2`)으로 통합 후 region env 단순화
- (d) Slack/Gmail 알림 (스냅샷 생성/실패 시)

## 연관 PR

이번 변경 = Path C 첫 단계. Path A(canary stage 2) 시작 전에 적용 권장.

## 파일 목록

- `v0-grid-tranasction-backend/.github/workflows/deploy.yml` — 수정 (snapshot step 추가)
- `v0-grid-tranasction-backend/docs/superpowers/plans/2026-04-29-path-c-iam-policy.json` — IAM 정책 JSON
- `v0-grid-tranasction-backend/docs/superpowers/plans/2026-04-29-path-c-deploy-snapshot.md` — 본 문서
