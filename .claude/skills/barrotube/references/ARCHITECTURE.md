# ARCHITECTURE.md — 17 에이전트 + 위임 라인

> BarroSkills의 17 에이전트 조직도와 Task 위임 라인 정본.

## 시스템 구성 (3-Layer)

```
┌──────────────────────────────────────────────────────────────┐
│ Layer 1 — Skill Entry (Claude Code)                          │
│  /barrotube · /barrotube doctor · /barrotube ep              │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ Layer 2 — 17 Agents (~/.claude/agents/barrotube-ceo.md ~ 17-*.md)   │
│  Task(subagent_type="<NN-name>", prompt="...") 형식 호출     │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ Layer 3 — Automation Scripts (BarroSkills/scripts/automation)│
│  produce-episode.js · run-episode.js · generate-*.js 등 60개 │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ Layer 4 — External APIs                                      │
│  ElevenLabs · Gemini · YouTube Data API · FFmpeg local       │
└──────────────────────────────────────────────────────────────┘
```

## 17 에이전트 명세

| # | subagent_type | 부서 | 모델 | 월 한도 | reports To |
|---|---|---|---|---|---|
| 01 | `barrotube-ceo` | Executive | Opus | $20 | Board |
| 02 | `02-producer` | Editorial Lead | Opus | $60 | CEO |
| 03 | `barrotube-researcher` | Editorial | Sonnet | $40 | Producer |
| 04 | `barrotube-strategist` | Editorial | Opus | $40 | Producer |
| 05 | `barrotube-writer` | Editorial | Opus | $120 | Producer |
| 06 | `barrotube-fact-checker` | Editorial | Sonnet | $60 | Producer |
| 07 | `barrotube-asset-pm` | Production Lead | Sonnet | $20 | Producer |
| 08 | `barrotube-image-generator` | Production | Haiku | $150 | Asset PM |
| 09 | `barrotube-voice-engineer` | Production | Haiku | $120 | Asset PM |
| 10 | `barrotube-capcut-composer` | Production | Sonnet | $20 | Asset PM |
| 11 | `barrotube-qa-reviewer` | Quality | Opus | $60 | Producer |
| 12 | `barrotube-metadata-writer` | Distribution | Sonnet | $30 | Producer |
| 13 | `barrotube-publisher` | Distribution | Haiku | $10 | Producer |
| 14 | `barrotube-cmo` | Marketing Lead | Sonnet | $0 | Board |
| 15 | `barrotube-content-manager` | Operations | Sonnet | $20 | CEO |
| 16 | `barrotube-marketing-analyst` | Marketing | Sonnet | $0 | CMO |
| 17 | `barrotube-producer-shorts` | Editorial Lead (Shorts) | Opus | $60 | CEO |

**월 총합: $770**

## 위임 라인 (S0~S12)

```
S0  Brief         : (자동 create-episode.js)
S1  Ticket        : (BarroSkills 생략 — Paperclip 의존이라)
S2  Research      : Producer ──► barrotube-researcher
S3  Strategy      : Producer ──► barrotube-strategist
S4  Script        : Producer ──► barrotube-writer
S5  Factcheck     : Producer ──► barrotube-fact-checker
S6a TTS           : Producer ──► barrotube-asset-pm ──► barrotube-voice-engineer
S6b Sync          : (자동 sync-durations.js)
S6c Scene Images  : Producer ──► barrotube-asset-pm ──► barrotube-image-generator
S6d Intro Card    : Producer ──► barrotube-asset-pm ──► barrotube-image-generator
S6e Thumbnail     : Producer ──► barrotube-asset-pm ──► barrotube-image-generator
S7  Render        : (자동 render-direct.js)
S7b CapCut Draft  : Producer ──► barrotube-capcut-composer (선택)
S8  QA            : Producer ──► barrotube-qa-reviewer
S9  Metadata      : Producer ──► barrotube-metadata-writer
S9b SEO Enhance   : Producer ──► barrotube-metadata-writer
S10 Approval      : Producer ──► Board (Human gate, AskUserQuestion)
S11 Publish       : Producer ──► barrotube-publisher (또는 직접 publish-youtube.js)
S12 Playlist      : Producer ──► barrotube-publisher
```

## 마케팅 자동 브릿지 (Pre-S0)

```
Marketing Data (RSS/입력) ──► barrotube-marketing-analyst (분석)
   ↓
barrotube-cmo (시리즈 후보 3안)
   ↓
barrotube-ceo (curriculum + 5 brief 작성)
   ↓
(자동 producer-trigger-series.js — 5 EP 부트스트랩)
   ↓
Producer 진입 (Mode A)
```

## 페르소나·포맷 라우팅

| 페르소나 | 적용 포맷 | Producer | 톤 |
|---|---|---|---|
| `barro-teacher` | long-3min (180s, 7씬, 16:9) | `02-producer` | 친근·신뢰·교육적 |
| `barro-alert` | shorts (60s, 5씬, 9:16) | `barrotube-producer-shorts` | 경고·긴장·행동 유발 |

라우팅 키:
- brief frontmatter의 `format` 또는 `persona`
- title에 `Shorts`, `60초`, `barro-alert` 포함 → Producer Shorts
- 미명시 시 Producer (long-form) fallback

`config/personas.json`에 forbidden_patterns 정의. 위반 시 **warning_only** (reject X).

## 동시성·직렬 정책

- **EP 단위**: `workspace/.in-flight.json` 락. 한 번에 1개 EP만 produce/run 가능 (다른 EP 시도 시 exit 2 `ELOCK_HELD`)
- **Stage 단위**: 단일 EP 안에서 직렬 (S2 done 후 S3 시작)
- **에이전트 단위**: Claude Code Task로 호출 시 메인 세션과 격리. 동시에 여러 Task 호출 가능 (parallel) 단 EP 안에서는 의미 없음 (다음 stage가 이전 stage 산출물 의존)

## Sub-issue 분해 정책 (BarroSkills 결정)

기존 BarroTube의 Sub-issue 분해 정책 모순(정책 A vs B)이 있었음. BarroSkills는 **Monolith 모드**로 단순화:

- **Producer 1명이 모든 단계를 produce-episode.js + run-episode.js로 처리**
- 각 stage의 LLM 호출은 monolith가 helper 스크립트로 직접 (generate-*.js)
- Task 위임은 **선택적** — 운영자가 명시한 stage(S4 script 재집필, S8 QA 등)에만
- 부서원 활용 부족? — 의도된 trade-off (속도·비용 우선)

만약 부서원 활성화를 원한다면 SKILL.md의 Mode A를 Task 위임 흐름으로 명시 호출.

## Audit·State Tracking

| 데이터 | 위치 |
|---|---|
| EP stage 진행 | `workspace/episodes/EP-YYYY-NNNN/.episode_status.json` |
| in-flight 락 | `workspace/.in-flight.json` |
| Audit log | `logs/audit/YYYY-MM-DD.jsonl` (90일 보존) |
| Budget log | `logs/budget/usage-YYYY-MM.json` |
| Marketing intel | `workspace/intel/marketing/*.json` |
| Cron 로그 | `logs/cron/*.log` (설치 시) |

## Workflow Variants

### Quick Mode (Shorts, 5분 + 비용)
```
Mode A (신규 EP, shorts, brief에 format=shorts)
→ produce-episode.js --episode <EP> --execute  (S4~S9 일괄)
→ run-episode.js --episode <EP> --from S10 --execute  (S10~S11)
```

### Full Mode (Long-3min, 30분 + 비용)
```
Mode A (신규 EP, long-3min)
→ 각 단계 명시 Task 위임 (S2~S5)
→ produce-episode.js --episode <EP> --execute  (S6)
→ render-direct.js
→ Task 위임 (S8~S9)
→ Board 승인 (S10)
→ publish-youtube.js --execute
```

### Series Mode (5편 일괄, 며칠~몇 주)
```
Mode B (마케팅 → 시리즈)
→ Step 1~4 (무비용)
→ Step 5 = 5개 EP 부트스트랩
→ 각 EP를 일정에 따라 Mode A로 진행 (Cron 옵션 또는 수동)
```
