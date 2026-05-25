---
template_id: 10_market_snapshot
owner_agent: barrotrade-data-preprocessor
cycle_id: "{{cycle_id}}"
ticker: "{{ticker}}"
ts_utc: "{{ts_utc}}"
data_window:
  start: "{{window_start}}"
  end: "{{window_end}}"
quality:
  completeness_pct: 0.0
  missing_bars: 0
  outliers_filtered: 0
---

# Market Snapshot — {{ticker}}

## Price Action
- 현재가: {{current_price}}
- 시가: {{open}}
- 고가: {{high}}
- 저가: {{low}}
- 전일 종가: {{prev_close}}
- 변화율: {{change_pct}}%

## Volume / Turnover
- 거래량: {{volume}} 주
- 거래대금: {{turnover_krw}} KRW
- 5일 평균 거래대금: {{avg_turnover_5d}}
- VWAP: {{vwap}}

## OHLCV Tail (최근 30봉, 1분봉 기준)
| ts | O | H | L | C | V |
|----|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... |

## 호가 스냅 (Top 5)
| 매수호가 | 매수잔량 | 매도호가 | 매도잔량 |
|----------|----------|----------|----------|
| ... | ... | ... | ... |

## 이상치 검출
- [ ] 틱 갭 (1분 이상 결측)
- [ ] 거래대금 0 봉 ({{count}}개)
- [ ] 가격 점프 (>3σ)

## 데이터 게이트
- completeness >= 0.98: {{pass_fail}}
- next_stage_allowed: {{true|false}}
