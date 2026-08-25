# PIPELINE.md — S0~S12 단계별 상세

> BarroSkills 에피소드 파이프라인 전체. 입력·출력·비용·시간·담당 에이전트 정본.

## 단계 요약

| Stage | 명칭 | 담당 (subagent_type) | 입력 | 출력 | 비용 | 시간 |
|---|---|---|---|---|---|---|
| Pre-S0 | Desk Briefing | (자동) `desk-briefing.js` — 증시·금리·원자재·코인·지정학·외환 6개 데스크 + 에디터. auto-pipeline Phase 2a. 상세는 `AUTO-PIPELINE.md` | 시세 18종 + 뉴스 + 경쟁 인텔 + 웹·소셜 검색 | `desk-<id>.md`, `desk-briefing.md`, `desk-topic.json` → EP 의 `05_desk_briefing.md` | `claude -p` 7회 | ~7분 |
| S0 | Brief | (자동) `create-episode.js` | topic, channel | `00_brief.md` + EP 디렉토리 | 0 | 5초 |
| S1 | Ticket | (BarroSkills 생략) | - | - | 0 | - |
| S2 | Research | `barrotube-researcher` | brief | `10_market_research.md` | ~$0.05 | 1~2분 |
| S3 | Strategy | `barrotube-strategist` | brief + research | `20_strategy.md` | ~$0.10 | 1~2분 |
| S4 | Script | `barrotube-writer` | brief + research + strategy | `30_script.md` | ~$0.10 | 2~3분 |
| S5 | Factcheck | `barrotube-fact-checker` | script | `35_factcheck.md` | ~$0.05 | 1~2분 |
| S6a | TTS | `barrotube-voice-engineer` (또는 직접 호출) | script | `40_assets/tts/*.wav` | **$0.02/씬** (ElevenLabs) | 30초/씬 |
| S6b | Duration Sync | (자동) `sync-durations.js` | tts metadata | `30_script.md` 갱신 | 0 | 5초 |
| S6c | Scene Images + Motion | **기본: `barrotube-media-render` 스킬** (브라우저 ChatGPT→Grok image-to-video, PD 수행) / 레거시: `barrotube-image-generator` API (`--image-engine openai\|gemini`) | script | 신규 Shorts: `40_assets/images/scene_001..005.png` + `40_assets/videos/scene_001..005.mp4` (각 5/5) | 기본 0 (브라우저) / 레거시 **$0.04/이미지** | 1~2분/씬 (브라우저) |
| S6d | Intro Card | **기본: `barrotube-media-render` 스킬** (브라우저 ChatGPT, PD가 타이틀 철자 검수) / 레거시: `generate-intro.js` v10 API (`--engine openai\|gemini`) | title + brand<br>타이틀의 기업명 → 연관 인물 캐리커처 + CI 로고 자동 주입 (`config/brand-entities.json`) | `45_intro.png` | 기본 0 / 레거시 ~$0.18 | 1~2분 (브라우저) |
| S6e | Thumbnail | `barrotube-image-generator` | brand + script | `47_thumbnail.png` | ~$0.04 | 20초 |
| S7 | Render | (자동) `render-direct.js` — 신규 Shorts는 Grok 클립 5/5 미달 시 기본 실패하며 각 클립을 반복하지 않고 TTS 길이에 맞춰 리타이밍. `--allow-stills`는 publish QA를 통과할 수 없는 레거시 전용 예외 | assets + script | `55_render/video.mp4` | 0 (FFmpeg) | 1~2분 |
| S7b | CapCut Draft | `barrotube-capcut-composer` (선택) | assets | `50_capcut_draft.json` | 0 | 1분 |
| S8 | QA | `barrotube-qa-reviewer` | video.mp4 + assets | `60_qa_report.md` | ~$0.10 | 1~2분 |
| S9 | Metadata | `barrotube-metadata-writer` | script + video | `70_publish_meta.json` | ~$0.03 | 1분 |
| **S10** | **Board Approval** | **Human (AskUserQuestion)** | meta + qa | `75_board_approval.json` | 0 | 수동 |
| S11 | Publish | `barrotube-publisher` (또는 publish-youtube.js) | video + meta + thumb | `80_publish_result.json` (videoId) | 0 + YouTube API quota | 2~5분 |
| S12 | Playlist | (자동) `create-playlist.js` | series_id | playlist 메타 갱신 | 0 | 30초 |

**EP 1편 총 비용 (long-3min, 7씬 + 자산)**: ~$0.5~$1
**EP 1편 총 시간**: 약 15~30분 (대부분 LLM/TTS/Image 대기)

## 자동 vs 운영자 승인

| 단계 | 자동? | 승인 조건 |
|---|---|---|
| S0~S5 | ✅ 자동 | dry-run 가능 (외부 API 호출 미만) |
| S6a~S6e | ⚠️ 운영자 명시 | `--execute` 플래그 필수 (💰 비용) |
| S7~S7b | ✅ 자동 | FFmpeg 로컬 |
| S8 | ✅ 자동 | QA score >= 60 |
| S9 | ✅ 자동 | (LLM 비용 미미) |
| **S10** | ❌ Human | AskUserQuestion publish/defer/cancel |
| S11 | ⚠️ 운영자 명시 | `--execute` + S10 승인 토큰 필수 |
| S12 | ✅ 자동 | S11 성공 후 시리즈 마지막 시 |

## Stage 별 실행 명령 (BarroSkills 기준)

```bash
cd $BARROTUBE_HOME
export PAPERCLIP_DISABLED=1

# S0
node scripts/automation/create-episode.js --channel econ-daily --topic "..."

# S2~S5 (CLI agent Task 위임 또는 직접 호출)
# Task(subagent_type="barrotube-researcher", prompt="...")
# Task(subagent_type="barrotube-strategist", prompt="...")
# Task(subagent_type="barrotube-writer", prompt="...")
# Task(subagent_type="barrotube-fact-checker", prompt="...")

# S6a~S6e (monolith, --execute로 일괄 비용 발생)
node scripts/automation/produce-episode.js --episode EP-YYYY-NNNN --execute

# S7 (자동 — produce-episode가 호출 또는 직접)
node scripts/automation/render-direct.js --episode EP-YYYY-NNNN

# S8 (Task agent)
# Task(subagent_type="barrotube-qa-reviewer", prompt="...")

# S9 (Task agent)
# Task(subagent_type="barrotube-metadata-writer", prompt="...")

# S10 (AskUserQuestion + approve)
node scripts/automation/approve-episode.js --episode EP-YYYY-NNNN

# S11 (Publisher Task 또는 직접)
node scripts/automation/publish-youtube.js \
  --video workspace/episodes/EP-YYYY-NNNN/55_render/video.mp4 \
  --meta workspace/episodes/EP-YYYY-NNNN/70_publish_meta.json \
  --execute

# 또는 S0~S11 일괄
node scripts/automation/run-episode.js --episode EP-YYYY-NNNN --execute
```

## 체크포인트 재시작

`.episode_status.json`이 stage 별 완료를 기록. `run-episode.js --episode EP-YYYY-NNNN`은 자동으로 마지막 완료 stage 다음부터 재개.

명시적 from:
```bash
node scripts/automation/run-episode.js --episode EP-YYYY-NNNN --from S4 --execute
```

## QA 실패 대응

QA score < 60 또는 blocker > 0:
- `60_qa_report.md`의 "회귀 stage" 명시 확인
- 일반 회귀: S4 (script 수정), S6c (이미지·Grok 클립 재생성), S7 (재렌더)
- 운영자 결정 후 해당 stage로 `--from`으로 재실행

## Fact Check HIGH 대응

`35_factcheck.md`에 HIGH 위험 있으면:
- 1차: S4 Writer 재집필 (수정 제안 반영)
- 2차: 여전히 HIGH면 운영자 escalation, 자동 진행 중단

최대 재집필 2회. 초과 시 `--force` 옵션 없으면 EP 차단.

## 비용 절감 팁

- 짧은 brief = LLM 토큰 절약
- shorts(5씬·60s) vs long(7씬·180s): shorts가 약 60% 비용
- 같은 시리즈의 brand DNA·intro·thumbnail 재사용 가능 (S6d/S6e skip)
- prompt cache 활용 (Claude Code Anthropic 캐싱)

## S8 QA 는 메타데이터만 보면 안 된다 (2026-08-14)

ffprobe 로 길이·코덱·라우드니스만 검사하던 시절, **아웃트로가 빠진 EP 가 QA PASS 로
게시 직전까지 갔다.** 카드가 없으면 목표 길이도 같이 줄어들어 Duration 검사가 통과한다 —
길이 정합성만으로는 구조적으로 못 잡는다. 사람이 렌더 결과를 보고서야 발견했다.

그래서 두 층으로 검사한다.

| 검사 | 무엇을 보나 | 잡는 것 |
|---|---|---|
| `Intro/Endcard cards` | 파일 존재 | 카드를 아예 안 만든 경우 |
| `Intro/Endcard in render` | **영상 프레임 vs 카드 그림** | 카드는 있는데 렌더에 안 붙은 경우 |
| `Motion clips` | 파일 존재 | 씬 클립을 아예 안 만든 경우 |
| `Motion liveness` | **클립 앞뒤 프레임끼리 비교** | 파일은 있는데 화면이 멈춰 있는 경우 |

`Motion liveness` 가 같은 종류의 구멍을 하나 더 막는다. `render-direct.js` 는
`videos/scene_NNN.mp4` 가 있으면 Ken Burns 를 끄고 그 클립을 그대로 쓰므로, 정지 클립이
들어오면 완전히 멈춘 씬이 나가는데 개수만 세는 검사는 5/5 로 통과시킨다.
문턱은 `lib/motion-verify.js` 의 `MOTION_MIN_DIFF`(0.008) — 정지 0.000, 실제 움직임
0.017~0.046 (`references/MOTION.md` 에 측정표).

프레임 대조는 `lib/qa-frame-match.js` 가 한다. 영상 1.0초 지점과 (끝-1.0초) 지점을
24×24 그레이스케일로 줄여 카드 이미지와 비교하고, 구도 차이와 밝기 차이를 반반 섞은
거리가 `FRAME_DIFF_THRESHOLD`(0.08)를 넘으면 FAIL 이다.

실측: 올바른 카드 0.000, 같은 채널의 **다른** 카드 0.106. 처음 0.18 로 잡았더니 바꿔치기를
통과시켰다 — 같은 채널 카드끼리는 배경 톤이 비슷해 차이가 작게 나온다.

> **원칙**: 산출물을 직접 보지 않는 검사는 "만들었다고 치는" 상태를 구분하지 못한다.
> 모델에게 프레임을 보여주는 방법도 있지만 판정이 흔들린다 — 픽셀 비교는 매번 같은 답을 준다.
