---
template_id: 22_fundamental
owner_agent: barrotrade-fundamental-specialist
cycle_id: "{{cycle_id}}"
ticker: "{{ticker}}"
fair_value_range_krw:
  low: 0
  mid: 0
  high: 0
safety_score: 0.0
audit_opinion: "clean|qualified|adverse|disclaimer"
red_flags: []
ts_utc: "{{ts_utc}}"
---

# Fundamental — {{ticker}}

## 재무 건전성 점수: {{score}}/100

| 항목 | 값 | 평가 |
|------|----|----- |
| PER | ... | ... |
| PBR | ... | ... |
| ROE | ... | ... |
| 부채비율 | ... | ... |
| 영업이익률 | ... | ... |
| 잉여현금흐름 | ... | ... |

## 적정 가치 산정 (DCF + 멀티플)
- 보수적: {{low}} KRW
- 기본: {{mid}} KRW
- 낙관적: {{high}} KRW

## 최근 분기 실적
- 매출 YoY: {{pct}}%
- 영업이익 YoY: {{pct}}%
- 컨센서스 대비: {{beat|inline|miss}}

## Veto 검사 (자동)
- [ ] 감사의견 비적정
- [ ] 자본잠식
- [ ] 분식회계 의혹
- [ ] 횡령/배임 공시
- [ ] 상장폐지 우려

위 중 하나라도 ✓ 면 사이클 즉시 veto.

## 출처
- DART 분기 보고서: {{rcept_no}}
- 실적 속보: {{url}}
