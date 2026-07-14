---
created: 2026-07-02
updated: 2026-07-02
status: reviewed
tags:
  - operations
  - barrotube
  - media-render
  - automation
  - reels
---

# BarroTube Media Render 자동 운영 갭 분석 및 구현 계획

## Status Update — 2026-07-12 (오토파일럿 + director 완성, today.myo 편입)

- **`reel_autopilot.py` 구현 완료** — director 지휘 루프의 *결정론 안전 절반*을 코드화.
  render-job.json을 읽어 브라우저·사람·비가역 액션 없이 완주 가능한 단계
  (R3/R5/R8 QA · R6 CapCut-route skip 또는 FFmpeg master · R9 distribution+게시메타 ·
  R11 postmortem)를 한 번에 몰고, 처음 만나는 브라우저(R2/R4)·GUI(R7)·HITL(R10)·QA fail
  게이트에서 멈춰 `blocked_kind` + `next_action`을 JSON으로 반환. 게시·삭제·결제·로그인
  대행은 절대 안 함.
- **`barrotube-reel-director` 에이전트 구현 완료** — `~/.claude/agents/barrotube-reel-director.md`
  (형제 barrotube-* 에이전트와 동일 discovery 경로). 지휘 루프 = "오토파일럿 먼저 →
  blocked_kind별 대응(browser는 barrotube-media-render 위임, GUI는 CapCut, hitl_publish는
  사람 승인)". Layer1(판단)+Layer2(상태) 분리 원칙 그대로.
- **today.myo 편입 검증**: 정본 스크립트가 takitani.lab뿐 아니라 today.myo 폴더에서도
  동작 확인. `reel_render_plan.py`가 today.myo script.md를 정상 파싱, 상태머신이 R단계를
  정확 감지. 실증: **EP01 = 13/13 DONE**(게시 완료본 편입), **EP02 = 11/13**(QA 3게이트
  통과·distribution·게시메타 자동 생성, **R10 게시(HITL)만 잔여** — 계획서가 EP04에서
  달성한 종착점과 동일).
  - today.myo route 반영: 클립→CapCut(합성+자막+1080화)→export 이므로 **R6(FFmpeg master)는
    CapCut export 존재 시 auto-skip**. CapCut export는 표준 경로 `56_capcut_export/video.mp4`에
    하드링크(디스크 중복 0).
  - 보드 연동: today.myo `tools/autopilot.sh <day>` 래퍼 + bridge 읽기전용
    `/api/reel/state?day=N`(render-job.json 상태를 보드에 노출, localStorage 추정 대체).
- **남은 결정론 미구현**(Phase 2~4): `build_capcut_reel_draft.py`, browser workers 코드화,
  publish duplicate-guard. R7 CapCut/R2·R4 브라우저는 여전히 인터랙티브 세션 필요.

---

## Purpose

`barrotube-media-render` 스킬을 현재의 절차형 운영에서 반복 가능한 자동 운영 시스템으로 올리기 위한 갭 분석과 구현 계획이다.

대상 파이프라인:

```text
scene plan
-> ChatGPT image generation
-> Grok image-to-video
-> FFmpeg master BGM/SFX mix
-> CapCut 2 draft/export
-> distribution package
-> Instagram Reels publish
```

관련 문서:

- [[barrotube-reels-pipeline|BarroTube Reels 제작 파이프라인]]
- [[instagram-publishing|Instagram Reels 게시 운영]]
- [[../10-Channels/takitani-lab/index|takitani.lab]]

## Skill Source of Truth

이 계획의 기준이 되는 정본(source of truth) 스킬 경로는 하나로 고정한다.

```text
정본: ~/workspace/BarroSkills/.claude/skills/barrotube-media-render
구버전: ~/Desktop/Workspace/my-skills/.claude/skills/barrotube-media-render
```

두 경로에 스킬이 **중복 존재**한다. 구버전(my-skills)은 scripts 3종
(`barrotube_to_prompts.py`, `move_media.py`, `reel_render_plan.py`)만 갖고 있고,
정본(BarroSkills)은 여기에 `production_timer.py`, `agents/openai.yaml`,
`references/capcut-reel-export.md`가 더해지고 SKILL.md가 CapCut/FFmpeg/Playwright까지
확장된 상태다.

> 드리프트 리스크: 두 벌이 갈라져 있으면 "어느 스킬을 운영에 쓰는가"가 모호해진다.
> 이 문서와 모든 자동화는 **BarroSkills 경로를 정본**으로 삼고, my-skills 사본은
> 폐기하거나 정본을 복제한 스냅샷으로만 취급한다.

## Current State

현재 `barrotube-media-render`는 Codex가 브라우저를 조작하며 끝까지 실행할 수 있는 수준의 절차서와 보조 스크립트를 갖고 있다.

이미 구현된 것 (정본 스킬 실측):

- 스크립트→프롬프트 결정론 매핑: `barrotube_to_prompts.py`
  (scene→`image_prompt`/`video_prompt`/`slug`, 필드 alias 흡수. R1에 해당)
- `script.md` 기반 컷 계획 파싱: `reel_render_plan.py`
- 다운로드 파일 정리와 기본 검증: `move_media.py`
  (PNG 시그니처 / `ffprobe` 720×1280·10s 검증, 복사 후 크기 일치 시에만 원본 삭제)
- 제작 시간 기록: `production_timer.py`
  — CLI(`init`/`start`/`end`/`event`/`run`/`summary`)뿐 아니라 `ProductionTimer`
  클래스 + 컨텍스트매니저 `step()`을 제공해 render 스크립트가 임포트해 자동 계측 가능
- 에이전트 인터페이스 정의: `agents/openai.yaml`
- **릴스 R단계 상태 머신: `render_reel_job.py`** (2026-07-02 구현)
  — `<reel>/render-job.json` 진실원천, R0~R11 stage + per-cut 추적,
  `sync`가 디스크 증거로 완료 stage를 idempotent skip, 표준 `error_type`으로
  실패 기록·retry 목록 제공, QA 리포트(`60_qa_report.*.json`) 게이트 연동.
  EP04 실물 검증: 6컷 감지, 완료 8개 stage 자동 skip, next=R3(image QA)
- **QA 게이트: `qa_reel_media.py`** (2026-07-02 구현)
  — `images`(R3)/`videos`(R5)/`final`(R8)/`all` 4모드, §4 검사 항목 전체 커버
  (컷 수 일치·PNG portrait·md5 중복·해상도/길이/codec·오디오 스트림·
  blackdetect·volumedetect·contact sheet·자막 스트림). error/warn 2단계 —
  error만 `ok:false`로 게이트 차단. EP04 검증: 3 stage 모두 ok:true,
  게이트 연동 후 next=R10(publish, HITL)만 잔여.
  실전 발견: **Grok 실측 해상도는 720×1264** (공칭 720×1280과 다름) — 둘 다
  known-good으로 등록, 그 외 portrait는 warn, landscape는 error.
- **Preflight doctor: `media_render_doctor.py`** (2026-07-02 구현)
  — `<reel>/00_preflight.media.json` 출력, §3 검사 항목 커버: 바이너리
  (ffmpeg/ffprobe/node/jq)·Downloads 쓰기·CapCut 2 앱+Draft 템플릿·BGM/SFX·
  Instagram token(+`--online` Graph API 실검증)·reel 구조. 브라우저 로그인/
  Grok 옵션바는 CLI 검증 불가 → `manual` 레벨로 분리(browser worker가 런타임 검증).
  token 조회는 `config-loader.js getSecret()`과 동일 체인(.env→process env→
  **macOS Keychain**)을 미러링, 값은 절대 출력하지 않음.
  실전 발견: **Instagram token이 현재 3곳 모두 부재** — EP02(6/30) 게시 당시
  일회성 주입 후 영속화되지 않음. 다음 R10 게시 전 운영자가 token을
  .env 또는 Keychain(`security add-generic-password -s INSTAGRAM_ACCESS_TOKEN`)에
  저장해야 함. doctor가 이 실패를 사전 감지하는 것이 확인됨.
- **공용 FFmpeg 렌더러: `render_master_mix.py`** (2026-07-02 구현, Phase 2 착수)
  — EP03/EP04 개별 스크립트에서 검증된 로직(1080×1920/30fps normalize·scene trim·
  smoothleft xfade·연속 BGM bed·전환점 whoosh SFX·loudnorm I=-16:TP=-1.5:LRA=11)을
  파라미터화. 컷 목록은 script.md 순서에서 자동 유도, `--durations`/`--duration-each`,
  `--bgm/sfx-volume`, `--dry-run`, `ProductionTimer` 자동 연동(`--no-timer` 지원).
  manifest 스키마 `barrotube.master_mix.v1`. **EP04 재현 검증: 스트림
  (h264 1080×1920 30fps/aac/25.97s)·볼륨(mean −17.6dB, max −1.0dB) 원본과 동일**,
  EP03 타임라인(26.85s, offsets 4.45~22.45) dry-run 일치, 단일클립·no-sfx 엣지 통과.
  → 새 EP는 개별 `render_epXX_master.py` 없이 이 스크립트로 렌더한다.
- ChatGPT 이미지 생성 절차 문서: `references/chatgpt-image.md`
- Grok 720p / 10s / 9:16 영상 생성 절차 문서: `references/grok-video.md`
- FFmpeg 마스터 믹스 + CapCut Draft + export 절차 → **단일 문서로 통합**:
  `references/capcut-reel-export.md`
- SKILL.md에 반영된 운영 정책:
  - **브라우저: Playwright MCP 우선**, `chrome:control-chrome`은 폴백
  - **wide-angle 24mm 이미지 규칙**(9:16 전신/전체 객체, 헤드룸/풋룸, 클로즈업·잘림 금지)
- EP04 기준 실제 산출물 구조 검증
- `90_timing/production-timing.json` 및 `.md` 기록 체계

현재 산출물 표준:

```text
<reel>/
  script.md
  prompts.md
  Image/<slug>.png
  video/<slug>.mp4
  55_render/video.mp4
  55_render/master-bgm-mix.m4a
  55_render/master-bgm-mix.manifest.json
  56_capcut_export/video.mp4
  56_capcut_export/contact_sheet_6cuts.jpg
  70_publish_meta.instagram.json
  80_publish_result.instagram.json
  90_timing/production-timing.json
  90_timing/production-timing.md
  distribution/{reels,tiktok,youtube}/
```

## Design Principle (결정론 / 비결정론 분리)

이 스킬의 현재 설계는 작업을 두 종류로 명확히 나눈 위에 서 있고, 자동 오케스트레이터도
이 경계를 그대로 유지해야 한다.

| 구분 | 담당 | 산출물 예 |
| --- | --- | --- |
| **결정론** (매번 동일 결과) | Python 스크립트 | 프롬프트 매핑, 컷 계획 파싱, 파일 이동·검증, 타이밍 기록 |
| **비결정론** (페이지 상태·대기·팝업 판단 필요) | 브라우저 UI 절차 문서 + LLM 조작 | ChatGPT 이미지 생성, Grok 영상 생성, CapCut export |

핵심은 "애매하고 틀리기 쉬운 부분(옵션 토글·생성 대기·바이트 회수)"은 절차 문서로,
"틀리면 안 되는 반복 작업"은 코드로 처리한다는 것이다. 오케스트레이터가 지켜야 할 함의:

- 상태(state)·검증(QA)·재시작 판정은 **결정론 영역(코드+JSON 파일)** 에만 둔다.
  브라우저 결과의 성패는 파일·`ffprobe`·md5 같은 결정론 신호로 판정한다.
- browser worker는 비결정론 영역을 감싸되, **표준 실패 응답(JSON)** 으로 결과를
  결정론 영역에 돌려줘야 재시작 위치가 명확해진다(§2 참조).

## Main Gap

가장 큰 문제는 현재 스킬이 "실행 가능한 절차서"에 가깝고, "자동 운영 오케스트레이터"가 아니라는 점이다.

현재 구조:

```text
운영자/Codex 판단
-> 브라우저 UI 조작
-> 파일 검증
-> 다음 컷 진행
```

목표 구조:

```text
reel job 생성
-> job state machine
-> browser worker
-> asset validator
-> retry/recovery
-> render/export worker
-> QA gate
-> publish worker
-> result/audit/timing report
```

## Gaps By Area

### 1. Orchestration

부족한 점:

- 전체 reel을 한 번에 진행하는 실행 스크립트가 없다.
- 컷별 완료/실패/재시도 상태가 표준 파일로 남지 않는다.
- 중단 후 재시작 시 어떤 단계부터 재개해야 하는지 자동 판정하지 않는다.
- 기존 BarroTube `produce-episode.js` / `run-episode.js`의 S단계와 새 릴스 파이프라인이 연결되지 않았다.

필요한 것:

- `render_reel_job.py` 또는 `render-reel-job.js`
- `<reel>/render-job.json`
- stage id 표준화
- idempotent skip / retry 정책

### 2. Browser Automation

부족한 점:

- ChatGPT 이미지 생성과 Grok 영상 생성은 문서화되어 있지만 worker 코드가 없다.
- 로그인 상태, quota, paywall, modal, option drift를 표준적으로 감지하지 않는다.
- 다운로드 중복 문제를 자동 방지하지 않는다.

필요한 worker:

```text
scripts/browser_workers/
  browser_session_check.js
  chatgpt_image_worker.js
  grok_video_worker.js
```

표준 실패 응답:

```json
{
  "ok": false,
  "stage": "grok_video_cut4",
  "error_type": "quota_or_paywall",
  "recoverable": true,
  "message": "SuperGrok modal appeared",
  "next_action": "switch_account_or_retry_later"
}
```

#### Gotchas → worker 감지 스펙 매핑

SKILL.md의 "Gotchas learned the hard way"는 곧 browser worker가 코드로 감지·처리해야
할 상태 스펙이다. 위 `error_type`은 이 함정 목록에서 도출한다.

| SKILL.md gotcha | worker 감지 방법 | `error_type` | `recoverable` / next_action |
| --- | --- | --- | --- |
| Grok SuperGrok / ChatGPT 이미지 quota·paywall modal | 생성 클릭 후 구독 모달/"이미지가 0개 남았습니다" 검출 | `quota_or_paywall` | true / 계정 전환·나중 재시도. **절대 결제 금지** |
| Chrome multi-download block | 연속 다운로드로 사이트 다운로드가 세션 차단됨 | `download_blocked` | false(자동 불가) / 사용자 주소창 허용·Chrome 재시작. 예방: 1건씩 ~2s 간격 |
| Download-too-early duplicate | 생성 완료 전 회수 → 이전 항목 재다운로드 | `stale_download` | true / 100% 폴링 후 재회수. **md5 guard** + 이미지 last-unique-src·portrait 확인 |
| Grok option drift | 옵션바가 비디오/720p/10s/9:16 아님 | `option_drift` | true / 재설정 후 zoom 스크린샷 재검증 |
| Account drift | 하단 아바타/이메일이 예상 계정과 다름 | `account_drift` | true(경고) / 기록만, 사용자 상태와 싸우지 않음 |
| Grok 파일첨부 모달 부재 | `browser_file_upload`가 모달 없음 반환 | `file_attach_unavailable` | true / `input[type=file].setInputFiles(path)` 폴백, 안 되면 text→video |
| 로그인 만료 | composer/prompt bar 대신 로그인 화면 | `not_logged_in` | false / 사용자 로그인 요청(대행 금지) |

#### 셀렉터 전략 리스크

현재 절차는 ChatGPT/Grok의 **한국어 UI 라벨 텍스트**("이미지 만들기", "생성 중 NN%",
"다운로드", "내보내기")에 의존한다. UI 개편·언어 설정 변화에 취약하므로 worker 코드화 시:

- 라벨 문자열은 상수 테이블로 분리(로케일 교체 대비).
- 가능하면 구조적 셀렉터(역할/DOM 위치)를 우선하고, 라벨은 보조 신호로.
- 상태 확인은 라벨뿐 아니라 결정론 신호(다운로드 파일 존재·`ffprobe`·md5)로 이중 확인.

### 3. Preflight

부족한 점:

- 렌더 시작 전에 환경, 로그인, 리소스, 권한을 일괄 검사하지 않는다.
- 긴 제작 시간이 지난 뒤 마지막 단계에서 토큰/권한 문제로 막힐 수 있다.

필요한 스크립트:

```text
scripts/media_render_doctor.py
```

검사 항목:

- `ffmpeg`, `ffprobe`, `jq`, `node`, `python3`
- ChatGPT 로그인 상태
- Grok 로그인 상태
- Grok option bar가 비디오 / 720p / 10s / 9:16인지 확인 가능 여부
- Downloads 접근 가능 여부
- CapCut 2 설치 여부
- CapCut Draft 템플릿 존재 여부
- BGM/SFX 기본 리소스 존재 여부
- Instagram token 존재 및 유효성
- reel 폴더 구조 정상 여부

출력:

```text
<reel>/00_preflight.media.json
```

### 4. QA Gate

부족한 점:

- 검증 명령은 있지만 QA 결과가 표준 JSON으로 누적되지 않는다.
- QA 실패 시 publish 단계로 넘어가지 못하게 막는 gate가 없다.
- contact sheet, blackdetect, volumedetect 결과가 운영 데이터로 남지 않는다.

필요한 스크립트:

```text
scripts/qa_reel_media.py
```

검사 항목:

- 이미지 개수와 컷 개수 일치
- 이미지 portrait 여부
- 이미지 md5 중복 여부
- Grok mp4 개수 일치
- Grok mp4 해상도, 길이, codec
- 최종 mp4 해상도, 길이, fps, 오디오 스트림
- blackdetect
- volumedetect
- contact sheet 생성
- 자막 스트림 존재 여부

출력:

```text
<reel>/60_qa_report.media.json
<reel>/56_capcut_export/contact_sheet_6cuts.jpg
```

### 5. FFmpeg Render

부족한 점:

- EP03/EP04처럼 에피소드별 `render_epXX_master.py`가 생기고 있다.
- 공용 렌더러가 없어 다음 EP마다 비슷한 스크립트를 복제하게 된다.
- BGM/SFX/scene duration/xfade/loudnorm 설정이 표준화되어 있지 않다.

필요한 스크립트:

```text
scripts/render_master_mix.py
```

예상 인터페이스:

```bash
python3 scripts/render_master_mix.py \
  --reel <reel> \
  --episode BT-EP05 \
  --clips video/ep05-cut1.mp4 video/ep05-cut2.mp4 \
  --durations 4.6,4.6,4.6,4.7,4.6,4.6 \
  --bgm <path> \
  --sfx <path> \
  --out 55_render/video.mp4
```

책임:

- 1080x1920 normalize
- 30fps
- scene trim
- xfade transition
- continuous BGM bed
- SFX placement
- loudnorm
- `master-bgm-mix.manifest.json`
- `production_timer.py` 자동 연동

### 6. CapCut Draft Builder

부족한 점:

- 현재는 기존 Draft를 복제하고 JSON을 수동/스크립트로 치환하는 방식이다.
- 작동은 하지만 템플릿/ID/경로/길이 갱신이 표준 builder로 고정되어 있지 않다.

필요한 스크립트:

```text
scripts/build_capcut_reel_draft.py
```

예상 인터페이스:

```bash
python3 scripts/build_capcut_reel_draft.py \
  --reel <reel> \
  --project BT-EP05-XXX \
  --template BT-EP04-SCHOOL-GUARDIAN \
  --video 56_capcut_export/video.mp4
```

책임:

- Draft 템플릿 복사
- `.locked`, `.bak` 제거
- `Resources/assets/videos/video.mp4` 교체
- 컷별 원본 mp4 복사
- cover 생성
- `draft_info.json`, `draft_meta_info.json`, timeline 내부 JSON 갱신
- JSON parse 검증
- ffprobe 검증
- 잔여 EP명/경로 grep 검사

### 7. Publishing

부족한 점:

- Instagram Graph API와 웹 fallback이 혼재되어 있다.
- EP03에서 중복 업로드 및 중복 삭제 이슈가 있었다.
- API token 유효성, `video_url` 필요 여부, 임시 HTTPS URL flow가 자동화되어 있지 않다.

필요한 것:

- Instagram token preflight
- API publish 가능 여부 확인
- `video_url` 필요 시 임시 HTTPS 서버/tunnel 자동 생성
- 업로드 전 중복 게시 방지
- 업로드 후 permalink 저장
- 실패 시 웹 fallback 분리
- 삭제는 명시 승인 필요

중복 방지 키:

- final video md5
- caption hash
- episode slug
- published permalink

출력:

```text
<reel>/80_publish_result.instagram.json
```

### 8. Metrics And Reporting

부족한 점:

- `production-timing`은 생겼지만, 에피소드별 시간/실패/재시도 통계 집계가 없다.
- 어떤 단계가 병목인지 장기적으로 비교할 수 없다.

필요한 문서/리포트:

```text
docs/10-Channels/takitani-lab/production-metrics.md
docs/10-Channels/takitani-lab/episodes/<EP>-postmortem.md
```

집계 항목:

- 총 제작 시간
- ChatGPT 평균 컷당 시간
- Grok 평균 컷당 시간
- 실패/재시도 횟수
- 가장 오래 걸린 단계
- FFmpeg/CapCut/export 시간
- 게시 시간
- 게시 후 조회수/좋아요/댓글 추적 필드

## Proposed Stage Model

릴스 전용 workflow를 기존 long-form S단계에 억지로 넣기보다 별도 R단계로 관리한다.

```text
R0   topic discovery        (완전 자율: marketing-analyst 블루오션 키워드→주제 후보)
R0.5 topic fact-check gate   (barrotube-fact-checker: 수치·인용·법적·트렌드 진위 검증)
R1   script/prompts         (ceo brief → strategist hook → writer script+prompts)
R2   ChatGPT images
R3   image QA
R4   Grok videos
R5   video QA
R6   FFmpeg master
R7   CapCut draft/export
R8   final QA
R9   distribution
R10  Instagram publish
R11  postmortem/timing report
```

R0.5는 **게이트**다: 팩트체크가 HIGH 위험(허위 수치·저작권/명예훼손 소지·트렌드 오판)을
반환하면 해당 주제를 반려하고 R0의 다음 후보로 되돌린다. 통과한 주제만 R1로 내려간다.
완전 자율로 주제를 뽑되, "검증되지 않은 주제로 제작에 들어가지 않는다"를 보장하는 장치.

각 단계는 다음 필드를 가진다:

```json
{
  "stage": "R4",
  "name": "Grok videos",
  "status": "in_progress",
  "started_at": "2026-07-02T06:00:00+09:00",
  "ended_at": null,
  "attempts": 1,
  "outputs": [],
  "error": null
}
```

## Orchestrator Agent Design (`barrotube-reel-director`)

릴스 R단계를 R0(자율 주제 발굴)부터 R11(회고)까지 자율 지휘하는 **신규 전용 에이전트**를
정의한다. 기존 `barrotube-producer`(S단계 long-form)와 **책임을 분리**하여 R단계 릴스 트랙만
담당한다.

### 설계 원칙 — 판단(에이전트)과 상태(코드) 분리

오케스트레이터는 "에이전트 1개"가 아니라 **판단 계층(에이전트) + 상태 계층(결정론 코드)**
의 조합이다. 위 **Design Principle (결정론 / 비결정론 분리)** 섹션을 그대로 따른다.

```text
Layer 1  판단/지휘 (비결정론)   barrotube-reel-director
  - render-job.json 읽고 "다음 단계" 결정
  - QA gate 판정(fail → publish 차단), HITL 승인 관리
  - worker 실패 error_type별 재시도/계정전환/에스컬레이션
  - topic 미지정 시 R0 자율 발굴 체인 dispatch
        │  Task dispatch  +  read/write state
Layer 2  상태/실행 (결정론)
  render_reel_job.py  ── render-job.json  (상태 진실원천)
  media_render_doctor.py (preflight)
  browser_workers/*  (chatgpt/grok, 표준 JSON 반환)
  qa_reel_media.py (gate)   production_timer.py (계측)
```

성패 판정은 항상 파일(`render-job.json`)과 결정론 신호(`ffprobe`/md5)로 한다. 그래야
중단 후 director를 다시 불러도 job 파일만 보고 이어갈 수 있다(idempotent resume).

### 기존 자산 재사용 (새로 만들지 않는다)

| R단계 | 재사용 에이전트/도구 | 신규 여부 |
| --- | --- | --- |
| R0 topic discovery | `barrotube-marketing-analyst` (블루오션 키워드) | 재사용 |
| R0.5 topic fact-check | `barrotube-fact-checker` (수치·인용·법적 위험) | 재사용 |
| R1 script/prompts | `barrotube-ceo`→`barrotube-strategist`→`barrotube-writer`, `barrotube_to_prompts.py` | 재사용 |
| R2/R4 image·video | media-render 절차 문서 + (신규)browser worker | 신규 worker |
| R3/R5/R8 QA | (신규)`qa_reel_media.py` | 신규 |
| R6/R7 render/export | `capcut-reel-export.md` + (신규)공용 렌더러 | 일부 신규 |
| R9 distribution | `build-distribution.js` | 재사용 |
| R10 publish | `publish-instagram-reels.js` + (신규)publish guard | 일부 신규 |
| R11 timing | `production_timer.py` | 재사용 |

즉 **"주제를 정하는 뇌"와 dispatch 대상은 이미 존재**하고, director가 새로 하는 일은
*릴스 전용 지휘 루프 + 상태 머신 연결*뿐이다.

### 에이전트 정의 (✅ 구현됨 2026-07-12)

구현 위치는 스킬 내부가 아니라 **형제 barrotube-* 에이전트와 동일한 discovery 경로**로
확정: `~/.claude/agents/barrotube-reel-director.md`. 아래 스케치대로 frontmatter +
지휘 루프(= reel_autopilot.py 먼저 → blocked_kind별 대응)를 system prompt로 둔다.

```yaml
---
name: barrotube-reel-director
description: >-
  릴스 R단계(R0 자율 주제 발굴 ~ R11 회고) 자율 오케스트레이터.
  render-job.json 상태 머신을 읽고 stage worker를 ONE-at-a-time dispatch,
  QA gate·HITL 승인·실패 복구를 지휘. 실거래성 액션(결제/삭제/게시)은 HITL 강제.
tools: [Bash, Read, Write, Edit, Task]
model: opus
---
```

### 지휘 루프 (director 알고리즘)

```text
1. render_reel_job.py load  (없으면 init) → 완료/미완 stage 판정
2. media_render_doctor.py    → preflight FAIL이면 중단·보고 (HITL)
3. topic 없으면 R0 자율 체인:
     marketing-analyst → 주제 후보 N개
     → R0.5 fact-check gate (barrotube-fact-checker)
          HIGH risk → 반려, 다음 후보 (모두 반려면 사람에게 에스컬레이션)
     → ceo brief → strategist hook → writer script/prompts
4. 다음 미완 stage worker를 ONE at a time dispatch (동시 다운로드 금지)
5. worker 표준 JSON 수신:
     ok:true  → qa gate 통과 시 stage=completed, production_timer end
     ok:false → error_type별 (§2 매핑 표):
        quota_or_paywall  → 계정전환/나중재시도  (결제 절대 금지)
        download_blocked  → 사용자 Chrome 허용 요청 (HITL, 자동 불가)
        stale_download    → 100% 재폴링 후 재회수
        option_drift      → 옵션 재설정 후 재시도
        account_drift     → 기록만, 사용자 상태와 싸우지 않음
6. idempotent skip: 산출물 존재 + md5 유효 → stage skip
7. HITL 게이트(승인 없이 진행 금지): R10 publish, 결제, Downloads 원본 삭제
8. 완료 → R11 postmortem + timing 집계
```

### 실패·안전 불변식

- 결제/유료 전환 **절대 금지** (quota/paywall은 항상 비결제 경로로 우회).
- 로그인 대행 금지 — `not_logged_in`은 사람에게 넘긴다.
- 게시(R10)·파일 삭제는 **명시적 사람 승인** 후에만.
- 모든 stage는 `production_timer.py`로 계측(브라우저 대기 시간 포함).

### 구현 순서 (이 설계의 다음 단계)

계획 문서 MVP 순서와 정합: 상태·검수 기반(코드) → worker → director 에이전트.

```text
1. render_reel_job.py + render-job.json 스키마   (상태 머신)
2. media_render_doctor.py                        (preflight)
3. qa_reel_media.py                              (gate)
4. browser_workers/{chatgpt,grok}                (§2 error_type 반환)
5. agents/reel-director.md                       (지휘 루프 = 위 알고리즘)
6. R0 자율 체인 + R0.5 fact-check 배선
```

에이전트를 먼저 만들면 붙일 상태 머신·worker가 없어 지휘할 대상이 없다. **상태/worker를
먼저 코드화한 뒤 director를 얹어야** 디버깅 비용이 낮다.

## Implementation Plan

### Phase 1 - Stability Foundation

목표: 자동 운영의 최소 상태관리와 검수 기반을 만든다.

구현:

- ~~`media_render_doctor.py`~~ ✅ 구현 완료 (2026-07-02, EP04 ok:true·token 부재 사전 감지 확인)
- ~~`render_reel_job.py`~~ ✅ 구현 완료 (2026-07-02, EP04 검증 통과)
- ~~`qa_reel_media.py`~~ ✅ 구현 완료 (2026-07-02, EP04 3-stage ok:true·게이트 연동 검증)
- ~~`render-job.json`~~ ✅ 스키마 `barrotube.render_job.v1` 확정

**→ Phase 1 완료 (2026-07-02).** 완료 기준 3건 모두 충족: ① doctor/QA가 EP04 대상
pass/fail JSON 생성 ② 중단 job 재실행 시 완료 산출물 skip ③ 실패 컷만 retry 표시.
- `production_timer.py`와 job stage 연결
  (재구현 아님 — 이미 있는 `ProductionTimer` 클래스/`step()` 컨텍스트매니저/`run`
  서브커맨드를 오케스트레이터가 임포트해 stage 경계에 연결)

완료 기준:

- 기존 EP04 폴더를 대상으로 doctor/QA가 pass/fail JSON을 생성한다.
- 중단된 job을 다시 실행하면 완료된 산출물을 skip한다.
- 실패한 컷만 retry 대상으로 표시된다.

### Phase 2 - Reusable Local Rendering

목표: EP별 렌더 스크립트 복제를 없앤다.

구현:

- ~~`render_master_mix.py`~~ ✅ 구현 완료 (2026-07-02)
- `build_capcut_reel_draft.py`
- final 4K export helper
- distribution symlink/package helper

완료 기준:

- ~~EP03/EP04를 공용 renderer로 재현할 수 있다.~~ ✅ EP04 실렌더 원본 동일
  (스트림·볼륨), EP03 dry-run 타임라인 일치
- 새 EP는 개별 `render_epXX_master.py` 없이 최종 mp4를 만든다.
  (렌더러 준비 완료 — 다음 EP 제작에서 실증)

### Phase 3 - Browser Workers

목표: ChatGPT/Grok UI 작업을 worker 단위로 안정화한다.

구현:

- `browser_session_check.js`
- `chatgpt_image_worker.js`
- `grok_video_worker.js`
- quota/paywall/modal 감지
- 중복 다운로드 md5 guard
- per-cut retry policy

완료 기준:

- 한 컷을 입력하면 이미지와 영상이 지정 경로에 저장된다.
- 실패 시 recoverable/error_type/next_action이 JSON으로 반환된다.
- option drift를 감지하고 720p / 10s / 9:16을 검증한다.

### Phase 4 - Publishing Automation

목표: Instagram 게시를 반복 가능하고 중복 안전하게 만든다.

구현:

- Instagram token doctor
- `video_url` tunnel flow 표준화
- duplicate publish guard
- publish result 저장
- web fallback 분리

완료 기준:

- API publish 전 토큰/권한 실패를 사전에 감지한다.
- 같은 episode/video/caption 조합은 중복 게시하지 않는다.
- 게시 성공 시 permalink가 `80_publish_result.instagram.json`에 저장된다.

### Phase 5 - Operations Reporting

목표: 반복 제작의 병목과 성과를 누적한다.

구현:

- production metrics 문서
- episode postmortem 템플릿
- timing aggregation
- 실패/재시도 통계

완료 기준:

- EP별 총 제작시간과 longest step이 자동 요약된다.
- 다음 제작 개선점이 postmortem에 남는다.

## MVP Priority

가장 먼저 구현할 MVP 순서:

```text
1. media_render_doctor.py
2. render_reel_job.py
3. qa_reel_media.py
4. render_master_mix.py
5. build_capcut_reel_draft.py
```

이 순서가 맞는 이유:

- 브라우저 자동화는 외부 UI 상태에 흔들린다.
- 먼저 job state, preflight, QA gate가 있어야 실패 위치와 재시작 위치가 명확해진다.
- 그 다음 ChatGPT/Grok worker를 붙여야 디버깅 비용이 낮다.

## Resolved Decisions

- **Browser worker 기반: Playwright MCP 우선.** SKILL.md가 이미 Playwright MCP를
  우선(로그인/파일업로드/`download.saveAs()` 지원), `chrome:control-chrome`을 폴백으로
  확정했다. 남은 일은 방향 선택이 아니라 이 방향대로 worker를 **코드화**하는 것(§2·Phase 3).

## Open Decisions

- CapCut export를 앱 UI로 유지할지, FFmpeg 4K export를 공식 최종본으로 인정할지 결정해야 한다.
- Instagram API 게시를 기본값으로 둘지, 웹 fallback을 운영자 승인 fallback으로만 둘지 결정해야 한다.
- 기존 BarroTube S단계와 릴스 R단계를 통합할지, 별도 workflow로 유지할지 결정해야 한다.

## Current Recommendation

릴스 파이프라인은 기존 long-form BarroTube S단계와 분리된 R단계 workflow로 운영한다.

자동 운영의 핵심은 스킬 문서를 더 늘리는 것이 아니라 다음 다섯 가지를 코드화하는 것이다:

```text
orchestrator
state file
browser worker
QA gate
publish guard
```

이 구조가 잡히면, ChatGPT/Grok UI가 불안정해도 "어디서 실패했고 어디서 재시작해야 하는지"가 명확해진다.
