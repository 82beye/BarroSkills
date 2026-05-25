# 글로벌 스윙 트레이더 전략 (Global Swing Traders)

보유 기간 2주 ~ 6개월, 일봉·주봉 위주의 정통 스윙 트레이딩. 펀더멘털 + 기술적 분석 결합. 미국 IBD(Investor's Business Daily) 계열 + 유럽 단타 마스터.

---

## 1. VCP — Volatility Contraction Pattern (Mark Minervini)

**트레이더**: Mark Minervini (2회 US Investing Champion, "Trade Like a Stock Market Wizard" 저자)
**원리**: 상승 추세 종목이 점진적으로 좁아지는 변동성 수축 패턴을 형성 → 거래량 감소 → 신고가 돌파 시 폭발적 상승.

### 패턴 식별

```
가격 패턴:
   ▲     ◄── BASE (큰 베이스 30~50% 변동)
   █ ▲
   █ █     ◄── Contraction 1: 25% 변동
   █ █ ▲
   █ █ █   ◄── Contraction 2: 12% (T2 ≈ T1 × 0.5)
   █ █ █ ▲
   █ █ █ █  ◄── Contraction 3: 6% (T3 ≈ T2 × 0.5)
   ━━━━━━━━━━━━━━━━━ ◄── Pivot Point (돌파 지점)
```

### 진입 조건

```python
# 1) Trend Template (Minervini 8 조건, 사전 필터)
above_150_200_MA   = price > MA150 ∧ price > MA200
MA150_above_MA200  = MA150 > MA200
MA200_uptrend      = MA200_now > MA200_30days_ago
above_50MA         = price > MA50
distance_from_low  = (price - low_52w) / low_52w >= 0.30
distance_from_high = (price - high_52w) / high_52w >= -0.25  # 신고가 75% 이내
RS_rating          >= 70  # Relative Strength vs S&P500 (한국: KOSPI 대비)
liquidity          >= 100_000_000 daily volume (KR: 거래대금 100억 이상)

template_pass = all(above 8 conditions)

# 2) VCP 식별
contractions = []
for window in [10, 20, 40 days]:
    high = high.rolling(window).max()
    low = low.rolling(window).min()
    contractions.append((high - low) / low)

# 점진 수축 확인 (각 단계 ≤ 이전 × 0.5)
shrinking = contractions[2] <= contractions[1] * 0.5 <= contractions[0] * 0.5

# 3) 거래량 (Dry-Up)
recent_avg_volume = volume.tail(5).mean()
volume_dry_up = recent_avg_volume < volume.rolling(50).mean() * 0.6

# 4) Pivot Breakout
pivot = max(high[last_contraction_period])
breakout = price > pivot ∧ volume > avg_volume × 1.4  # +40% volume surge

signal = template_pass ∧ shrinking ∧ volume_dry_up ∧ breakout
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | -7~-8% (절대 -10% 미만, Minervini 룰) |
| 1차 익절 | +20~25% (1/3 청산) |
| 2차 익절 | +50% (1/3 청산) |
| 잔량 | Trailing 10일 이평선 또는 50일 이평선 |
| 보유 기간 | 평균 6~12주 |

### Risk:Reward

```
target_minimum = entry * 1.20  (+20%)
stop = entry * 0.93           (-7%)
R:R = (target - entry) / (entry - stop) ≈ 2.86:1
```

### BarroTrade 통합

- `barrotrade-fundamental-specialist` 의 신규 메서드 `compute_trend_template()`
- `barrotrade-pattern-expert` 의 `detect_vcp()` — 3 단계 수축 식별
- `barrotrade-rag-analyst` 의 RS rating 산출 (KOSPI 대비 상대 강도)

### 약점

- VCP 후 신고가 돌파 실패 (false breakout) → 즉시 -7% 손절
- 8조건 Template 너무 엄격해 한국 중소형주 적용 시 후보 부족

---

## 2. SEPA — Specific Entry Point Analysis (Mark Minervini)

**원리**: VCP 의 진입 정확도를 극대화하는 framework. **Volume Confirmation + Pivot + Risk Sizing** 의 결합.

### Pivot 정확도 향상

```python
# 1) Standard Pivot (전통적)
standard_pivot = max(high[base_period])

# 2) Aggressive Entry (Minervini 권장)
aggressive_pivot = max(high[last_3_days]) + 0.10  # 직전 3일 고점 + $0.10

# 3) Conservative Entry
conservative_pivot = standard_pivot + 0.5 × ATR  # 1차 돌파 후 0.5 ATR 추가

# 진입 강도 선택
if signal_confidence >= 0.85:
    entry_price = aggressive_pivot
elif signal_confidence >= 0.7:
    entry_price = standard_pivot
else:
    entry_price = conservative_pivot
```

### Position Sizing (SEPA 핵심)

```python
# Risk per trade ≤ 1% of total equity
max_loss_dollars = total_equity * 0.01

# Position size 결정
risk_per_share = entry_price - stop_loss_price
shares = max_loss_dollars / risk_per_share

# Maximum position size cap
shares = min(shares, total_equity * 0.25 / entry_price)  # 종목당 25% 한도
```

### BarroTrade 통합

- `barrotrade-risk-manager` 의 ATR 사이징 공식과 동일 (이미 구현됨)
- VCP 신호 발생 시 `barrotrade-portfolio-pm` 가 SEPA 사이즈 자동 계산
- `risk-policy.json.gamma_max_alloc_per_ticker: 0.15` 와 충돌 시 보수적 값 (0.15) 우선

---

## 3. CANSLIM (William J. O'Neil)

**트레이더**: William O'Neil ("How to Make Money in Stocks", IBD 창업자)
**원리**: 7개 펀더멘털·기술적 요소의 약어. 1953~2003 100+ 슈퍼 종목 분석 후 도출.

### 7 요소

| 글자 | 의미 | 임계 |
|------|------|------|
| **C** | **Current Earnings** | 분기 EPS YoY +25% 이상 |
| **A** | **Annual Earnings** | 3년 연속 연간 EPS +25% 이상 |
| **N** | **New Product/Service/High** | 신제품·신경영·신고가 |
| **S** | **Supply and Demand** | 발행주식 적음 + 거래량 증가 |
| **L** | **Leader or Laggard** | RS Rating 80+ (Leader) |
| **I** | **Institutional Sponsorship** | 기관 보유 증가 |
| **M** | **Market Direction** | 시장 전체 상승 추세 |

### 진입 조건 (정량화)

```python
C = quarterly_eps_yoy >= 0.25
A = (annual_eps_3y_avg_growth >= 0.25) ∧ all_3_years_positive
N = (new_52w_high in last_5_days) ∨ (new_product_news_30days)
S = (shares_outstanding <= 100_000_000) ∧ (recent_volume > avg_volume × 1.5)
L = RS_rating >= 80
I = institutional_ownership_quarterly_change > 0
M = SP500_above_200MA ∧ SP500_50MA > SP500_200MA   # 한국: KOSPI 200MA

canslim_score = sum([C, A, N, S, L, I, M])  # /7

entry = canslim_score >= 6 ∧ cup_with_handle_breakout
```

### Cup-with-Handle (O'Neil 의 핵심 패턴)

```
신고가 ─────●─────── ◄── handle 형성 후 돌파
             ╲       ╱
              ╲    ╱
               ╲ ╱
              ╱╲╱   ◄── handle: 신고가 -8~12% 작은 횡보
             ╱  ╲  
            ╱    ╲
       ───●        ●─── ◄── cup 저점 (신고가 대비 -12~33%)
         5~50주 동안 형성
```

```python
# Cup 식별
cup_left_high = high_at_T_minus_30_to_50_weeks
cup_low = min(low[cup_period])
cup_right_high = recent_high
cup_depth = (cup_left_high - cup_low) / cup_left_high

valid_cup = (0.12 <= cup_depth <= 0.33) ∧ (cup_right_high >= cup_left_high * 0.98)

# Handle 식별 (cup 직후 좁은 횡보)
handle_period = 1..6 weeks
handle_depth = (cup_right_high - handle_low) / cup_right_high
valid_handle = handle_depth <= 0.12

# Pivot
pivot = cup_right_high + 0.10  # 신고가 + $0.10
breakout = price > pivot ∧ volume > avg_volume × 1.5

signal = canslim_score >= 6 ∧ valid_cup ∧ valid_handle ∧ breakout
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | -7~-8% (O'Neil 룰: -8% 절대값 금지) |
| 익절 1차 | +20~25% (1/3 청산) |
| 익절 2차 | +50% (1/3 청산) |
| 잔량 | 10주 이동평균 또는 50일선 trailing |
| 시장 손절 | 시장 distribution day 카운트 ≥ 5 시 전량 청산 |

### BarroTrade 통합

- `barrotrade-fundamental-specialist` 의 CANSLIM 7요소 자동 계산
- `barrotrade-pattern-expert` 의 `detect_cup_with_handle()`
- 한국 시장: DART 분기보고서 + IBD-style RS rating (KRX 전체 vs KOSPI)

### 약점

- 분기 어닝 발표 시점 의존 → 한국 시장 발표 지연 (40일 후)
- 한국 중소형주는 institutional ownership 데이터 부족

---

## 4. Stage Analysis (Stan Weinstein)

**트레이더**: Stan Weinstein ("Secrets for Profiting in Bull and Bear Markets", 1988)
**원리**: 모든 종목은 4 단계 사이클을 거친다 — 매수는 Stage 2, 매도는 Stage 4 회피.

### 4 Stage 정의

```
가격 ▲
     │
     │   Stage 3 (꼭대기/Distribution)
     │ ●●●●●●●●●●●●
     │ ●         ●●●●
Stage 2 (상승/Markup)            Stage 4 (하락/Markdown)
     │●                ●●
     │                   ●●
     │ Stage 1 (바닥/Accumulation) ●●●●●
     │ ●●●●●●●●●●                       ●●●●●●●●●●●●●
     │                                                  ●●●●●●●
     └─────────────────────────────────────────────────────────► 시간
                                       30주 이평선 (MA30 weekly)
```

### Stage 식별

```python
# 주봉 30주 이동평균 (= 일봉 150일 이평선)
MA30_weekly = close.rolling(30, freq='W').mean()

# Stage 1: 횡보 + MA30 평탄
stage1 = (
    abs(MA30_weekly_slope) < 0.001 ∧
    price oscillating around MA30 ∧
    duration_weeks >= 13
)

# Stage 2: 상승 + 30주선 상향 돌파
stage2 = (
    price > MA30_weekly ∧
    MA30_weekly_slope > 0.005 ∧
    breakout_volume > avg_volume × 1.5 ∧
    relative_strength_uptrend
)

# Stage 3: 꼭대기 + 평탄화
stage3 = (
    price oscillating ∧
    MA30_weekly_slope decelerating ∧
    distribution_days_count >= 3
)

# Stage 4: 하락
stage4 = (
    price < MA30_weekly ∧
    MA30_weekly_slope < 0
)
```

### 진입 (Stage 2 시작 시점)

```python
buy_signal = (
    stage1_to_stage2_transition ∧
    price > 30_week_MA ∧
    30_week_MA_upward_sloping ∧
    breakout_above_resistance ∧
    volume_surge >= avg_volume × 2
)
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | Stage 1 의 직전 swing low |
| 익절 | Stage 3 진입 신호 (MA30 평탄화 + distribution) |
| 시장 손절 | 시장 지수가 Stage 4 진입 시 전량 |
| 평균 보유 | 6~24개월 (장기 스윙) |

### BarroTrade 통합

- `barrotrade-macro-specialist` 가 시장 stage 식별 (KOSPI Stage)
- `barrotrade-trend-expert` 의 신규 메서드 `detect_stage()` — 종목별 stage 라벨링
- 거시 regime 매핑:
  - Stage 1 → regime_3 (박스권)
  - Stage 2 → regime_1 (고성장)
  - Stage 3 → 회피
  - Stage 4 → 회피 또는 회로 차단기

### 약점

- 30주 이평선 기준 → 단기 트레이딩 불가
- Stage 1 ↔ Stage 2 전환 판별 모호 (whipsaw 가능)

---

## 5. Darvas Box (Nicolas Darvas)

**트레이더**: Nicolas Darvas (1956~1957, $36k → $2.25M 공개, "How I Made $2,000,000 in the Stock Market")
**원리**: 신고가 종목이 좁은 박스권을 형성 → 박스 상단 돌파 시 매수, 박스 하단 이탈 시 손절.

### Box 식별

```python
# 1) 신고가 (52주 신고가 또는 6개월 신고가)
new_high = max(high[252])  # 52주

# 2) 박스 형성 (최소 3 거래일 동안 신고가 미경신 + 좁은 횡보)
box_period = 3..21 days
box_high = max(high[box_period])
box_low = min(low[box_period])
box_size = (box_high - box_low) / box_low

valid_box = (
    box_size <= 0.10 ∧                # 박스 크기 ≤ 10%
    box_high == new_high ∧             # 박스 상단이 신고가
    box_low > new_high * 0.93          # 박스 깊이 ≤ 7%
)
```

### 진입

```python
breakout = (
    valid_box ∧
    price > box_high + 0.5 × ATR(14) ∧  # 박스 + 0.5 ATR 돌파
    volume > avg_volume × 1.3
)
```

### 트레일링 (Darvas 의 핵심)

```python
# 새 box 가 형성되면 stop을 이전 box high 로 상향
boxes = []
entry_box = current_box
stop = entry_box.low

while price_rising:
    if new_higher_box_formed():
        boxes.append(new_box)
        stop = new_box.low  # stop 자동 상향
    if price < stop:
        exit_at_stop
        break
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | 최신 박스 하단 |
| 익절 | "Trade until the trend breaks" — 추세 종료까지 trailing |
| 평균 보유 | 1~6개월 |

### BarroTrade 통합

- `barrotrade-pattern-expert` 의 `detect_darvas_box()` — 박스 식별 및 trailing
- 다중 box 추적: `workspace/<cycle>/darvas_boxes.jsonl` (박스 형성 이력)

### 약점

- 박스 형성 기간 모호 (3~21일 범위 안에서 운영자 판단 필요)
- 거짓 돌파 후 박스 내부 회귀 빈번

---

## 6. Tight Consolidation Breakout (Kristjan Kullamägi / Qullamaggie)

**원리**: 강한 상승 임펄스(prior move) 후 매우 좁은 횡보(tight consolidation) → 돌파 시 second leg up.

### 패턴 식별

```python
# 1) Prior Move (선행 임펄스)
prior_move_period = 20..50 days
prior_move_gain = (price_now - price_at_start) / price_at_start >= 0.30  # +30~100%

# 2) Tight Consolidation
consolidation_period = 5..30 days
consolidation_range = (max(high[period]) - min(low[period])) / price
tight = consolidation_range <= 0.10  # 10% 이내

# 3) Volume Dry-Up
recent_volume_avg = volume.rolling(consolidation_period).mean()
volume_decline = recent_volume_avg < prior_move_volume_avg * 0.5

# 4) Breakout
breakout = price > consolidation_high ∧ volume > avg_consolidation_volume × 2

signal = prior_move_gain ∧ tight ∧ volume_decline ∧ breakout
```

### Qullamaggie 의 특수 룰

- **Prior Move 강도**: +30% 미만이면 무시 (큰 임펄스만)
- **Consolidation 깊이**: 10% 이내 (그 이상이면 분화)
- **ADR 트레일링**: Episodic Pivot 과 동일 (`global-day-traders.md` 참조)
- **Risk Per Trade**: 0.5R 시작, 1차 익절 후 추가 (피라미딩)

### 청산

| 항목 | 값 |
|------|----|
| 손절 | Consolidation low 또는 entry - 1 ADR |
| 1차 익절 | +1R 도달 시 1/3 청산 (break-even stop) |
| 2차 익절 | +2R 도달 시 1/3 청산 (1R trailing) |
| 잔량 | Trailing 10일 EMA |

### BarroTrade 통합

- `barrotrade-pattern-expert` 의 `detect_tight_consolidation()`
- VCP 와 유사하지만 prior move 크기 + consolidation 깊이 차이
- 한국 중소형주 적합 (변동성 높은 종목 우선)

---

## 카테고리 공통 룰 (스윙 마스터)

| 항목 | 값 |
|------|----|
| 시간프레임 | 일봉 주력, 주봉 보조 |
| 최소 보유 | 5 거래일 |
| 평균 보유 | 4~12주 |
| 손절 | -7~-8% 절대값 (Minervini/O'Neil 공통) |
| 익절 1차 | +20~25% (1/3 청산) |
| Risk:Reward | 최소 2.5:1 |
| Position Size | 1% Risk Rule (총자산의 1%만 단일 거래 risk) |
| 시장 손절 | 시장 distribution day ≥ 5 또는 50MA 하향 이탈 |

## BarroTrade Strategy 매핑

| 전략 | 1차 에이전트 | 2차 결합 |
|------|------------|---------|
| VCP | barrotrade-pattern-expert | barrotrade-fundamental-specialist (Trend Template) |
| SEPA | barrotrade-risk-manager | barrotrade-pattern-expert (VCP entry) |
| CANSLIM | barrotrade-fundamental-specialist | barrotrade-pattern-expert (Cup-with-Handle) |
| Stage Analysis | barrotrade-macro-specialist | barrotrade-trend-expert |
| Darvas Box | barrotrade-pattern-expert | barrotrade-trend-expert (trailing) |
| Tight Consolidation | barrotrade-pattern-expert | barrotrade-event-driven-expert (prior move) |

## Trend Template (Minervini) — 한국 시장 캘리브레이션

```python
# 한국 시장 적용 시 조정
KR_template = {
    "above_150_200_MA": True,
    "MA150_above_MA200": True,
    "MA200_uptrend": True,
    "above_50MA": True,
    "distance_from_low_52w": ">= 0.30",  # 동일
    "distance_from_high_52w": ">= -0.25", # 동일
    "RS_rating": ">= 70",  # KRX 전체 종목 대비 상대 강도
    "liquidity": "거래대금 일평균 100억원 이상"  # 미국 $50M 환산
}
```

본 스킬은 `barrotrade-fundamental-specialist` 가 위 조건을 자동 계산하여 후보 종목군에 라벨링.
