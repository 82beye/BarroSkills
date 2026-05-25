# KPI — 성과·위험·지연·추론 SLA

본 문서는 BarroTrade 플랫폼의 상용 검증 기준입니다. 모든 항목은 일일 배치로 자동 측정·추적합니다.

> 본 스킬은 KPI **측정 도구**를 제공합니다. 실제 SLA 충족은 사용자가 외부 OMS·인프라와 결합한 운영 환경의 책임입니다.

---

## 1. 재무 투자 성과

### 샤프 비율 (Sharpe Ratio)

```
Sharpe = (E[R_p] - R_f) / σ_p

annualized = Sharpe_daily * sqrt(252)
```

| 지표 | SLA |
|------|-----|
| 연율화 Sharpe Ratio | **≥ 2.2** |
| 측정 방법 | 일일 수익률 공분산 매트릭스 |
| 측정 주기 | 매일 장 마감 후 batch |
| 측정 대상 | 시뮬 + 실거래 (연결 시) |

산출 로직: `scripts/kpi/sharpe-calc.sh`

### 누적 수익률 (Cumulative Return)

| 기간 | 측정 |
|------|------|
| 일간 | `current_equity / day_start_equity - 1` |
| 월간 | `month_end / month_start - 1` |
| YTD | `current / year_start - 1` |

### Hit Rate

```
hit_rate = winning_cycles / total_completed_cycles
```

- 목표: **≥ 55%** (시뮬), **≥ 50%** (실거래)
- 사이클별 PnL 은 시뮬 청산가 기준 계산

### Turnover

```
turnover = total_executed_value / avg_portfolio_value
```

- 일간 turnover **≤ 0.4** (40% 이하)
- 과회전 시 거래 비용 누적 위험

---

## 2. 위험 통제력

### 최대 낙폭 (Maximum Drawdown, MDD)

```
DD_t = (peak_t - current_t) / peak_t
MDD  = max_t(DD_t)
```

| 지표 | SLA |
|------|-----|
| 연간 MDD | **< 4.5%** |
| 일일 MDD | < 1.5% (회로 차단기 임계) |
| 측정 방법 | 분 단위 portfolio value 시계열 |

### VaR 95% (Value at Risk)

- Monte Carlo 1,000 시뮬레이션
- 시나리오: covid 2020, fed pivot 2022, korea blackout 2024
- VaR 95% **< 8%** (risk-policy.json)

### Max Consecutive Loss

- 연속 손절 사이클 수
- 5회 연속 손절 시 → `barrotrade-self-reflector` 강제 호출
- 8회 연속 손절 시 → 회로 차단기 자동 발동

---

## 3. 엔지니어링 지연 (Latency)

### Tick-to-Trade

```
P99 latency = 호가 수신 → OMS 주문 패킷 송출 완료
```

| 지표 | SLA |
|------|-----|
| P99 tick-to-trade | **≤ 10ms** (실거래 연결 시) |
| 측정 도구 | OpenTelemetry distributed tracing |
| 측정 위치 | 외부 OMS (본 스킬은 측정 데이터만 분석) |

본 스킬은 LLM 기반이라 직접 10ms SLA 보장 불가. 디커플링 아키텍처로 OMS 가 별도 책임.

### Agent Response Time

| 에이전트 | P50 | P95 |
|----------|-----|-----|
| data-preprocessor | < 1s | < 3s |
| rag-analyst | < 4s | < 10s |
| analysis layer | < 8s | < 20s |
| strategy layer | < 4s | < 10s |
| debate (전체 4 라운드) | < 30s | < 60s |
| risk-manager | < 2s | < 5s |
| portfolio-pm | < 3s | < 8s |

사이클 전체 P95 ≤ **120초**.

---

## 4. 추론 정확성

### Factual Hallucination Rate

```
hallucination_rate = false_factual_claims / total_factual_claims
```

| 지표 | SLA |
|------|-----|
| 발생률 | **≤ 0.05%** |
| 측정 도구 | Ragas RAG 평가 + LLM-as-a-Judge |
| 측정 주기 | 일간 (sampling 50개 사이클) |

### RAG Faithfulness

- 모든 RAG 인용은 원본 출처 URL/문서 ID 명시
- 인용 검증: 원본과 매칭 ≥ **0.92** (cosine similarity)

### Numerical Accuracy

- 모든 수치 (가격, 비율, 점수) 는 계량 도구로 산출
- LLM 이 계산 결과를 변형하면 즉시 fail
- 검증: `barrotrade-fundamental-specialist` 산출 수치를 deterministic Python 으로 재계산해 비교

---

## 5. 인프라 복원성

### KIS API Failover

| 지표 | SLA |
|------|-----|
| 웹소켓 단절 → REST 폴링 전환 | **≤ 300ms** |
| 자동 재접속 성공률 | ≥ 99.5% |
| 측정 도구 | 가상 chaos monkey 테스트 |

### Cycle Recovery

- 사이클 중간 인스턴스 충돌 시 in-flight lock + workspace 산출물 기반 자동 복구
- 복구 가능 단계: Stage I (data ingest) ~ Stage IV (debate) 까지 idempotent
- Stage V (risk) 이후는 사용자 명시 재시작 필요 (HITL 일관성 보장)

### Chaos Engineering 정기 테스트

매월 마지막 일요일 0시:

1. KIS websocket 강제 단절 → 300ms 내 REST 대피?
2. RAG vector DB 응답 지연 5초 인젝션 → 사이클 graceful pause?
3. 에이전트 백엔드 429 인젝션 → 자동 fallback?
4. Redis snapshot 손실 → 사이클 자동 abort + audit log?

결과: `logs/audit/chaos-<YYYY-MM>.md`

---

## 6. KPI 종합 대시보드

`scripts/kpi/dashboard.sh` 실행 시 다음 표 출력:

```
─────────────────────────────────────────────────────────
BarroTrade KPI Dashboard — 2026-05-25
─────────────────────────────────────────────────────────
재무 성과
  연율화 Sharpe        2.34   PASS  (target ≥ 2.2)
  YTD 누적 수익률      +8.4%
  Hit Rate (시뮬)      58.2%  PASS  (target ≥ 55%)
  Daily Turnover       0.28   PASS  (target ≤ 0.40)

위험 통제
  연간 MDD             3.7%   PASS  (target < 4.5%)
  VaR 95% (MC)         6.1%   PASS  (target < 8%)
  Consecutive Loss     2      PASS

엔지니어링
  Agent P95 cycle      94s    PASS  (target ≤ 120s)
  RAG Faithfulness     0.94   PASS  (target ≥ 0.92)

추론 정확성
  Hallucination Rate   0.03%  PASS  (target ≤ 0.05%)
  Numerical Drift      0      PASS

인프라 복원성
  WS Failover P99      280ms  PASS  (target ≤ 300ms)
  Cycle Recovery Rate  99.7%
─────────────────────────────────────────────────────────
```

---

## 7. SLA 위반 알람

| 위반 항목 | 알람 채널 |
|----------|----------|
| Sharpe < 2.2 (월간 평균) | email |
| MDD > 4.5% (연간) | telegram + email |
| Hallucination > 0.05% | telegram |
| WS Failover > 300ms | telegram |
| Hash chain violation | telegram + email + sms |

---

## 8. KPI 측정 데이터 보관

- 원본 일간 KPI: `logs/kpi/daily/YYYY-MM-DD.jsonl` (5년)
- 월간 종합 리포트: `logs/kpi/monthly/YYYY-MM.md` (영구)
- 분석가용 export: `scripts/kpi/export-csv.sh <range>` → CSV
