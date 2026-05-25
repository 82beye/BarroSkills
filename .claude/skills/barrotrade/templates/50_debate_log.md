---
template_id: 50_debate_log
owner_agent: barrotrade-debate-moderator
cycle_id: "{{cycle_id}}"
ticker: "{{ticker}}"
moderator_model: "claude-opus-4-7"
rounds_completed: 0
vote_score: 0.0
decision: "PASS|FAIL_BELOW_THRESHOLD|VETO"
user_profile: "conservative|balanced|aggressive"
veto_reason: null
ts_utc: "{{ts_utc}}"
---

# Debate Log — {{ticker}}

## Round 1: 기초 진술
### Bull
{{축약 인용 (40_bull_brief.md 참조)}}

### Bear
{{축약 인용 (41_bear_brief.md 참조)}}

## Round 2: 교차 논증
### Bull → Bear 반박
{{...}}

### Bear → Bull 반박
{{...}}

## Round 3: 데이터 대조
| 데이터 포인트 | Bull 해석 | Bear 해석 | Moderator 가중치 |
|--------------|-----------|-----------|-----------------|
| ... | ... | ... | ... |

## Round 4: 합의 시도

### 합의 가능 영역
- {{...}}

### 합의 불능 영역
- {{...}}

### 가중 점수 산정
| 디멘션 | 가중치 | Bull | Bear | 최종 |
|--------|--------|------|------|------|
| macro_alignment | 20 | ... | ... | ... |
| fundamental_safety | 20 | ... | ... | ... |
| technical_signal_quality | 20 | ... | ... | ... |
| event_impact | 10 | ... | ... | ... |
| sector_momentum | 10 | ... | ... | ... |
| rag_sentiment_confidence | 10 | ... | ... | ... |
| historical_pattern_match | 10 | ... | ... | ... |

**vote_score** = {{score}}

## Veto 점검
- macro regime == crisis: {{yes|no}}
- audit opinion ≠ clean: {{yes|no}}
- RAG veto keywords: {{list}}

## 최종 결정
- decision: {{PASS|FAIL_BELOW_THRESHOLD|VETO}}
- next_stage: {{risk_check|reflect}}
