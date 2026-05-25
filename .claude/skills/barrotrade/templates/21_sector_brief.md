---
template_id: 21_sector_brief
owner_agent: barrotrade-sector-expert
cycle_id: "{{cycle_id}}"
ticker: "{{ticker}}"
sector: "{{sector_name}}"
sector_strength_score: 0.0
ts_utc: "{{ts_utc}}"
---

# Sector Brief — {{sector_name}}

## 섹터 강도 지수
- 점수: {{score}} (0~1)
- 5일 거래대금 변동: {{pct}}%
- 동종 종목 평균 수익률: {{pct}}%

## 주도 테마
| 테마 | 강도 | 핵심 종목 |
|------|------|----------|
| ... | ... | ... |

## 타겟 종목 ({{ticker}}) 의 섹터 내 상대 위치
- 시총 순위: {{rank}} / {{total}}
- 5일 수익률 vs 섹터 평균: {{delta_pct}}%
- 외국인 보유율 변화: {{delta_pct}}%

## 공급망 노출
- 상위 공급사: {{list}}
- 주요 고객사: {{list}}
- 단일 의존도 위험: {{low|medium|high}}

## 후보 종목군
{{관련 ticker 리스트 + 사유}}
