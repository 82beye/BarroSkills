---
template_id: 30_trend_signal
owner_agent: barrotrade-trend-expert
cycle_id: "{{cycle_id}}"
ticker: "{{ticker}}"
direction: "long|short|neutral"
strength: 0.0
adx_value: 0.0
adx_gate_pass: true
ts_utc: "{{ts_utc}}"
---

# Trend Signal — {{ticker}}

## 지표 측정
| 지표 | 값 |
|------|----|
| EMA(8)  | ... |
| EMA(21) | ... |
| EMA(55) | ... |
| ADX(14) | ... |
| MACD line | ... |
| MACD signal | ... |
| MACD histogram | ... |

## 게이트 체크
- ADX ≥ 25: {{pass|fail}}
- EMA(8) cross-up EMA(21): {{pass|fail}}
- MACD_hist > 0: {{pass|fail}}

## 신호
- **방향**: {{long|short|neutral}}
- **강도**: {{0~1}}
- **기대 손절가**: {{price}} (ATR(14) × β = 2.0)
- **기대 익절가 (1st)**: {{price}}

## 약점 점검
- 패턴 expert 가 삼각수렴 감지: {{yes|no}}
- 거시 분석가 regime: {{regime}}

## 신호 발행 여부
- emit_signal: {{true|false}}
- reason: {{...}}
