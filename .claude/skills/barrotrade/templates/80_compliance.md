---
template_id: 80_compliance
owner_agent: barrotrade-compliance-officer
cycle_id: "{{cycle_id}}"
ticker: "{{ticker}}"
user_id_hash: "{{sha256_hash}}"
audit_log_hash: "{{sha256}}"
prev_audit_hash: "{{sha256}}"
ts_utc: "{{ts_utc}}"
---

# Compliance Report — {{cycle_id}}

## 1. 사이클 요약
- ticker: {{ticker}}
- consensus_score: {{score}}
- risk_status: {{status}}
- hitl_status: {{status}}
- order_simulated: {{summary}}

## 2. 설명 가능성 (XAI) 체크리스트
| 아티팩트 | 존재 | 무결성 |
|----------|------|--------|
| 10_market_snapshot.md | ✓/✗ | sha: ... |
| 15_news_rag.json | ✓/✗ | sha: ... |
| 20_macro_report.md | ✓/✗ | sha: ... |
| 21_sector_brief.md | ✓/✗ | sha: ... |
| 22_fundamental.md | ✓/✗ | sha: ... |
| 30~33_*_signal.md | ✓/✗ | sha: ... |
| 40_bull_brief.md | ✓/✗ | sha: ... |
| 41_bear_brief.md | ✓/✗ | sha: ... |
| 50_debate_log.md | ✓/✗ | sha: ... |
| 60_risk_check.md | ✓/✗ | sha: ... |
| 70_order.simulated.json | ✓/✗ | sha: ... |

## 3. 편향 방어 체크
- [x] Look-Ahead Bias: T_virtual={{ts}}, 모든 데이터 published_at < T_virtual
- [x] Distraction Filter: entity_score ≥ 0.75
- [x] Confirmation Bias: bull/bear 의무 호출
- [x] Anchoring Bias: 직전 사이클 결과 prepend 없음

## 4. FSC 5대 원칙 매핑
1. **인간 책임성**: HITL {{required|not_required}}, sign-off 완료
2. **안전성**: 회로 차단기 {{armed_normal|tripped}}, MC VaR ≤ 8%
3. **투명성**: 토론 로그 전문 보존
4. **공정성**: 정량 기준만 사용
5. **개인정보**: user_id_hash 만 기록, PII 없음

## 5. Audit Hash Chain
- prev_hash: {{prev}}
- this_hash: {{this}}
- chain_valid: {{true|false}}

## 6. 다음 권장 작업
- [ ] D+5 자가 점검 예약 (`/barrotrade reflect {{cycle_id}}`)
- [ ] 동일 ticker 재진입 대기 시간: 24h
