---
template_id: 99_reflection
owner_agent: barrotrade-self-reflector
cycle_id: "{{cycle_id}}"
ticker: "{{ticker}}"
outcome: "stop_loss|take_profit|risk_fail|hitl_expired|consensus_fail"
realized_pnl_pct: 0.0
pattern_id: "{{pattern_id}}"
semantic_memory_path: "workspace/_memory/semantic/{{pattern_id}}.md"
ts_utc: "{{ts_utc}}"
---

# Self-Reflection — {{cycle_id}}

## 1. 결과 요약
- ticker: {{ticker}}
- outcome: {{outcome}}
- 실현 손익률: {{pct}}%
- 보유 기간: {{N}} 거래일

## 2. 토론 로그 역추적

### Bear 가 경고했으나 묵살된 항목
- 경고 1: {{인용 (41_bear_brief.md L:N)}}
  - Moderator 처리: {{인용 (50_debate_log.md)}}
  - 실제 결과: {{경고가 적중했음을 보여주는 사후 데이터}}

- 경고 2: {{...}}
- 경고 3: {{...}}

### Bull 의 과신 항목
- 과신 1: {{인용}}
  - 실제 데이터: {{사후 검증}}

## 3. 신호 누락 분석
- 분석가 산출물에서 발견되지 않은 위험 시그널:
  - {{...}}
- RAG 가 놓친 공시·뉴스:
  - {{...}}

## 4. 오판 패턴 (Semantic Memory 적재 대상)

### Pattern ID: {{pattern_id}}
- 시장 국면: {{regime}}
- 섹터: {{sector}}
- 손실 유형: {{trend_reversal|earnings_miss|liquidity_shock|...}}
- 트리거 시그널 조합: {{signals}}
- 핵심 교훈: {{1~2문장 강력한 경고}}

이 패턴을 다음 동일 ticker 또는 동일 섹터 사이클의 RAG 컨텍스트 앞에 자동 prepend 합니다.

## 5. 시스템 개선 제안
- [ ] {{Moderator 가중치 조정 제안}}
- [ ] {{Bear 가중치 multiplier 조정 제안}}
- [ ] {{새로운 veto 키워드 추가 제안}}

## 6. 의미론적 기억 적재
파일: `workspace/_memory/semantic/{{pattern_id}}.md`

```markdown
---
pattern_id: {{pattern_id}}
created_at: {{ts}}
source_cycle: {{cycle_id}}
applies_to:
  tickers: [{{ticker}}]
  sectors: [{{sector}}]
  regimes: [{{regime}}]
severity: "low|medium|high|critical"
---

# 오판 패턴: {{title}}

## 트리거 조건
{{...}}

## 위험 시그널 (놓치면 안 됨)
{{...}}

## 권장 대응
{{...}}
```
