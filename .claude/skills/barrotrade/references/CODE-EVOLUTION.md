# Code Evolution Policy — 자가 진화 안전 규약

본 문서는 BarroTrade 의 자가 진화 기능 (`/barrotrade evolve`) 의 변경 범위·검증·HITL·롤백 절차를 정의합니다. 정책은 [`../config/barroaitrade-bridge.json`](../config/barroaitrade-bridge.json) 의 `code_evolution_policy` 섹션에서 선언됩니다.

> ⚠️ **본 스킬은 BarroAiTrade 코드를 직접 수정하지 않습니다.** patch.diff 파일만 생성하고, `git apply` 는 사용자가 수동으로 실행합니다.

---

## 1. 변경 범위 (Strict Whitelist)

### 허용되는 변경

| 카테고리 | 예시 |
|----------|------|
| `@dataclass` 의 `float` 필드 default | `impulse_min_gain_pct: float = 0.03` → `0.04` |
| `@dataclass` 의 `int` 필드 default | `lookback_days: int = 20` → `25` |
| `policy_config.py` 의 `PolicyConfig` 필드 | `min_score: float = 0.5` → `0.55` |

### 절대 금지

- 함수 body 수정
- 조건문 분기 추가/삭제 (`if/else/elif`)
- 새 필드 추가
- 필드 이름 변경
- 타입 어노테이션 변경 (`float → int` 도 금지)
- `import` 문 변경
- 클래스 상속 구조 변경
- 문자열·튜플·리스트 default 변경 (`["a", "b"]` → `["a", "b", "c"]` 도 금지)

위반 시 `code-surgeon` 이 patch 생성을 거부하고 evolve 사이클을 abort.

---

## 2. AST 기반 자동 검증

`barrotrade-code-surgeon` 는 patch 생성 전 다음 검증을 수행:

```python
import ast

def is_safe_change(file_path, field_name, new_value):
    src = Path(file_path).read_text()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for stmt in node.body:
                if isinstance(stmt, ast.AnnAssign) and getattr(stmt.target, "id", None) == field_name:
                    # 필드의 어노테이션 타입과 new_value 타입 일치하는지
                    # default 가 ast.Constant 인지 (복합 표현식 금지)
                    return (
                        isinstance(stmt.value, ast.Constant)
                        and type(stmt.value.value) in {int, float}
                        and type(new_value) is type(stmt.value.value)
                    )
    return False
```

검증 통과 시에만 unified diff 생성.

---

## 3. 변경 폭 한도

```json
{
  "max_relative_change_pct": 25,
  "max_absolute_change_per_field_per_week": 3
}
```

- **25% 룰**: `old_value` 대비 `new_value` 변화율이 ±25% 초과 시 즉시 거부
  - 예: `0.03` → `0.04` (Δ +33%) 는 **거부**. `0.0375` (Δ +25%) 까지만 허용.
- **주당 3회 룰**: 동일 필드의 변경 이력이 직전 7일 내 3건 이상이면 추가 변경 거부 (overfitting 방지)
- **30일 누적 보호**: 한 필드가 30일 내 누적 50% 이상 변경되면 frozen 상태로 lock

---

## 4. HITL 강제 (Auto Apply = 0)

```json
{
  "hitl_policy": {
    "auto_apply_threshold_pct": 0
  }
}
```

**모든 변경은 사용자 명시 승인 필수.** 자동 적용 비활성.

### 승인 흐름

```
[evolve 모드 실행]
    │
    ▼
[workspace/_evolve/<id>/proposal.md + patch.diff 생성]
    │
    ▼
[사용자에게 알림: telegram + email]
    │
    ▼
[사용자가 proposal.md 검토]
    │
    ├─ 거부 → evolve-ack <id> --status rejected --reason "..."
    │
    └─ 수락 → 다음 단계:
            1. cp data/policy.json data/policy.json.bak.$(date +%s)
            2. cd /Users/beye/workspace/BarroAiTrade && git apply <patch>
            3. /barrotrade evolve-ack <id> --status applied --commit-hash <sha>
```

24h 미응답 시 `pending → expired` 자동 전환, audit log ALERT.

---

## 5. policy_config.py 우선 경로 (BAR-OPS-31)

BarroAiTrade 는 이미 BAR-OPS-31 로 정책 영속화 + runtime apply 인프라가 있습니다:

```python
# backend/core/journal/policy_config.py
@dataclass
class PolicyConfig:
    min_score: float = 0.5
    stop_loss_pct: float = -4.0
    take_profit_pct: float = 5.0
    # ...

# 명령: /tune apply 로 추천값 자동 반영
```

### code-surgeon 의 우선순위

```
1차 시도: PolicyConfig 필드 매칭 → data/policy.json 만 수정
         (재시작 불필요, /tune apply 로 즉시 반영)

2차 시도: 1차 매칭 실패 시 → strategy 파일의 @dataclass default 수정
         (서비스 재시작 필요)
```

### 1차 경로의 장점

- 코드 파일은 무수정
- 백업·복원이 JSON 한 파일 단위로 간단
- `/tune apply` 가 이미 audit log 를 남김 — BarroTrade 의 audit 와 더불어 2중 추적

---

## 6. Patch 파일 형식

### unified diff (git apply 호환)

```diff
diff --git a/backend/core/strategy/f_zone.py b/backend/core/strategy/f_zone.py
--- a/backend/core/strategy/f_zone.py
+++ b/backend/core/strategy/f_zone.py
@@ -44,7 +44,7 @@ class FZoneParams:
     # 기준봉(impulse) 정의
-    impulse_min_gain_pct: float = 0.03
+    impulse_min_gain_pct: float = 0.0375
     # 눌림목(pullback) 정의
     pullback_min_pct: float = 0.005
```

- 한 patch 파일에 **한 strategy file 의 변경만** 포함 (분리성)
- 여러 strategy 변경 시 여러 patch 파일 생성

### 적용 명령 hint (proposal.md 끝에 포함)

```bash
# 백업
cp data/policy.json data/policy.json.bak.$(date +%s)

# 적용
cd /Users/beye/workspace/BarroAiTrade
git apply /Users/beye/workspace/BarroSkills/.claude/skills/barrotrade/workspace/_evolve/<id>/patch.diff

# 검증
git diff --stat
pytest backend/tests/strategy/test_f_zone.py -v

# 확인 후 commit (선택)
git add backend/core/strategy/f_zone.py
git commit -m "tune: FZoneParams.impulse_min_gain_pct 0.03 → 0.0375

근거: 2026-05-26 intraday recap, 손실 사이클 N건의 공통 시그널
관련: BarroTrade evolve <id>"
```

---

## 7. 롤백 절차

### 즉시 롤백 (git)

```bash
cd /Users/beye/workspace/BarroAiTrade
git revert HEAD                # 마지막 commit 만 되돌리기
# 또는
git reset --hard <prev-sha>    # ⚠️ 다른 변경도 날아감 — 신중히
```

### policy.json 만 롤백

```bash
cd /Users/beye/workspace/BarroAiTrade
ls -t data/policy.json.bak.* | head -1 | xargs -I {} cp {} data/policy.json
# /tune apply 재호출
```

### 자동 롤백 트리거

- 적용 후 24h 내 일일 손실 ≥ 회로 차단기 임계 (1.5%) → 알림 + 롤백 권장
- 적용 후 7일 누적 Sharpe < 직전 7일 - 0.3 → 알림 + 롤백 검토

자동 트리거는 **알림만** 발생, 실제 롤백은 사용자가 수동 실행.

---

## 8. 감사 추적 (Append-Only)

`logs/audit/code-evolution-<date>.jsonl`:

```json
{
  "ts_utc": "2026-05-26T08:32:11Z",
  "evolve_id": "evolve-2026-05-26-001",
  "recap_id": "2026-05-26",
  "target_file": "backend/core/journal/policy_config.py",
  "target_class": "PolicyConfig",
  "field_name": "stop_loss_pct",
  "old_value": -4.0,
  "new_value": -3.5,
  "relative_change_pct": -12.5,
  "rationale_summary": "5거래일 평균 -3.7% 손절 시점이 -4.0% 임계 직전 — 일관된 슬리피지 +0.3% 흡수 필요",
  "applied_via": "policy_config",
  "hitl_status": "pending|approved|rejected|expired",
  "hitl_approved_at": null,
  "hitl_approver_hash": null,
  "commit_hash": null,
  "rollback_status": null,
  "prev_hash": "sha256:...",
  "hash": "sha256:..."
}
```

5년 보존 + hash chain 무결성.

---

## 9. 동시 진화 방지

- `workspace/_evolve/.in-flight.json` 락 파일
- 한 번에 하나의 evolve 사이클만 pending
- 이전 evolve 가 `approved/rejected/expired` 되기 전 새 evolve 차단
- `--force` 만 우회 (audit 에 force_reason 기록 필수)

---

## 10. 알려진 함정 (Pitfalls)

### Pitfall 1: 과학습 (Overfitting)
- 단일 손실 day 의 데이터로 파라미터 조정 → 다음날 더 큰 손실 가능
- 방어: **30일 rolling window 통계** 사용. 단일 day 의 outlier 만으로 변경 제안 X.

### Pitfall 2: 파라미터 결합 효과 무시
- `impulse_min_gain_pct` 와 `bounce_min_gain_pct` 는 상관관계
- 한쪽만 조정 시 의도치 않은 진입 빈도 변화
- 방어: 동일 dataclass 내 변경은 한 evolve 사이클에 묶어서 제안 (개별 patch but 동일 proposal)

### Pitfall 3: 데이터 누락 day
- 시장 휴장·시스템 다운 day 의 PnL 0 처리 시 통계 왜곡
- 방어: `valid_trading_days` 필터 + 휴장일 캘린더 cross-reference

### Pitfall 4: HITL fatigue
- 매일 evolve 제안 → 사용자가 검토 피곤 → rubber-stamp approve
- 방어: `min_significance_threshold` (제안 가치가 일정 수준 이상일 때만 evolve 생성). 사이클 효익 < 0.1 Sharpe 향상 예상 시 제안 자체 생략.
