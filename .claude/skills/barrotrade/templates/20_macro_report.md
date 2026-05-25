---
template_id: 20_macro_report
owner_agent: barrotrade-macro-specialist
cycle_id: "{{cycle_id}}"
ts_utc: "{{ts_utc}}"
T_virtual: "{{T_virtual}}"
regime: "regime_1|regime_2|regime_3|regime_4"
growth_sentiment_index: 0.0
inflation_sentiment_index: 0.0
sources:
  - "wsj"
  - "bloomberg"
  - "reuters"
  - "fed_statements"
---

# Macro Report

## 거시 국면 결정
- **결정**: {{regime}}
- **사유**: {{한 줄 요약}}

## Growth Sentiment Index
- 점수: {{growth_index}} ([-1, 1])
- 주요 드라이버:
  1. {{driver_1}}
  2. {{driver_2}}
  3. {{driver_3}}

## Inflation Sentiment Index
- 점수: {{inflation_index}}
- 주요 드라이버:
  1. {{driver_1}}
  2. {{driver_2}}
  3. {{driver_3}}

## 섹터 회전 추천
| 우대 섹터 | 사유 | 비중 가이드 |
|----------|------|-----------|
| ... | ... | ... |

| 비우대 섹터 | 사유 | 한도 |
|------------|------|------|
| ... | ... | ... |

## Strategy Layer 게이트
- `trend-following`: {{enabled|disabled}}
- `mean-reversion`: {{enabled|disabled}}
- `event-driven`: {{enabled|disabled}}
- `chart-pattern`: {{enabled|disabled}}

## 인용 출처
{{인용 텍스트 + URL/문서ID, 모든 클레임에 1:1 매핑}}
