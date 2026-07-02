# PIPELINE.md — S0~S12 단계별 상세

> BarroSkills 에피소드 파이프라인 전체. 입력·출력·비용·시간·담당 에이전트 정본.

## 단계 요약

| Stage | 명칭 | 담당 (subagent_type) | 입력 | 출력 | 비용 | 시간 |
|---|---|---|---|---|---|---|
| S0 | Brief | (자동) `create-episode.js` | topic, channel | `00_brief.md` + EP 디렉토리 | 0 | 5초 |
| S1 | Ticket | (BarroSkills 생략) | - | - | 0 | - |
| S2 | Research | `barrotube-researcher` | brief | `10_market_research.md` | ~$0.05 | 1~2분 |
| S3 | Strategy | `barrotube-strategist` | brief + research | `20_strategy.md` | ~$0.10 | 1~2분 |
| S4 | Script | `barrotube-writer` | brief + research + strategy | `30_script.md` | ~$0.10 | 2~3분 |
| S5 | Factcheck | `barrotube-fact-checker` | script | `35_factcheck.md` | ~$0.05 | 1~2분 |
| S6a | TTS | `barrotube-voice-engineer` (또는 직접 호출) | script | `40_assets/tts/*.wav` | **$0.02/씬** (ElevenLabs) | 30초/씬 |
| S6b | Duration Sync | (자동) `sync-durations.js` | tts metadata | `30_script.md` 갱신 | 0 | 5초 |
| S6c | Scene Images | **기본: `barrotube-media-render` 스킬** (브라우저 ChatGPT, PD 수행) / 레거시: `barrotube-image-generator` API (`--image-engine openai\|gemini`) | script | `40_assets/images/*.png` (+선택 `40_assets/videos/*.mp4` Grok 모션 클립) | 기본 0 (브라우저) / 레거시 **$0.04/이미지** | 1~2분/씬 (브라우저) |
| S6d | Intro Card | `barrotube-image-generator` | brand DNA | `45_intro.png` | ~$0.04 | 20초 |
| S6e | Thumbnail | `barrotube-image-generator` | brand + script | `47_thumbnail.png` | ~$0.04 | 20초 |
| S7 | Render | (자동) `render-direct.js` — `videos/scene_NNN.mp4` 존재 씬은 모션 클립, 없으면 정지 이미지+Ken Burns(레거시), 씬별 혼합 가능 | assets + script | `55_render/video.mp4` | 0 (FFmpeg) | 1~2분 |
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
- 일반 회귀: S4 (script 수정), S6c (이미지 재생성), S7 (재렌더)
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
