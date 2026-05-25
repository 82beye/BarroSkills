---
template_id: 60_risk_check
owner_agent: barrotrade-risk-manager
cycle_id: "{{cycle_id}}"
ticker: "{{ticker}}"
risk_status: "PASS|FAIL_*"
reason_codes: []
computed_Q_i: 0
trailing_stop_initial_krw: 0
ts_utc: "{{ts_utc}}"
---

# Risk Check — {{ticker}}

## 입력 파라미터
- total_equity_krw: {{equity}}
- α_risk_per_trade: 0.01
- γ_max_alloc_per_ticker: 0.15
- ATR_14: {{atr}}
- multiplier_κ: 2.0
- price: {{price}}

## 포지션 사이징 계산
```
A = total_equity * α / (ATR * κ) = {{A}}
B = total_equity * γ_max / price = {{B}}
Q_i = min(A, B) = {{Q}}
binding_constraint: {{A|B}}
```

## 트레일링 스탑
- 초기 손절: Entry - β·ATR = {{stop_initial}}
- 추적 손절 (현재): {{stop_current}}
- β: 2.0, θ: 1.5
- arm_delay_min: 5

## 포트폴리오 제약 점검
| 항목 | 한도 | 현재 | 평가 |
|------|------|------|------|
| max_concurrent_positions | 8 | ... | ✓/✗ |
| max_sector_concentration_pct | 35% | ...% | ✓/✗ |
| max_single_ticker_pct | 15% | ...% | ✓/✗ |
| min_cash_buffer_pct | 10% | ...% | ✓/✗ |
| leverage_max | 1.0 | ... | ✓/✗ |

## 회로 차단기 (Daily Loss)
- 일 시작 자산: {{day_start}}
- 현재 자산: {{current}}
- 손실률: {{pct}}%
- 임계: 1.5%
- 상태: {{armed_normal|tripped}}

## Monte Carlo VaR
- 시나리오: {{list}}
- 시뮬 횟수: 1000
- VaR 95%: {{pct}}%
- 임계: 8%
- 평가: {{pass|fail}}

## 결정
- **risk_status**: {{PASS|FAIL_*}}
- **reason_codes**: {{list}}
- **next_stage**: {{portfolio_pm|reflect}}
