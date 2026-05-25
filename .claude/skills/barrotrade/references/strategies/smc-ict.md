# SMC / ICT 전략 (Smart Money Concept / Inner Circle Trader)

기관 수급 흐름을 추적하는 trade concept. TradingView 의 LuxAlgo, LonesomeTheBlue, ChartPrime 등 인기 indicator 의 기반 이론. 한국 시장(KRX) 적용 시 외국인·기관 매매 동향 데이터(`ka10008`, `ka10009`) 와 직접 매핑.

> 본 카테고리는 가격 행동(price action)이 기관의 의도된 행위라는 가정에 기반합니다. 군중 손절(retail liquidity)을 사냥한 후 진짜 추세가 시작된다는 관점.

---

## 1. Order Block (OB)

**개념**: 기관이 큰 포지션을 진입한 마지막 캔들. 가격이 그 구간으로 되돌아올 때 강한 지지/저항 작용.

### 식별

```python
# Bullish Order Block (매수 OB)
# 1) 강한 상승 임펄스 직전의 마지막 음봉
def find_bullish_ob(candles):
    for i in range(2, len(candles)):
        # 다음 3봉이 강하게 상승
        impulse = (candles[i+3].close - candles[i].close) / candles[i].close >= 0.02
        # 본 캔들이 음봉
        is_red = candles[i].close < candles[i].open
        if impulse and is_red:
            return {
                'ob_high': candles[i].high,
                'ob_low': candles[i].low,
                'ob_open': candles[i].open,
                'ob_close': candles[i].close,
                'created_at': candles[i].ts,
                'type': 'bullish'
            }

# Bearish Order Block (매도 OB)
# 강한 하락 직전의 마지막 양봉
def find_bearish_ob(candles):
    # ... (symmetric)
```

### 진입 조건

```python
# Bullish OB 재방문 진입
price_returns_to_ob = ob.low <= current_price <= ob.high
volume_at_ob_touch = volume > avg_volume * 1.5  # 거래량 확인
imbalance_below = check_fvg_below(ob)  # FVG 가 아래에 존재하면 더 강력

entry_long = price_returns_to_ob ∧ volume_at_ob_touch
stop_loss = ob.low - 0.5 * ATR(14)
take_profit_1 = recent_swing_high
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | OB low (Bullish) 또는 OB high (Bearish) 이탈 |
| 익절 1차 | 직전 swing high/low (1:2 R:R) |
| 익절 2차 | 다음 OB 또는 Liquidity Pool |

### BarroTrade 통합

- `barrotrade-pattern-expert` 의 `detect_order_block()`
- 외국인·기관 매매 동향 (`ka10008`, `ka10009`) 데이터로 OB 강도 가중치
- 4시간봉/일봉 OB 가 단기봉 OB 보다 강함 (multi-timeframe confluence)

### TradingView Indicator 참조

- **LuxAlgo: Smart Money Concepts (Premium)** — OB 자동 식별
- **LonesomeTheBlue: Order Block Indicator** — open-source

---

## 2. Fair Value Gap (FVG) / Imbalance

**개념**: 3봉 중 첫 봉의 high < 셋째 봉의 low (또는 그 반대) 일 때 발생하는 가격 갭. 미체결 매매가 남아있어 가격이 메우러 돌아오는 경향.

### 식별

```python
# Bullish FVG (gap up)
def is_bullish_fvg(c1, c2, c3):
    return c1.high < c3.low

# Bearish FVG (gap down)
def is_bearish_fvg(c1, c2, c3):
    return c1.low > c3.high

# FVG 영역
fvg_zone = {
    'type': 'bullish',
    'top': c3.low,
    'bottom': c1.high,
    'created_at': c2.ts,
    'is_filled': False  # 가격이 zone 통과 시 True
}
```

### 진입 조건

```python
# Bullish FVG fill (long)
fvg_top = bullish_fvg.top
fvg_bottom = bullish_fvg.bottom

# 가격이 FVG 영역으로 되돌아옴
price_enters_fvg = fvg_bottom <= current_price <= fvg_top

# 50% mid-point 또는 fvg_bottom 에서 진입 (보수적/공격적)
conservative_entry = fvg_bottom
aggressive_entry = (fvg_top + fvg_bottom) / 2

# 거래량 + 캔들 패턴 확인
bullish_candle = current_close > current_open
volume_confirm = volume > volume_avg(5)

entry = price_enters_fvg ∧ bullish_candle ∧ volume_confirm
stop = fvg_bottom - 0.5 * ATR(14)
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | FVG 하단 이탈 (Bullish) 또는 상단 (Bearish) |
| 익절 | 다음 swing high/low 또는 다음 FVG/OB |
| 시간 손절 | FVG 형성 후 50봉 내 fill 안 되면 invalid |

### FVG 의 우선순위

1. **High Timeframe FVG > Low Timeframe FVG**: 4H/일봉 FVG 가 5분 FVG 보다 강함
2. **Unfilled > Filled**: 완전히 메워지지 않은 FVG 만 유효
3. **At Confluence**: OB + FVG + 0.618 Fib 가 겹치는 zone 이 가장 강력

### BarroTrade 통합

- `barrotrade-pattern-expert` 의 `detect_fvg()`
- `workspace/<cycle>/fvg_zones.jsonl` 에 unfilled FVG 추적
- Multi-timeframe confluence: 일봉 FVG + 1시간 FVG 일치 시 confidence 2배

---

## 3. Liquidity Grab / Stop Hunt

**개념**: 기관이 군중의 손절선(retail stop loss)을 의도적으로 trigger 한 후 진짜 방향으로 움직임. "유동성 사냥".

### 식별

```python
# Equal Highs (군중 손절선이 모이는 곳)
def find_equal_highs(highs, tolerance=0.001):
    pivots = []
    for i in range(2, len(highs) - 2):
        if highs[i] > highs[i-1] and highs[i] > highs[i+1]:
            pivots.append((i, highs[i]))

    # 같은 가격대 (tolerance 이내) 의 highs 묶기
    equal_groups = []
    for p1 in pivots:
        group = [p1]
        for p2 in pivots:
            if abs(p2.value - p1.value) / p1.value < tolerance:
                group.append(p2)
        if len(group) >= 2:
            equal_groups.append(group)

    return equal_groups

# Liquidity Grab (sweep) 식별
def detect_liquidity_grab(equal_highs, current_candle):
    # 1) 가격이 equal high 위로 살짝 돌파 (wick)
    swept = current_candle.high > max(equal_highs.values) + 0.001
    # 2) 그러나 종가는 다시 아래로 (failed breakout)
    failed = current_candle.close < max(equal_highs.values)
    # 3) Wick 길이가 본체보다 길어야 함 (rejection)
    wick_ratio = (current_candle.high - max(current_candle.open, current_candle.close)) / \
                 abs(current_candle.close - current_candle.open + 0.0001)

    return swept ∧ failed ∧ (wick_ratio >= 1.5)
```

### 진입 조건

```python
# Equal Highs 위 wick → Bearish Liquidity Grab → Short or exit long
# Equal Lows 아래 wick → Bullish Liquidity Grab → Long

bearish_grab = sweep_above_equal_highs ∧ rejection_candle
bullish_grab = sweep_below_equal_lows ∧ rejection_candle

# 본 스킬은 short 비활성 → Bearish grab 은 long 청산 신호로만
# Bullish grab → Long 진입

entry_long = bullish_grab
stop = grab_candle.low - 0.5 * ATR(14)
target = next_equal_high or order_block_above
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | Grab candle low (Bullish) |
| 익절 | 직전 swing high 또는 다음 OB |
| 시간 손절 | 진입 후 5봉 무수익 |

### BarroTrade 통합

- `barrotrade-bear-researcher` 의 우선 인자: 보유 long 종목이 Bearish liquidity grab 시 청산 권고
- `barrotrade-pattern-expert` 의 `detect_liquidity_grab()`
- Equal Highs/Lows 추적: `workspace/<cycle>/liquidity_zones.jsonl`

### TradingView Indicator 참조

- **LuxAlgo: Smart Money Concepts** — sweep detection
- **ChartPrime: Liquidity Sweeps** — open-source

---

## 4. Break of Structure (BoS) / Change of Character (CHoCH)

**개념**: 추세 전환의 첫 신호. 상승 추세에서 마지막 higher low 가 깨지면 BoS (추세 종료) 또는 CHoCH (추세 전환).

### 식별

```python
# Uptrend Structure
# Higher Highs (HH) + Higher Lows (HL)
def is_uptrend(candles):
    highs_increasing = all(h2 > h1 for h1, h2 in pairs(swing_highs))
    lows_increasing = all(l2 > l1 for l1, l2 in pairs(swing_lows))
    return highs_increasing and lows_increasing

# Break of Structure (BoS) — 추세 종료
def detect_bos_bearish(candles):
    """상승 추세에서 last HL 이탈"""
    last_HL = find_last_higher_low(candles)
    return current_price < last_HL

# Change of Character (CHoCH) — 추세 전환 (BoS 직후 반대 방향 confirm)
def detect_choch(candles, last_bos):
    """BoS 후 반대 방향의 HL/LH 형성"""
    if last_bos.type == 'bearish':
        new_LH = find_lower_high_after(last_bos)
        return new_LH is not None
```

### 진입 조건

```python
# Bullish CHoCH (하락 추세 → 상승)
choch_bull = (
    prev_trend == 'downtrend' ∧
    last_lower_high_broken ∧
    new_higher_low_formed
)

# 진입: CHoCH confirm 후 첫 retracement
entry_long = choch_bull ∧ price_retraces_to_50_61_8_fib

stop = recent_swing_low
target = previous_higher_high (before downtrend)
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | CHoCH 가 broken (구조 무효화) |
| 익절 | 다음 swing high (직전 추세의 시작점) |
| 추세 trailing | new BoS 형성 시 stop 상향 |

### BarroTrade 통합

- `barrotrade-trend-expert` 의 신규 메서드 `detect_market_structure()`
- 거시 regime 전환 신호: Stage Analysis 의 Stage 1 → Stage 2 와 동일 의미
- Multi-timeframe: 일봉 CHoCH + 4시간 BoS → confidence 강화

### TradingView Indicator 참조

- **LuxAlgo: Smart Money Concepts** — BoS/CHoCH 자동
- **LonesomeTheBlue: Market Structure** — open-source

---

## 5. Premium / Discount Zone (Optimal Trade Entry)

**개념**: 직전 swing high/low 사이를 50% 기준 premium (위) / discount (아래) 로 분리. Long 은 discount, Short 은 premium 에서만.

### 식별

```python
# 최근 impulse leg 의 high/low 추출
leg_high = max(high[recent_impulse])
leg_low = min(low[recent_impulse])

# 50% level
mid_point = (leg_high + leg_low) / 2

# Premium zone: mid_point ~ leg_high
# Discount zone: leg_low ~ mid_point

current_zone = 'premium' if price > mid_point else 'discount'

# Optimal Trade Entry (OTE): 0.618 ~ 0.786 retracement
fib_618 = leg_high - 0.618 * (leg_high - leg_low)
fib_786 = leg_high - 0.786 * (leg_high - leg_low)

OTE_zone = (fib_786, fib_618)  # Long 진입 적정 구간
```

### 진입 조건

```python
# Long entry (only in discount + at OTE)
entry_long = (
    current_zone == 'discount' ∧
    fib_786 <= price <= fib_618 ∧
    bullish_reversal_pattern  # FVG fill, OB tap, bullish engulfing 등
)

# Risk-Reward 자동 최적화
stop = fib_786 - 0.5 * ATR(14)
target = leg_high  # 1:2 R:R 자연 충족
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | Fib 0.786 + ATR buffer |
| 익절 | Leg high (1차) / Premium zone 75% (2차) |
| R:R | 최소 2:1 자동 (OTE 위치 덕분) |

### BarroTrade 통합

- `barrotrade-pattern-expert` 의 신규 메서드 `compute_premium_discount()`
- 피보나치 모듈 (38스윙 에서 이미 구현됨) 재사용
- OTE 진입 시 confidence ≥ 0.8 자동 라벨 (R:R 자연 우수)

---

## SMC 4 Pillar Confluence (가장 강력한 셋업)

다음 4가지가 동시에 발생할 때 진입 확률 최고:

```
1. Bullish Order Block (지지 구간 식별)
   ↓ 가격이 OB 로 되돌아옴
2. Fair Value Gap (FVG) 가 OB 와 겹침
   ↓ unfilled gap 메우기 + OB tap
3. Liquidity Grab (sweep below equal lows)
   ↓ 군중 손절 사냥 후 rejection
4. Premium/Discount Zone: Discount 영역 + OTE (0.618~0.786)
   ↓ 자연스러운 2:1 R:R

Entry: OB top
Stop: OB bottom - ATR buffer
Target: Previous swing high (또는 다음 OB)
```

이 4가지가 모두 일치하면 **시그널 confidence 0.95+** 로 라벨링. `barrotrade-quick-decider` 가 즉시 GO 권고.

---

## 카테고리 공통 룰

| 항목 | 값 |
|------|----|
| 시간프레임 | 일봉/4시간/1시간 multi-timeframe |
| Confluence 의무 | 최소 2개 SMC 요소 + 가격 행동 |
| 손절 | ATR 기반 buffer + 구조 무효화 시점 |
| R:R | 최소 2:1 (OTE 영역 진입 시 자연 충족) |
| Multi-Timeframe | 일봉 추세 + 4시간 entry + 15분 timing |
| Fakeout 방어 | 캔들 종가 종료까지 대기 (intra-candle 진입 금지) |

## BarroTrade Strategy 에이전트 매핑

| 전략 | 1차 에이전트 | 2차 결합 |
|------|------------|---------|
| Order Block | barrotrade-pattern-expert | barrotrade-foreigner-institution (외국인 매수 동향) |
| FVG | barrotrade-pattern-expert | barrotrade-trend-expert (multi-TF) |
| Liquidity Grab | barrotrade-pattern-expert | barrotrade-bear-researcher (청산 권고) |
| BoS / CHoCH | barrotrade-trend-expert | barrotrade-macro-specialist (regime) |
| Premium/Discount | barrotrade-pattern-expert | barrotrade-risk-manager (자동 R:R) |

## TradingView 인기 SMC indicators

| Indicator | 저자 | 라이선스 | 한국 시장 적용 |
|-----------|------|---------|--------------|
| Smart Money Concepts | LuxAlgo | Premium | 직접 적용 가능 |
| Market Structure | LonesomeTheBlue | Open-source | 직접 적용 |
| Order Block Indicator | TradingView built-in | Free | 직접 적용 |
| Liquidity Sweeps | ChartPrime | Premium | 한국 시간대 조정 필요 |
| Fair Value Gaps | TradingView built-in | Free | 직접 적용 |

## 한국 시장 캘리브레이션

| 요소 | 미국 시장 | 한국 시장 (KRX) |
|------|----------|----------------|
| Equal Highs tolerance | 0.001 (0.1%) | 0.002 (0.2%, 가격제한 ±30% 영향) |
| OB 임펄스 임계 | +2% / 3봉 | +1.5% / 3봉 (변동성 차이) |
| FVG 시간프레임 | 4H, 1H | 1H, 30m (장 시간 6.5h 짧음) |
| Multi-TF Confluence | 일봉+4H+1H | 일봉+1H+15m |
| 외국인·기관 데이터 | 제한적 | KIS `ka10008`/`ka10009` + Kiwoom 동일 — **차별화 우위** |

---

## 한국 시장의 SMC 특수 적용

한국은 외국인·기관 매매 동향이 일별·실시간 공개되므로, **OB + 기관 수급 데이터** 결합이 가장 강력:

```python
# Bullish OB 발견 직후 외국인 순매수 확인
ob_bullish = detect_order_block(candles, type='bullish')
if ob_bullish:
    foreign_net_buy = kis_api.ka10008(ticker, days=5)
    institutional_net_buy = kis_api.ka10009(ticker, days=5)

    confluence_strength = (
        ob_bullish.confidence +
        (foreign_net_buy > 0) * 0.2 +
        (institutional_net_buy > 0) * 0.2
    )

    if confluence_strength >= 0.85:
        signal_quality = 'A+'  # 최고 등급
```

이는 미국 SMC 트레이더가 갖지 못하는 한국 시장만의 **데이터 우위**.
