# Risk Policy

본 문서는 BarroTrade 의 리스크 통제 규칙입니다. 정책은 [`../config/risk-policy.json`](../config/risk-policy.json) 에 선언되며, 모든 리스크 평가는 `barrotrade-risk-manager` 에이전트가 수행합니다.

---

## 1. 동적 포지션 사이징 (ATR Weighting)

### 수식

```
Q_i = min(
        total_equity * α_risk          /  (ATR_i(N) * κ),
        total_equity * γ_max_alloc     /  price_i
      )
```

| 파라미터 | 기본값 | 의미 |
|----------|--------|------|
| `α_risk` | 0.01 (1%) | 1회 거래당 감내 가능한 위험 비율 |
| `γ_max_alloc` | 0.15 (15%) | 단일 종목 최대 포트폴리오 비중 |
| `ATR_i(N)` | N=14 | 종목 i 의 14일 평균 실질 변동폭 |
| `κ` | 2.0 | ATR multiplier (변동성 강도 보정) |

### ATR 산출

```
TR_t = max(High_t - Low_t,
            |High_t - Close_{t-1}|,
            |Low_t  - Close_{t-1}|)

ATR_t(N) = (ATR_{t-1} * (N - 1) + TR_t) / N         (Wilder's smoothing)
```

### 예시 (삼성전자 005930, 가정값)

- `total_equity` = 100,000,000 KRW
- `α_risk` = 0.01 → 거래당 손실 한도 1,000,000 KRW
- `ATR_14` = 1,200 KRW, `κ` = 2.0 → ATR 거리 2,400 KRW
- `γ_max_alloc` = 0.15 → 종목당 15,000,000 KRW 한도
- `price` = 68,500 KRW

```
A = 100,000,000 * 0.01 / (1,200 * 2.0) = 416.67  → floor = 416 주
B = 100,000,000 * 0.15 / 68,500        = 219.0   → floor = 219 주

Q_i = min(416, 219) = 219 주
```

`γ_max_alloc` 제약이 바인딩.

---

## 2. 가변형 트레일링 스탑 (Dynamic Trailing Stop)

### 수식

```
Exit_Price(t) = max(
                  Entry_Price - β * ATR(t_0),
                  max_{τ ∈ [t_0, t]}(Price(τ)) - θ * ATR(t)
                )
```

| 파라미터 | 기본값 | 의미 |
|----------|--------|------|
| `β` | 2.0 | 초기 손절선 ATR 배수 |
| `θ` | 1.5 | 트레일링 추적 ATR 배수 |

### 작동 방식

1. 진입 직후: `Entry - β · ATR(t_0)` 가 손절선
2. 가격이 상승하여 신고가 갱신 시: 신고가 - θ · ATR(t) 로 손절선 상향
3. 가격이 손절선 터치 시: 시장가 매도 시뮬레이션 즉시 송출

### Arm Delay

- 진입 후 최소 5분간 트레일링 비활성 (즉시 손절 회피)
- 그 이후 매 5초마다 손절선 재계산

### 예시

- Entry = 68,500, ATR = 1,200, β=2.0 → 초기 손절 65,100
- 가격이 70,000 까지 상승 (신고가) → 새 손절선 = 70,000 - 1.5 × 1,200 = 68,200
- 가격이 69,500 으로 하락 → 손절 미발동 (69,500 > 68,200)
- 가격이 68,100 도달 → 손절 발동 → 시장가 매도 시뮬

---

## 3. 전역 회로 차단기 (Global Circuit Breaker)

### 트리거 조건

```
if (day_start_equity - current_equity) / day_start_equity >= 0.015:
    activate_circuit_breaker()
```

기본 임계: **일일 손실 1.5%**. `risk-policy.json.daily_loss_circuit_breaker.threshold_pct_of_day_start_equity` 로 변경.

### 활성화 시 동작

1. **신규 사이클 거부**: 모든 `cycle/analyze/order` mode 차단
2. **보유 포지션 청산 시뮬**: 모든 open position 에 대해 시장가 매도 명령서 생성 (`workspace/_circuit_breaker/<timestamp>/*.json`)
3. **에이전트 오프라인**: 17 에이전트 모두 `LOCKED_DOWN` 상태로 전환
4. **감사 알림**: `logs/audit/circuit_breaker-<timestamp>.jsonl` 에 cause + equity curve 기록
5. **사용자 알림**: telegram + email (compliance.json 참조)

### 해제

```
/barrotrade init --unlock --confirm
```

- 사용자 명시 확인 + 사유 입력 필수
- 해제 직후 30분간 cycle mode 만 허용 (관찰 기간)
- 해제 이력은 `logs/audit/unlock_history.jsonl` 영구 보존

---

## 4. 포트폴리오 제약

| 항목 | 한도 |
|------|------|
| `max_concurrent_positions` | 8 |
| `max_sector_concentration_pct` | 35% (단일 섹터) |
| `max_single_ticker_pct` | 15% |
| `min_cash_buffer_pct` | 10% |
| `leverage_max` | 1.0 (배율 거래 금지) |
| `short_selling` | false |

### 사전 체크

`portfolio-pm` 가 주문 시뮬 생성 전에 위 한도 위반 여부를 자동 검사. 위반 시 사이즈 자동 축소 또는 차단.

---

## 5. Monte Carlo 스트레스 테스트

### 시나리오

- `covid_2020_03`: 2020년 3월 코로나 폭락 (KOSPI -27%)
- `fed_pivot_2022`: 2022년 6월 연준 75bp 인상
- `korea_blackout_2024_q3`: 가상 시나리오 (한국 시장 블랙스완)

### 절차

1. 현재 포트폴리오에 시나리오 가격 충격 적용
2. 1,000회 Monte Carlo 시뮬 (`risk-policy.json.monte_carlo_stress_test.min_simulations`)
3. 시나리오별 최악의 5% 손실(VaR 95%) 산출
4. `fail_threshold_drawdown_pct = 8.0%` 초과 시 신규 매수 자동 차단

### 실행 트리거

- 신규 사이클 시작 시 (cached, 1시간 TTL)
- 매주 일요일 0시 정기 실행

---

## 6. 체결 제약 (Execution Constraints)

| 항목 | 한도 | 비고 |
|------|------|------|
| `max_slippage_tolerance_bps` | 15 | 슬리피지 0.15% 초과 시 시장가 → 지정가 전환 |
| `min_order_value_krw` | 100,000 | 더 작으면 주문 비효율 |
| `max_order_value_per_cycle_krw` | 100,000,000 | 사이클당 1억 KRW 상한 (HITL 무관) |
| `limit_order_offset_bps_from_mid` | 5 | 지정가 주문 시 mid-price ±5bps |
| `cancel_replace_max_per_minute` | 4 | API rate limit 보호 |

---

## 7. 리스크 결과 코드

`60_risk_check.md` 의 `risk_status` 필드는 다음 중 하나:

| 코드 | 의미 | 대응 |
|------|------|------|
| `PASS` | 모든 게이트 통과 | Stage VI (portfolio-pm) 진입 |
| `FAIL_POSITION_TOO_LARGE` | Q_i > γ_max 한도 | 자동 사이즈 축소 후 재계산, 그래도 위반 시 차단 |
| `FAIL_SECTOR_OVER_CONCENTRATED` | 섹터 ≥ 35% | 차단, reflection 트리거 |
| `FAIL_MAX_DRAWDOWN_HIT` | 회로 차단기 발동 | LOCKED_DOWN, 사용자 unlock 대기 |
| `FAIL_MONTE_CARLO` | VaR 95% > 8% | 신규 매수 차단, 기존 포지션 trailing tighten |
| `FAIL_CASH_BUFFER_VIOLATED` | 현금 비중 < 10% | 신규 매수 차단 |
| `FAIL_LEVERAGE_VIOLATION` | 배율 > 1.0 | 즉시 차단 |
| `FAIL_INSUFFICIENT_DATA` | ATR 산출 불가 (상장 N일 미만) | 데이터 보강 또는 사이클 종료 |

---

## 8. Audit Log 스키마 (logs/risk/<cycle>.jsonl)

```json
{
  "ts_utc": "2026-05-25T05:32:11Z",
  "cycle_id": "2026-05-25-005930",
  "ticker": "005930",
  "stage": "risk_check",
  "atr_14": 1200,
  "computed_Q_i": 219,
  "trailing_stop_initial": 66100,
  "circuit_breaker_status": "armed",
  "monte_carlo_var95_pct": 6.2,
  "sector_concentration_pct": 22.3,
  "cash_buffer_pct": 14.8,
  "risk_status": "PASS",
  "reason_codes": []
}
```
