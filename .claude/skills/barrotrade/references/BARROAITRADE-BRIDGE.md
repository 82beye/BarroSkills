# BarroAiTrade Bridge — 통합 지점 명세

본 문서는 BarroTrade 스킬과 [BarroAiTrade](https://github.com/82beye/BarroAiTrade) 프로젝트 간 통합 표면(integration surface) 을 정의합니다. 메타는 [`../config/barroaitrade-bridge.json`](../config/barroaitrade-bridge.json) 에 선언됩니다.

---

## 1. 통합 토폴로지

```
┌──────────────────────────────────────────────────────────────────┐
│  BarroTrade (Claude Code Skill)                                  │
│                                                                  │
│   ┌────────────┐   tail+poll   ┌─────────────┐                  │
│   │ signal-    │ ◄──────────── │ logs/       │                  │
│   │ watcher    │               │ data/       │                  │
│   └────┬───────┘               │ (read-only) │                  │
│        │                       └─────────────┘                  │
│        │ events                                                  │
│        ▼                                                         │
│   ┌────────────┐   recap       ┌─────────────┐                  │
│   │ intraday-  │ ◄──────────► │ workspace/  │                  │
│   │ reporter   │               │ _intraday/  │                  │
│   └────┬───────┘               └─────────────┘                  │
│        │                                                         │
│        ▼                                                         │
│   ┌────────────┐   patch.diff  ┌─────────────┐                  │
│   │ code-      │ ────────────► │ workspace/  │                  │
│   │ surgeon    │               │ _evolve/    │                  │
│   └────────────┘               └─────────────┘                  │
│                                       │                          │
└───────────────────────────────────────┼──────────────────────────┘
                                        │ HITL git apply
                                        ▼
┌──────────────────────────────────────────────────────────────────┐
│  BarroAiTrade (별도 프로젝트, /Users/beye/workspace/BarroAiTrade)│
│                                                                  │
│   logs/barro.log              ◄── tail -F                        │
│   data/barro_trade.db         ◄── polling 5s (read-only)         │
│   data/order_audit.csv        ◄── tail new lines                 │
│   data/active_positions.json  ◄── watch 10s                      │
│   analysis/strategy_ledger.csv◄── watch 60s                      │
│                                                                  │
│   backend/core/strategy/*.py  ◄── AST read for evolve            │
│   backend/core/journal/       ──── policy_config.py 우선 수정    │
│       policy_config.py            (BAR-OPS-31 /tune apply)       │
│                                                                  │
│   scripts/intraday_buy_daemon.py    ──── 데몬 (스킬 외부)        │
│   scripts/_daily_evening_pipeline.py──── recap 시 호출           │
│   scripts/_strategy_perf_track.py   ──── ledger 재생성용         │
│   scripts/_loss_drill_down.py       ──── recap 손실 분석용       │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 통합 지점 (Integration Points)

### IP-1: 로그 Tail

| 항목 | 값 |
|------|-----|
| 파일 | `logs/barro.log` (활성), `logs/barro.log.YYYY-MM-DD` (rotated) |
| 형식 | JSONL: `{"ts": "...", "level": "...", "logger": "...", "msg": "..."}` |
| 읽기 | `tail -F` (Bash 표준) 또는 Python `aiofiles.tail` |
| 필터 | `bridge.data_sources.logs.tail_policy.filter_loggers` 의 prefix 매칭 |
| 인코딩 | UTF-8 (한국어 메시지 포함) |
| 쓰기 | **절대 X** |

### IP-2: SQLite Polling

| 항목 | 값 |
|------|-----|
| 파일 | `data/barro_trade.db` |
| 연결 | `sqlite:///data/barro_trade.db?mode=ro` (read-only enforced) |
| 주기 | 5초 |
| 대상 테이블 | `trades`, `signals`, `positions`, `pnl_snapshots` |
| 쿼리 | `WHERE ts > <last_seen>` 로 incremental fetch |
| 쓰기 | **절대 X** |

### IP-3: CSV Append Tail

| 파일 | 형식 | 정책 |
|------|------|------|
| `data/order_audit.csv` | `ts,action,side,symbol,qty,price,order_no,return_code,blocked,reason` | offset 기억하여 새 라인만 읽음 |
| `analysis/strategy_ledger.csv` | 동적 컬럼 | 1분 주기 watch, 없으면 `_strategy_perf_track.py` 호출하여 재생성 |

### IP-4: JSON 파일 Watch

| 파일 | 주기 | 용도 |
|------|------|------|
| `data/active_positions.json` | 10초 | 현재 보유 포지션 |
| `data/policy.json` | on evolve | 정책 백업 + 변경 비교 |

### IP-5: 스크립트 호출 (recap 단계)

```bash
# 재생성·분석 도구는 BarroAiTrade의 venv 또는 system python 으로 호출
cd /Users/beye/workspace/BarroAiTrade
python scripts/_daily_evening_pipeline.py --date 2026-05-26 --output /tmp/recap-input.json
python scripts/_strategy_perf_track.py    --since 2026-05-19 --until 2026-05-26
python scripts/_loss_drill_down.py        --date 2026-05-26 --strategies f_zone,gold_zone
```

이 스크립트들은 BarroAiTrade 의 venv 가 있다고 가정. 없으면 system python 3.13 fallback.

### IP-6: AST 읽기 (evolve 단계)

| 파일 | 용도 |
|------|------|
| `backend/core/strategy/*.py` | dataclass 필드 default 추출 |
| `backend/core/journal/policy_config.py` | PolicyConfig 우선 매칭 |

Python `ast` 모듈로 read-only 파싱. 절대 쓰기 X.

### IP-7: Patch 출력 (HITL gate)

| 산출 | 위치 |
|------|------|
| unified diff | `workspace/_evolve/<id>/patch.diff` |
| rationale | `workspace/_evolve/<id>/proposal.md` |
| apply command hint | `proposal.md` 내부 |

사용자가 `git apply` 직접 실행. 스킬은 절대 자동 apply X.

---

## 3. BarroAiTrade 에 요구하는 사전 조건

### A. Python 환경

- Python ≥ 3.13
- 의존성: `pandas`, `numpy`, `pydantic` (BarroAiTrade pyproject.toml 에 이미 명시)
- BarroAiTrade venv 가 있으면 우선 사용, 없으면 system python 으로 폴백

### B. 권한

- BarroAiTrade 디렉토리 **읽기** 권한 필수
- `data/policy.json.bak.<timestamp>` 작성을 위해 `data/` 디렉토리 **쓰기** 권한 (백업 한정)
- 위 외에 절대 쓰기 X

### C. 로그 로테이션 호환

- `logs/barro.log` 가 `barro.log.YYYY-MM-DD` 로 회전되어도 tail 가 끊김 없이 follow
- `tail -F` 사용 (대문자 F, retry on rotation)

### D. PolicyConfig 인터페이스 (BAR-OPS-31)

BarroAiTrade 가 다음을 제공한다고 전제:

- `backend/core/journal/policy_config.py` 의 `PolicyConfig` dataclass
- `data/policy.json` 파일 (PolicyConfig 의 영속화)
- `/tune apply` 명령 (CLI 또는 endpoint, runtime 반영)

위 인터페이스가 사라지면 evolve 모드는 자동으로 strategy 파일 직접 수정 경로(2차) 로 폴백.

---

## 4. 통합 데이터 흐름 예시

### 예시 1: 시그널 발생 → decide

```
1. BarroAiTrade orchestrator 가 EntrySignal 생성
     logger=backend.core.orchestrator, level=INFO
     msg="EntrySignal symbol=005930 side=buy strategy=f_zone conf=0.78"
     ↓ (logs/barro.log 에 jsonl line append)

2. barrotrade-signal-watcher 가 tail 로 캡처
     ↓ workspace/_intraday/<date>/signals.jsonl 에 정규화 line append
     ↓ 자동으로 decide 모드 호출 (옵션, 사용자 선택)

3. barrotrade-quick-decider 가 10초 내 응답
     ↓ logs/decisions/<date>.jsonl 에 결정 line append
     ↓ 콘솔에 결정 즉시 출력

4. 사용자가 BarroAiTrade UI 또는 별도 도구로 발주
   (BarroTrade 는 발주에 관여하지 않음)
```

### 예시 2: 장 마감 → recap → evolve

```
15:30 KST  live 모드 자동 종료
       ↓
15:35     intraday-reporter 가 recap 생성
       ↓ workspace/_intraday/<date>/recap.md
       ↓ _daily_evening_pipeline.py, _loss_drill_down.py 호출
       ↓
16:00     evolve 권고가 §5 에 있으면 자동 evolve 트리거 (옵션)
       ↓ code-surgeon 이 PolicyConfig 우선 매칭
       ↓ workspace/_evolve/<id>/proposal.md + patch.diff
       ↓ telegram + email 알림
       ↓
       사용자 검토 (24h timeout)
       ↓
       승인 → cp data/policy.json data/policy.json.bak.<ts>
            → git apply <patch>
            → /tune apply (runtime 반영)
            → /barrotrade evolve-ack <id> --status applied
```

---

## 5. 실시간 시그널 알림 (옵션)

`decide` 모드를 자동 호출하지 않고 알림만 받고 싶을 경우:

```json
// barroaitrade-bridge.json
"signal_notification_only_mode": true,
"notification_channels": ["telegram", "email"]
```

이 경우 signal-watcher 가 시그널 감지 시 알림만 발송. decide 모드는 사용자가 수동으로만 호출.

---

## 6. BarroAiTrade 미설치 시 동작

- `barroaitrade-bridge.json.target_project.root_path` 가 존재하지 않으면:
  - `live/recap/evolve/decide` 모드 전부 거부
  - `cycle/analyze/debate/risk/order/reflect/backtest/doctor/init` 는 정상 동작 (Bridge 없이도 시뮬레이션 가능)
- doctor 가 bridge 부재를 WARN 으로 표시 (FAIL 아님)

---

## 7. 정합성 검증 (doctor)

`/barrotrade doctor` 는 다음을 자동 검사:

1. `barroaitrade-bridge.json` 파싱
2. `target_project.root_path` 존재
3. `data_sources.logs.current` 읽기 가능
4. `data_sources.sqlite.path` 읽기 가능 + read-only 연결 가능
5. `strategies.directory` 존재
6. `strategies.policy_config.file` 존재 (BAR-OPS-31 인터페이스 검증)
7. `code_evolution_policy.hitl_policy.auto_apply_threshold_pct == 0` (안전 보증)

위 중 1~6 이 한 개라도 실패하면 live/recap/evolve/decide 모드 차단. 7번은 절대 변경 불가 (config 무결성 위반).

---

## 8. 양방향 통신 금지 원칙

| 항목 | 허용? |
|------|------|
| BarroTrade → BarroAiTrade 파일 read | ✓ |
| BarroTrade → BarroAiTrade `data/policy.json.bak.*` write | ✓ (백업 한정) |
| BarroTrade → BarroAiTrade 코드 직접 수정 | ✗ (patch.diff 만 생성) |
| BarroTrade → BarroAiTrade DB write | ✗ |
| BarroTrade → BarroAiTrade `active_positions.json` write | ✗ |
| BarroTrade → BarroAiTrade API endpoint POST/PUT/DELETE | ✗ |
| BarroAiTrade → BarroTrade workspace 읽기 | ✓ (선택, BarroAiTrade 가 의지 있다면) |
| BarroAiTrade → BarroTrade workspace 쓰기 | ✗ (BarroAiTrade 책임 아님) |
