---
title: BarroTube 경쟁 인텔 기반 콘텐츠 자동화 고도화 PRD
status: draft
date: 2026-08-12
owner: beye
scope: barrotube · barrotube-media-render
supersedes: none
related:
  - "[[barrotube-episode-pipeline]]"
  - "[[barrotube-media-render-automation-plan]]"
  - "[[barrotube-media-render-operations-architecture]]"
---

# BarroTube 경쟁 인텔 기반 콘텐츠 자동화 고도화 PRD

> **한 줄 요약** — 경쟁 채널 6곳을 매일 자동 관측해 콘텐츠 갭·성과 이상치·블루오션 키워드를 뽑고, 그 결과가 그날의 주제 선정에 자동 반영되게 한다. 새 플랫폼을 도입하지 않고 이미 가동 중인 launchd + Node 기반 위에 배선만 잇는다.

---

## §1. 문제 정의

### 1.1 현상

경쟁 채널 분석 기능은 **코드가 완성돼 있는데도 2026-05-24 이후 한 번도 성공하지 못했다.** 마지막 산출물은 `workspace/intel/competitors/2026-05-24.json`(45KB)이고, 그 이후 2.5개월간 새 파일이 없다.

이 침묵은 조용했다. `lib/auto-pipeline.sh:198-201`이 실패를 비치명으로 삼키기 때문이다.

```bash
if [ "$COMPETITOR_SCAN" = "True" ]; then
  run_or_echo node scripts/automation/fetch-competitor-stats.js --date "$TODAY" --window-days 1 \
    || echo "⚠️  경쟁 채널 수집 실패 (OAuth 만료 가능) — 없이 진행"
fi
```

실제 결과는 EP-2026-0074·0076의 리서치 문서에 "파일이 존재하지 않아 비교 불가"라는 **결과만** 남는 형태로 나타났다. 원인은 기록되지 않았다.

### 1.2 근본 원인 4건

| # | 층 | 원인 | 코드 위치 |
|---|---|---|---|
| 1 | **수집 = 0** | 존재하지 않는 `paperclip/` 디렉토리 참조 → 매 실행 throw | `resolve-competitor-channels.js:32-33` |
| 2 | **목록 = 0** | 채널 목록 소스가 마케팅 리포트 파싱뿐인데 리포트가 만료 | `config/competitor-channels.json` v2.0 |
| 3 | **분석 = 0** | 분석 코드가 아예 없음 — 원시 JSON만 저장 | (부재) |
| 4 | **루프 = 0** | 핸드오프 규칙이 PaperClip HTTP 의존이라 격리 봉인 | `_legacy_paperclip/lifecycle-bridge.js:39-40` |

#### 원인 1 — 유령 경로

```js
// resolve-competitor-channels.js:31-33
const ROOT = resolve(import.meta.dirname, '../..');
const POLICY = join(ROOT, 'paperclip', 'config', 'competitor-channels.json');
const OVERRIDES = join(ROOT, 'paperclip', 'config', 'competitor-channel-overrides.json');
```

`ROOT`는 `.claude/skills/barrotube/`이고 `paperclip/` 하위 디렉토리는 실재하지 않는다. 실제 파일은 `config/competitor-channels.json`에 있다. 결과적으로 `throw new Error('Invalid or missing policy (expected v2.0)')`가 발생하고 `fetch-competitor-stats.js`는 무조건 exit 1이다.

**이것은 경쟁 분석만의 문제가 아니다.** 스킬 전반에 같은 유령 경로가 남아 있다 (§13.1 전수 목록).

#### 원인 2 — 목록 가용성이 리포트 신선도에 종속

v2.0 정책은 정적 채널 목록을 의도적으로 제거하고 마케팅 리포트 md를 정규식 3종으로 파싱해 채널명을 얻는다. 정책상 `max_reports: 3`, `max_age_days: 30`이다.

그런데 `workspace/intel/marketing/`에는 `YOU-99.json`(2026-04-27) 단 1건뿐이다. 30일 기준으로 이미 만료됐으므로 **원인 1을 고쳐도 채널 목록은 빈 배열이 된다.**

관측 대상 목록이 다른 파이프라인 산출물의 신선도에 종속되는 구조 자체가 장애 원인이다.

#### 원인 3 — 관측은 있는데 해석이 없다

수집 데이터는 채널당 최근 영상 10개의 제목·조회수·태그를 담고 있지만, 이를 "무엇을 다뤄야 하는가"로 바꾸는 코드가 없다. 유일한 소비 지점인 `research-brief.js:87`은 조건부 한 줄이다.

```
경쟁 채널이 이미 다룬 주제 (입력에 경쟁 데이터가 있을 때만)
```

데이터가 없으면 조용히 스킵된다.

#### 원인 4 — 의사결정 루프의 단절

`lifecycle-bridge.js`는 Rule 1(Analyst done → CMO 핸드오프)과 Rule 1b(CMO done → CEO 시리즈 기획)를 구현하고 있고 멱등 로그까지 갖췄다. 그러나:

```js
// _legacy_paperclip/lifecycle-bridge.js:39-40
const COMPANY_ID = '46041d31-43ca-4135-8db6-8a84ba0d22de';
const API_BASE = 'http://localhost:3100';
```

PaperClip 이슈 트래커 REST API에 의존한다. 스킬은 "Paperclip 0% 의존"을 선언했고 `lib/doctor-cli.sh:80`이 `localhost:3100` 문자열 유출을 검사하므로, 이 코드는 `_legacy_paperclip/`에 봉인된 참조 구현이지 실행 경로가 아니다.

추가로 `run-episode.js:440-483`의 S2(시장 조사) 스테이지는 **no-op stub**이다. 에이전트 설정 존재를 확인하고 프롬프트 문자열을 `console.log`한 뒤 곧바로 `completed`로 마킹한다. 실제 실행은 0회다.

### 1.3 왜 지금 고치는가

침묵 실패는 데이터가 없다는 사실조차 드러내지 않는다. 파이프라인은 매일 정상 종료되고, 리서치 문서는 생성되며, 에피소드는 발행된다. 다만 **경쟁 대비 차별화 없이** 만들어진다. 이 상태가 길어질수록 "무엇을 놓쳤는지 모르는" 기간이 누적된다.

---

## §2. 목표와 성공 지표

### 2.1 제품 목표

1. 지정한 경쟁 채널을 매일 자동 관측하고, 실패 시 **소리 내어** 실패한다
2. 관측 데이터를 사람이 읽지 않아도 되는 형태(구조화된 신호)로 변환한다
3. 그 신호가 **그날의 주제 선정에 자동 반영**된다
4. 시리즈 기획과 발행은 사람 승인을 유지한다

### 2.2 성공 지표

| 지표 | 목표 | 측정 방법 |
|---|---|---|
| 수집 성공률 | ≥ 95% (30일 롤링) | `intel/competitors/YYYY-MM-DD.json` 파일 존재율 |
| 주제 반영률 | ≥ 60% | `topic-*.json`의 `competitor_gap_used ≠ null` 비율 |
| API 쿼터 사용 | ≤ 30 units/일 | `intel/competitors/quota-YYYY-MM-DD.json` |
| 파이프라인 차단 | **0건** | 인텔 실패로 인한 EP 생산 중단 횟수 |
| 분석 결정성 | 100% | 동일 입력 2회 실행 시 `generated_at` 제외 완전 일치 |
| 신규 LLM 비용 | ≤ $0.10/월 | `logs/budget/usage-YYYY-MM.json` 증분 |

**측정 도구**: `node scripts/automation/intel-metrics.js` — 6개 지표를 파일에서 사후 측정하고 목표 대비 PASS/FAIL 을 낸다. `--check-determinism` 은 분석을 2회 돌려 `generated_at` 제외 완전 일치를 검사한다(느림). API·LLM 을 쓰지 않는다.

2026-08-13 실측: 쿼터 18u/일 ✅ · 파이프라인 차단 0건 ✅ · 결정성 일치 ✅ · LLM 비용 $0 ✅ · 수집 성공률 0% ❌ · 주제 반영률 0% ❌ — 뒤 둘은 OAuth 블로커와 배선 이전 데이터 때문이며, 갱신 후 재측정해야 의미가 있다.

### 2.3 비목표 (v1에서 하지 않는 것)

- 썸네일 이미지의 비전 분석 (편당 과금 + 로컬 보드에서 눈으로 보는 편이 쌈)
- 경쟁 채널 댓글·커뮤니티 탭 수집 (쿼터 대비 신호 대 잡음비 낮음)
- 검색량 API 연동 (유료, 별도 결정)
- 발행 자동화 확대 (`publish_remains_human_only: true` 유지)
- 자동 A/B 테스트

---

## §3. 아키텍처 결정

### 3.1 결정: BarroTube 네이티브 확장

새 플랫폼(n8n/Make 자체호스팅, Hermes/PaperClip 재개)을 도입하지 않고 이미 가동 중인 스택 위에 배선한다.

#### 근거 1 — 윤자동 3층 구조가 이미 다 있다

레퍼런스로 지정된 윤자동 채널(유튜브 5만, 17년차 업무자동화 전문가)이 공개한 운영 루틴은 **노션(단일 DB) + Make(워크플로우 엔진) + 슬랙(알림·승인 창구)** 3층이다. 패턴은 `입력 수집 → AI 정리 → DB 자동 저장 → 알림/승인`.

BarroTube에는 이 3층이 모두 있다.

| 윤자동 | BarroTube 대응 | 상태 |
|---|---|---|
| 노션 (단일 DB) | `workspace/intel/` + `workspace/channels/*/channel.yaml` | ✅ 가동 |
| Make (워크플로우 엔진) | `lib/auto-pipeline.sh` (launchd 2개 가동 중) | ✅ 가동 |
| 슬랙 (알림·승인) | `scripts/automation/telegram-bot.js` (`/approve` 등) | ✅ 가동 |
| **관측 → 의사결정 배선** | — | ❌ **없음** |

즉 새 층을 만들 필요가 없고, **빠진 것은 배선 하나**다. n8n을 도입하면 기존 bash/Node 파이프라인과 이중 관리가 되고, launchd 잡 5개는 그대로 남는다.

#### 근거 2 — Hermes/PaperClip은 ADR이 차단한 상태

`barrotube-media-render-operations-architecture.md`(status: accepted, rev 2)가 Paperclip × Hermes control plane을 **NO-GO**로 판정했다. 정량 평가에서 종합 2.3점(채택안 4.5 대비 최하위)이고, 재도입 게이트 6개 중 **5개가 미통과**다.

| 게이트 | 실측 (2026-08-12) |
|---|---|
| Phase 0~2 COMPLETE | ❌ 증거 파일 2026-07-19 갱신, 30일 만료 |
| Phase 3 synthetic 10건 | ❌ 미실행 |
| Phase 4 handoff 3회 | ❌ 미실행 |
| Hermes/Docker 연속 168h PASS | ❌ **Docker 데몬 자체가 꺼짐** |
| 비용 hard stop 실증 | ❌ 미실행 |
| cookie/OAuth mount 0건 | ✅ |

ADR 원문은 결정적이다.

> **Chrome 쿠키와 OAuth를 Hermes에 주는 방법은 현재 격리 설계의 핵심을 무효화한다.**

BarroTube의 미디어 생성(R2 ChatGPT, R4 Grok)은 브라우저 로그인 세션이 필수다. 즉 Hermes로 실행층을 옮기려면 격리 설계를 포기해야 한다.

#### 근거 3 — 즉시 복구 가능

원인 1(경로 버그)은 2줄, 원인 2(채널 목록)는 JSON 시드로 해결된다. **S0 스프린트 30분이면 수집이 되살아난다.** 새 플랫폼 도입은 최소 수 주다.

### 3.2 전체 데이터 흐름

```
                  ┌──────────────── launchd (macOS) ────────────────┐
                  │  competitor-scan  05:20                          │
                  │  us-close         06:00                          │
                  │  kr-close         16:00                          │
                  │  weekly-marketing Mon 09:00                      │
                  └───────────────────┬─────────────────────────────┘
                                      │
  ┌───────────────────────────────────▼──────────────────────────────────┐
  │ [수집]  fetch-competitor-stats.js                                     │
  │   config/competitor-channels.json v3.0 (정적 6채널)                    │
  │   → channels.list + playlistItems.list + videos.list  = 3 units/채널  │
  │   → intel/competitors/YYYY-MM-DD.json                                 │
  │   → intel/competitors/videos/<channelId>.json  (영구 인덱스)           │
  └───────────────────────────────────┬──────────────────────────────────┘
                                      │
  ┌───────────────────────────────────▼──────────────────────────────────┐
  │ [분석]  analyze-competitors.js  +  lib/competitor-analytics.js         │
  │   콘텐츠 갭 · 성과 이상치 · 포맷/시각 패턴 · 제목 후킹 · 블루오션        │
  │   → intel/competitors/analysis-YYYY-MM-DD.json  (+ .md)               │
  └───────────────────┬───────────────────────────┬──────────────────────┘
                      │                           │
      ┌───────────────▼──────────┐   ┌────────────▼─────────────┐
      │ [자동] research-brief.js  │   │ [승인] intel-handoff.js   │
      │  주제 선정에 갭 반영       │   │  Rule I1 → 리뷰 문서       │
      │  이상치 주제 회피          │   │  Rule I2 → 시리즈 planned │
      │  → topic-<slot>.json     │   │  (텔레그램 /intel approve)│
      └───────────────┬──────────┘   └───────────────────────────┘
                      │
      ┌───────────────▼───────────────────────────────────────────┐
      │ EP 파이프라인 S0~S12  (auto-pipeline.sh)                    │
      │   S4 generate-script.js  ← 갭이 대본까지 전파               │
      │   S6c media-render R2/R4 ← §7                              │
      │   S9 seo-enhance.js      ← 블루오션 키워드                  │
      │   S10 사람 승인 · S11 발행 (변경 없음)                       │
      └───────────────────────────────────────────────────────────┘
```

### 3.3 설계 원칙

| 원칙 | 적용 |
|---|---|
| **Fail-soft** | 인텔 경로의 어떤 실패도 exit ≠ 0을 내지 않는다. EP 생산이 우선 |
| **결정론 우선** | 수치 판정은 규칙으로, 언어 추상화만 LLM으로 |
| **무의존** | 신규 npm 패키지 0. Node 내장 `fetch`/`node:*`만 |
| **기존 재사용** | 새 파일보다 기존 파일 확장 우선. 호출자·소비자 경로 보존 |
| **증거 보존** | 모든 판정에 근거 `videoId`를 동봉해 사후 검증 가능하게 |

---

## §4. 경쟁 채널 레지스트리

### 4.1 대상 채널 (확정)

| # | 채널 | 핸들 | UC ID | 경쟁 슬롯 | 등급 |
|---|---|---|---|---|---|
| 1 | 오선의 미국증시 라이브 | `@futuresnow` | `UC_JJ_NhRqPKcIOj5Ko3W_3w` | us-close | core |
| 2 | 삼프로TV 3PROTV | `@3protv` | `UChlv4GSd7OQl3js-jkLOnFA` | 양쪽 | core |
| 3 | 슈카월드 | `@syukaworld` | `UCsJ6RuBiTVWRX156FVbeaGg` | kr-close | core |
| 4 | 소수몽키 | `@sosumonkey` | `UCC3yfxS5qC6PCwDzetUuEWg` | us-close | core |
| 5 | 설명왕_테이버 | `@테이버` | `UCOio3vyYLWiKlHSYRKW-9UA` | 양쪽 | core |
| 6 | 심플한 관심종목TV | `@심플관심종목TV` | *(handle 해석 필요)* | kr-close | watch |

채널 1은 평일 22:00~06:00 KST 라이브 방송이고 3개월 후 영상을 비공개 전환하는 운영을 한다 — us-close 슬롯의 **직접 경쟁**이다. 채널 3은 제목 후킹 레퍼런스로, 채널 5는 설명형 포맷 레퍼런스로 가치가 크다.

### 4.2 배치 결정

| 파일 | 현재 | 변경 후 |
|---|---|---|
| `config/competitor-channels.json` | 추출 정책 v2.0 | **v3.0 — 정적 `channels[]` 정본 + 수집·쿼터·분석 정책** |
| `config/competitor-channel-overrides.json` | `{"overrides": {}}` | suggest 경로 전용 별칭 매핑 |
| `intel/competitors/channel-id-cache.json` | name→UC 캐시 | handle→UC 해석 메모 (config가 정본, 캐시는 보조) |

**채널 레지스트리(`channel.yaml`)를 확장하지 않는다.** 레지스트리는 소유 자산용이다 — credentials, pipeline profile, document output, revision CAS, 시크릿 스캔, 경로변수 화이트리스트. 경쟁 채널은 그중 어느 것도 갖지 않는 **읽기 전용 관측 대상 6행**이다. 1,367줄 모듈(`lib/channel-registry.js`)과 240줄 스키마의 `oneOf`를 늘리는 비용이 20줄 JSON보다 크다.

### 4.3 `config/competitor-channels.json` v3.0

```json
{
  "version": "3.0",
  "description": "경쟁 채널 정본 목록. v2.0의 마케팅 리포트 동적 추출은 주 경로에서 제거 — 리포트 만료 시 목록이 빈 배열이 되어 2.5개월 무음 실패했다. 운영자가 이 배열을 직접 편집한다.",
  "channels": [
    { "id": "futuresnow", "name": "오선의 미국증시 라이브", "handle": "@futuresnow",
      "channelId": "UC_JJ_NhRqPKcIOj5Ko3W_3w", "tier": "core", "active": true,
      "competes_with": ["us-close"], "note": "us-close 직접 경쟁 — 평일 22:00~06:00 KST 라이브, 3개월 후 비공개 전환" },
    { "id": "3protv", "name": "삼프로TV 3PROTV", "handle": "@3protv",
      "channelId": "UChlv4GSd7OQl3js-jkLOnFA", "tier": "core", "active": true,
      "competes_with": ["us-close", "kr-close"], "note": "종합 벤치마크" },
    { "id": "syukaworld", "name": "슈카월드", "handle": "@syukaworld",
      "channelId": "UCsJ6RuBiTVWRX156FVbeaGg", "tier": "core", "active": true,
      "competes_with": ["kr-close"], "note": "제목 후킹 레퍼런스" },
    { "id": "sosumonkey", "name": "소수몽키", "handle": "@sosumonkey",
      "channelId": "UCC3yfxS5qC6PCwDzetUuEWg", "tier": "core", "active": true,
      "competes_with": ["us-close"], "note": "미국주식 개인투자자 앵글" },
    { "id": "taver", "name": "설명왕_테이버", "handle": "@테이버",
      "channelId": "UCOio3vyYLWiKlHSYRKW-9UA", "tier": "core", "active": true,
      "competes_with": ["us-close", "kr-close"], "note": "설명형 포맷 레퍼런스" },
    { "id": "simple-watch", "name": "심플한 관심종목TV", "handle": "@심플관심종목TV",
      "channelId": null, "tier": "watch", "active": true,
      "competes_with": ["kr-close"], "note": "UC 미확보 — --resolve-handles 필요" }
  ],
  "tracking": {
    "uploads_page_size": 50,
    "refresh_window_days": 14,
    "baseline_window_days": 90,
    "deep_scan_pages": 4,
    "stats_history_max": 30
  },
  "quota": {
    "daily_cap_units": 2000,
    "units": { "channels.list": 1, "playlistItems.list": 1, "videos.list": 1 },
    "note": "무료 10,000/day 중 발행 경로(videos.insert 1600 + thumbnails.set 50 + playlistItems.insert 50 ≈ 1700/편)를 위해 인텔은 2000으로 자체 제한한다."
  },
  "analysis": {
    "gap_window_days": 7,
    "own_window_days": 30,
    "gap_min_channel_df": 2,
    "gap_min_views": 20000,
    "outlier_mad_z": 3.5,
    "outlier_min_views": 10000,
    "blue_ocean_max_competition": 0.34,
    "blue_ocean_min_demand_norm": 0.5,
    "title_feature_min_n": 5,
    "title_feature_min_lift": 1.3
  },
  "discovery": {
    "enabled": false,
    "source_dir": "workspace/intel/marketing",
    "max_reports": 3,
    "max_age_days": 30,
    "output": "workspace/intel/competitors/suggested-channels.json",
    "note": "v2.0 정규식 추출기를 --suggest 모드로만 보존. 결과는 제안 파일이며 수집 대상이 되지 않는다. 운영자가 channels[]에 복사해야 반영된다.",
    "channel_name_patterns": [
      { "type": "h3_section", "regex": "^###\\s*채널\\s*\\d+\\s*:\\s*([^\\n(]+?)\\s*(?:\\(|$)" },
      { "type": "h2_section", "regex": "^##\\s*채널\\s*\\d+\\s*:\\s*([^\\n(]+?)\\s*(?:\\(|$)" },
      { "type": "table_row",  "regex": "^\\|\\s*\\d+\\s*\\|\\s*([^|]+?)\\s*\\|" }
    ],
    "exclude_names": ["채널명", "구독자", "비고", "BarroTube"],
    "min_name_length": 2,
    "max_name_length": 30
  }
}
```

### 4.4 마케팅 리포트 파싱: 제거가 아닌 강등

추출 정규식 3종은 이미 검증됐다(2026-04-30 5채널 해석 성공). 신규 채널 발굴에는 여전히 쓸모가 있다. 그러나 **수집 목록의 가용성이 리포트 신선도에 종속되는 구조**가 장애 원인이므로 주 경로에서 끊는다.

`resolve-competitor-channels.js` 개편 (215줄 → 약 120줄):

```js
// 신규 정본 API — fetch-competitor-stats.js가 이것만 호출
export function loadCompetitorChannels() {
  const policy = loadJSON(POLICY);                     // config/competitor-channels.json
  if (!policy || policy.version !== '3.0') {
    throw new Error(`Invalid policy (expected v3.0): ${POLICY}`);
  }
  const cache = loadJSON(CACHE, { by_handle: {} });
  return {
    policy,
    channels: (policy.channels || [])
      .filter(c => c.active !== false)
      .map(c => ({
        ...c,
        channelId: c.channelId || cache.by_handle?.[c.handle]?.channelId || null,
        resolved_via: c.channelId ? 'config'
                    : cache.by_handle?.[c.handle] ? 'cache'
                    : 'unresolved',
      })),
  };
}

// handle → UC. search.list(100 units) 대신 channels.list?forHandle(1 unit)
export async function resolveByHandle(handle, accessToken) { /* channels.list part=id&forHandle= */ }

// v2.0 정규식 추출기는 이 함수 하나로만 잔존 (CLI --suggest 전용)
export async function suggestChannelsFromReports() { /* → suggested-channels.json */ }
```

기존 `resolveCompetitorChannels()`는 **삭제한다** — 호출자가 `fetch-competitor-stats.js` 하나뿐이라 안전하다.

### 4.5 운영자 절차

```bash
# 채널 추가 — channels[] 에 한 줄. channelId 를 모르면 null 로 두고 handle 만 적는다
node scripts/automation/resolve-competitor-channels.js --resolve-handles   # 1 unit
#   → channel-id-cache.json 갱신 + "config 에 붙여넣을 줄" 표준출력

node scripts/automation/fetch-competitor-stats.js --dry-run                # API 0콜
npm test -- tests/competitor-registry.test.js

# 채널 삭제 — 배열에서 지우지 말고 active:false 로 둔다
#   (제거하면 과거 분석의 baseline 모집단이 깨진다)
```

---

## §5. 수집 계층

### 5.1 API 호출 경로 변경 — `search.list` 제거

현재 `fetchRecentVideos()`는 `search.list`(**100 units**)를 쓴다. uploads 재생목록 경로로 교체한다.

```
channels.list(part=snippet,statistics,contentDetails,brandingSettings, id=UC…)   1 unit
   → contentDetails.relatedPlaylists.uploads = "UU…"
playlistItems.list(part=contentDetails, playlistId=UU…, maxResults=50)           1 unit
   → [{ videoId, videoPublishedAt }] 최신 50개
videos.list(part=snippet,statistics,contentDetails, id=<최대 50개 comma-joined>) 1 unit
   → duration, viewCount, likeCount, commentCount, tags, thumbnails
```

**채널당 3 units** — 기존 102 units 대비 **34배 절감**. 부가 이득으로 `search.list`의 색인 지연·누락이 사라지고 `publishedAt` 정확도가 오른다.

### 5.2 쿼터 예산

| 작업 | 빈도 | 채널당 | 6채널 | 10채널 |
|---|---|---|---|---|
| daily scan | 1회/일 | 3 | 18 | 30 |
| deep scan (4페이지) | 1회/주 (월) | 9 | 54 | 90 |
| handle 해석 | 신규 채널당 1회 | 1 | — | — |
| **일 평균** | | | **≈26** | **≈43** |
| **월 합계** | | | ≈780 | ≈1,300 |

일 무료 쿼터 10,000 대비 **0.26%**. 발행 경로(≈1,700 units/편 × 2편 = 3,400)를 제하고도 6,000 이상 여유가 남는다. 자체 상한 `daily_cap_units: 2000`은 폭주 방지용이며 정상 운영에서 닿지 않는다.

### 5.3 영구 비디오 인덱스

`workspace/intel/competitors/videos/<channelId>.json`

```json
{
  "channelId": "UCsJ6RuBiTVWRX156FVbeaGg",
  "uploads_playlist_id": "UUsJ6RuBiTVWRX156FVbeaGg",
  "updated_at": "2026-08-12T20:20:11.043Z",
  "videos": {
    "fIuoyKl6MdI": {
      "title": "삼성전자 전격 노사 합의…",
      "publishedAt": "2026-05-24T11:22:11Z",
      "duration_s": null,
      "length_bucket": "live",
      "isShorts": false,
      "tags": ["슈카월드", "경제"],
      "thumbnail": "https://i.ytimg.com/vi/fIuoyKl6MdI/hqdefault.jpg",
      "first_seen": "2026-05-24T12:00:05.554Z",
      "stats_history": [
        { "at": "2026-05-24T12:00:05Z", "views": 35361,  "likes": 1687, "comments": 0 },
        { "at": "2026-05-25T05:20:03Z", "views": 214880, "likes": 6104, "comments": 812 }
      ]
    }
  }
}
```

증분 규칙:

```
fetchIds = playlistItems 상위 50개 중
             (videoId ∉ index)  ∨  (now − publishedAt ≤ refresh_window_days)
fetchIds = fetchIds.slice(0, 50)            # videos.list 1콜 = 1 unit 상한
index[v].stats_history.push({ at, views, likes, comments })
index[v].stats_history = 최근 30개만 유지   # 파일 무한 증식 차단
```

`stats_history`가 두 역할을 동시에 한다 — 성과 이상치의 **속도(velocity)** 신호이자, 14일이 지나 고정된 스냅샷은 90일 baseline의 안정적 모수가 된다.

### 5.4 쿼터 소진과 실패 처리

`workspace/intel/competitors/quota-YYYY-MM-DD.json`

```json
{ "date": "2026-08-12", "units_used": 26, "cap": 2000,
  "calls": [{ "at": "…", "api": "channels.list", "units": 1, "channel": "syukaworld" }] }
```

```
preflight:  planned = 3 × eligible.length
            if (ledger.units_used + planned > cap)
              → skip, audit "competitor_quota_skipped", exit 0

runtime:    403 && reason ∈ {quotaExceeded, rateLimitExceeded}
              → 남은 채널 중단, degraded:'quota' 로 부분 스냅샷 저장, exit 0
            401
              → degraded:'auth', 텔레그램 1회 알림(OAuth 갱신 필요), exit 0
            채널별 기타 오류
              → channels[].error 기록 후 다음 채널 계속
```

**모든 경로가 exit 0이다.** 파이프라인 차단 금지가 상위 제약이다.

### 5.5 `fetch-competitor-stats.js` — 같은 파일에서 재작성

새 파일명을 쓰지 않는 이유: 호출 지점(`auto-pipeline.sh:199`)과 소비 지점(`research-brief.js:183`)이 이미 이 파일명과 출력 경로를 가리킨다. 새 파일은 두 곳을 고치고 201줄 사체를 남긴다.

- **보존**: `--dry-run` / `--date` / `--window-days`, OAuth 재사용(`getSecret`), 출력 경로
- **제거**: `--skip-resolve`(search.list를 안 쓰므로 무의미), `sourced_reports`

출력 스키마는 기존의 **상위집합**이다.

```json
{
  "schema_version": 2,
  "fetched_at": "2026-08-12T05:20:11Z", "window_days": 7,
  "channel_count": 6, "unresolved_count": 0, "unresolved": [],
  "degraded": null,
  "quota": { "planned_units": 18, "used_units": 18, "cap": 2000 },
  "channels": [{
    "resolved": { "id": "syukaworld", "name": "슈카월드", "channelId": "UC…",
                  "handle": "@syukaworld", "tier": "core", "resolved_via": "config" },
    "stats": { "channelId": "…", "title": "…", "customUrl": "…", "publishedAt": "…",
               "statistics": { "subscriberCount": "3700000", "viewCount": "…", "videoCount": "…" },
               "branding_keywords": "…",
               "subscriber_delta_7d": 12000, "video_delta_7d": 9 },
    "recent_videos": [{ "videoId": "…", "title": "…", "publishedAt": "…",
                        "duration": "PT12M31S", "duration_s": 751, "length_bucket": "long",
                        "isShorts": false, "statistics": { … }, "tags": [],
                        "thumbnail": "https://i.ytimg.com/…" }]
  }]
}
```

`subscriber_delta_7d`는 7일 전 스냅샷과의 차분이며 비교 대상이 없으면 `null`이다.

---

## §6. 분석 계층

### 6.1 파일 배치

| 파일 | 성격 | 테스트 |
|---|---|---|
| `scripts/automation/lib/competitor-analytics.js` | **순수 함수만.** fs·network·`Date.now()` 주입 | 전량 유닛 테스트 |
| `scripts/automation/analyze-competitors.js` | I/O·CLI·LLM opt-in | 계약 테스트 |

산출: `workspace/intel/competitors/analysis-YYYY-MM-DD.json` + 동명 `.md`(사람용·텔레그램용).

### 6.2 결정론 / LLM 경계

| 산출물 | 방식 | 근거 |
|---|---|---|
| 토큰화 · n-gram · DF/TF | 결정론 | 재현성 · 무비용 |
| 성과 이상치 z-score | 결정론 | 수치 판정에 LLM 불필요 |
| 길이 · 시각 · 요일 분포 | 결정론 | 집계 |
| 제목 피처 lift | 결정론 | 정규식 + 중앙값 비 |
| 블루오션 점수 | 결정론 | 수식 |
| **후킹 패턴 명명·일반화** | **LLM 1콜 (opt-in `--llm`)** | 언어 추상화는 규칙으로 안 나온다 |
| **우리 채널 적용 앵글** | **추가 콜 0** — `research-brief.js`의 기존 호출이 흡수 | 이미 있는 호출에 입력만 얹는다 |

LLM 예산: `gemini-2.5-flash`, 입력 ≈2k / 출력 ≈800 토큰 = **$0.0026/회**. 일 1회 = **$0.08/월**. `strategist` 월 한도 $40 대비 0.2%. `recordCost()`로 기존 원장에 기록한다.

### 6.3 실측 기반 정정 — duration 파싱

현재 `fetch-competitor-stats.js:105`의 판정식은 정규식 하나다.

```js
isShorts: /PT\d{0,2}([0-5]?\dS)?$/.test(v.contentDetails?.duration || '')
```

**2026-08-13 실측 검증 결과** (수집 32편 + 경계 케이스 9종):

| duration | 의미 | 기대 | 현재 정규식 |
|---|---|---|---|
| `PT45S` / `PT59S` | 쇼츠 | true | ✅ true |
| **`PT1M`** | **정확히 60초** | **true** | ❌ **false** |
| `PT1M30S` / `PT12M31S` | 롱폼 | false | ✅ false |
| `P0D` | 라이브·진행중 | false | ✅ false |

즉 **버그는 두 가지이며, 라이브 오분류는 아니다.**

1. **경계 누락** — `PT1M`(정확히 60초)을 쇼츠로 잡지 못한다. `\d{0,2}`가 `1`을 먹은 뒤 `M`이 남아 `$` 앵커에서 실패한다. YouTube 쇼츠 상당수가 정확히 60초로 렌더링되므로 실질 누락률이 낮지 않다.
2. **버킷 부재** — `P0D`(라이브)가 일반 영상과 같은 모집단에 섞인다. 2026-08-13 수집분에도 1건 존재했다. 라이브는 조회수 누적 곡선이 완전히 다르므로 §6.5의 vpd 중앙값을 왜곡한다.

`isShorts` 불리언만으로는 2번을 표현할 수 없다. ISO 8601 파서 + `length_bucket`으로 교체한다.

```js
const ISO = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/;

export function parseDuration(s) {
  const m = ISO.exec(s ?? '');
  if (!m) return null;
  const sec = 86400 * (+m[1] || 0) + 3600 * (+m[2] || 0) + 60 * (+m[3] || 0) + (+m[4] || 0);
  return sec > 0 ? sec : null;              // "P0D" → null (라이브/프리미어/미처리)
}

export const lengthBucket = sec =>
  sec === null ? 'live' : sec <= 60 ? 'shorts' : sec <= 600 ? 'mid'
                        : sec <= 1800 ? 'long' : 'xlong';

export const isShorts = sec => sec !== null && sec <= 60;
```

### 6.4 (a) 콘텐츠 갭

**토큰화** — 형태소 분석기 의존 없이(무의존 관례 유지) 조사 제거 + 스톱워드.

```js
const PARTICLES = /(은|는|이|가|을|를|에|의|로|와|과|도|만|까지|부터|보다|에서|에게|으로|이나|라도)$/;
const STOP = new Set([
  '오늘','속보','실시간','라이브','다시보기','풀버전','모아보기','전체','영상',
  '이슈','뉴스','시장','경제','주식','증시','투자','분석','전망','정리','feat',
  '채널','구독','좋아요','댓글',
  // + 각 경쟁 채널명 토큰 (config 에서 동적 주입)
]);

function tokenize(title) {
  const raw = title.match(/[가-힣A-Za-z0-9]{2,}/g) ?? [];
  const uni = raw
    .map(t => (t.length >= 3 ? t.replace(PARTICLES, '') : t))
    .filter(t => t.length >= 2 && t.length <= 12 && !STOP.has(t) && !/^\d+$/.test(t));
  const bi = uni.slice(0, -1).map((t, i) => `${t} ${uni[i + 1]}`);   // 인접 2-gram
  return [...new Set([...uni, ...bi])];
}
```

**집계** (윈도 `gap_window_days = 7`, N = 활성 채널 수)

```
comp_df(t)    = |{ c ∈ channels : ∃ v ∈ videos(c, 7d), t ∈ tokenize(v.title) }|
comp_tf(t)    = Σ_v [ t ∈ tokenize(v.title) ]
comp_views(t) = Σ_{v : t ∈ tokenize(v.title)} v.views
```

**우리 코퍼스** (윈도 `own_window_days = 30`)

```
own = ∪ over workspace/episodes/EP-*/  (mtime ≤ 30d):
        00_brief.md 의 topic
      ∪ platforms/*/70_publish_meta.json 의 title,
                    seo.primary_keyword, seo.secondary_keywords[], tags[]
own_tf(t) = Σ 문자열 포함 횟수
```

**갭 점수**

```
gap(t) = log₁₀(1 + comp_views(t)) × (comp_df(t) / N) × 1 / (1 + own_tf(t))
```

필터: `comp_df ≥ 2` ∧ `own_tf = 0` ∧ `comp_views ≥ 20000`. 상위 15개, 근거 `videoId` 최대 3개 동봉.

**`comp_df ≥ 2`가 핵심 임계값이다.** 한 채널의 단발 기획은 갭이 아니라 노이즈고, 2개 이상 채널이 독립적으로 다뤘다면 수요가 검증된 것으로 본다.

### 6.5 (b) 성과 이상치

**속도 정규화 + 수정 z-score (Iglewicz–Hoaglin)**

```
vpd(v) = v.views / max(age_days(v), 1)

pool(c, bucket) = { v ∈ index(c) : bucket(v) = bucket ∧ 3d ≤ age ≤ 90d }, 최근 30개
med = median(vpd[pool])
MAD = median(|vpd − med|)

z(v) = MAD > 0 ? 0.6745 × (vpd(v) − med) / MAD
                : (vpd(v) ≥ 3 × med ? 999 : 0)          # MAD=0 폴백

outlier ⟺ z(v) ≥ 3.5  ∧  age_days(v) ≥ 1  ∧  views(v) ≥ 10000
multiple(v) = vpd(v) / med                              # 사람용: "평소의 4.2배"
```

평균·표준편차가 아니라 중앙값·MAD를 쓰는 이유: 표본 30개에서 평균과 표준편차는 **이상치 자신에게 오염된다.**

**버킷별 독립 모집단이 필수다.** shorts와 long의 vpd 분포는 자릿수가 다르다.

보조 신호(게이팅하지 않음): `stats_history`가 2점 이상이면
`velocity = (views_t − views_{t−1}) / hours_between`, `accelerating = velocity_last > velocity_prev`.

### 6.6 (c) 포맷 · 길이 · 업로드 시각 패턴

```
per (channel, bucket) over 30d:  n, median_views, median_vpd, share = n / 총n
format_recommendation = argmax_bucket median_vpd   (단, n ≥ 5 인 버킷만)

upload_hour(v) = KST 시(0..23)     # Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul' })
hour_stats[h]  = { n, median_vpd }
best_hours     = top3 { h : hour_stats[h].n ≥ 3 } by median_vpd
weekday_stats[0..6] 동일

slot_alignment = {
  "us-close": { our_publish_kst: 8,  competitor_best: best_hours,
                verdict: 8 ∈ best_hours ? 'aligned' : 'shift_candidate' },
  "kr-close": { our_publish_kst: 18, … }
}
```

`verdict: 'shift_candidate'`는 **자동 변경을 유발하지 않는다.** `routines.json`의 `publish_at`은 운영자만 바꾼다.

### 6.7 (d) 제목 후킹 패턴

**결정론 파트 (기본)**

```js
const FEATURES = {
  has_number:      t => /\d/.test(t),
  has_percent:     t => /%|퍼센트|배 |bp/.test(t),
  has_question:    t => /[?？]|왜 |어떻게|얼마나|진짜|정말|맞나/.test(t),
  has_bracket:     t => /^\[[^\]]+\]|^【/.test(t),
  has_superlative: t => /최대|최고|역대|급등|급락|폭락|폭등|사상|처음|충격|경고|비상/.test(t),
  has_split:       t => /[:|/]/.test(t),
  has_person:      t => matchesPublicFigure(t),      // lib/public-figures.js 재사용
  title_short:     t => t.length <= 30,
  has_emoji:       t => /\p{Extended_Pictographic}/u.test(t),
};

lift(f) = median_vpd({ v : f(v.title) }) / median_vpd({ v : ¬f(v.title) })
보고 조건: 양쪽 표본 n ≥ 5  ∧  (lift ≥ 1.3 ∨ lift ≤ 0.77)
```

`has_person`은 `lib/public-figures.js`(12KB 인물명 사전)를 재사용한다 — 이미 QA 정책 검출에 쓰이는 자산이다.

**LLM 파트 (`--llm`, 이상치 3건 이상일 때만)** — 단일 콜, 입력은 제목과 배수만.

```
입력:  [{ title, multiple, channel, length_bucket }] × 최대 15
출력(JSON 강제):
{ "hook_patterns": [
    { "pattern": "<한 문장 패턴명>", "evidence_titles": ["…"],
      "applicable_to_us": true|false, "why_not": "<false 일 때만>" } ] }   # 최대 5개
```

LLM 실패·타임아웃 시 `hook_patterns: []`로 두고 계속한다(fail-soft).

**썸네일은 v1 비목표.** `snippet.thumbnails.high.url`을 저장만 하고 다운로드·비전 분석은 하지 않는다.

### 6.8 (e) 블루오션 키워드 — 하드코딩 제거

```
demand(t)      = median( vpd(v) : t ∈ tokenize(v.title) )
competition(t) = comp_df(t) / N
demand_norm(t) = log₁₀(1 + demand(t)) / log₁₀(1 + max_t demand(t))
blue_ocean(t)  = demand_norm(t) × (1 − competition(t))
```

필터: `competition ≤ 0.34` ∧ `demand_norm ≥ 0.5` ∧ `own_tf = 0`. 상위 10.

N=6일 때 `comp_df = 2 → competition = 0.333 ≤ 0.34`이므로 **갭 조건(df≥2)과 블루오션 조건(comp≤0.34)이 정확히 겹치는 지점이 스위트스팟**이다 — 2개 채널이 수요를 검증했고 나머지 4개는 아직 안 건드린 주제.

**배선 1** — `ceo-analyze-marketing.js:87`의 하드코딩 상수 교체

현재 `blue_ocean_keywords: ['3분경제','경제알기쉽게', …]`는 데이터에서 도출된 게 아니라 상수인데 `:215`에서 "블루오션 키워드 (경쟁 강도 낮음, SEO 공략 대상)"으로 출력된다.

```js
// CANDIDATE_RULES 위에 추가 (~15줄). 구조 변경 없음.
function dataDerivedBlueOcean(fallback) {
  const a = newestAnalysis(14);                        // ≤14일 이내 analysis-*.json
  const top = (a?.blue_ocean_keywords ?? [])
    .filter(k => k.score >= 0.5).slice(0, 5).map(k => k.keyword);
  return top.length >= 3 ? top : fallback;             // 데이터 부족 시 기존 상수 유지
}
// seedFn() 반환 직전:
//   seed.blue_ocean_keywords = dataDerivedBlueOcean(seed.blue_ocean_keywords);
```

**배선 2** — `seo-enhance.js`의 `related_by_topic` 정적 맵에 데이터 유도 항목 최대 5개 병합 (§7.3).

### 6.9 `analysis-YYYY-MM-DD.json` 스키마

```json
{
  "schema_version": 1,
  "date": "2026-08-12",
  "generated_at": "2026-08-12T05:22:41.118Z",
  "source_snapshot": "workspace/intel/competitors/2026-08-12.json",
  "channel_count": 6,
  "windows": { "gap_days": 7, "own_days": 30, "baseline_days": 90 },
  "degraded": null,
  "llm_used": false,

  "content_gaps": [
    { "term": "국민성장펀드", "gap_score": 4.31, "comp_df": 3, "comp_tf": 5,
      "comp_views": 812400, "own_tf": 0,
      "evidence": [{ "videoId": "fIuoyKl6MdI", "channel": "슈카월드", "views": 214880 }] }
  ],

  "outliers": [
    { "videoId": "abc123", "channel": "소수몽키", "title": "…", "publishedAt": "…",
      "views": 412000, "vpd": 137333, "median_vpd": 32100, "multiple": 4.28,
      "mad_z": 6.9, "length_bucket": "mid", "duration_s": 431,
      "accelerating": true, "thumbnail": "https://i.ytimg.com/…" }
  ],

  "patterns": {
    "length": {
      "by_bucket": { "shorts": { "n": 41, "median_vpd": 8400,  "share": 0.36 },
                     "mid":    { "n": 52, "median_vpd": 21300, "share": 0.45 } },
      "recommendation": "mid"
    },
    "upload_hour_kst": { "histogram": [0,0,0,0,0,0,3,9,14,6,2,1,0,0,0,0,4,11,8,3,1,0,0,0],
                         "best_hours": [8, 17, 18] },
    "weekday_kst": { "histogram": [4,18,17,19,16,12,3], "best_weekdays": [2, 4] },
    "slot_alignment": { "us-close": { "our_publish_kst": 8,  "verdict": "aligned" },
                        "kr-close": { "our_publish_kst": 18, "verdict": "aligned" } },
    "title_features": [
      { "feature": "has_number",      "n_with": 63, "n_without": 51,  "lift": 1.62, "direction": "positive" },
      { "feature": "has_superlative", "n_with": 22, "n_without": 92,  "lift": 1.41, "direction": "positive" },
      { "feature": "has_emoji",       "n_with": 7,  "n_without": 107, "lift": 0.71, "direction": "negative" }
    ],
    "hook_patterns": []
  },

  "blue_ocean_keywords": [
    { "keyword": "국민성장펀드", "score": 0.71, "competition": 0.33,
      "demand": 137333, "demand_norm": 1.06, "evidence": ["fIuoyKl6MdI"] }
  ],

  "related_terms": { "국민성장펀드": ["정부", "재정", "세제혜택"] },

  "channel_summary": [
    { "id": "syukaworld", "name": "슈카월드", "subscribers": 3700000,
      "subscriber_delta_7d": 12000, "uploads_7d": 6, "median_vpd_30d": 32100 }
  ]
}
```

---

## §7. 피드백 루프 배선

### 7.1 `research-brief.js` — 최고 레버리지 지점

이 파일의 출력이 곧 `10_market_research.md` / `20_strategy.md`가 되고, `generate-script.js`가 `[MARKET RESEARCH]` / `[CONTENT STRATEGY]` 블록으로 이미 소비한다(`cron-pipeline-contract.test.js:80-82`가 계약을 고정). **여기 한 곳만 고치면 대본까지 자동 전파된다.**

**변경 1** — `:180-184` 입력 추가

```js
const inputs = {
  '시세 스냅샷':   { path: join(outDir, `market-${values.slot}.json`) },
  '뉴스':          { path: join(outDir, 'news.json') },
  '경쟁 채널 원시': { path: join(ROOT, 'workspace', 'intel', 'competitors', `${date}.json`) },
  '경쟁 인텔 분석': { path: newestAnalysisPath(ROOT, date, 3) },   // ≤3일 이내
};
```

**변경 2** — `buildPrompt()`의 조건부 한 줄(`:87`)을 독립 섹션으로 승격

```
## 경쟁 인텔 (분석 파일이 있으면 필수 반영, 없으면 이 섹션 전체를 건너뛴다)

분석 파일을 읽고 아래 3가지를 반드시 수행해라.

1. content_gaps 상위 5개 중, 오늘 시세·뉴스와 실제로 연결되는 것이 있으면
   candidates 에 최소 1개 포함하고 topic-*.json 의 competitor_gap_used 에 그 term 을 적어라.
   억지로 연결하지 마라 — 연결이 없으면 null 로 두어라.
2. outliers 에 등장한 주제는 오늘 다루지 마라. 이미 소진된 화제다.
   피한 주제를 avoided_duplicates 에 적어라.
3. patterns.title_features 중 direction=positive 인 피처를 angle 에 반영해라.
   (예: has_number 의 lift 가 1.3 이상이면 앵글에 구체 수치를 넣는다.)

경쟁 채널의 제목·문장을 그대로 베끼지 마라. 다루는 '주제'만 참고한다.
```

**변경 3** — `topic-<slot>.json` 스키마 확장 (`:97-104` 및 폴백 `:141-150` 양쪽)

```json
{
  "topic": "…", "angle": "…", "content_mode": "…",
  "key_numbers": [], "candidates": [], "social_searched": true,
  "competitor_gap_used": "국민성장펀드",
  "avoided_duplicates": ["삼성전자 노사합의"],
  "competitor_intel_at": "2026-08-12"
}
```

폴백 경로에서는 세 필드를 `null` / `[]`로 채운다(스키마 일관성).

### 7.2 `ceo-select-topics.js`

`loadMarketingKeywords()`(`:51-83`)에 소스 우선순위를 추가한다. 시그니처 유지, 약 20줄.

```
1순위: newest analysis-*.json (≤14d) → blue_ocean_keywords[].keyword   [신규]
2순위: 같은 파일 → content_gaps[].term                                 [신규]
3순위: 마케팅 리포트 백틱/따옴표 추출                                   [기존 유지, 폴백]
```

`scoreItem()`(`:120-127`) 가산 분리:

```js
if (blueOceanMatched.length) score += 5;   // 기존 동작 유지 (1회만)
if (gapMatched.length)       score += 3;   // 신규 (1회만)
```

`topics.json`에 `blue_ocean_matched[]` / `gap_matched[]`를 따로 실어 사후 검증을 가능하게 한다.

> 우선순위 낮음(S3 후반) — 이 스크립트는 `auto-pipeline.sh` 경로에 없다. `/produce` 수동 경로 전용이다.

### 7.3 `seo-enhance.js`

`expandRelated()`(`:126-137`)에 데이터 유도 항목을 병합한다.

```js
function competitorRelated(candidates, maxAdd = 5) {
  const a = newestAnalysis(14);
  if (!a) return [];
  const out = new Set();
  for (const cand of candidates)
    for (const co of (a.related_terms?.[cand] ?? []))      // 분석기가 사전 계산
      if (!isCompetitorBrand(co, a)) out.add(co);          // 경쟁 채널명 토큰 차단
  return [...out].slice(0, maxAdd);
}
```

분석기가 `related_terms`를 미리 계산하므로 `seo-enhance.js`는 순수 조회만 한다 — 로직 추가 0. `assembleTags()`의 500자 상한이 이미 오버플로를 막는다.

### 7.4 lifecycle-bridge Rule 1/1b 재구현 — 파일 큐

**결정: 파일 기반 큐 + 승인 마커.** 상태 머신·데몬·HTTP 없음. 실제로 필요한 규칙은 2개뿐이고, 승인 창구(Telegram)와 멱등 로그(jsonl) 관례는 이미 있다.

신규 `scripts/automation/intel-handoff.js` (약 150줄). `localhost:3100` 문자열을 포함하지 않으므로 `doctor-cli.sh:80`의 leak 검사는 GREEN을 유지한다.

```
workspace/intel/handoffs/
  queue.jsonl                       # append-only 멱등 로그
  2026-08-12-ceo-review.md          # Rule I1 산출: 사람이 읽는 의사결정 요청
  2026-08-12-ceo-review.approved    # Rule I2 트리거: 운영자 승인 마커 (빈 파일)
```

`queue.jsonl` 레코드:

```json
{ "key": "competitor-analysis:2026-08-12", "at": "2026-08-12T05:24:03Z", "rule": "I1",
  "source": "workspace/intel/competitors/analysis-2026-08-12.json",
  "target": "operator", "artifact": "workspace/intel/handoffs/2026-08-12-ceo-review.md",
  "status": "emitted" }
```

**Rule I1** (구 Rule 1: Analyst done → CMO)

```
트리거:  analysis-<date>.json 존재  ∧  key "competitor-analysis:<date>" ∉ queue.jsonl
가드:    autonomy-pause status ≠ active → skip
        todayCount("competitor-analysis:") ≥ 1 → skip      # 구 일일 상한 1 동일
액션:    <date>-ceo-review.md 작성
           · content_gaps 상위 5 (term, comp_df, 증거 videoId)
           · outliers 상위 3 (channel, title, multiple)
           · blue_ocean 상위 5 (keyword, score)
           · patterns.title_features 중 positive
           · 하단: "승인하려면 /intel approve <date>"
        텔레그램 1건 발송
기록:    queue.jsonl append
```

**Rule I2** (구 Rule 1b: CMO done → CEO 시리즈 기획)

```
트리거:  <date>-ceo-review.approved 존재  ∧  key "ceo-review-approved:<date>" ∉ queue.jsonl
가드:    동일 + todayCount 1
액션:    node ceo-analyze-marketing.js --report <analysis-json> --channel econ-daily
           → 시리즈는 status:'planned' 로만 등록
           → 첫 EP 생산은 절대 자동 실행하지 않는다
기록:    queue.jsonl append (status: 'executed' | 'failed')
```

승인 마커 생성 경로는 둘이다 — 텔레그램 `/intel approve <date>` 또는 운영자가 직접 파일 생성. HTTP·데몬이 불필요하고, `intel-handoff.js`는 일 1회 `competitor-pipeline.sh` 말미에서 실행된다.

> **함께 고칠 것**: `ceo-analyze-marketing.js:41`의 `SERIES_CONFIG_PATH`도 `paperclip/config/series.json` 유령 경로다. 실재하는 `config/series.json`으로 교정한다.

### 7.5 `run-episode.js` S2 no-op stub

두 단계로 나눈다(각각 독립 커밋).

**7.5.1 게이트 복원** (약 6줄) — ADR `:115`가 지적한 우회 차단

현재 `:478`은 산출물 존재를 확인하지 않고 무조건 `completed`로 마킹한다.

```js
if (stage.file) {
  const outputPath = join(episodeDir, stage.file);
  if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
    console.log(`  ⛔ ${stage.id} 산출물 없음: ${outputPath}`);
    updateStatus(episodeDir, episodeId, stage.id, 'blocked', { reason: 'missing_output' });
    auditLog(episodeId, 'stage_blocked', { stage: stage.id, file: stage.file });
    return false;
  }
}
updateStatus(episodeDir, episodeId, stage.id, 'completed', { agent: stage.agent });
```

**7.5.2 S2/S3 실제 실행** (약 35줄) — 새 에이전트 호출 경로를 만들지 않고 이미 작동하는 `research-brief.js`에 위임한다.

```js
if (stage.id === 'S2' || stage.id === 'S3') {
  const slot = detectSlot(episodeDir);                    // 00_brief.md frontmatter
  const date = briefDate(episodeDir) ?? today();
  const tmp  = mkdtempSync(join(tmpdir(), 'bt-s2-'));
  const args = ['scripts/automation/research-brief.js',
                '--slot', slot ?? 'us-close', '--date', date, '--out-dir', tmp,
                ...(slot ? [] : ['--fallback'])];
  spawnSync('node', args, { cwd: ROOT, stdio: 'inherit', timeout: 600_000 });
  const src = stage.id === 'S2' ? `research-${slot}.md` : `strategy-${slot}.md`;
  copyFileSync(join(tmp, src), join(episodeDir, stage.file));
  // 이후 7.5.1의 파일 검증 게이트가 completed 여부를 판정
}
```

**모순 해소**: `config/formats.json`의 `shorts.pipeline.skip_stages: ["S2_market_research","S3_strategy"]`와 `auto-pipeline.sh`의 강제 설치가 충돌한다. skip_stages에서 두 항목을 제거해 정본을 실제 동작에 맞춘다.

---

## §8. media-render (R0~R11) 통합

### 8.1 현재 자동화 수준

`barrotube-media-render`는 별도 레포가 아니라 `.claude/skills/barrotube-media-render/`의 스킬이다(정본 1개 + 심볼릭 링크 2개).

| 단계 | 종류 | 상태 |
|---|---|---|
| R0 / R0.5 | manual | ❌ 주제 발굴 — autopilot이 `blocked_kind:"manual"`로 즉시 반환 |
| R1, R3, R5, R6, R8, R9, R11 | deterministic | ✅ `reel_autopilot.py` 자동 완주 |
| **R2** (ChatGPT 이미지) | browser | ⚠️ 대화형 세션 또는 `codex exec` |
| **R4** (Grok 영상) | browser | ⚠️ 동일 |
| **R7** (CapCut) | GUI | ⚠️ 사람 |
| **R10** (발행) | HITL | 🔒 사람 승인 필수 |

즉 **R2·R4·R7·R10 네 지점에서 반드시 멈춘다.**

강점은 이미 견고하다 — `render_reel_job.py`(1,189줄)의 `fcntl.flock` 릴 단위 락, revision CAS, SHA-256 증거, v1→v2 lazy 마이그레이션, 13종 `ERROR_TYPES` 분류, 종료코드 계약(0/2/3/4/5), 35개 테스트.

### 8.2 통합 지점 — R0 자율 주제 발굴 체인

**경쟁 인텔이 직접 연결되는 곳은 R0다.** 설계는 `barrotube-media-render-automation-plan.md:581-585`에 이미 있다.

```
3. topic 없으면 R0 자율 체인:
     marketing-analyst → 주제 후보 N개
     → R0.5 fact-check gate (barrotube-fact-checker)
          HIGH risk → 반려, 다음 후보 (모두 반려면 사람에게 에스컬레이션)
     → ceo brief → strategist hook → writer script/prompts
```

문제는 이 체인의 첫 입력인 "marketing-analyst의 주제 후보"가 없었다는 것이다. §6의 분석 산출물이 그 자리를 채운다.

**배선안** — `render_reel_job.py`의 `STAGES`에서 R0의 `kind`를 `manual` → `auto`로 바꾸고, `reel_autopilot.py:340-499`의 `blocked_kind:"manual"` 분기 앞에 R0 처리를 추가한다.

```
R0 입력:  workspace/intel/competitors/analysis-<date>.json  (≤3일)
R0 산출:  <reel_dir>/00_topic.json
          { topic, angle, source: "content_gap"|"blue_ocean",
            evidence: [videoId], gap_score, fact_check_required: true }
R0.5:     기존 barrotube-fact-checker 위임 (HIGH → 다음 후보)
후보 소진: exit 3 (blocked) + 사람 에스컬레이션 — 자동 생성으로 때우지 않는다
```

R0가 자동화되면 릴스 파이프라인의 **manual 정지점이 4개에서 3개로** 줄고, 주제 결정이 데이터 근거를 갖게 된다.

### 8.3 R2/R4 무인화 — Sprint 2 worker 계약

ADR `:339-358`이 worker 결과 계약을 JSON 스키마로 이미 확정했다. 이를 구현 기준으로 채택한다.

```json
{
  "job_id": "econ-daily/EP-YYYY-NNNN",
  "stage": "R2 | R4 | S6c | S6c-motion | S6d",
  "cut": 1,
  "status": "completed|blocked|failed",
  "error_type": null,
  "recoverable": false,
  "artifacts": [
    { "path": "Image/ep-cut1.png", "sha256": "…",
      "binding": "요청↔다운로드 연결 증거 (메시지 식별자 또는 다운로드 직후 md5 대조 기록)" }
  ],
  "next_action": null
}
```

**미구현 실체 (정직 고지)** — 문서에는 있으나 코드가 없다.

| 항목 | 문서 위치 | 실체 |
|---|---|---|
| `browser_workers/{chatgpt,grok}` | 계획서 `:615` | **없음** (`find -iname "*worker*"` 0건) |
| `build_capcut_reel_draft.py` | 계획서 `:39` | **없음** |
| `publish_instagram_guarded.py` | ADR 참조 | **`.pyc`만 잔존** — `git log --all` 0건, 커밋된 적 없음 |
| R0 자율 체인 | 계획서 `:576-599` | **미배선** |

**rev2 실측 제약** (EP-2026-0068 기반) — worker 구현 시 반드시 반영:

- **클립보드 전역 lock** — `«class PNGf»` 첨부는 머신 전역 공유 자원이다. 계정 lock과 별개의 전역 lock 필요
- **TCC 차단 대응** — macOS TCC가 `~/Downloads` readdir을 차단하는 환경을 기본 가정. Chrome History(`target_path`) 조회 + `osascript` 복제를 표준 회수 절차로
- **컷-파일 결속** — 대화 내 이미지가 전부 동일 크기(941×1672)라 정렬·크기 기반 식별 **금지**(EP-0068 오배치 실사례). 다운로드 직후 md5 대조 + 결속 증거 기록
- **오류 분류 확장** — `connection_lost`(브라우저 확장 단절, 실측 세션당 수 회), `tls_block`(네트워크 교체 필요), `tcc_denied`, `option_drift`, `timeout`

**안전 불변식** (계획서 `:600-605`, 변경 없음):

- 결제·유료 전환 **절대 금지** — quota/paywall은 항상 비결제 경로로 우회
- 로그인 대행 금지 — `not_logged_in`은 사람에게
- 게시(R10)·파일 삭제는 명시적 사람 승인 후에만

### 8.4 EP 모드 연결 — 파일 게이트 계약 유지

EP 파이프라인(S0~S12)과 media-render는 **호출 API가 아니라 파일 경로 규약 + exit 3**으로 연결된다. 이 계약은 이미 작동하므로 **변경하지 않는다.**

- `config/image-engines.json`이 SSOT — `stages.S6c_scene / S6d_intro / S6e_thumbnail = "media-render"`
- `produce-episode.js:306-314`가 산출물 존재만 확인하고 불완전하면 `exit 3`
- `auto-pipeline.sh:374-453` Phase 7이 `codex exec --ephemeral`로 Chrome 조작 시도
- 성공 판정은 에이전트 응답이 아니라 `media_assets_ready()` **파일 게이트**로만 — scene_001~005 png + mp4 ffprobe 통과 + 오디오 codec aac + SHA-256 중복 없음 + intro/thumbnail = 12자산

이 "에이전트 말을 믿지 않고 파일만 믿는" 설계가 media-render 신뢰성의 핵심이며, 경쟁 인텔 통합에서도 동일 원칙을 적용한다.

### 8.5 우선순위

R2/R4 브라우저 worker 코드화는 **S7 이후 별도 산정**한다. 근거 — ADR이 "조작 주체는 당분간 대화형 유지(결정 9)"로 확정했고, 재사용할 기존 CDP 구현이 없어 신규 개발 기준이다. 경쟁 인텔(S0~S6)이 먼저 완료되어야 R0 자동화의 입력이 생긴다.

---

## §9. 스케줄링과 운영

### 9.1 신규 루틴 `competitor-scan`

`lib/install-cron.sh:55-89`의 case에 4줄 추가:

```bash
competitor-scan)
  script_path="${BARROTUBE_HOME}/lib/competitor-pipeline.sh"
  extra_args=""
  ;;
```

신규 `lib/competitor-pipeline.sh` (약 45줄). 별도 셸을 만드는 이유: `guards.sh`의 `audit` / `notify_telegram`이 bash 헬퍼이고, 이를 Node로 재구현하는 편이 셸 45줄보다 크다.

```bash
set -uo pipefail
source "${SCRIPT_DIR}/guards.sh"
guard_master_switch || exit 0            # paused 면 조용히 종료

DATE=$(date +%Y-%m-%d)
node scripts/automation/fetch-competitor-stats.js --date "$DATE" \
  || { echo "⚠️ 수집 실패"; audit "competitor_fetch_fail" "WARN" "date=$DATE"; }
node scripts/automation/analyze-competitors.js --date "$DATE" \
  || { echo "⚠️ 분석 실패"; audit "competitor_analyze_fail" "WARN" "date=$DATE"; }
node scripts/automation/intel-handoff.js --date "$DATE" \
  || echo "⚠️ 핸드오프 실패"
exit 0                                   # 항상 0 — 다음 슬롯을 막지 않는다
```

**주기: 매일 05:20 KST.** us-close(06:00) 40분 전이라 `research-brief.js`가 당일 분석 파일을 확실히 읽고, kr-close(16:00)도 같은 파일을 재사용한다. 경쟁 채널 업로드 빈도(1~3편/일)에 하루 1회면 충분하다.

```bash
bash lib/install-cron.sh install competitor-scan "05:20"
```

### 9.2 `auto-pipeline.sh` Phase 1 — catch-up

`:198-201`을 교체한다.

```bash
if [ "$COMPETITOR_SCAN" = "True" ]; then
  ANALYSIS="${BARROTUBE_HOME}/workspace/intel/competitors/analysis-${TODAY}.json"
  if [ ! -s "$ANALYSIS" ]; then
    # 05:20 정기 스캔이 실패했을 때만 만회 실행 — 쿼터 이중 지출 방지
    run_or_echo node scripts/automation/fetch-competitor-stats.js --date "$TODAY" \
      || echo "⚠️  경쟁 채널 수집 실패 — 없이 진행"
    run_or_echo node scripts/automation/analyze-competitors.js --date "$TODAY" \
      || echo "⚠️  경쟁 분석 실패 — 없이 진행"
  else
    echo "  ⏭  경쟁 인텔 재사용: $ANALYSIS"
  fi
fi
```

`fail_with_alert`를 **절대 쓰지 않는다** — `|| echo` fail-soft 관례를 그대로 따른다. `routines.json`은 `us-close.competitor_scan: true` / `kr-close: false`를 유지한다(kr-close는 05:20 산출물 재사용).

### 9.3 `weekly-marketing` 부활

코드 변경 없음. 현재 plist는 구 경로(`/Users/beye/youtube-co/scripts/automation/routine-trigger.js`)를 가리키고 launchctl에 로드돼 있지 않다.

```bash
bash lib/install-cron.sh uninstall weekly-marketing 2>/dev/null
bash lib/install-cron.sh install weekly-marketing "Mon 09:00"
launchctl print gui/$(id -u)/com.barroskills.barrotube.weekly-marketing | grep state
```

`install-cron.sh:38-43`이 `which node/claude/codex`로 PATH를 재계산하므로 경로 문제가 함께 해소된다.

### 9.4 텔레그램

`telegram-bot.js`의 `COMMANDS` 맵(`:300`)에 2개 추가:

```
/intel [YYYY-MM-DD]          — analysis 요약 (갭 5 · 이상치 3 · 블루오션 5)
/intel approve YYYY-MM-DD    — <date>-ceo-review.approved 마커 생성 (Rule I2 트리거)
```

**푸시 발송은 조건부 1건만**:

```
발송 ⟺ outliers ≥ 1  ∨  content_gaps ≥ 3  ∨  degraded ≠ null
```

매일 "발견 0건" 알림은 운영자가 채널 전체를 무시하게 만든다.

---

## §10. 보드 가시화

### 10.1 서버 — 라우트 1개

`tools/board/server.js` 라우팅 블록(`:951-1055`)의 `/api/channels` 분기 앞에 삽입:

```js
if (req.method === 'GET' && segments.length === 3
    && segments[1] === 'intel' && segments[2] === 'competitors') {
  const q = url.searchParams.get('date');
  if (q && !/^\d{4}-\d{2}-\d{2}$/.test(q))
    throw new HttpError(400, '날짜 형식이 올바르지 않습니다.', 'INVALID_DATE');
  return json(res, 200, readIntelSummary(intelRoot, q));   // 없으면 { available:false }
}
```

- `intelRoot`는 옵션 주입 가능하게 한다(테스트용)
- GET이므로 mutation token 불필요. loopback bind + Host/Origin 검증은 `createBoardServer`가 전역 적용
- **경로 주입 차단이 이 라우트의 유일한 보안 요구사항** — 정규식 검증 후에만 `join()`에 넣는다
- 파일 부재 시 500이 아니라 `200 {available:false}` — 보드가 죽지 않는다

### 10.2 클라이언트 — 패널 1개

`tools/board/index.html`의 워크스페이스 패널(`:783-853`) 다음에 `<section class="panel" id="intelPanel">`을 추가한다. 기존 바닐라 스타일과 `esc()` / `api()` 헬퍼를 재사용하고 프레임워크는 쓰지 않는다.

```
[경쟁 인텔  2026-08-12  ↻]
  채널 6 · 갭 12 · 이상치 3 · 쿼터 18/2000
  ┌ 채널 현황 ──────┐  채널 | 구독자 | Δ7d | 업로드7d
  ┌ 콘텐츠 갭 ──────┐  주제 | 점수 | 다룬 채널수 | 근거(→YouTube 링크)
  ┌ 성과 이상치 ────┐  [썸네일 96px] 제목 | 채널 | 평소의 N배 | 조회수
  ┌ 블루오션 ───────┐  키워드 | 점수 | 경쟁도
```

`renderIntel()`을 `loadAll()`(`:1155`)에서 호출한다. 썸네일은 YouTube CDN URL을 `<img src>`로 직접 쓴다 — 공개 CDN이고 보드는 loopback 전용이라 프록시가 불필요하다.

**v1 비목표**: 필터 UI, 차트, 채널 드릴다운, 시계열, 쓰기 액션.

---

## §11. 테스트 전략

`node --test tests/*.test.js`, 프레임워크 0, 네트워크 0. 현재 16파일 94테스트 → 20파일 약 125테스트.

### 11.1 픽스처

| 파일 | 출처 | 목적 |
|---|---|---|
| `tests/fixtures/competitors-2026-05-24.json` | **실측 45KB 무가공 복사** | 실제 스키마 · `P0D` 라이브 · 채널별 영상 수 편차 |
| `tests/fixtures/competitors-synthetic.json` | 손작성 약 2KB | MAD=0, 단일 영상 채널, shorts/long 혼합, 조회수 0 |
| `tests/fixtures/own-corpus.json` | 손작성 | `own_tf` 계산용 우리 제목·태그 |

실측 파일을 **무가공**으로 넣는 이유: 가공하면 `P0D` 같은 "설계가 놓쳤던 현실"이 픽스처에서 사라진다.

### 11.2 신규 테스트 4파일

**`tests/competitor-registry.test.js`** (약 8건)
- v3.0 검증, `channels.length ≥ 6`, 각 항목 `id/name/handle` 존재
- `channelId`는 `/^UC[\w-]{22}$/` 또는 `null`, `id`·`channelId` 중복 없음
- `loadCompetitorChannels()`가 `active:false` 제외 + 캐시 병합
- **회귀 가드**: `scripts/automation/*.js` 어느 파일도 `join(ROOT, 'paperclip'`을 포함하지 않음

**`tests/competitor-analytics.test.js`** (약 16건, 순수 함수)
- `parseDuration('PT12M31S') === 751`, `parseDuration('PT1M') === 60`, `parseDuration('P0D') === null`, `lengthBucket(null) === 'live'`
- `isShorts(60) === true` ← **`PT1M` 경계 회귀 차단** (구 정규식이 놓치던 케이스), `isShorts(61) === false`, `isShorts(null) === false`
- `tokenize()` 조사 제거·스톱워드 결과 일치
- `contentGaps()` 전 항목 `comp_df ≥ 2 ∧ own_tf === 0`, 내림차순
- `outliers()` — MAD=0 폴백에서 10× 검출, 1.2× 미검출
- `blueOcean()` 단조성: `competition` 증가 → `score` 감소
- `titleFeatureLift()` — 한쪽 표본 n<5면 미보고
- **결정성**: 같은 입력 2회 → `assert.deepEqual` (Set/Map 순회 누출 차단)

**`tests/competitor-quota.test.js`** (약 6건)
- `planQuota(6) === 18`, `planQuota(10, {deep:true}) === 90`
- `preflight({used:1990, planned:18, cap:2000})` → blocked + 사유
- `classifyApiError` — 403+`quotaExceeded`→`'quota'`, 401→`'auth'`, 404→`'not_found'`, 500→`'transient'`
- `degraded:'quota'`일 때도 유효 JSON을 쓰고 exit 0

**`tests/board-intel.test.js`** (약 5건, `channel-board.test.js:117-130` 하네스 재사용)
- `createBoardServer({ intelRoot: tmp })` + `listen(0, '127.0.0.1')`
- `?date=2026-05-24` → 200, 픽스처 채널명 포함
- `?date=../../../etc/passwd` → **400** (경로 주입 차단)
- 파일 부재 → **200 `{available:false}`**
- 토큰 없는 GET도 200 (mutation이 아님)

### 11.3 기존 계약 테스트 확장

`tests/cron-pipeline-contract.test.js`에 1건 추가. 이 파일은 이미 auto-pipeline.sh의 단계 **순서 계약**을 검증하는 선례다.

```js
test('competitor intel runs before research and never blocks the pipeline', () => {
  const src = readFileSync(AUTO, 'utf8');
  const fetchIdx    = src.indexOf('fetch-competitor-stats.js');
  const analyzeIdx  = src.indexOf('analyze-competitors.js');
  const researchIdx = src.indexOf('research-brief.js');
  assert.ok(fetchIdx >= 0 && fetchIdx < analyzeIdx && analyzeIdx < researchIdx);

  // fail-soft: 경쟁 블록 어디에도 fail_with_alert 가 없어야 한다
  assert.doesNotMatch(src.slice(fetchIdx - 400, researchIdx), /fail_with_alert/);

  const install = readFileSync(INSTALL, 'utf8');
  assert.match(install, /^\s*competitor-scan\)$/m);

  const research = readFileSync(RESEARCH, 'utf8');
  assert.match(research, /content_gaps/);
  assert.match(research, /competitor_gap_used/);

  // doctor 계약: 신규 스크립트가 Paperclip API URL 을 유출하지 않는다
  for (const f of ['analyze-competitors.js', 'intel-handoff.js', 'fetch-competitor-stats.js'])
    assert.doesNotMatch(readFileSync(join(ROOT, 'scripts', 'automation', f), 'utf8'),
                        /(localhost|127\.0\.0\.1):3100/);
});
```

---

## §12. 실행 계획

**S0~S6 · §13 전부 2026-08-13 완료.** 35파일 변경(+1,288/−234), 테스트 94 → **138 전부 통과**.

| 스프린트 | 범위 | 상태 | 실측 |
|---|---|---|---|
| **S0** | 경로 버그 + 6채널 시드 | ✅ | 5/6 즉시 해석, 32편 수집 |
| **S1** | 수집 재작성 (uploads 경로·증분·쿼터) | ✅ | 510u → **18u**, 6/6 채널, 인덱스 300편 |
| **S2** | 분석 5종 | ✅ | 갭 15 · 이상치 20 · 블루오션 10 |
| **S3** | 소비 배선 | ✅ | research-brief / ceo-select / seo-enhance / ceo-analyze |
| **S4** | 스케줄·알림 | ✅ | launchd 4잡 가동, `/intel` 명령 |
| **S5** | 보드 | ✅ | 라우트 1 + 패널 1, 경로주입 400 |
| **S6** | 루프 폐쇄 | ✅ | 게이트 복원 + S2/S3 위임 |
| **§13** | 유령 경로 정리 | ✅ | **22곳 / 13파일** (계획 10곳보다 많았다) |
| **S7** | media-render R0 배선 | ✅ | R0 auto 승격 + 증거 게이트, 정지점 4→3 |

### 구현 중 드러난 것 — 계획에 없던 4건

| 발견 | 내용 | 처리 |
|---|---|---|
| **`Number(null) === 0`** | `subscriberDelta` 가 "이전 값 없음"을 "이전엔 0명"으로 읽어 **구독자 전체가 증가분**으로 보고됐다 (`Δ7d +1,190,000`) | null 선검사 + 회귀 테스트 |
| **채널 규모 교란** | 제목 피처 lift 가 피처 효과가 아니라 채널 크기를 재고 있었다. `has_bracket` 5.98× → 정규화 후 **1.63×**, `has_split`·`has_percent`·`title_short`·`has_question` 은 전부 탈락 | `relativeVpd()` 채널 내 정규화 + `minChannels: 2` |
| **pause 게이트 위치** | `guard_master_switch` 를 파이프라인 앞에 두니 **관측까지 멈췄다**. pause 기간 내내 인덱스가 비면 재개 시 baseline 도 이상치 판정도 불가능 | 게이트를 `intel-handoff.js`(의사결정)로 이동, 수집·분석은 계속 |
| **실패가 데이터를 파괴** | OAuth 만료 시 채널마다 토큰 재발급을 시도해 6번 실패하고, 그 결과로 **정상 스냅샷을 빈 파일로 덮었다** | 토큰 선발급 후 즉시 중단 + 수집 0건이면 기존 스냅샷 보존 |
| **분석이 시각 의존** | `vpd = views / age_days` 라 `new Date()` 가 흐르면 같은 입력에도 `gap_score`·`multiple` 이 달라졌다. 순수 함수 테스트는 `now` 를 고정해 통과했지만 **실제 실행 경로는 비결정적**이었다 — PRD §2.2 의 "결정성 100%" 가 실측에서 깨졌다 | 기준 시각을 날짜 끝(`<date>T23:59:59Z`)으로 고정. `generated_at`(실행 시각)과 `analysis_basis`(기준 시각)를 분리 |

### S7 — media-render R0 배선 ✅ 완료 (2026-08-13)

경쟁 인텔이 **릴 주제 결정까지** 도달했다. R0 자율 주제 발굴 체인의 없던 첫 입력이 채워진 것이다.

- `scripts/topic_from_intel.py` 신규 — 분석 파일에서 블루오션 우선, 갭 차선으로 후보를 뽑고 이상치에 걸린 주제는 제외. LLM·네트워크 없이 결정론
- `render_reel_job.py` STAGES에서 **R0 `manual` → `auto`**. R0.5(사실 검증)는 모델이 필요해 manual 유지
- `evidence()`에 R0 항목 등록 — `00_topic.json` 이 유일한 완료 증거

**증거 게이트가 실제로 막는다** (스모크 검증):

```
job init            → next: R0
end R0 (증거 없이)   → exit 2  "R0 completion evidence is missing"
topic_from_intel    → "10년물 국채" (source: blue_ocean, intel: 2026-08-13)
end R0 (증거 후)     → exit 0  R0 completed, next: R0.5
```

산출된 `00_topic.json` 은 근거 `videoId`, positive 제목 피처(`has_bracket`·`has_number`), 대안 4개(`경매`·`국채 경매`·`반도체 강세`·`세레브라스`)를 함께 담는다. 인텔이 없거나 쓸 만한 키워드가 없으면 **주제를 지어내지 않고** exit 3 으로 사람에게 넘긴다.

**정지점 4개 → 3개.** R2(ChatGPT)·R4(Grok)·R7(CapCut)·R10(발행) 중 R0 앞단이 자동화됐다. 안전 불변식(결제 금지·로그인 대행 금지·R10 HITL)은 그대로다.

media-render 테스트 35 → **36** (R0 증거 계약) + autopilot 8 → **11** (R0 분기·분류·경로).

### S0 — 즉시 복구 ✅ 완료 (2026-08-13)

변경 3건: ① `POLICY`/`OVERRIDES` 상수의 `'paperclip','config'` → `'config'` ② `competitor-channels.json`을 v3.0 정적 `channels[]` 6개로 교체 ③ `resolveFromStaticList()` 분기 추가 — v3.0이면 마케팅 리포트를 읽지 않고 즉시 반환, v2.0은 레거시로 유지

```bash
node scripts/automation/fetch-competitor-stats.js --dry-run          # 6행 출력, exit 0
node scripts/automation/fetch-competitor-stats.js --date $(date +%F)
python3 -c "import json;d=json.load(open('workspace/intel/competitors/$(date +%F).json'));print(d['channel_count'], d['unresolved_count'])"
```

**실측 결과** — `workspace/intel/competitors/2026-08-13.json`, 80일 만의 첫 성공:

| 채널 | 구독자 | 7일 업로드 | 해석 |
|---|---:|---:|---|
| 슈카월드 | 3,720,000 | 7 | config |
| 삼프로TV 3PROTV | 3,040,000 | 10 | config |
| 오선의 미국 증시 라이브 | 1,190,000 | 10 | config |
| 소수몽키 | 1,160,000 | 4 | config |
| 설명왕_테이버 | 297,000 | 1 | config |
| 심플한 관심종목TV | — | — | unresolved (S1) |

`channel_count: 5` / `unresolved_count: 1` — 합격 기준 일치. 총 32편 수집, 쿼터 510 units 사용(S1에서 15로 감소 예정). 회귀 테스트 **91/91 통과**.

### S1 — 수집

```bash
node scripts/automation/resolve-competitor-channels.js --resolve-handles   # 1 unit
node scripts/automation/fetch-competitor-stats.js --date $(date +%F)
python3 -c "
import json
d=json.load(open('workspace/intel/competitors/$(date +%F).json'))
assert d['schema_version']==2 and d['channel_count']==6 and d['quota']['used_units']<=20
assert all('duration_s' in v for c in d['channels'] for v in c['recent_videos'])
print('OK', d['quota'])"
ls workspace/intel/competitors/videos/ | wc -l     # 6
npm test -- tests/competitor-registry.test.js tests/competitor-quota.test.js
```

**합격 기준**: 쿼터 ≤ 20 units, 6채널 전부 `resolved_via ≠ 'unresolved'`, 비디오 인덱스 6파일.

### S2 — 분석

```bash
node scripts/automation/analyze-competitors.js --date $(date +%F)
python3 -c "
import json;a=json.load(open('workspace/intel/competitors/analysis-$(date +%F).json'))
assert a['schema_version']==1
assert all(g['comp_df']>=2 and g['own_tf']==0 for g in a['content_gaps'])
assert all(o['mad_z']>=3.5 and o['views']>=10000 for o in a['outliers'])
assert all(b['competition']<=0.34 for b in a['blue_ocean_keywords'])
assert len(a['patterns']['upload_hour_kst']['histogram'])==24
print('gaps',len(a['content_gaps']),'outliers',len(a['outliers']))"
npm test -- tests/competitor-analytics.test.js
```

**합격 기준**: `content_gaps ≥ 5`, 2회 실행 결정성 통과, LLM 미사용 시 비용 원장 증분 $0.

### S3 — 배선

```bash
node scripts/automation/research-brief.js --slot us-close --date $(date +%F) --dry-run
node scripts/automation/research-brief.js --slot us-close --date $(date +%F)
python3 -c "
import json;t=json.load(open('workspace/daily-news/$(date +%F)/topic-us-close.json'))
assert 'competitor_gap_used' in t; print(t.get('competitor_gap_used'), t.get('avoided_duplicates'))"
npm test
```

**합격 기준**: `topic-*.json`에 신규 3필드, `10_market_research.md`에 경쟁 관련 문단 1개 이상, 전체 테스트 통과.

### S4 — 스케줄

```bash
DRY_RUN=1 bash lib/install-cron.sh install competitor-scan "05:20"   # plist만
bash lib/install-cron.sh install competitor-scan "05:20"
bash lib/install-cron.sh install weekly-marketing "Mon 09:00"
bash lib/competitor-pipeline.sh; echo "exit=$?"       # 반드시 0
DRY_RUN=1 bash lib/auto-pipeline.sh --slot us-close | grep -E "경쟁 인텔 재사용|경쟁 채널"
bash lib/doctor-cli.sh | grep paperclip_leak          # GREEN
```

**합격 기준**: plist state=waiting, `weekly-marketing` 경로에 `youtube-co` 부재, doctor GREEN, 파이프라인 exit 0.

### S5 — 보드

```bash
npm run board &
curl -s "http://127.0.0.1:8933/api/intel/competitors?date=$(date +%F)" | python3 -m json.tool | head -20
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8933/api/intel/competitors?date=../../etc"  # 400
curl -s "http://127.0.0.1:8933/api/intel/competitors?date=1999-01-01" | grep '"available": false'      # 200
npm test -- tests/board-intel.test.js
```

### S6 — 루프 폐쇄

```bash
node scripts/automation/intel-handoff.js --date $(date +%F)
cat workspace/intel/handoffs/$(date +%F)-ceo-review.md
node scripts/automation/intel-handoff.js --date $(date +%F)    # 멱등: skip
touch workspace/intel/handoffs/$(date +%F)-ceo-review.approved
node scripts/automation/intel-handoff.js --date $(date +%F)    # Rule I2 → series planned
python3 -c "import json;print([s['status'] for s in json.load(open('config/series.json')).get('series',[])])"
```

**합격 기준**: `queue.jsonl` 2행, 재실행 시 신규 행 0, 신규 시리즈 전부 `planned`, S2가 산출물 없으면 `blocked`.

### 전 스프린트 공통 불변식

- `config/autonomy-pause.json`의 `status: "paused"` · `publish_remains_human_only: true` **변경 금지**
- 신규 npm 의존성 **0** (Node 내장 `fetch` / `node:*`만)
- 경쟁 인텔 경로의 어떤 실패도 `exit ≠ 0`을 내지 않음
- `grep -rE "(localhost|127\.0\.0\.1):3100" scripts/automation/*.js` 결과 **0행**

---

## §13. 부록

### 13.1 `paperclip/` 유령 경로 전수 (조사 중 발견)

경로 버그는 경쟁 분석 하나가 아니라 **스킬 전반의 미정리 부채**다. 설정이 `config/`로 이전됐으나 참조가 남았다.

| 파일 | 줄 | 영향 |
|---|---|---|
| ~~`resolve-competitor-channels.js`~~ | ~~32-33~~ | ✅ **S0에서 수정 완료 (2026-08-13)** |
| `ceo-analyze-marketing.js` | 41 | 🔴 시리즈 등록 실패 (**S6에서 수정**) |
| `create-episode.js` | 40, 132 | 🔴 시리즈 모드 `exit 1` |
| `budget-report.js` | 15 | 🟡 예산 리포트 설정 미로드 |
| `create-series.js` | 30 | 🟡 시리즈 생성 |
| `notify.js` | 13 | 🟡 알림 설정 미로드 |
| `reformat-vertical.js` | 123-124 | 🟡 `exit 1` |
| `generate-thumbnail.js` | 74, 321 | 🟡 CWD 상대경로 |
| `generate-intro.js` | 69, 237 | 🟡 CWD 상대경로 |
| `bootstrap.js` | 53, 87-92 | 🟡 부트스트랩 체크리스트 6종 |

🔴 표시는 이 PRD 범위에서 수정한다. 🟡는 **별도 정리 작업**으로 분리한다 — 각각 독립적인 기능이고 함께 고치면 이 PRD의 변경 범위가 흐려진다.

### 13.2 기타 발견 (범위 밖, 기록용)

| 항목 | 내용 |
|---|---|
| DOCTOR 카운트 버그 | `_legacy_paperclip/` 실제 10개 vs 검사 기준 9 (`references/DOCTOR.md:92`, `SKILL.md:371`) → 항상 YELLOW 가능. `README.md:25`만 10으로 정확 |
| `npm run sync:agents` 깨짐 | `package.json:22-23`이 `scripts/automation/sync-agents.js`를 가리키나 그 파일은 `_legacy_paperclip/`에만 존재 |
| `workflow-engine.js` 데드코드 | 235줄, S0~S11 STAGES를 export하나 import하는 곳 0. 실제 정본은 `run-episode.js:69-82` |
| 고아 relay 데몬 | `com.barrotube.paperclip-hermes-ingress`(PID 11095)가 대상 컨테이너 없이 2026-07-26부터 재기동 반복. Docker 재기동 시 하드코딩된 컨테이너 ID(`relay.py:23`)가 달라져 **어차피 동작하지 않는다**. 파일럿 재개 계획이 없으면 `launchctl bootout` 권장 |
| `config/series.json` 빈 배열 | 시리즈 기능 코드는 있으나 데이터 없음 (`{"version":"1.1","series":[]}`) |

### 13.3 레퍼런스

- **윤자동** — 유튜브 5만 구독, 17년차 업무자동화 전문가. 공개 운영 루틴 = 노션 + Make + 슬랙 3층. 삼성전자로지텍·현대백화점·한국투자공사 등 50개 이상 기업 시스템 구축. [yunjadong.com](https://www.yunjadong.com/) · [유튜브 자동화 운영 루틴 영상](https://www.youtube.com/watch?v=Vssg1WfAv0A)
- **경쟁 채널 6곳** — §4.1
- **ADR** — `barrotube-media-render-operations-architecture.md` (accepted, rev 2)
- **media-render 계획서** — `barrotube-media-render-automation-plan.md` (763줄)
- **실측 운영 기록** — `barrotube-episode-pipeline.md` (2026-07-29~31 관측)

### 13.4 미결 사항 (2026-08-13 갱신)

| # | 항목 | 상태 |
|---|---|---|
| 1 | 심플한 관심종목TV UC ID | ✅ 해결 — `--resolve-handles`(1 unit)로 `UChQIBrXk5QMyJjF3Hl_5-kQ` 확보 |
| 2 | R2/R4 브라우저 worker 코드화 | ⏸ 의도적 보류 — ADR 결정 9가 "조작 주체는 당분간 대화형 유지"로 확정. 재사용할 CDP 구현이 없어 신규 개발 기준 |
| 3 | 검색량 API 도입 | ⏸ 비용 결정 대기 — 현재 `demand` 는 경쟁 채널 vpd 대리 지표 |
| 4 | WARN 유령 경로 정리 | ✅ 해결 — 22곳/13파일 전부 수정, 회귀 가드 테스트 추가 |
| 5 | **YouTube OAuth 만료** | 🔴 **블로커** — `invalid_grant`. 브라우저 인증이라 사람만 갱신 가능: `node scripts/automation/setup-youtube-oauth.js` |
| 6 | 고아 relay 데몬 | ⏸ 사용자 판단 — `com.barrotube.paperclip-hermes-ingress`(PID 11095)가 18일째 대상 컨테이너 없이 가동. Docker 재기동 시 하드코딩된 컨테이너 ID가 달라져 **어차피 동작하지 않는다**. 파일럿 재개 계획이 없으면 `launchctl bootout gui/$(id -u)/com.barrotube.paperclip-hermes-ingress` |
| 7 | `workflow-engine.js` 데드코드 | ⏸ 보존 — import 0곳. 삭제 대신 헤더에 DEAD CODE 표식과 정본(`run-episode.js:72`) 위치를 명시 |
