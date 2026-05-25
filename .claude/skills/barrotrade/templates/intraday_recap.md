---
template_id: intraday_recap
owner_agent: barrotrade-intraday-reporter
date: "{{YYYY-MM-DD}}"
session_start_kst: "09:00"
session_end_kst: "15:30"
broker: "{{kis|kiwoom}}"
signals_total: 0
executions_total: 0
daily_pnl_pct: 0.0
status: "complete|partial|aborted"
ts_utc: "{{ts_utc}}"
---

# Intraday Recap — {{YYYY-MM-DD}}

## 1. 세션 요약

| 항목 | 값 |
|------|-----|
| 운영 시간 | 09:00 ~ 15:30 KST |
| 시그널 발생 | {{N}}건 (buy={{B}}, sell={{S}}) |
| 체결 시도 | {{N}}건 (dry_run={{D}}, real={{R}}, blocked={{X}}) |
| 활성 포지션 (장 마감 기준) | {{N}}개 |
| 일일 PnL | {{±X.XX}}% ({{KRW}} KRW) |
| 회로 차단기 발동 | {{yes|no}} |
| Live 세션 무결성 | {{ok|gap_detected|partial}} |

## 2. 시그널 × 체결 매칭

| 시그널 ID | 시각 | 종목 | side | 전략 | conf | 체결 여부 | 비고 |
|----------|------|------|------|------|------|----------|------|
| sig-... | 09:32 | 005930 | buy | f_zone | 0.78 | ✓ DRY_RUN | |
| ... | ... | ... | ... | ... | ... | ... | ... |

미체결 시그널 사유 ({{N}}건):
- {{이유 1}}: {{N}}건
- {{이유 2}}: {{N}}건

## 3. 전략별 성과

| 전략 | 시그널 | 체결 | hit | miss | hit rate | 평균 PnL | 누적 PnL |
|------|--------|------|-----|------|----------|----------|----------|
| f_zone | ... | ... | ... | ... | ...% | ... | ... |
| gold_zone | ... | ... | ... | ... | ...% | ... | ... |
| sf_zone | ... | ... | ... | ... | ...% | ... | ... |
| ... | ... | ... | ... | ... | ... | ... | ... |

## 4. 손실 사이클 Drill-Down

각 손실 -1.5% 이상 사이클 detail:

### {{symbol}} — {{strategy}} (PnL {{±X.XX}}%)
- 진입: {{time}}, {{price}} KRW
- 청산: {{time}}, {{price}} KRW (사유: {{stop_loss|trailing|manual}})
- 시그널 confidence: {{0.XX}}
- 손실 주요 사유 (loss-drill-down 분석):
  - {{원인 1}}
  - {{원인 2}}
- 직전 cycle (있다면) bear-researcher 가 경고한 항목 매칭:
  - {{Bear L:N — "..."}}

(N개 손실 사이클 반복)

## 5. 자가 진화 권고 (다음 evolve 모드 입력)

### 권고 1: {{dataclass_field_name}}
- **대상**: `backend/core/journal/policy_config.py::PolicyConfig.{{field}}` 또는 `backend/core/strategy/{{file}}.py::{{Params}}.{{field}}`
- **현재값**: {{old_value}}
- **제안값**: {{new_value}} (Δ {{±X.XX}}%)
- **근거**:
  - 직전 30일 데이터: {{통계}}
  - 손실 사이클 N건의 공통 패턴: {{패턴}}
  - 예상 효과: {{예상 향상치}}
- **위험**: {{과학습 가능성 / 결합 효과 등 명시}}

### 권고 2: ...

(권고가 없으면 "이번 세션은 변경 권고 없음" 명시)

## 6. 인시던트 (WARN/ERROR)

| 시각 | 레벨 | 로거 | 메시지 요약 | 횟수 |
|------|------|------|-------------|------|
| 09:50 | ERROR | backend.api.routes.positions | 잔고 조회 실패 (kiwoom-native rc=3) | 4 |
| ... | ... | ... | ... | ... |

## 7. 거시 환경 Snapshot

| 항목 | 값 | 변화 |
|------|----|------|
| KOSPI 종가 | ... | ... |
| KOSDAQ 종가 | ... | ... |
| USD/KRW | ... | ... |
| US10Y yield | ... | ... |
| VIX | ... | ... |
| 거시 국면 | regime_? | ... |

## 8. 다음 조치 추천

- [ ] `/barrotrade evolve {{recap_id}}` — 자가 진화 권고 검토
- [ ] 직전 30일 손실 사이클 cross-reference 필요 시 `/barrotrade reflect <cycle_id>`
- [ ] 회로 차단기 발동 시 `unlock` 절차 안내

## 9. 아카이브

- 시그널 raw: `workspace/_intraday/{{date}}/signals.jsonl` ({{N}} lines)
- 체결 raw: `workspace/_intraday/{{date}}/executions.jsonl` ({{N}} lines)
- PnL timeline: `workspace/_intraday/{{date}}/pnl_timeline.jsonl` ({{N}} snapshots)
- 인시던트: `workspace/_intraday/{{date}}/incidents.jsonl` ({{N}} lines)
- Audit chain hash: `{{sha256}}`
