# BarroTrade

한국투자증권 (KIS) + 키움증권 (Kiwoom) 멀티 브로커 대응 **멀티에이전트 주식 트레이딩 시뮬레이션** Claude Code 스킬.

> ⚠️ **본 스킬은 실거래를 송출하지 않습니다.** 분석·토론·합의·리스크 평가·시뮬레이션 주문 명령서 생성까지만 수행하며, 실제 매매 집행은 외부 OMS와 인간의 명시적 승인을 통해서만 가능합니다.
> 두 브로커 모두 주문 경로(`/uapi/.../trading/order-*`, `/api/dostk/ordr`, `/api/dostk/crdordr`)는 게이트웨이가 강제 차단합니다.

## 왜 이 스킬인가

전통적 단일 에이전트 트레이딩은 거시 변화나 비정형 데이터(뉴스, 공시)에 취약하고 할루시네이션이 실거래로 직결되면 치명적입니다. BarroTrade는 PRD에서 정의한 **5계층 멀티에이전트 자산운용 조직**을 Claude Code 스킬로 재현하여:

- 17개 전문 에이전트가 영역별로 정렬
- 다자간 토론(Bull vs Bear) + 중재자가 합의를 도출
- 동적 ATR 포지션 사이징과 회로 차단기로 리스크 방어
- 자가 성찰 루프로 손실 패턴을 의미론적 기억에 축적
- HITL · 설명 가능성 · 감사 추적으로 규제 준수

## 5계층 아키텍처

```
┌─────────────────────────────────────────────────┐
│ I.   Input Layer       (정형/비정형 수집·정규화) │
│ II.  Analysis Layer    (거시·섹터·재무)         │
│ III. Strategy Layer    (추세·평균회귀·이벤트·패턴)│
│ IV.  Debate Layer      (Bull vs Bear + 중재자)  │
│ V.   Control Layer     (리스크·HITL·집행 시뮬)  │
└─────────────────────────────────────────────────┘
```

상세는 [references/ARCHITECTURE.md](references/ARCHITECTURE.md).

## 빠른 시작

```bash
# 1) Broker 선택 (기본 kis)
export BARROTRADE_BROKER=kiwoom   # 또는 kis

# 2) 진단으로 환경 점검
/barrotrade doctor

# 3) 워크스페이스 초기화 (config 검증, broker별 env 안내)
/barrotrade init

# 4) 풀 사이클 시뮬레이션 (예: 삼성전자 005930)
/barrotrade cycle 005930

# 5) 분석 단계만 실행
/barrotrade analyze 005930

# 6) 손실 사이클 자가 성찰
/barrotrade reflect 2026-05-25-005930
```

자세한 5분 인계는 [QUICKSTART.md](QUICKSTART.md).

## 17 에이전트 한눈에

| 계층 | 에이전트 | 책무 |
|------|----------|------|
| Controller | `barrotrade-controller` | 사이클 오케스트레이션 |
| Input | `barrotrade-data-preprocessor` | OHLCV/VWAP 정규화 |
| Input | `barrotrade-rag-analyst` | 뉴스·공시 RAG (Adaptive) |
| Analysis | `barrotrade-macro-specialist` | 거시 감성 지수 (성장/인플레) |
| Analysis | `barrotrade-sector-expert` | 섹터 강도·후보군 |
| Analysis | `barrotrade-fundamental-specialist` | 적정 가치·안전성 |
| Strategy | `barrotrade-trend-expert` | EMA·ADX·MACD |
| Strategy | `barrotrade-mean-reversion-expert` | BB·RSI·Z-Score |
| Strategy | `barrotrade-event-driven-expert` | 공시·속보 RAG |
| Strategy | `barrotrade-pattern-expert` | 피벗·삼각수렴·돌파 |
| Debate | `barrotrade-bull-researcher` | 낙관 논거 |
| Debate | `barrotrade-bear-researcher` | 비관 논거 |
| Debate | `barrotrade-debate-moderator` | 토론 중재·합의 |
| Control | `barrotrade-risk-manager` | ATR·트레일링·회로 차단기 |
| Control | `barrotrade-portfolio-pm` | 자산 배분·주문 시뮬 |
| Reflect | `barrotrade-self-reflector` | 손절 역추적·오판 패턴 |
| Compliance | `barrotrade-compliance-officer` | HITL·설명가능성·감사 |

상세 책임·입출력은 [references/AGENTS.md](references/AGENTS.md).

## 성능 SLA (KPI)

| 분류 | 지표 | 통과 기준 |
|------|------|----------|
| 재무 | 연율화 Sharpe Ratio | ≥ 2.2 |
| 위험 | 연간 최대 낙폭 (MDD) | < 4.5% |
| 엔지니어링 | P99 tick-to-trade | ≤ 10ms (실거래 연결 시) |
| 추론 | Factual Hallucination | ≤ 0.05% |
| 인프라 | 웹소켓 단절 → REST 대피 | ≤ 300ms |

본 스킬은 시뮬레이션 환경에서 측정 도구만 제공합니다. 실제 SLA 달성은 외부 OMS·인프라 책임. 상세는 [references/KPI.md](references/KPI.md).

## 규제 준수

- **인간 위속 (HITL)**: `compliance.json.hitl_threshold_krw` 초과 주문은 자동으로 인간 승인 대기 큐로 전환.
- **설명 가능성 (XAI)**: 모든 사이클의 토론 로그·지표·합의 점수가 `logs/audit/*.jsonl` 에 박제 보존, 사후 소명 리포트로 즉시 변환.
- **금융위원회 AI 가이드라인**: 인간 책임성 원칙, 알고리즘 투명성, 차별 금지, 안전성을 [references/COMPLIANCE.md](references/COMPLIANCE.md) 에 매핑.

## 디렉토리

```
.claude/skills/barrotrade/
├── SKILL.md                 # 진입점
├── README.md                # 이 문서
├── QUICKSTART.md            # 5분 인계
├── config/                  # 8개 정책 JSON (kis-api + kiwoom-api 포함)
├── references/              # 9개 상세 사양 MD (KIS-OPENAPI + KIWOOM-API 포함)
├── templates/               # 13개 산출물 템플릿
├── scripts/                 # doctor-cli 등
├── workspace/               # 사이클별 산출물 (런타임)
└── logs/                    # audit·trades·consensus·risk (런타임)

~/.claude/agents/
└── barrotrade-*.md          # 17개 에이전트 정의
```

## 라이선스 · 면책

본 스킬은 학습·연구·시뮬레이션 목적. 실제 투자 손실에 대해 어떤 책임도 지지 않습니다. 사용자가 직접 외부 OMS와 결합하여 실거래를 수행할 경우, 자본시장법·금융회사 내부통제 가이드라인·금융위원회 인공지능 가이드라인을 준수할 의무는 전적으로 사용자에게 있습니다.
