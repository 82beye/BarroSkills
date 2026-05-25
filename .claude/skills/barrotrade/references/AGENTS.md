# BarroTrade Agents (17)

각 에이전트는 단일 책임을 가지며, Controller 가 사이클 단계에 맞춰 Task 위임으로 호출합니다. 모든 에이전트의 메타데이터는 [`../config/agents.json`](../config/agents.json) 에 선언됩니다.

---

## I. Controller Layer

### barrotrade-controller

- **역할**: 사이클 오케스트레이션, 상태 머신 관리, 에이전트 dispatch plan 수립
- **인풋**: `mode`, `args`, `config/*`
- **아웃풋**: 사이클 ID, 단계별 dispatch plan, status log
- **권한**: in-flight lock, audit log append
- **모델**: Opus 4.7 (fallback: Sonnet 4.6)
- **온도**: 0.2

---

## II. Input Layer

### barrotrade-data-preprocessor

- **역할**: KIS websocket 또는 REST 시세를 OHLCV/VWAP/거래량 가중 평균으로 정규화. 이상치(틱 갭, 거래대금 0)는 필터.
- **인풋**: `kis_websocket_tick` 또는 `/uapi/.../inquire-price`, Redis timeseries 캐시
- **아웃풋**: `10_market_snapshot.md`
- **품질 게이트**: 최근 5분 봉 결측 ≥ 2개 시 데이터 불완전 플래그 + 사이클 일시 정지
- **모델**: Haiku 4.5 (fallback: 로컬 Llama-3-8B)

### barrotrade-rag-analyst

- **역할**: 실시간 뉴스 RSS + DART 공시를 Adaptive RAG 로 처리. NER 로 타겟 entity score 산출, distraction filter ≥ 0.75.
- **인풋**: `news_rss`, `dart_disclosures`, vector_db
- **아웃풋**: `15_news_rag.json` (감성 점수, entity 가중치, 인용 출처)
- **가드레일**:
  - `look_ahead_bias_deflector`: `published_at < T_virtual` 강제
  - `distraction_filter_min`: 0.75
- **모델**: GPT-4o-mini (fallback: Haiku 4.5)

---

## III. Analysis Layer

### barrotrade-macro-specialist

- **역할**: WSJ/Bloomberg/Reuters 텍스트 기반 거시 감성 지수 (Growth Sentiment Index, Inflation Sentiment Index). 매크로 국면 정의 (Regime 1/2/3).
- **인풋**: 거시 텍스트, Fed 발언, CPI/GDP API
- **아웃풋**: `20_macro_report.md` (국면 + Growth/Inflation 지수 + 섹터 회전 추천)
- **모델**: Gemini 1.5 Pro (fallback: Sonnet 4.6)

### barrotrade-sector-expert

- **역할**: 섹터 강도 지수 산정, 주도 테마 식별, 공급망 노출 평가
- **인풋**: 섹터 거래대금, supply_chain_ontology
- **아웃풋**: `21_sector_brief.md`
- **모델**: Sonnet 4.6 (fallback: GPT-4o)

### barrotrade-fundamental-specialist

- **역할**: DART 분기 보고서·실적 속보 분석, 적정 가치 범위, 안전성 점수 (재무 건전성, 부채 비율)
- **인풋**: DART 재무 테이블, 어닝 콜 텍스트
- **아웃풋**: `22_fundamental.md`
- **레드 플래그**: 감사의견 거절 / 분식 / 횡령 / 자본잠식 → 즉시 veto
- **모델**: Sonnet 4.6 (fallback: Gemini 1.5 Pro)

---

## IV. Strategy Layer

### barrotrade-trend-expert

- **역할**: EMA(8,21,55) 크로스오버 + ADX(14) ≥ 25 게이트 + MACD 히스토그램 기울기. 추세 강도 점수 산출.
- **아웃풋**: `30_trend_signal.md` (방향, 강도 0~1, 기대 손절/익절가)
- **게이트**: ADX < 25 면 신호 발행 안 함 (whipsaw 방어)

### barrotrade-mean-reversion-expert

- **역할**: Bollinger Bands(-2σ), RSI(14)<30, Z-Score(60일)≤-2.5 동시 충족 시 진입 신호. 호가 잔량 정상성 검증.
- **아웃풋**: `31_meanrev_signal.md`
- **게이트**: 재무 redfundamental flag 시 자동 차단

### barrotrade-event-driven-expert

- **역할**: DART 공시·속보의 LM Finance Lexicon 매칭. Persistent vs Transitory 분류. 과거 유사 공시 5일 누적 반응 DB 조회.
- **아웃풋**: `32_event_signal.md` (이벤트 강도, 추천 holding window)

### barrotrade-pattern-expert

- **역할**: 5분봉/15분봉/일봉 차트의 피벗·삼각수렴·헤드앤숄더·이중바닥 자동 검출. 거래량 동반 돌파 확률.
- **아웃풋**: `33_pattern_signal.md` (패턴명, confidence, 돌파 시 1차 저항 목표가)

---

## V. Debate Layer

### barrotrade-bull-researcher

- **역할**: 20~22 분석가 리포트와 30~33 전략 신호를 종합하여 **낙관 논거**를 구성. 핵심 논거 3개 + 근거 데이터 + 상방 목표가.
- **인풋**: stage II/III 산출물 전체
- **아웃풋**: `40_bull_brief.md`
- **온도**: 0.5 (창의적 논증 허용)

### barrotrade-bear-researcher

- **역할**: 동일 인풋에서 **비관 논거**를 구성. 거시·재무·기술적 위험 강조, 예상 손절 단가 제시.
- **아웃풋**: `41_bear_brief.md`
- **온도**: 0.5
- **의무 호출**: signals 가 만장일치 bullish 여도 항상 호출 (Confirmation Bias Deflector)

### barrotrade-debate-moderator

- **역할**: 4 라운드 토론 진행 (기초 진술 → 교차 논증 → 데이터 대조 → 합의 시도). 가중치 투표 집계. 사용자 프로파일 (보수/균형/공격) 반영.
- **아웃풋**: `50_debate_log.md`, `logs/consensus/<cycle>.jsonl`
- **합의 게이트**: 가중 합산 점수 < `vote_pass_threshold` 면 사이클 차단
- **온도**: 0.4

---

## VI. Control Layer

### barrotrade-risk-manager

- **역할**: ATR 동적 포지션 사이징, 트레일링 스탑 라인 계산, 일일 누적 손실 회로 차단기 점검
- **수식**: `Q_i = min( total_eq * α / (ATR * κ), total_eq * γ_max / price )`
- **아웃풋**: `60_risk_check.md`, `logs/risk/<cycle>.jsonl`
- **결과**: PASS / FAIL + 사유 코드 (`POSITION_TOO_LARGE`, `MAX_DRAWDOWN_HIT`, `SECTOR_OVER_CONCENTRATED` 등)
- **FAIL 시**: 사이클 즉시 중단, self-reflector 자동 트리거
- **온도**: 0.0 (deterministic)

### barrotrade-portfolio-pm

- **역할**: 최종 자산 배분 확정, 호가 타입·수량·종목코드 결정, HITL 게이트 적용
- **인풋**: `60_risk_check.md`, 현 잔고, `compliance.json`
- **아웃풋**: `70_order.simulated.json` 또는 `70_order.pending_hitl.json`
- **HITL 트리거**: 주문 금액 > `compliance.json.hitl_threshold_krw` 또는 > 잔고의 `hitl_threshold_pct_of_equity` %

### barrotrade-compliance-officer

- **역할**: 사이클 전체에 대한 설명 가능성 리포트 (XAI), HITL 추적, 감사 로그 hash chain 무결성, FSC AI 가이드라인 매핑
- **아웃풋**: `80_compliance.md`, `logs/audit/<date>.jsonl` append
- **언어**: 한국어 (규제 보고 표준)

---

## VII. Reflect Layer

### barrotrade-self-reflector

- **역할**: 사이클 종료 후 손절/risk FAIL/HITL expired 사이클의 토론 로그 역추적. Bear 가 경고했지만 Moderator 가 묵살한 항목 식별. "하지 말아야 할 오판 패턴" 추출.
- **인풋**: cycle archive 전체 (10~80)
- **아웃풋**: `99_reflection.md`, `workspace/_memory/semantic/<pattern_id>.md`
- **다음 사이클 영향**: 동일 ticker 또는 동일 섹터의 다음 사이클에서 RAG 컨텍스트에 자동 prepend
- **모델**: Opus 4.7 (높은 메타인지 능력 필요)

---

## 모델 백엔드 매트릭스

| 에이전트 군 | 기본 백엔드 | Failover Target | Temp | Max Tokens |
|------------|------------|-----------------|------|------------|
| 뉴스·공시 RAG (rag-analyst, event-driven) | GPT-4o-mini | Llama-3-8B (local) | 0.1 | 2048 |
| 토론·합의 (bull/bear/moderator) | Opus 4.7 | GPT-4o | 0.4~0.5 | 3072~4096 |
| 거시 분석 (macro-specialist) | Gemini 1.5 Pro | Sonnet 4.6 | 0.3 | 4096 |
| 로컬 신호 (trend/meanrev/pattern) | Haiku 4.5 | Llama-3-8B | 0.0~0.1 | 2048 |
| 리스크·컴플라이언스 | Sonnet 4.6 | Haiku 4.5 | 0.0~0.1 | 2048~3072 |
| 자가 성찰 | Opus 4.7 | GPT-4o | 0.3 | 4096 |

## 호출 비용 추정 (월간, 1일 5 사이클 가정)

- 에이전트별 예산: [`../config/budget-policy.json`](../config/budget-policy.json) 참고
- 합계 상한: **USD 244 / month** (warning 70%, critical 90%, kill switch 110%)

## 에이전트 신규 추가 절차

1. `~/.claude/agents/barrotrade-<new-id>.md` 생성 (frontmatter + 본문)
2. `config/agents.json` 의 `agents` 배열에 메타 추가
3. `config/budget-policy.json` 의 `roles` 에 월 한도 명시
4. 필요 시 `SKILL.md` 의 Stage 위임 라인에 포함
5. `/barrotrade doctor` 로 무결성 검증
