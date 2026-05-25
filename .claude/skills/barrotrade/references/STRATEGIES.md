# BarroTrade Strategy Catalog

25+ 전문 트레이더 전략 카탈로그 + 4 베이스 전략 + 3 하이브리드. 정의 메타는 [`../config/strategies.json`](../config/strategies.json) 에 선언됩니다.

> 본 카탈로그는 한국 시장(KRX) 적용을 우선시하며, 미국 데이트레이더/스윙 트레이더·SMC/ICT·클래식 프레임워크의 검증된 전략을 통합합니다.

---

## 카테고리 인덱스

| 카테고리 | 파일 | 전략 수 | 시간프레임 | 핵심 트레이더 |
|---------|------|---------|----------|--------------|
| 🇰🇷 한국 마스터 | [strategies/korean-masters.md](strategies/korean-masters.md) | 5 | 1m ~ 일봉 | 서희파더(이재상), 마하세븐(김대용) |
| 🌎 글로벌 데이 | [strategies/global-day-traders.md](strategies/global-day-traders.md) | 5+1 | 1m ~ 15m | Linda Raschke, Ross Cameron, Tim Sykes, Kristjan Kullamägi |
| 🌍 글로벌 스윙 | [strategies/global-swing-traders.md](strategies/global-swing-traders.md) | 6 | 일봉/주봉 | Mark Minervini, William O'Neil, Stan Weinstein, Nicolas Darvas, Qullamaggie |
| 🧊 SMC / ICT | [strategies/smc-ict.md](strategies/smc-ict.md) | 5 | multi-TF | LuxAlgo, LonesomeTheBlue (TradingView) |
| 📐 클래식 | [strategies/classical-frameworks.md](strategies/classical-frameworks.md) | 5+1 | 일봉/주봉 | Wyckoff, Elliott, Hosoda, Seban, Brian Shannon |
| **총합** | — | **27 전략** | — | — |

---

## 핵심 전략 표 (Quick Reference)

### 한국 마스터 (KRX 특화)

| ID | 이름 | 시간 | 손절 | 익절 | 약점 |
|----|------|-----|------|------|------|
| `kr-fzone` | F존 (장중 눌림) — 서희파더 | 1m~5m | -1.5% | +3.0% | 박스권 whipsaw |
| `kr-sfzone` | SF존 (상한가 따라잡기) | 일봉 | -5.0% | 갭 시세 | 안착 실패 시 즉시 손절 |
| `kr-goldzone` | 골드존 (스윙) | 일봉+분봉 | -2.5% | +5.0% | One-way 하락 |
| `kr-swing38` | 38스윙 (1~2주) | 일봉 | Fib 0.618 | 직전 고점 | 파동 파라미터 민감 |
| `kr-maha7` | 마하세븐 단타 | 5m | -3.0% (절대) | +5/8/10% | 거래대금 1위 회전 빠름 |

### 글로벌 데이 트레이더

| ID | 이름 | 시간 | R:R | 평균 보유 |
|----|------|-----|-----|---------|
| `gd-orb` | Opening Range Breakout (Linda Raschke) | 5m~15m | 2:1 | 1일 |
| `gd-bullflag` | Bull Flag (Ross Cameron) | 1m~5m | 2:1 | 1일 |
| `gd-gapandgo` | Gap and Go (Ross Cameron) | 1m~15m | 2:1 | 1일 |
| `gd-morningpanic` | Morning Panic (Tim Sykes) | 5m | 3:1 | 1일 |
| `gd-episodic` | Episodic Pivot (Kullamägi) | 일봉 | trailing | 3~30일 |
| `gd-parabolic` | Parabolic Short (모니터링만) | 일봉 | — | (exit trigger) |

### 글로벌 스윙

| ID | 이름 | 시간 | R:R | 평균 보유 |
|----|------|-----|-----|---------|
| `gs-vcp` | VCP (Minervini) | 일봉 | 2.86:1 | 6~12주 |
| `gs-sepa` | SEPA (Minervini risk sizing) | — | (VCP 강화) | — |
| `gs-canslim` | CANSLIM (O'Neil) | 일봉+분기 | 2.5:1 | 3~12개월 |
| `gs-cwh` | Cup-with-Handle (O'Neil) | 일봉 | 2:1 | 4~12주 |
| `gs-stage` | Stage Analysis (Weinstein) | 주봉 | 추세 종료까지 | 6~24개월 |
| `gs-darvas` | Darvas Box | 일봉 | 추세 종료까지 | 1~6개월 |
| `gs-qullamaggie` | Tight Consolidation Breakout | 일봉 | trailing | 3~30일 |

### SMC / ICT (TradingView 표준)

| ID | 이름 | 핵심 |
|----|------|------|
| `smc-orderblock` | Order Block (OB) | 기관 마지막 매수 캔들 재방문 |
| `smc-fvg` | Fair Value Gap (FVG) | 3봉 갭, unfilled 가 강력 |
| `smc-liqgrab` | Liquidity Grab (Stop Hunt) | Equal Highs/Lows 위/아래 wick |
| `smc-bos` | Break of Structure / CHoCH | 추세 전환 첫 신호 |
| `smc-premdisc` | Premium / Discount Zone | 50% 기준, OTE 진입 |

### 클래식 + TradingView

| ID | 이름 | 시간 |
|----|------|-----|
| `cl-wyckoff` | Wyckoff Method (4 phase + Spring) | 주봉 |
| `cl-elliott` | Elliott Wave (5+3) | 일봉/주봉 |
| `cl-ichimoku` | Ichimoku Cloud (5 line) | 일봉/주봉 |
| `cl-supertrend` | SuperTrend (ATR 기반) | 일봉 |
| `cl-avwap` | Anchored VWAP (Brian Shannon) | multi-TF |
| `cl-heikinashi` | Heikin-Ashi Smoothed | 일봉 (보조) |

---

## 기존 베이스 4 전략 (BarroTrade 코어)

이 4 전략은 위 25 전략의 **상위 추상 계층**으로, Stage III 의 4 strategy expert 가 각각 담당합니다.

### 1. Trend-Following (`base-trend`)
- 소유: `barrotrade-trend-expert`
- EMA(8,21,55) + ADX(14) + MACD(12,26,9)
- **포함 전략**: gd-orb, gd-episodic, gs-stage, cl-ichimoku, cl-supertrend

### 2. Mean-Reversion (`base-meanrev`)
- 소유: `barrotrade-mean-reversion-expert`
- BB(20,2σ) + RSI(14) + Z-Score(60)
- **포함 전략**: kr-goldzone, gd-morningpanic, smc-premdisc

### 3. Event-Driven (`base-event`)
- 소유: `barrotrade-event-driven-expert`
- DART 공시 + LM Finance Lexicon + 5-day reaction DB
- **포함 전략**: kr-sfzone, gd-gapandgo, gd-episodic, gs-canslim, cl-avwap

### 4. Chart-Pattern (`base-pattern`)
- 소유: `barrotrade-pattern-expert`
- Pivot, 삼각수렴, 헤드앤숄더, 이중바닥
- **포함 전략**: kr-fzone, kr-swing38, gd-bullflag, gs-vcp, gs-cwh, gs-darvas, gs-qullamaggie, smc-orderblock, smc-fvg, smc-liqgrab, smc-bos, cl-wyckoff, cl-elliott

---

## 하이브리드 전략 (3종)

### 1. Dynamic Sentiment Allocation Strategy (DSAS)
실시간 뉴스 감성 + 가격 변동성 결합 동적 비중 분할. [상세](strategies/global-day-traders.md#5-episodic-pivot-kristjan-kullamägi--qullamaggie) 의 Episodic Pivot 과 결합 시 강력.

```
I_i(t) = 0.6 × S_i(t) + 0.4 × normalized_V_i(t)
τ_active = 0.65, multiplier = 1.5
```

### 2. Hybrid LLM + RL Execution (HSRE)
LLM 이 주간 전략 가이드 π_g → RL 이 ms 단위 체결 최적화.

```
L_policy(θ) = -E_t[A_t · log π_θ(a_t | s_t, π_g)]
```

본 스킬은 시뮬레이션만 — RL 학습은 외부 GPU 클러스터 책임.

### 3. Self-Improving Dual-Loop (SIDL)
Inner loop 토론 + Outer loop 백테스트 + Nightly Fin-R1 7B 로컬 학습.

`barrotrade-self-reflector` + `evolve` 모드와 직접 연결.

---

## Strategy Stacking (Confluence 시그널)

여러 카테고리의 전략이 동시 발생할 때 confidence 가 비선형 상승:

```
일봉 SuperTrend 'up'              (cl-supertrend)
+ Wyckoff Accumulation Spring     (cl-wyckoff)
+ Order Block tap                 (smc-orderblock)
+ FVG fill at OB                  (smc-fvg)
+ Premium/Discount: Discount      (smc-premdisc)
+ Bullish CHoCH on 4H             (smc-bos)
+ Volume Dry-Up                   (gs-vcp)
+ Pivot Breakout                  (gs-darvas)
+ kr-fzone 진입 신호              (한국 시장 한정 보너스)

→ Signal Strength: 0.95+
→ barrotrade-quick-decider 즉시 GO 권고
→ Position size: gamma_max_alloc 한도 max
```

### Confluence 점수 산출

```python
def compute_confluence(active_strategies):
    """
    동시 활성 전략 수 + 카테고리 다양성 기반 신뢰도
    """
    n = len(active_strategies)
    categories = set(s.category for s in active_strategies)

    base_score = min(1.0, n / 10)              # 10 전략 동시 만점
    diversity_bonus = len(categories) * 0.05   # 카테고리 다양성 보너스

    # Veto: 상충 시그널 (예: trend up + bearish OB) 시 감점
    contradictions = count_contradictions(active_strategies)
    veto = contradictions * 0.10

    return max(0, min(1.0, base_score + diversity_bonus - veto))
```

---

## 거시 국면별 추천 전략 매트릭스

| 거시 국면 | 추천 카테고리 | 비활성 |
|----------|-------------|--------|
| **Regime 1**: 고성장-저인플레 | global-day, global-swing, korean-masters | — |
| **Regime 2**: 저성장-고인플레 | smc-ict (defensive), classical (Wyckoff Distribution) | global-day |
| **Regime 3**: 박스권 횡보 | korean-masters (kr-fzone, kr-goldzone), smc-ict (premdisc) | gd-orb, gd-bullflag, gs-vcp |
| **Regime 4**: 위기 | (전부 비활성, 회로 차단기 발동) | 전부 |

`barrotrade-macro-specialist` 가 매 사이클 시작 시 regime 결정 → 전략 카탈로그에서 활성 셋 동적 결정.

---

## 트레이더 정보 & 유튜브 채널 참조

### 한국
- **서희파더** (이재상): 유튜브 "서희파더TV", 저서 "주식 단타의 정석" (F/SF/골드/38)
- **마하세븐** (김대용): 유튜브 "마하세븐TV", 손절 -3% 원칙

### 미국 데이 트레이더
- **Linda Raschke**: "Street Smarts", "Trading Sardines" — ORB 의 원조
- **Ross Cameron**: Warrior Trading YouTube/Course — Bull Flag, Gap and Go
- **Tim Sykes**: Profitly platform — Penny stock Morning Panic
- **Kristjan Kullamägi**: @qullamaggie Twitter — Episodic Pivot, Parabolic Short

### 미국 스윙 트레이더
- **Mark Minervini**: "Trade Like a Stock Market Wizard" — VCP, SEPA, Trend Template
- **William O'Neil**: IBD 창업자, "How to Make Money in Stocks" — CANSLIM, Cup-with-Handle
- **Stan Weinstein**: "Secrets for Profiting in Bull and Bear Markets" — Stage Analysis
- **Nicolas Darvas**: "How I Made $2,000,000 in the Stock Market" — Darvas Box
- **Brian Shannon**: @AlphaTrends — Anchored VWAP 의 현대적 보급자

### TradingView SMC
- **LuxAlgo**: Smart Money Concepts indicator (Premium)
- **LonesomeTheBlue**: Open-source Market Structure
- **ChartPrime**: Liquidity Sweeps

### 클래식
- **Richard D. Wyckoff** (1873~1934): Wyckoff Method 창시자
- **Ralph Nelson Elliott** (1871~1948): Elliott Wave Principle
- **Goichi Hosoda** (細田悟一, 1898~1982): Ichimoku Cloud
- **Olivier Seban** (2010): SuperTrend 

---

## BarroTrade 통합 — Stage III 위임 확장

기존 4 strategy expert 에 카탈로그 인지 능력 추가:

```python
# Stage III dispatch
strategies_to_activate = macro_specialist.recommend_strategies()
# 예: regime_1 → ['kr-fzone', 'gs-vcp', 'smc-orderblock', 'gd-episodic']

# 각 strategy expert 가 카탈로그에서 해당 전략 로드
for s in strategies_to_activate:
    if s.startswith('kr-'):
        Task(barrotrade-pattern-expert, prompt=f"전략 {s} 적용, 카탈로그: strategies/korean-masters.md")
    elif s.startswith('gd-'):
        Task(barrotrade-trend-expert, prompt=f"전략 {s} 적용, 카탈로그: strategies/global-day-traders.md")
    # ...
```

미래 작업: 각 카테고리별 dedicated expert 추가 (`barrotrade-korean-master-expert`, `barrotrade-smc-expert`) — 17→21 에이전트 확장 시 진행.

---

## 자가 진화 (evolve 모드) 후보 파라미터

각 전략의 dataclass 파라미터는 `barrotrade-code-surgeon` 의 자동 튜닝 대상:

| 전략 | 튜닝 가능 파라미터 |
|------|-------------------|
| kr-fzone | `volume_decline_ratio`, `profit_target_pct`, `stop_loss_pct` |
| kr-sfzone | `min_volume_multiplier`, `hold_days` |
| kr-goldzone | `rsi_oversold`, `bb_period`, `profit_target_pct` |
| kr-swing38 | `impulse_min_gain`, `retracement_level`, `tolerance` |
| kr-maha7 | `stop_loss_pct` (-3.0 절대 보호), `position_size` |
| gs-vcp | `pivot_volume_surge`, `contraction_ratio` |
| smc-orderblock | `impulse_threshold`, `volume_confirm` |
| cl-supertrend | `atr_period`, `multiplier` |
| cl-ichimoku | `tenkan_period`, `kijun_period`, `span_b_period` |

변경 범위 한도는 [`CODE-EVOLUTION.md`](CODE-EVOLUTION.md) 참조 (±25%, 주당 ≤ 3회, HITL 100%).

---

## 다음 단계

1. 신규 strategy expert 에이전트 4개 추가 (옵션):
   - `barrotrade-korean-master-expert`
   - `barrotrade-global-day-expert`
   - `barrotrade-global-swing-expert`
   - `barrotrade-smc-expert`
2. `barrotrade-quick-decider` 의 Memory Match 시 카탈로그 cross-reference
3. 백테스트 시 전략별 hit rate 비교 → 시장 적합도 자동 라벨링
4. `evolve` 모드의 변경 후보를 카탈로그의 `tunable_params` 기반으로 자동 식별
