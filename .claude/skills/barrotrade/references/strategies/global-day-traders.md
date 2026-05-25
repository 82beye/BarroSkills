# 글로벌 데이 트레이더 전략 (Global Day Traders)

미국 NYSE/NASDAQ 데이트레이딩 표준. 한국 시장(KRX) 적용 시 거래시간·갭 룰·동시호가 차이 유의. 5분봉 ~ 1시간봉 위주.

---

## 1. Opening Range Breakout (Linda Raschke)

**트레이더**: Linda Raschke (Market Wizards 인터뷰, "Street Smarts" 저자)
**원리**: 시초가 후 첫 30분 동안의 가격 범위(Opening Range)를 돌파할 때 그 방향으로 진입.

### 진입 조건

```python
# 09:00 ~ 09:30 (장 시작 후 30분) 의 high·low 기록
OR_high = max(price[09:00..09:30])
OR_low  = min(price[09:00..09:30])
OR_size = OR_high - OR_low

# 09:30 이후 첫 돌파
breakout_up   = (price > OR_high) ∧ (volume > avg_volume_30min × 1.5)
breakout_down = (price < OR_low)  ∧ (volume > avg_volume_30min × 1.5)

# 추가 필터: ATR 대비 OR 사이즈가 너무 작거나 크면 skip
0.3 ≤ OR_size / ATR(14) ≤ 1.5

signal = breakout_up ∨ breakout_down
```

### 청산

| 항목 | 값 |
|------|----|
| 익절 | OR_size × 1.5 (예: OR=2% → +3%) |
| 손절 | 진입가 - OR_size × 0.5 (또는 OR_low 재진입) |
| 시간 손절 | 진입 후 60분 무수익 |
| 강제 청산 | 장 종료 15분 전 |

### 한국 시장 적용 시 조정

- 동시호가(08:40~09:00) 영향으로 OR 측정은 **09:00~09:30 정규장 30분**으로 한정
- 점심시간 (12:00~13:00) 없으므로 미국 대비 단축 적용 가능

### BarroTrade 통합

- `barrotrade-trend-expert` 의 ADX 게이트와 결합 (ADX ≥ 25 시에만 breakout 신뢰)
- 단타 모드: `barrotrade-korean-master-expert` 와 동시 호출 → 마하세븐 거래대금 1위 + ORB

### 약점

- 박스권 횡보 시 가짜 돌파 후 OR 내부 회귀 (5~7월 한국 시장 빈번)

---

## 2. Bull Flag (Ross Cameron / Warrior Trading)

**트레이더**: Ross Cameron (Warrior Trading 창업자, 일평균 $1k~$10k 데이트레이딩 공개)
**원리**: 강한 상승 임펄스(깃대) → 좁은 횡보 조정(깃발) → 깃발 상단 돌파 시 추세 재개.

### 패턴 식별

```
깃대(Flagpole): 5~15분 동안 +3~10% 급등 (volume burst)
       ▲
       │   ████
       │   █  █ █ █ ◄── 깃발(Flag): 좁은 횡보, 5~10봉
       │  ▲      █ █ █  
       │  █   ◄── 돌파 지점
       │ ▲
       │█
```

### 진입 조건

```python
# 깃대 식별
flagpole_gain = (current_close - close_15min_ago) / close_15min_ago
flagpole_volume_burst = volume / volume.rolling(5).mean() > 3.0

cond_pole = (flagpole_gain >= 0.03) ∧ flagpole_volume_burst

# 깃발 식별 (깃대 직후 5~10봉)
flag_range = (max(high[N봉]) - min(low[N봉])) / pole_high
flag_volume_decline = volume[N봉].mean() / pole_volume < 0.5

cond_flag = (flag_range <= 0.40 * pole_gain) ∧ flag_volume_decline

# 돌파 진입
breakout = price > max(high[flag_period]) ∧ volume > flag_avg_volume × 2

signal = cond_pole ∧ cond_flag ∧ breakout
```

### 청산

| 항목 | 값 |
|------|----|
| 익절 | Entry + (pole_high - pole_low) × 1.0 (Measured Move) |
| 손절 | Flag 의 하단 - 1 tick |
| Risk:Reward | 최소 2:1 |

### BarroTrade 통합

- 분봉 데이터 (1m, 5m) 필수 — `barrotrade-data-preprocessor` 의 분봉 캐시
- 한국 시장: 거래대금 1위 + Bull Flag 결합 시 마하세븐 + Bull Flag 하이브리드
- `barrotrade-pattern-expert` 의 신규 메서드 `detect_bull_flag()`

### 약점

- 깃발이 너무 깊으면 패턴 무효 (40% retracement 룰)
- 거래량 감소가 너무 급격하면 추세 약화 신호

---

## 3. Gap and Go (Ross Cameron / Warrior Trading)

**원리**: 갭 상승 + 거래량 + 호재 종목을 시초가 매수, VWAP 상회 유지 시 추세 추종.

### 사전 스캔 (장 시작 전)

```python
# Pre-market scanner (08:30~09:00 in KR, 04:00~09:30 in US)
gap_pct = (open - prev_close) / prev_close
premarket_volume > 100_000 shares (KR: 거래대금 5억 이상)
news_event_exists = RAG.has_news(ticker)
float_size <= 50_000_000 shares (소형주 우선)

candidate = (gap_pct >= 0.04) ∧ premarket_volume ∧ news_event_exists
```

### 진입 조건

```python
# 시초가 매수 후 즉시 VWAP 모니터
entry = open_price                              # 시초가 진입
vwap = cumulative(close * volume) / cumulative(volume)

# VWAP 상회 유지 확인
hold = price > vwap for 3 consecutive bars

# 추가 조건: 호가 잔량 매수 우위
bid_ask_ratio = bid_volume / ask_volume > 1.2

signal = candidate ∧ hold ∧ bid_ask_ratio
```

### 청산

| 항목 | 값 |
|------|----|
| 손절 | VWAP 하향 이탈 |
| 1차 익절 | +5% (50% 청산) |
| 2차 익절 | +10% (잔량 trailing) |
| 시간 손절 | 30분 무수익 |

### BarroTrade 통합

- 한국 시장: 시간외 단일가 (16:00~18:00) 또는 동시호가에서 갭 시그널 감지
- `barrotrade-event-driven-expert` 와 결합 (호재 키워드 매칭)
- VWAP 산출은 `barrotrade-data-preprocessor` 의 누적 계산

### 약점

- 갭 fade (갭 상승 후 매도 압력) 빈번 — 첫 30분 내 -3% 손절 다발

---

## 4. Morning Panic (Tim Sykes)

**트레이더**: Tim Sykes (페니스톡 트레이딩, "American Hedge Fund")
**원리**: 갭 상승 펌프(pump) 후 첫 30분 내 폭락(panic) 발생 시 반등 캐치. **숏 매수(공매수)**가 아닌 **롱(매수)** 진입.

### 패턴 식별

```
gap_up_pre_market: +20%+ 갭 상승
       │ ●●  ◄── 시초가 고점
       │ ●  ●  
       │     ●  ◄── 패닉 시작 (volume burst)
       │      ●●
       │        ●  ◄── 패닉 저점 (매도 소진)
       │       ●●●  ◄── 반등 (entry)
       │        ●●
```

### 진입 조건

```python
gap_up = (open - prev_close) / prev_close >= 0.20
first_30min_drop = (min(low[09:00..09:30]) - open) / open <= -0.10
volume_spike_at_low = volume_at_panic_low > avg_volume × 5

# 반등 신호
reversal_candle = bullish_engulfing OR hammer
volume_decline_after_panic = volume_5min < panic_volume × 0.5

signal = gap_up ∧ first_30min_drop ∧ volume_spike_at_low ∧ reversal_candle
```

### 청산

| 항목 | 값 |
|------|----|
| 익절 | 패닉 저점 → 시초가의 50% 회복 |
| 손절 | 패닉 저점 - 0.5% |
| Risk:Reward | 3:1 (높은 변동성) |

### 한국 시장 적용

- 펌프 종목: 테마주, IPO 직후, 작전주 의심 종목
- `barrotrade-rag-analyst` 의 keyword: "급등", "테마주", "정치테마", "이슈"
- 거래정지 위험 동반 → HITL 임계 자동 강화

### BarroTrade 통합

- 매우 위험한 전략 — 기본 비활성, 사용자 명시 enable 필요 (`/barrotrade cycle <T> --enable-morning-panic`)
- `barrotrade-risk-manager` 의 max_position 자동 0.05 (5%) 로 축소
- 사이클당 1회만 (`max_morning_panic_per_day: 1`)

### 약점

- 패닉 저점 식별 실패 시 추가 손실 누적
- 거래정지 (volatility halt) 시 청산 불가

---

## 5. Episodic Pivot (Kristjan Kullamägi / Qullamaggie)

**트레이더**: Kristjan Kullamägi (스웨덴, 2014~2021 $5k → $100M+ 공개)
**원리**: 어닝 서프라이즈·뉴스 등 "에피소드" 발생 → 신고가 + 거래량 폭증 → 강력한 상승 임펄스. 진입 후 추세 추종 + ADR (Average Daily Range) 기반 트레일링.

### 진입 조건

```python
# 1) Episode 식별
news_event = earnings_beat OR M&A OR FDA_approval OR patent_breakthrough
gap_open = (open - prev_close) / prev_close >= 0.10  # +10% 갭 상승
volume_surge = day_volume > avg_volume_50d × 5       # 거래량 50일 평균 5배

# 2) 베이스 컨디션 (Pre-episode)
prior_consolidation_days = 20..60                    # 직전 1~3개월 횡보
prior_volatility = ATR/price < 0.025                 # 변동성 수축

# 3) 진입 타이밍 (가장 중요)
# 신고가 돌파 후 5~10분간의 좁은 횡보(틱 단위 ±1%) 후 재돌파
post_pivot_consolidation = (high[5min] - low[5min]) / price < 0.01
new_high_breakout = price > max(prior_60min_high)

signal = news_event ∧ gap_open ∧ volume_surge ∧ post_pivot_consolidation ∧ new_high_breakout
```

### 청산 (ADR-Based Trailing)

```python
ADR = (high.rolling(20).max() - low.rolling(20).min()).mean()  # 20일 평균 일일 범위

# 초기 손절
initial_stop = entry - 1 × ADR  # 또는 episode_low

# 트레일링 스탑 (Qullamaggie 특유)
if days_held <= 3:
    trail = entry - 1.5 × ADR
elif days_held <= 10:
    trail = max(price) - 2 × ADR
else:
    trail = max(price) - 3 × ADR  # 큰 추세 캐치
```

### 보유 기간

- **3 ~ 30 거래일** (다중 시간프레임 추세 추종)
- 평균 보유: 7~10 거래일
- 익절 트리거: 트레일링 hit 또는 가속 상승 후 가속 종료 (parabolic exhaustion)

### BarroTrade 통합

- `barrotrade-event-driven-expert` + `barrotrade-trend-expert` 결합
- ADR 계산: `barrotrade-data-preprocessor` 의 신규 메서드 `compute_adr(window=20)`
- `barrotrade-rag-analyst` 의 키워드: "어닝", "실적", "신약 임상", "M&A", "특허"

### Qullamaggie 의 추가 룰

1. **3-Day Setup**: episode 후 3일 내 진입, 그 이후는 stale
2. **Anti-Position Sizing Mistake**: 첫 진입은 작게 (0.5R), 추세 확인 후 추가 진입
3. **Earnings Within Hold Period**: 다음 어닝 발표 전 청산 (변동성 risk)

### 약점

- 가짜 돌파 (false breakout) 후 -5~10% 손실 빈번
- 거래량 surge 없는 episode 는 무효

---

## 보너스: Parabolic Short (Kullamägi)

**원리**: Episodic Pivot 의 반대 — 과열 종목이 parabolic 상승 후 first red day (첫 음봉) 시 숏 진입.

> **본 스킬에서는 숏 매도 비활성** (`risk-policy.json.portfolio_constraints.short_selling: false`).
> Parabolic Short 는 **monitoring only** — 보유 중인 long 포지션의 청산 트리거로만 활용.

### 식별 조건 (정보용)

```python
# Parabolic 가속
days_up_consecutive >= 5
gain_over_5days >= 0.30
distance_from_MA50 / price >= 0.50  # 50일 이평선 대비 +50% 이상

# First Red Day
prev_5_days_all_green ∧ today_red
volume_spike_on_red ∧ prior_day_dojistar OR shooting_star

exit_long_trigger = parabolic ∧ first_red_day
```

본 스킬은 보유 long 포지션이 위 조건에 매칭되면 `barrotrade-risk-manager` 가 trailing stop tighten + 알림.

---

## 카테고리 공통 룰

| 항목 | 값 |
|------|----|
| 시간프레임 | 1m, 5m, 15m 주력 |
| 최소 거래량 | 일일 100k shares 이상 (KR: 거래대금 50억 이상) |
| Float Size | < 100M shares (소형~중형주) |
| 손절 | -3% ~ -5% (전략별 ATR 비례) |
| 최대 보유 | 1일 (Bull Flag/Gap and Go/Morning Panic) ~ 30일 (Episodic Pivot) |
| 시장 외 시간 | 갭 모니터링 (한국: 16:00~18:00 시간외 / 미국: pre-market 04:00~09:30) |

## BarroTrade Strategy 에이전트 매핑

| 전략 | 1차 에이전트 | 2차 결합 |
|------|------------|---------|
| ORB | barrotrade-trend-expert | barrotrade-pattern-expert |
| Bull Flag | barrotrade-pattern-expert | barrotrade-trend-expert |
| Gap and Go | barrotrade-event-driven-expert | barrotrade-data-preprocessor (VWAP) |
| Morning Panic | barrotrade-pattern-expert | barrotrade-rag-analyst (펌프 키워드) |
| Episodic Pivot | barrotrade-event-driven-expert | barrotrade-trend-expert (ADR trailing) |

---

## 한국 시장 적용 캘리브레이션

| 변수 | 미국 시장 | 한국 시장 (KRX) |
|------|----------|----------------|
| ORB window | 30 min | 30 min (점심시간 없음) |
| Bull Flag pole | $3+ stocks | 거래대금 50억 이상 종목 |
| Gap and Go pre-market | 04:00~09:30 | 시간외 16:00~18:00 + 동시호가 08:40~09:00 |
| Morning Panic gap | +20% (penny stock) | +15% (가격제한 ±30% 고려) |
| Episodic Pivot ADR | 20일 | 20 거래일 (KRX 약 4주) |
