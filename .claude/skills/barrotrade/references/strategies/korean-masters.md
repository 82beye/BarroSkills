# 한국 마스터 트레이더 전략 (Korean Masters)

한국 시장(KRX) 특성 — 가격 제한폭 ±30%, 동시호가, 강한 테마 회전, 거래대금 집중 — 을 정조준한 전문 트레이더의 매매 기법. 첨부된 `seoheefather_strategy.py` (1014 줄) 의 4 전략을 BarroTrade 표준으로 인용·확장합니다.

> **레퍼런스 코드**: `/Users/beye/Downloads/seoheefather_strategy.py` (서희파더 4 전략 풀 구현, 1014 줄, detect/backtest/plot)

---

## 1. F존 (서희파더 / 이재상) — 장중 눌림 매매법

**원리**: 장중 최강 주도주가 일시적으로 눌릴 때 특정 가격대(F존)에서 지지 확인 후 진입. "긴가민가" 구간 진입 후 "확신" 구간 매도.

### 진입 4대 조건 (`seoheefather_strategy.py:218 detect_fzone`)

```python
cond_surge    = prev_change > 0.02            # 직전 봉 +2% 이상 (급등 확인)
cond_pullback = curr_change < 0               # 현재 봉 음봉 (눌림)
cond_volume   = vol_ratio < 0.6               # 거래량 5봉 평균의 60% 이하 (세력 매도 없음)
cond_support  = (|close - EMA5|/EMA5 < 0.005  # EMA5 지지 (편차 0.5% 이내)
              or |close - EMA20|/EMA20 < 0.008) # EMA20 지지 (편차 0.8% 이내)

signal = surge ∧ pullback ∧ volume ∧ support
```

### 청산 (기본값)

| 항목 | 값 |
|------|----|
| 익절 | +3.0% (`profit_target_pct`) |
| 손절 | -1.5% (`stop_loss_pct`) |
| 최대 보유 | 20 봉 (1분봉 기준 20분) |

### 시간프레임

**분봉 (1~5분)**. 일봉 적용 시 SF존/골드존 영역.

### BarroTrade 통합

- 소유 에이전트: `barrotrade-korean-master-expert` (또는 `barrotrade-pattern-expert` 확장)
- 시그널 출력: `30_korean_fzone_signal.md`
- macro_specialist regime 게이트: regime_1 (고성장-저인플레) 활성, regime_4 (위기) 비활성

### 약점

- 박스권 횡보 시 false breakout 다발 (서희파더는 "주도주 한정" 강조)
- 갭 상승 → 음봉 → 추가 하락 시 손절 누적

---

## 2. SF존 (서희파더) — 상한가 따라잡기 매매법

**원리**: 상한가(+29.5%) 안착 또는 근접 종목을 매수해 다음 날 갭 상승 또는 추가 시세 차익. "장 마감 직전 상한가 잔량 + 거래량 + 호재" 3박자.

### 진입 조건 (`seoheefather_strategy.py:333 detect_sf_candidates`)

```python
is_upper     = change_rate >= 29.5%             # 상한가 도달
vol_strong   = vol_ratio >= 3.0                 # 거래량 5일 평균의 3배 이상
price_stable = (high - close) / close < 0.01    # 상한가 안착 (윗꼬리 1% 이내)

sf_signal = is_upper ∧ vol_strong ∧ price_stable
sf_score  = change_rate * 0.4 + vol_ratio * 0.4 + price_stable * 20
```

### 선별 우선순위 (실전)

1. **이슈/재료 확인**: 강한 테마 + 공시 (RAG analyst 연동)
2. **상한가 도달 시각**: 빠를수록 강함 (09:30 이전 > 11:00 이전 > 장 후반)
3. **상한가 직후 거래량 잔존**: 매도 압력 부재

### 청산

| 항목 | 값 |
|------|----|
| 보유 기간 | 3 거래일 (`hold_days`) |
| 손절 | -5.0% |
| 목표 | 다음 날 갭 시 일부 익절, 잔량은 추세 추종 |

### BarroTrade 통합

- 한국 시장 (KRX) 한정 — `kis-api.json`/`kiwoom-api.json` 의 KRX 시세 사용
- `barrotrade-event-driven-expert` 와 결합 (테마·공시 강도)
- HITL 임계 자동 강화: SF존 진입 시 `hitl_threshold_krw` × 0.5 (변동성 큼)

### 약점

- 상한가 안착 실패 시 즉시 -5% 손절 (변동성 매우 높음)
- 시장 전체 하락장에서 다음 날 갭 다운 빈번

---

## 3. 골드존 (서희파더) — 스윙 & 장중 눌림 매매법

**원리**: 주도주 상승 후 첫 번째 주요 지지선(피보나치 0.382~0.618, 볼린저 하단)까지 내려왔을 때 기술적 반등이 가장 강한 황금 타점.

### 핵심 지표 (`seoheefather_strategy.py:425 compute_goldzone`)

```python
# 볼린저 밴드 (20일, 2σ)
bb_upper, bb_mid, bb_lower = bollinger_bands(close, 20, 2.0)

# 피보나치 골드존 (최근 20봉 high~low)
swing_high = high.rolling(20).max()
swing_low  = low.rolling(20).min()
fib_382 = swing_high - 0.382 * (swing_high - swing_low)
fib_618 = swing_high - 0.618 * (swing_high - swing_low)

# 골드존 진입 조건
in_goldzone = (close >= fib_618) ∧ (close <= fib_382) ∧ (close >= bb_lower * 0.99)

# RSI 과매도 회복
rsi_recovery = (rsi > 35) ∧ (rsi.shift(1) <= 35)

goldzone_signal = in_goldzone ∨ rsi_recovery
```

### 청산

| 항목 | 값 |
|------|----|
| 익절 | +5.0% |
| 손절 | -2.5% |
| 보유 | 최대 7 거래일 |

### 시간프레임

**일봉 + 분봉 혼합**. 일봉으로 골드존 식별 → 분봉으로 정확한 진입 타이밍.

### BarroTrade 통합

- `barrotrade-mean-reversion-expert` 와 골드존을 결합 (BB + RSI + Fib 트리플 확인)
- `barrotrade-trend-expert` 와 충돌 시 → 거시 regime 으로 결정 (regime_1 trend / regime_3 골드존)

### 약점

- One-way 하락 추세에서 무한 골드존 (실제 가치 손상 가능)
- 피보나치 기준 봉 N=20 의 outlier 영향

---

## 4. 38스윙 (서희파더) — 1~2주 스윙 매매법

**원리**: 강한 상승 파동 후 피보나치 0.382 되돌림 구간에서 재진입. 직장인 투자자용 (실시간 모니터링 최소화).

### 파동 탐색 (`seoheefather_strategy.py:530 _find_impulse_waves`)

```python
for i in range(impulse_days, len(df)):
    seg  = df.iloc[i - impulse_days : i]      # 직전 5일
    gain = (seg.close.iloc[-1] - seg.close.iloc[0]) / seg.close.iloc[0]
    if gain >= 0.10:                          # +10% 이상 임펄스
        waves.append({high, low, gain, ...})
```

### 진입 조건 (`detect_swing38`)

```python
for wave in waves:
    fib382 = fibonacci_levels(wave.high, wave.low)['0.382']
    fib618 = fibonacci_levels(wave.high, wave.low)['0.618']

    # 파동 종료 후 되돌림 구간 탐색
    for k in range(wave.end_idx + 1, end + hold_days*2):
        in_range = |price - fib382| / fib382 <= 0.015      # ±1.5%
        rsi_ok   = rsi < 55                                 # 과매수 아님
        vol_ok   = volume >= volume.rolling(10).mean() * 0.5 # 세력 잔존

        if in_range ∧ rsi_ok ∧ vol_ok:
            entry  = price
            target = wave.high   # 이전 고점
            stop   = fib618      # 0.618 손절
            break
```

### 청산

| 항목 | 값 |
|------|----|
| 익절 | 이전 고점 (`fib_target` = wave high) |
| 손절 | Fib 0.618 (`fib_stop`) |
| 보유 | 최대 10 거래일 |
| 비중 | 종목당 ≤ 30% (서희파더 원칙) |

### BarroTrade 통합

- 일봉 데이터만 사용 (분봉 불필요)
- `barrotrade-pattern-expert` 의 피보나치 모듈 직접 호출
- 비중 제약: `risk-policy.json.gamma_max_alloc_per_ticker: 0.15` 와 충돌 시 보수적 값(0.15) 우선

### 약점

- 파동 정의의 `impulse_days=5` / `impulse_gain=0.10` 파라미터 민감 (시장 변동성 적응 필요 — 자가 진화 후보)
- 0.618 손절 깊음 (대형 손실 가능)

---

## 5. 마하세븐 단타 (김대용) — 거래대금 1위 + 5분봉 단타

**원리**: "거래대금 1위 종목만 매매한다" — 시장의 모든 자금이 몰리는 종목에 단기 진입, 손절 -3% 칼같이.

### 진입 조건

```python
# 종목 선별 (장 시작 30분 후 / 11:30 / 13:30 3회 스캔)
rank_1 = market.amount_ranking()[0]            # 거래대금 1위
amount_min = 100_000_000_000                   # 1000억 이상

# 5분봉 진입 조건
prev_5min_change > 0.03                        # 5분봉 +3% 강세
volume_5min > volume_5min.rolling(5).mean() * 2 # 거래량 2배
price > vwap                                    # VWAP 상회
position_size = total_equity * 0.10            # 종목당 10%

signal = rank_1 ∧ amount_min ∧ prev_5min_change ∧ volume_5min ∧ price>vwap
```

### 청산 (엄격)

| 항목 | 값 |
|------|----|
| 손절 | **-3.0% 절대값** (마하세븐 트레이드마크) |
| 익절 | +5% 1차 / +8% 2차 / +10% 최종 |
| 시간 손절 | 진입 후 15분 무수익 시 청산 |
| 최대 보유 | 60분 (장 종료 30분 전 강제 청산) |

### 핵심 원칙

1. **거래대금 1위만**: 2위·3위는 잠재 시그널만, 진입 X
2. **3종목 동시 보유 금지**: 1종목 청산 후 다음 진입
3. **추세 절대 거스르지 않음**: 일봉 음봉이면 보수적

### BarroTrade 통합

- `barrotrade-event-driven-expert` 와 결합 (테마·이슈 강도)
- 거래대금 ranking: KIS `ka10032` 또는 Kiwoom `ka10032` (거래대금 상위)
- `barrotrade-risk-manager`: stop_loss_pct -3.0 강제 (마하세븐 모드)

### 약점

- 거래대금 1위가 빠르게 회전 → 진입 타이밍 놓치기 쉬움
- 1위 종목이 약세 패턴이면 시그널 자체 발생 X (놓치는 기회 비용)

---

## 카테고리 공통 적용 원칙 (서희파더 핵심)

```
① 주도주 선별 : 현재 테마 + 거래대금 상위 (LeadingStockScreener)
② 비중 관리   : 3종목 이내 집중 / 종목당 ≤ 30%
③ 심리 전략   : "긴가민가" 시 진입 → 대중이 확신할 때 매도
④ 손절 엄격   : -1.5% (F존), -2.5% (골드존), -3.0% (마하), -5.0% (SF존)
```

### LeadingStockScreener (`seoheefather_strategy.py:641`)

```python
score = (
    change_pct * 0.35 +     # 등락률
    vol_ratio  * 15   +     # 거래량 비율
    (amount / 1000) * 0.3 + # 거래대금 (백만원 단위)
    (rsi < 70) * 10         # RSI 과매수 아님 보너스
)
```

본 스킬은 이 스크리너를 `barrotrade-sector-expert` 의 입력으로 활용. 다음 사이클 candidate 종목군 결정에 직접 반영.

---

## 한국 시장 특화 가드 (BarroTrade)

| 가드 | 적용 |
|------|------|
| 가격 제한폭 ±30% | SF존: +29.5% 임계, 동시호가 영향 인지 |
| 동시호가 (08:40~09:00, 15:20~15:30) | 진입·청산 시간대 제외 (slippage 높음) |
| 거래정지·관리종목 | RAG analyst veto 자동 |
| 단일가 매매 종목 | F존/마하세븐 자동 제외 (intraday 불가) |
| 시간외 단일가 | 본 스킬은 정규장만 처리 (16:00~17:40 제외) |

---

## 다음 단계 권장

1. 첨부 코드의 `MarketDataGenerator` 는 가상 데이터 → BarroAiTrade의 `barro_trade.db` + KIS/Kiwoom 실시간 시세로 교체
2. F존 분봉 추적은 `barrotrade-signal-watcher` 의 `intraday_buy_daemon.py` hook 과 직접 연동
3. SF존 종목 선별은 KIS `ka10032` (거래대금 상위) + 키움 `ka10032` (동일 TR) 의 일별 ranking 활용
4. 자가 진화 (`evolve` 모드) 후보 파라미터:
   - F존: `volume_decline_ratio: 0.6`, `profit_target_pct: 3.0`
   - SF존: `min_volume_multiplier: 3.0`
   - 골드존: `rsi_oversold: 35.0`, `profit_target_pct: 5.0`
   - 38스윙: `impulse_min_gain: 0.10`, `retracement_level: 0.382`, `tolerance: 0.015`
   - 마하: `stop_loss_pct: 3.0`, `position_size: 0.10`
