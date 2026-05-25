---
template_id: evolve_proposal
owner_agent: barrotrade-code-surgeon
evolve_id: "{{evolve_id}}"
recap_id: "{{recap_id}}"
target_project: "/Users/beye/workspace/BarroAiTrade"
target_files:
  - "{{file_1}}"
  - "{{file_2}}"
fields_changed: 0
applied_via: "policy_config|strategy_dataclass"
hitl_status: "pending|approved|rejected|expired"
patch_file: "patch.diff"
created_at: "{{ts_utc}}"
expires_at_utc: "{{ts_plus_24h}}"
---

# Evolve Proposal — {{evolve_id}}

> ⚠️ 본 제안은 dataclass 의 숫자 필드 default 만 변경합니다. 함수 로직·조건문·필드 추가/삭제 일체 포함되지 않습니다.
> 적용은 사용자 명시 승인 후 수동 `git apply` 로만 가능합니다.

## 1. 변경 요약

| 필드 | 파일 | 현재값 | 제안값 | Δ |
|------|------|--------|--------|---|
| {{field_1}} | {{file}} | {{old}} | {{new}} | {{±X.XX}}% |
| {{field_2}} | {{file}} | {{old}} | {{new}} | {{±X.XX}}% |

## 2. 변경 근거

### 필드 1: `{{ClassName}}.{{field_1}}`

**파일**: `{{path}}` (line {{N}})

**현재값**: `{{old_value}}`
**제안값**: `{{new_value}}` (Δ {{±X.XX}}%)

**근거 데이터** (직전 30 거래일):
- 손실 사이클 {{N}}건 중 {{M}}건이 이 필드와 연관
- 평균 손실폭: {{X.XX}}%
- 현재값으로 진입한 사이클의 PnL 평균: {{X.XX}}%
- 제안값 simulation (`scripts/_strategy_perf_track.py` 회귀 백테스트): PnL {{기대 향상}}

**근거 인용** ({{recap_id}}/recap.md 의 §5 권고):
> {{recap.md 의 권고 영역 1~3 줄 직접 인용}}

**예상 영향**:
- 신호 발생 빈도: {{현재 N/day → 예상 M/day}}
- 평균 win rate: {{현재 X% → 예상 Y%}}
- 평균 loss rate: {{...}}

**위험**:
- 과학습 가능성: {{low|medium|high}} — 사유: {{...}}
- 결합 효과 (동일 dataclass 다른 필드와): {{...}}
- 단일 사이클 outlier 영향 배제: {{30일 rolling window 사용 검증}}

### 필드 2: ...

(각 필드별 동일 구조 반복)

## 3. 변경 폭 검증 (Code-Surgeon Self-Check)

| 검증 | 결과 |
|------|------|
| `max_relative_change_pct: 25` 이내 | ✓ |
| 동일 필드 주당 ≤ 3회 변경 | ✓ ({{N}}회) |
| 30일 누적 변경 ≤ 50% | ✓ ({{X.XX}}%) |
| 함수 로직 변경 없음 (AST 검증) | ✓ |
| 새 필드 추가/삭제 없음 | ✓ |
| 타입 어노테이션 변경 없음 | ✓ |
| `import` 변경 없음 | ✓ |
| 적용 경로 (policy_config 우선) | {{policy_config|strategy_dataclass}} |

## 4. 패치 파일

**위치**: `workspace/_evolve/{{evolve_id}}/patch.diff`

미리보기:

```diff
diff --git a/backend/core/journal/policy_config.py b/backend/core/journal/policy_config.py
--- a/backend/core/journal/policy_config.py
+++ b/backend/core/journal/policy_config.py
@@ -N,X +N,X @@ class PolicyConfig:
-    {{field}}: float = {{old}}
+    {{field}}: float = {{new}}
```

## 5. 적용 절차 (HITL)

### Step 1: 검토

```bash
cat /Users/beye/workspace/BarroSkills/.claude/skills/barrotrade/workspace/_evolve/{{evolve_id}}/proposal.md
git -C /Users/beye/workspace/BarroAiTrade status
```

### Step 2: 백업

```bash
cd /Users/beye/workspace/BarroAiTrade
cp data/policy.json data/policy.json.bak.$(date +%s)
```

### Step 3: 패치 적용

```bash
git apply /Users/beye/workspace/BarroSkills/.claude/skills/barrotrade/workspace/_evolve/{{evolve_id}}/patch.diff
git diff --stat
```

### Step 4: 테스트

```bash
# 가능하면 strategy 테스트만이라도
pytest backend/tests/strategy/test_{{strategy}}.py -v

# 또는 daily pipeline regression
pytest backend/tests/test_daily_pipeline.py -v
```

### Step 5: Runtime 반영 (PolicyConfig 변경 시)

```bash
# BarroAiTrade 의 /tune apply (CLI 또는 API endpoint) 호출
# 자세한 사용법은 BarroAiTrade RUNBOOK 참조
```

### Step 6: 적용 확인

```bash
# 신규 commit (선택)
git add backend/core/journal/policy_config.py
git commit -m "tune: {{ClassName}}.{{field_1}} {{old}} → {{new}}

근거: {{recap_id}} intraday recap, 손실 사이클 {{N}}건 공통 패턴
관련: BarroTrade evolve {{evolve_id}}"

# audit log 업데이트
/barrotrade evolve-ack {{evolve_id}} --status applied --commit-hash <sha>
```

## 6. 거부 시

```bash
/barrotrade evolve-ack {{evolve_id}} --status rejected --reason "..."
```

24h 무응답 시 자동 expired. 다음 evolve 사이클은 expired 처리 후에만 진입 가능.

## 7. 롤백 (적용 후 문제 발생 시)

### 즉시 롤백 (git)

```bash
cd /Users/beye/workspace/BarroAiTrade
git revert HEAD
```

### policy.json 만 롤백

```bash
ls -t data/policy.json.bak.* | head -1 | xargs -I {} cp {} data/policy.json
# /tune apply 재호출
```

## 8. 알림

- ✉️ telegram: {{전송 여부}}
- ✉️ email: {{전송 여부}}
- 알림 시각: {{ts}}

## 9. 감사 로그 라인

```json
{
  "ts_utc": "{{ts_utc}}",
  "evolve_id": "{{evolve_id}}",
  "recap_id": "{{recap_id}}",
  "target_file": "{{file}}",
  "target_class": "{{ClassName}}",
  "field_name": "{{field}}",
  "old_value": {{old}},
  "new_value": {{new}},
  "relative_change_pct": {{Δ}},
  "rationale_summary": "{{1줄 요약}}",
  "applied_via": "{{policy_config|strategy_dataclass}}",
  "hitl_status": "pending",
  "prev_hash": "{{sha256}}",
  "hash": "{{sha256}}"
}
```

`logs/audit/code-evolution-{{date}}.jsonl` 에 append (append-only, hash chain).
