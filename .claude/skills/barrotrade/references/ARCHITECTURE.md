# BarroTrade Architecture

## 5계층 멀티에이전트 자산운용 조직

```
                          ┌─────────────────────────────────────┐
                          │  실시간 시장 데이터 스트림           │
                          │  (정형: 호가/체결/지표)              │
                          │  (비정형: 공시/뉴스/소셜 센티먼트)   │
                          └─────────────────┬───────────────────┘
                                            │
                                            ▼
            ┌───────────────────────────────────────────────────────┐
            │ I. INPUT LAYER                                        │
            │   • barrotrade-data-preprocessor (OHLCV/VWAP)         │
            │   • barrotrade-rag-analyst (Adaptive RAG, NER, T_V)   │
            └─────────────┬─────────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
┌────────────────────────────────┐  ┌────────────────────────────────┐
│ II. ANALYSIS LAYER             │  │ III. STRATEGY LAYER            │
│  • macro-specialist            │  │  • trend-expert (EMA·ADX·MACD) │
│  • sector-expert               │  │  • mean-reversion-expert       │
│  • fundamental-specialist      │  │  • event-driven-expert         │
│                                │  │  • pattern-expert              │
└──────────────┬─────────────────┘  └─────────────┬──────────────────┘
               │                                  │
               └──────────────┬───────────────────┘
                              ▼
            ┌───────────────────────────────────────────────────────┐
            │ IV. DEBATE LAYER                                      │
            │   • bull-researcher (낙관 논거)                       │
            │   • bear-researcher (비관 논거)                       │
            │   • debate-moderator (교차 논증·가중치 투표)          │
            └─────────────┬─────────────────────────────────────────┘
                          │
                          ▼ (합의 점수 ≥ 70 통과)
            ┌───────────────────────────────────────────────────────┐
            │ V. CONTROL LAYER                                      │
            │   • risk-manager (ATR 사이징·트레일링·회로 차단기)    │
            │   • portfolio-pm (자산 배분·주문 시뮬·HITL 게이트)    │
            │   • compliance-officer (XAI·감사·FSC 매핑)            │
            └─────────────┬─────────────────────────────────────────┘
                          │
                          ▼ (HITL 통과)
            ┌───────────────────────────────────────────────────────┐
            │ Output: workspace/<cycle_id>/70_order.simulated.json  │
            │         logs/audit/<date>.jsonl (append)              │
            └───────────────────────────────────────────────────────┘

                          ↑ feedback loop
                          │
            ┌───────────────────────────────────────────────────────┐
            │ REFLECT LAYER                                         │
            │   • self-reflector (손절 역추적·오판 패턴 적재)       │
            │   → workspace/_memory/semantic/<pattern_id>.md         │
            │   → 다음 cycle RAG 컨텍스트에 자동 주입               │
            └───────────────────────────────────────────────────────┘
```

## 사이클 위임도 (Task Hub-and-Spoke)

```
S0  init               : Controller (config 검증, in-flight lock 획득)

S1  data ingest        : Controller ──┬──► barrotrade-data-preprocessor
                                       └──► barrotrade-rag-analyst        (병렬)

S2  analysis           : Controller ──┬──► barrotrade-macro-specialist
                                       ├──► barrotrade-sector-expert
                                       └──► barrotrade-fundamental-specialist   (병렬)

S3  strategy signals   : Controller ──┬──► barrotrade-trend-expert
                                       ├──► barrotrade-mean-reversion-expert
                                       ├──► barrotrade-event-driven-expert
                                       └──► barrotrade-pattern-expert            (병렬)

S4  debate             : Controller ──┬──► barrotrade-bull-researcher
                                       ├──► barrotrade-bear-researcher
                                       └──► barrotrade-debate-moderator (직렬, 합의)

S5  risk gate          : Controller ──► barrotrade-risk-manager  (FAIL → S9)

S6  portfolio decision : Controller ──► barrotrade-portfolio-pm  (HITL 게이트)

S7  compliance         : Controller ──► barrotrade-compliance-officer

S8  audit + lock 해제  : Controller (logs/audit/*.jsonl append, .in-flight 삭제)

S9  reflect (조건부)   : Controller ──► barrotrade-self-reflector
                                       (손절·risk FAIL·HITL expired 시)
```

## 데이터 흐름 (정형 vs 비정형)

```
[정형 파이프라인]                          [비정형 파이프라인]
KIS websocket tick                          news_rss + DART
       ↓                                          ↓
Redis timeseries cache                      vector_db (embeddings)
       ↓                                          ↓
data-preprocessor                           rag-analyst
       ↓                                          ↓
10_market_snapshot.md  ←─── join ───→      15_news_rag.json
       ↓                                          ↓
   (Stage II / III 분석가들이 각 산출물을 참조)
       ↓
   ... (이후 stage)
```

## 비동기 분리형 아키텍처 (실제 거래 연결 시 권장)

본 스킬은 시뮬레이션이지만, 실거래 연결 시 PRD가 권장하는 디커플링:

```
[KIS websocket]
       ↓
[C++/Rust OMS in-memory queue]
       ↓ (writes Redis snapshot)
[Redis strategy_map]  ←────── BarroTrade Claude Skill (전략 파라미터 갱신)
       ↑                       ↑
       │                       │ (MCP read-only)
       │                       ↑
       │                  [Agents (LLM)]
       │
       ↓ (조건 매칭 1ms 내)
[C++/Rust OMS 주문 송출]
       ↓
[KIS order endpoint]
```

핵심 원칙:
1. LLM 에이전트는 **전략 파라미터만 결정**, 절대 직접 송출 X
2. 실제 tick-to-trade는 네이티브 코드 OMS 책임 (P99 ≤ 10ms)
3. 에이전트는 Redis 의 strategy_map 만 갱신, OMS 는 그것을 무한 루프로 읽음
4. MCP Read-only 프로토콜로 LLM 호출 연쇄 병목 회피

## 메모리 계층 (Episodic / Semantic / Working)

```
┌────────────────────────────────────────────┐
│ Working Memory  (현재 사이클)              │
│   workspace/<cycle_id>/*.md                │
│   사이클 종료 시 archive 로 이동           │
└────────────────────────────────────────────┘
                  ↓
┌────────────────────────────────────────────┐
│ Episodic Memory (사이클별 결과 기록)       │
│   workspace/_archive/<YYYY-MM>/<cycle_id>/ │
│   백테스트·자가성찰 시 검색 대상           │
└────────────────────────────────────────────┘
                  ↓ (reflect 트리거 시 추출)
┌────────────────────────────────────────────┐
│ Semantic Memory (오판 패턴·시장 지식)      │
│   workspace/_memory/semantic/<pattern>.md  │
│   다음 cycle RAG에 자동 주입               │
└────────────────────────────────────────────┘
```

## 상태 머신 (Cycle State Machine)

```
                ┌────────┐
                │ idle   │
                └───┬────┘
                    │ /barrotrade cycle <T>
                    ▼
              ┌──────────┐
              │ ingesting│ ──── KIS API rate limit hit ──► paused
              └──────┬───┘
                     ▼
              ┌──────────┐
              │ analyzing│ ──── any veto condition ──► aborted
              └──────┬───┘                                │
                     ▼                                    │
              ┌──────────┐                                │
              │ debating │ ──── score < threshold ────────┤
              └──────┬───┘                                │
                     ▼                                    │
              ┌──────────┐                                │
              │ risk_chk │ ──── FAIL ─────────────────────┤
              └──────┬───┘                                │
                     ▼                                    │
              ┌──────────┐                                │
              │  hitl    │ ──── timeout(24h) ──► expired ─┤
              └──────┬───┘                                │
                     ▼                                    │
              ┌──────────┐                                │
              │  order   │                                │
              │ simulated│                                │
              └──────┬───┘                                │
                     ▼                                    ▼
              ┌──────────┐                          ┌──────────┐
              │ complete │                          │ reflect  │
              └──────────┘                          └──────────┘
```

## 거버넌스 메커니즘

| 메커니즘 | 위치 | 동작 |
|----------|------|------|
| in-flight lock | `workspace/.in-flight.json` | 사이클 진입 시 락 획득, 종료 시 해제. `--force` 만 우회. |
| audit log | `logs/audit/YYYY-MM-DD.jsonl` | 사이클별 1줄 JSONL append, hash chain |
| budget tracker | `logs/budget/YYYY-MM.jsonl` | 에이전트별 토큰·API 호출 누적 |
| consensus log | `logs/consensus/<cycle>.jsonl` | 토론 라운드별 라인 |
| risk log | `logs/risk/<cycle>.jsonl` | 리스크 평가 라인별 |
| policy override | brief frontmatter `policy_override` | 운영자가 명시 token 부여 시 해당 항목만 우회 |
