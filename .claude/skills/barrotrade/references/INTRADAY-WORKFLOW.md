# Intraday Workflow — live → recap → evolve → decide

본 문서는 BarroAiTrade와 통합된 장중 실시간 워크플로우와 자가 진화 사이클을 정의합니다. 정책은 [`../config/barroaitrade-bridge.json`](../config/barroaitrade-bridge.json) 에 선언됩니다.

---

## 1. 4 모드 개요

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  09:00 KST                  15:30 KST                            │
│     │  ◄────── live ──────▶  │ ◄── recap ──▶ ◄── evolve ──▶     │
│     │  (장중 추적)           │ (종합 리포트)  (코드 패치 제안)    │
│     │                         │                                  │
│     │    ▲                    │                                  │
│     │    │ decide              │                                  │
│     │    │ (시그널 발생 시,   │                                  │
│     │    │  10초 내 GO/NO-GO) │                                  │
│     │                         │                                  │
└─────┴─────────────────────────┴──────────────────────────────────┘
                                      │
                                      ▼
                            patch.diff + proposal.md
                                      │
                                      ▼
                            HITL (사용자 git apply)
                                      │
                                      ▼
                              policy_config 업데이트
                                      │
                                      └─► 다음 장 시작 (loop)
```

---

## 2. Mode: `live <YYYY-MM-DD>` — 장중 실시간 추적

### 진입점

```
/barrotrade live 2026-05-26
```

`BARROTRADE_LIVE_AUTO_START=true` 환경변수 설정 시 09:00 KST 에 launchd 가 자동 호출.

### 데이터 소스 (병행 수집)

| 소스 | 방식 | 주기 |
|------|------|------|
| `logs/barro.log` | `tail -F` JSONL 파싱 | 실시간 (line by line) |
| `data/barro_trade.db` | SQLite read-only polling | 5초 |
| `data/order_audit.csv` | 새 라인 tail | 실시간 |
| `data/active_positions.json` | 파일 watch | 10초 |
| `analysis/strategy_ledger.csv` | 파일 watch | 1분 |

### 수집 이벤트

1. **시그널 이벤트** (`barrotrade-signal-watcher` 가 캡처)
   - `EntrySignal` 생성 (logger: `backend.core.orchestrator` 또는 `backend.api.routes.signals`)
   - 시점, 종목, 방향, strategy_id, confidence, 가격
   - 종착지: `workspace/_intraday/<date>/signals.jsonl`

2. **체결 이벤트** (order_audit.csv 의 새 라인)
   - action=DRY_RUN/REAL, side=buy/sell, symbol, qty, price, blocked
   - 종착지: `workspace/_intraday/<date>/executions.jsonl`

3. **PnL 스냅샷** (5분마다)
   - DB 의 positions + pnl_snapshots 테이블 read
   - 종착지: `workspace/_intraday/<date>/pnl_timeline.jsonl`

4. **에러·경고 이벤트**
   - level=WARNING/ERROR 만 필터
   - 종착지: `workspace/_intraday/<date>/incidents.jsonl`

### 종료 조건

- 15:30 KST 도달 (장 마감)
- 사용자 Ctrl+C 또는 `/barrotrade live stop`
- 회로 차단기 발동
- 디스크 90% 도달

### 산출물 디렉토리

```
workspace/_intraday/2026-05-26/
├── signals.jsonl            # 시그널 타임라인
├── executions.jsonl         # 체결 타임라인
├── pnl_timeline.jsonl       # 5분 단위 PnL
├── incidents.jsonl          # WARN/ERROR
├── positions_snapshots/     # 시간대별 active_positions.json 백업
│   ├── 09-00.json
│   ├── 09-05.json
│   └── ...
└── live_meta.json           # 세션 메타 (시작·종료 시각, 수집 통계)
```

---

## 3. Mode: `recap <YYYY-MM-DD>` — 장종 후 종합 리포트

### 진입점

```
/barrotrade recap 2026-05-26
```

자동: live 모드가 15:30 KST 에 자동으로 `recap` 트리거 (`after_market_recap_at: "15:35"`).

### 처리 단계

1. **데이터 로드**: `workspace/_intraday/<date>/*.jsonl` 전체 + BarroAiTrade의 `_daily_evening_pipeline.py` 실행 결과
2. **`barrotrade-intraday-reporter` 위임**:
   - 시그널 × 체결 매칭 (어떤 시그널이 실제 체결로 이어졌는가)
   - 전략별 hit rate, 평균 PnL, 손실 사이클 detail
   - 손실 사이클 → `_loss_drill_down.py` 호출하여 사후 분석 보강
   - 거시 환경(VIX, KOSPI 지수) snapshot
3. **`barrotrade-self-reflector` 위임** (필요 시):
   - 손절 사이클 토론 로그 역추적 (cycle mode 산출물이 있을 경우)
   - 오판 패턴 추출 → semantic memory 적재

### 리포트 구조 ([templates/intraday_recap.md](../templates/intraday_recap.md))

```markdown
# Intraday Recap — 2026-05-26

## 1. 세션 요약
- 운영 시간: 09:00 ~ 15:30 KST
- 시그널 발생: N건 (buy=N, sell=N)
- 체결: N건 (dry_run=N, real=N, blocked=N)
- 일일 PnL: ±X.XX%

## 2. 전략별 성과
| 전략 | 시그널 | 체결 | hit rate | 평균 PnL |
| ... |

## 3. 손실 사이클 Drill-Down
- (목록)

## 4. 인시던트
- (WARN/ERROR 요약)

## 5. 자가 진화 권고
- (다음 evolve 모드의 입력)
```

### 산출물 위치

```
workspace/_intraday/<date>/recap.md
logs/audit/intraday-recap-<date>.jsonl
```

---

## 4. Mode: `evolve <recap_id>` — dataclass 파라미터 자동 수정 제안

### 진입점

```
/barrotrade evolve 2026-05-26
```

`recap_id` 는 보통 날짜. 명시적으로 `/barrotrade evolve 2026-05-26-ep01` 처럼 지정 가능.

### 처리 단계

1. **Recap 로드**: `workspace/_intraday/<recap_id>/recap.md` 의 §5 자가 진화 권고
2. **`barrotrade-code-surgeon` 위임**:
   - 권고된 dataclass 파라미터 식별 (예: FZoneParams.impulse_min_gain_pct)
   - 현재 값 읽기 (`backend/core/strategy/f_zone.py` line 44)
   - 새 값 제안 (recap 의 손실 패턴 + STRATEGIES.md 의 수식 정합)
   - **제약 검증**:
     - `max_relative_change_pct: 25` 이내
     - 동일 필드 주당 ≤ 3회
     - 함수 로직·조건문 변경 X
3. **patch.diff 생성**:
   - unified diff 형식
   - 우선순위: `policy_config.py` 의 `/tune apply` 경로 (BAR-OPS-31)
   - 폴백: dataclass field default 직접 수정 (strategy 파일)
4. **proposal.md 작성**:
   - 변경 필드 1개당 1 문단: 현재값 → 제안값, 사후 데이터 근거, 예상 영향
5. **HITL 강제**: 자동 적용 절대 X. 사용자가 `git apply` 수동 실행.

### 산출물 디렉토리

```
workspace/_evolve/<id>/
├── proposal.md
├── patch.diff
├── rationale.jsonl          # 필드별 변경 근거 raw 데이터
└── meta.json                # evolve_id, recap_id, target_fields, hitl_status
```

### 적용 (HITL)

```bash
# 1) 검토
cat workspace/_evolve/<id>/proposal.md
git -C /Users/beye/workspace/BarroAiTrade diff --stat

# 2) policy_config 백업
cp /Users/beye/workspace/BarroAiTrade/data/policy.json \
   /Users/beye/workspace/BarroAiTrade/data/policy.json.bak.$(date +%s)

# 3) patch 적용
cd /Users/beye/workspace/BarroAiTrade && git apply <patch_path>

# 4) 적용 확인 후 audit log update
/barrotrade evolve-ack <id> --status applied --commit-hash <sha>
```

---

## 5. Mode: `decide <signal_id>` — 시그널 결정 어시스턴트 (10초 이내)

### 진입점

장중 시그널 발생 즉시 (signal-watcher 가 자동 호출, 또는 사용자가 수동 호출):

```
/barrotrade decide sig-2026-05-26-09-32-15-005930-buy
```

`signal_id` 는 `workspace/_intraday/<date>/signals.jsonl` 의 line ID.

### 처리 단계 (Fast Path, target ≤ 10s)

1. **시그널 로드**: `signal_id` 의 raw event
2. **컨텍스트 조회** (캐시 우선):
   - 직전 macro_specialist regime (TTL 1h)
   - 현재 active_positions
   - 일일 누적 PnL
3. **`barrotrade-quick-decider` 위임**:
   - **단축 토론** (Bull/Bear 각 1 문단, 600 토큰 이내)
   - 리스크 mini-check (ATR 사이징, 회로 차단기 상태)
   - 의미론적 메모리 검색 (`workspace/_memory/semantic/`) — 유사 패턴 매칭
4. **결정**: GO / WAIT / NO-GO + 추천 사이즈 + 1줄 근거
5. **로깅**: `logs/decisions/<date>.jsonl`

### 산출물 ([templates/signal_decision.md](../templates/signal_decision.md))

콘솔 + 파일 동시 출력:

```
─────────────────────────────────────────
SIGNAL: 005930 buy @ 68,500  (strategy=f_zone, conf=0.78)
DECISION: GO
SIZE: 23 shares (1,575,500 KRW)
─────────────────────────────────────────
Bull: 1Q 메모리 반등 + ADX 28
Bear: HBM 격차 risk 잔존 — Bear weight 1.0
Risk: PASS (회로 차단기 armed, 사용자 위험 한도 65% 사용 중)
Memory: 유사 패턴 0건 (pattern-trend-reversal-semi 미해당)
─────────────────────────────────────────
다음: 인간 트레이더가 BarroAiTrade UI 에서 직접 발주
```

### 정확성 vs 속도 트레이드오프

| 항목 | live decide | 전체 cycle |
|------|-------------|-----------|
| 응답 시간 | ≤ 10s | 60~120s |
| 분석 깊이 | Bull/Bear 1 문단 | 4 라운드 토론 |
| Memory 활용 | 키워드 검색 | 전체 컨텍스트 |
| 리스크 점검 | ATR + 회로차단기 only | 풀 매트릭스 |

긴급 결정용 — 깊은 분석이 필요하면 `/barrotrade cycle` 사용.

---

## 6. 자동화 (launchd 스케줄)

### 일일 스케줄 (KST)

| 시각 | 모드 | 트리거 |
|------|------|--------|
| 09:00 | `live` 시작 | launchd |
| 09:00 ~ 15:30 | `decide` (on-demand) | signal-watcher hook |
| 15:30 | `live` 종료 | 자동 |
| 15:35 | `recap` 생성 | live → recap chain |
| 16:00 | `evolve` 제안 (옵션) | recap → evolve chain |
| 16:30 | telegram/email 알림 | 외부 통합 |

### launchd plist 예시

```xml
<key>Label</key><string>com.barrotrade.live</string>
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string>
  <string>-lc</string>
  <string>/barrotrade live $(date +%Y-%m-%d)</string>
</array>
<key>StartCalendarInterval</key>
<dict>
  <key>Hour</key><integer>9</integer>
  <key>Minute</key><integer>0</integer>
</dict>
```

설치 헬퍼는 `scripts/install-intraday-cron.sh` 로 제공 예정 (BarroTube 패턴 차용).

---

## 7. 안전 가드

| 가드 | 위치 | 동작 |
|------|------|------|
| BarroAiTrade read-only | `barroaitrade-bridge.json.safety_rails` | 코드·active_positions·db 쓰기 절대 금지 |
| HITL 100% | `code_evolution_policy.hitl_policy.auto_apply_threshold_pct: 0` | 자동 적용 항상 차단 |
| 변경 폭 한도 | `change_magnitude_limits.max_relative_change_pct: 25` | 25% 초과 변경 거부 |
| 주당 변경 횟수 | `max_absolute_change_per_field_per_week: 3` | overfitting 방지 |
| 함수 로직 변경 금지 | `scope: "dataclass_numeric_fields_only"` | 파서가 AST 단위로 검증 |
| 백업 의무 | `policy.json.bak.<timestamp>` | evolve apply 전 무조건 백업 |
