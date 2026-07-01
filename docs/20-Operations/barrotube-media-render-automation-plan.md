---
created: 2026-07-02
status: draft
tags:
  - operations
  - barrotube
  - media-render
  - automation
  - reels
---

# BarroTube Media Render 자동 운영 갭 분석 및 구현 계획

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

## Current State

현재 `barrotube-media-render`는 Codex가 브라우저를 조작하며 끝까지 실행할 수 있는 수준의 절차서와 보조 스크립트를 갖고 있다.

이미 구현된 것:

- `script.md` 기반 컷 계획 파싱: `reel_render_plan.py`
- 다운로드 파일 정리와 기본 검증: `move_media.py`
- 제작 시간 기록: `production_timer.py`
- ChatGPT 이미지 생성 절차 문서
- Grok 720p / 10s / 9:16 영상 생성 절차 문서
- FFmpeg 마스터 믹스 / CapCut Draft / export 절차 문서
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
R0 topic/brief
R1 script/prompts
R2 ChatGPT images
R3 image QA
R4 Grok videos
R5 video QA
R6 FFmpeg master
R7 CapCut draft/export
R8 final QA
R9 distribution
R10 Instagram publish
R11 postmortem/timing report
```

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

## Implementation Plan

### Phase 1 - Stability Foundation

목표: 자동 운영의 최소 상태관리와 검수 기반을 만든다.

구현:

- `media_render_doctor.py`
- `render_reel_job.py`
- `qa_reel_media.py`
- `render-job.json`
- `production_timer.py`와 job stage 연결

완료 기준:

- 기존 EP04 폴더를 대상으로 doctor/QA가 pass/fail JSON을 생성한다.
- 중단된 job을 다시 실행하면 완료된 산출물을 skip한다.
- 실패한 컷만 retry 대상으로 표시된다.

### Phase 2 - Reusable Local Rendering

목표: EP별 렌더 스크립트 복제를 없앤다.

구현:

- `render_master_mix.py`
- `build_capcut_reel_draft.py`
- final 4K export helper
- distribution symlink/package helper

완료 기준:

- EP03/EP04를 공용 renderer로 재현할 수 있다.
- 새 EP는 개별 `render_epXX_master.py` 없이 최종 mp4를 만든다.

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

## Open Decisions

- Browser worker를 Node Playwright 기반으로 둘지, Codex MCP 호출 절차로 유지할지 결정해야 한다.
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
