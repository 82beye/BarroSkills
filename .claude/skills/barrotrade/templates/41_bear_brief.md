---
template_id: 41_bear_brief
owner_agent: barrotrade-bear-researcher
cycle_id: "{{cycle_id}}"
ticker: "{{ticker}}"
stop_loss_target_krw: 0
downside_pct: 0.0
key_red_flags: []
confidence: 0.0
ts_utc: "{{ts_utc}}"
---

# Bear Brief — {{ticker}}

## 핵심 위험 3개

### 1. {{위험 제목}}
- 근거 데이터: {{지표·수치 + 출처}}
- 충격 시 예상 하락폭: {{pct}}%

### 2. {{위험 제목}}
- 근거 데이터: ...
- 충격 시 예상 하락폭: ...

### 3. {{위험 제목}}
- 근거 데이터: ...
- 충격 시 예상 하락폭: ...

## 하방 시나리오
- 예상 손절 단가: {{stop_loss}}
- 기간: {{N}} 거래일
- 트리거 조건: {{...}}

## Bull 논거에 대한 반박
- Bull 논거 1 반박: {{...}}
- Bull 논거 2 반박: {{...}}
- Bull 논거 3 반박: {{...}}

## Red Flag 자동 검출
- audit_opinion ≠ clean: {{yes|no}}
- 거래정지 / 상장폐지 키워드: {{yes|no}}
- 자본잠식: {{yes|no}}
- macro regime == crisis: {{yes|no}}

위 중 1개 ✓ 면 즉시 veto.

## 인용
- 22_fundamental.md: {{줄 인용}}
- 15_news_rag.json: {{직접 인용}}
- 31_meanrev_signal.md: {{줄 인용}}
