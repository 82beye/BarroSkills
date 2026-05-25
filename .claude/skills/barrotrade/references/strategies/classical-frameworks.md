# 클래식 프레임워크 + TradingView 인기 전략 (Classical Frameworks)

100년 검증된 클래식 + TradingView 에서 가장 많이 사용되는 indicator 기반 전략. 추세·되돌림·다중 시간프레임 접근법.

---

## 1. Wyckoff Method (Richard D. Wyckoff, 1873~1934)

**원리**: 시장은 4단계 사이클 — Accumulation (축적) → Markup (상승) → Distribution (분배) → Markdown (하락). 기관(Composite Operator) 의 행동을 추적.

### 4 Phase 식별

```
가격 ▲
     │         ★ UTAD (Distribution 마무리)
     │      ●●●     ●●
     │    ●●          ●●●  Markdown
Markup    ●            ●●●
     │ ●  ★ Sign of Strength (Markup 시작)
     │
     │ ●●●  ★ Spring (Accumulation 마무리)
     │     ●●● Accumulation Phase
     └────────────────────────────────► 시간
```

### Accumulation Phase 식별 (매수 진입 단계)

```python
# Wyckoff Accumulation 6 sub-phases
phase_PS  = preliminary_support       # 첫 매수 흔적
phase_SC  = selling_climax            # 마지막 패닉 매도
phase_AR  = automatic_rally           # 기술적 반등
phase_ST  = secondary_test            # SC 저점 재테스트
phase_SOS = sign_of_strength          # 본격 매수 시그널
phase_LPS = last_point_of_support     # 최종 지지선

# 정량 식별
def is_accumulation_phase(candles):
    sc = find_selling_climax(candles)  # 거래량 폭증 + 큰 음봉
    ar = find_auto_rally_after(sc)     # SC 후 거래량 감소 반등
    st = find_secondary_test(ar)       # AR 후 SC 저점 재테스트
    sos = find_sign_of_strength(st)    # ST 후 신고가 + 거래량
    return all([sc, ar, st, sos])
```

### Spring (가장 강력한 진입 시점)

```python
# Spring: ST 의 저점 아래로 잠시 이탈 후 강한 반등
def detect_spring(accumulation_range):
    range_low = min(low[accumulation_period])
    spring = (
        current_low < range_low ∧                # 하단 이탈 (wick)
        current_close > range_low ∧               # 종가는 회복
        volume_spike > avg_volume × 2 ∧           # 거래량 폭증
        next_3_bars_bullish                       # 후속 반등 confirm
    )
    return spring

entry_at_spring = spring
stop = spring_low - 0.5 * ATR(14)
target = accumulation_range_top * 1.3  # range top 위 30%
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | Spring low - 0.5 ATR |
| 익절 1차 | Accumulation range 상단 |
| 익절 2차 | Markup phase 의 가속 마무리 (parabolic) |
| 시장 손절 | UTAD (Upthrust After Distribution) 발견 시 |

### BarroTrade 통합

- `barrotrade-trend-expert` 의 신규 phase detector
- `barrotrade-macro-specialist` 의 거시 regime 과 매핑:
  - Accumulation → regime_3 끝물 / regime_1 초입
  - Markup → regime_1
  - Distribution → regime_1 끝물
  - Markdown → regime_2 또는 regime_4

### 약점

- Phase 식별 주관적 (Wyckoff 의 textbook 패턴이 명확히 적용 안 되는 경우 다수)
- 시간 소요 (Accumulation 만 수개월~수년)

---

## 2. Elliott Wave (Ralph Nelson Elliott, 1938)

**원리**: 시장은 5 파동 상승 (Impulse) + 3 파동 조정 (Correction) 의 fractal pattern 으로 움직임.

### 5+3 파동 구조

```
                 ●5  ◄── 마지막 임펄스
              ╱ ╲
           ● 4 ╲
          ╱     ●a
        ●3     ╱ ╲
        ╱     ●b ●c
     ●2      
      ╲    
    ╱  ●1
   ●  
  Start (0)
```

### 진입 조건 (Wave 3 진입 — 가장 강력)

```python
# Wave 1: 초기 임펄스 (small)
wave_1 = (price_start_to_first_high) ∧ volume_increase

# Wave 2: 조정 (Wave 1 의 0.382 ~ 0.618 retracement)
wave_2 = retrace_38_61 of wave_1

# Wave 3 진입 (가장 큰 임펄스)
# 규칙: Wave 3 는 Wave 1 의 1.618 배 이상
wave_3_min_target = wave_1_high + 1.618 * (wave_1_high - wave_1_low)
wave_3_max_target = wave_1_high + 2.618 * (wave_1_high - wave_1_low)

# Wave 3 진입 시점: Wave 2 의 0.382 ~ 0.50 retracement 종료 시점
entry_long = (
    wave_2_retracement >= 0.382 ∧
    wave_2_retracement <= 0.618 ∧
    bullish_reversal_pattern_at_retracement
)
stop = wave_2_low - 0.5 * ATR
target_1 = wave_3_min_target  # 1.618 × wave_1
target_2 = wave_3_max_target  # 2.618 × wave_1
```

### Elliott 의 3 절대 룰

1. **Wave 2 는 Wave 1 을 완전히 retrace 하지 않는다** (overlap 시 패턴 무효)
2. **Wave 3 는 Wave 1, 3, 5 중 가장 짧지 않다** (보통 가장 길음)
3. **Wave 4 는 Wave 1 의 영역과 overlap 하지 않는다** (Impulse 패턴 한정)

### 청산

| 항목 | 값 |
|------|----|
| 손절 | Wave 2 low (rule 1 위반) |
| 익절 | Wave 3 의 1.618 / 2.618 fibonacci extension |
| Wave 4 대기 | Wave 3 종료 후 Wave 4 조정 → Wave 5 진입 재진입 |

### BarroTrade 통합

- `barrotrade-pattern-expert` 의 신규 `detect_elliott_wave()`
- 피보나치 모듈 재사용 (38스윙 에서 이미 구현)
- 결정 신뢰도 낮음 (Elliott Wave 식별 주관적) — `confidence` 자동 ≤ 0.6 라벨

### 약점

- 식별 모호함 (한 차트에서 여러 파동 카운트 가능)
- TradingView 의 자동 Elliott Wave indicator 도 정확도 낮음

---

## 3. Ichimoku Cloud (Goichi Hosoda, 1969)

**원리**: 5 라인의 종합 시스템 — 추세 + 모멘텀 + 지지/저항 + 미래 예측 동시 표시.

### 5 라인 정의

```python
# 1) Tenkan-sen (전환선): 9일 (high + low) / 2
tenkan = (high.rolling(9).max() + low.rolling(9).min()) / 2

# 2) Kijun-sen (기준선): 26일
kijun = (high.rolling(26).max() + low.rolling(26).min()) / 2

# 3) Senkou Span A (선행 스팬 A): (tenkan + kijun) / 2, 26 forward
span_A = ((tenkan + kijun) / 2).shift(-26)

# 4) Senkou Span B (선행 스팬 B): 52일 (high + low) / 2, 26 forward
span_B = ((high.rolling(52).max() + low.rolling(52).min()) / 2).shift(-26)

# 5) Chikou Span (지행 스팬): 종가, 26 backward
chikou = close.shift(26)

# Cloud (Kumo)
cloud_top = max(span_A, span_B)
cloud_bottom = min(span_A, span_B)
cloud_color = 'green' if span_A > span_B else 'red'  # 미래 추세 예측
```

### 진입 조건 (TK Cross + Cloud Breakout)

```python
# Bullish signal: 5 confirmation
bullish_signals = (
    tenkan crosses_above kijun ∧               # TK cross
    price > cloud_top ∧                        # 가격 cloud 위
    cloud_color == 'green' ∧                   # future cloud green
    chikou > price.shift(26) ∧                 # 지행 스팬이 26일 전 가격 위
    volume_confirm  # 거래량 동반
)

# 진입 강도
strong_signal = all 5 conditions
medium_signal = 4 conditions
weak_signal = 3 conditions

entry = strong_signal or medium_signal
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | Cloud 하단 이탈 |
| Trailing | Kijun (26일) 또는 Cloud bottom |
| 익절 | TK cross 하향 (Bearish signal) |
| 평균 보유 | 4~12주 (스윙) |

### BarroTrade 통합

- `barrotrade-trend-expert` 의 신규 `compute_ichimoku()`
- 일봉/주봉 multi-TF: 주봉 cloud + 일봉 TK cross 일치 시 강력
- 미래 cloud color 변화는 거시 regime 전환 선행 지표

### TradingView Indicator

- **Ichimoku Cloud** (built-in) — Free, 가장 인기 indicator

---

## 4. SuperTrend (Olivier Seban, 2010)

**원리**: ATR 기반 추세 라인. 가격이 SuperTrend 위면 상승 추세, 아래면 하락. 매우 단순하지만 효과적.

### 계산

```python
# 1) Basic Bands
hl_avg = (high + low) / 2
multiplier = 3.0  # ATR 배수 (기본값)
atr_period = 10

basic_upper = hl_avg + multiplier * ATR(atr_period)
basic_lower = hl_avg - multiplier * ATR(atr_period)

# 2) Final Bands (이전 값 고려한 smoothing)
final_upper = min(basic_upper, prev_final_upper) if prev_close <= prev_final_upper else basic_upper
final_lower = max(basic_lower, prev_final_lower) if prev_close >= prev_final_lower else basic_lower

# 3) SuperTrend 라인
if prev_supertrend == prev_final_upper:
    supertrend = final_upper if close <= final_upper else final_lower
else:
    supertrend = final_lower if close >= final_lower else final_upper

# 4) 방향
direction = 'up' if close > supertrend else 'down'
```

### 진입 조건

```python
# Direction flip = 진입 신호
prev_direction = 'down'
curr_direction = 'up'
flip_to_up = (prev_direction == 'down' and curr_direction == 'up')

# 추가 필터
volume_confirm = volume > avg_volume * 1.3
above_50ma = price > MA50

entry_long = flip_to_up ∧ volume_confirm ∧ above_50ma
stop = supertrend_value at entry
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | Direction flip 'up' → 'down' |
| 익절 | (없음, trailing trend exit) |
| Multi-TF | 일봉 'up' + 4시간 'up' 시 holding 강화 |

### 파라미터 튜닝

| 파라미터 | 단타 | 스윙 | 장기 |
|---------|-----|------|-----|
| atr_period | 7 | 10 | 14 |
| multiplier | 2.0 | 3.0 | 4.0 |

### BarroTrade 통합

- `barrotrade-trend-expert` 의 SuperTrend indicator 추가
- 단순함 + 효과 → `barrotrade-quick-decider` 의 빠른 추세 확인용 ideal
- 자가 진화 후보 파라미터: `multiplier`, `atr_period`

### TradingView Indicator

- **SuperTrend** (built-in) — Free, 가장 사랑받는 추세 indicator

---

## 5. Anchored VWAP (AVWAP)

**원리**: 특정 이벤트(어닝·뉴스·고점·저점) 기준점에서 VWAP 시작. 그 이벤트 이후 누적 평균 매매가를 추적.

### Anchor Point 선택

```python
# 1) 어닝 발표일
anchor_earnings = earnings_announcement_date

# 2) 신고가 또는 신저가
anchor_high = date_of_recent_swing_high
anchor_low = date_of_recent_swing_low

# 3) 거시 이벤트
anchor_fed = fed_meeting_date
anchor_news = major_news_event_date

# AVWAP 계산
def compute_avwap(candles, anchor_date):
    anchored = candles[anchor_date:]
    cumulative_pv = (anchored.close * anchored.volume).cumsum()
    cumulative_v = anchored.volume.cumsum()
    return cumulative_pv / cumulative_v
```

### 진입 조건

```python
# AVWAP from swing low (Long entry 후보)
avwap_from_low = compute_avwap(candles, swing_low_date)

# 가격이 AVWAP 위에서 retrace 후 AVWAP tap
above_avwap = price > avwap_from_low
recent_high_above_avwap = max(high[last_10]) > avwap_from_low * 1.05
current_tap = avwap_from_low * 0.99 <= price <= avwap_from_low * 1.01

bullish_candle_at_tap = current_close > current_open

entry_long = above_avwap ∧ recent_high_above_avwap ∧ current_tap ∧ bullish_candle_at_tap
stop = avwap_from_low * 0.99 - 0.5 * ATR
target = recent_high_above_avwap
```

### Multi-Anchor Confluence

```
가장 강력한 시그널: 여러 AVWAP 이 동일 가격대에 수렴
- AVWAP from earnings (지난 분기 어닝)
- AVWAP from swing high
- AVWAP from yearly low

세 AVWAP 이 ±0.5% 이내로 수렴 → high-probability support/resistance
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | AVWAP - 0.5 ATR |
| 익절 | Recent swing high |
| 시간 손절 | 진입 후 5봉 AVWAP 미회복 시 청산 |

### BarroTrade 통합

- `barrotrade-data-preprocessor` 의 신규 `compute_avwap(anchor)` 메서드
- Anchor 자동 식별: `barrotrade-event-driven-expert` 가 어닝·뉴스 시점 출력
- `barrotrade-pattern-expert` 의 multi-anchor confluence 검색

### TradingView Indicator

- **Anchored VWAP** (built-in) — Pro 계정 필요
- **VWAP Anchored** (Brian Shannon original) — open-source variant 다수

### Brian Shannon (Anchored VWAP 의 현대적 보급자)

- "Maximum Trading Gains with Anchored VWAP" 저자
- @AlphaTrends YouTube
- 어닝일 AVWAP + 신고가 AVWAP 결합이 핵심
- 한국 시장 적용 시 어닝 발표일 (분기 보고서 제출) 명확

---

## 보너스: Heikin-Ashi Smoothed

**원리**: 일반 캔들의 노이즈를 제거한 평활 캔들. 추세 식별 우수.

```python
# Heikin-Ashi 캔들
ha_close = (open + high + low + close) / 4
ha_open  = (prev_ha_open + prev_ha_close) / 2
ha_high  = max(high, ha_open, ha_close)
ha_low   = min(low,  ha_open, ha_close)

# 추세 식별: 연속 양봉/음봉
ha_green = ha_close > ha_open
ha_red = ha_close < ha_open

# 강한 추세: 5봉 연속 동일 색 + 아래꼬리/위꼬리 없음
strong_uptrend = (
    all(ha_green for last 5 bars) ∧
    all(ha_low == ha_open for last 5 bars)  # 아래꼬리 없음
)
```

### BarroTrade 통합

- `barrotrade-data-preprocessor` 의 보조 캔들 형식
- `barrotrade-trend-expert` 가 일반 캔들 + HA 캔들 둘 다 봄
- 추세 confirm 용 보조 지표 (단독 진입 X)

---

## 카테고리 공통 룰

| 항목 | 값 |
|------|----|
| 시간프레임 | 일봉 주력, multi-TF confluence 의무 |
| 보유 기간 | 1주 ~ 6개월 (스윙 위주) |
| 손절 | ATR 기반 또는 구조적 무효화 시점 |
| 익절 | Trailing trend exit (Ichimoku/SuperTrend) 또는 fixed R:R (Elliott) |
| 핵심 원칙 | "노이즈 무시하고 큰 흐름 따라간다" |

## BarroTrade Strategy 에이전트 매핑

| 전략 | 1차 에이전트 | 2차 결합 |
|------|------------|---------|
| Wyckoff | barrotrade-trend-expert | barrotrade-macro-specialist (regime) |
| Elliott Wave | barrotrade-pattern-expert | barrotrade-fundamental-specialist (낮은 confidence) |
| Ichimoku | barrotrade-trend-expert | barrotrade-multi-tf-checker |
| SuperTrend | barrotrade-trend-expert | barrotrade-quick-decider (빠른 추세 확인) |
| Anchored VWAP | barrotrade-data-preprocessor | barrotrade-event-driven-expert (anchor 시점) |
| Heikin-Ashi | barrotrade-data-preprocessor (보조) | barrotrade-trend-expert (확인) |

## TradingView Indicator 우선순위

| Indicator | 인기도 | 본 스킬 활용도 |
|-----------|-------|-------------|
| Ichimoku Cloud | ⭐⭐⭐⭐⭐ | 높음 (multi-signal) |
| SuperTrend | ⭐⭐⭐⭐⭐ | 매우 높음 (단순+효과) |
| Anchored VWAP | ⭐⭐⭐⭐ | 높음 (이벤트 기반) |
| Wyckoff Phases | ⭐⭐⭐ | 중간 (식별 주관적) |
| Elliott Wave (auto) | ⭐⭐ | 낮음 (자동 식별 부정확) |

## 한국 시장 캘리브레이션

| 요소 | 미국 시장 | 한국 시장 (KRX) |
|------|----------|----------------|
| Ichimoku 기본값 | 9/26/52 | 7/22/44 (시장 일수 차이 보정) |
| SuperTrend ATR | 10/3.0 | 10/2.5 (변동성 차이) |
| AVWAP anchor | 어닝 분기 | 분기 보고서 제출일 (DART) |
| Wyckoff phase 기간 | 수개월~수년 | 한국은 사이클 빨라 1.5~2개월 단축 |

---

## 다중 전략 컨플루언스 (Strategy Stacking)

가장 강력한 시그널은 **여러 카테고리 전략이 동시 발생**할 때:

```
일봉 SuperTrend 'up'         (classical)
+ Wyckoff Accumulation Spring  (classical)
+ Order Block tap              (SMC)
+ FVG fill at OB              (SMC)
+ Premium/Discount: Discount   (SMC)
+ Bullish CHoCH on 4H          (SMC)
+ Volume Dry-Up                (VCP — Minervini)
+ Pivot Breakout               (VCP, Darvas)

→ Signal Strength: 0.95+
→ barrotrade-quick-decider 즉시 GO 권고
→ position size: max 가능 (gamma_max_alloc 한도 내)
```

이런 confluence 가 한 사이클에 발생할 확률은 낮지만 (월 1~2회), 발생 시 hit rate ≥ 80% 가능.
