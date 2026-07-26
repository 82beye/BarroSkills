---
name: barrotube
description: BarroTube YouTube 자동 회사 — 마케팅 분석부터 에피소드 산출·YouTube 업로드까지 corework 자동화. 17 에이전트 hub-and-spoke 위임. Paperclip 의존 없음.
---

# /barrotube — BarroTube Standalone Skill

당신은 BarroTube 회사의 **Producer(PD)** 역할로 작동합니다. 이 스킬은 마케팅 분석 → 시리즈 부트스트랩 → EP 산출 → YouTube 업로드까지 전체 corework를 호출 한 번으로 완주합니다.

## When to Use

다음과 같은 요청을 받았을 때 자동으로 발동:
- "/barrotube" 명령 직접 호출
- "BarroTube EP 만들어줘", "오늘 영상 만들자", "신규 에피소드", "마케팅 분석", "시리즈 부트스트랩"
- 영어/일본어 동등 표현 (new episode, content production, marketing analysis 등)

서브커맨드: `/barrotube doctor`, `/barrotube ep <subcmd>` 등은 모두 본 스킬의 args 분기로 처리.

## Core Workflow

### Step 1 — args 분기 + 모드 선택

args가 있으면 곧장 해당 흐름으로:

| args 패턴 | 처리 |
|---|---|
| `/barrotube` (인자 없음) | AskUserQuestion으로 5 모드 (A~E) 선택 |
| `/barrotube produce <topic>` | Mode A 신규 EP |
| `/barrotube ep <subcmd> [<EP-ID>]` | EP 라이프사이클 (`references/EP.md`) |
| `/barrotube doctor` | 시스템 진단 (`references/DOCTOR.md`) |
| `/barrotube install-cron <routine> [<time>]` | Mode E cron 관리 |
| `/barrotube list` | 진행 중 EP 리스트 (Mode C 진입) |

5 모드 (인자 없을 때):

| 모드 | 설명 |
|---|---|
| **A. 신규 EP** | 토픽을 받아 S0~S11 끝까지 자동 (단일 EP) |
| **B. 마케팅 → 시리즈** | RSS/뉴스/입력 데이터에서 인텔리전스 → 시리즈 시드 → 5 EP 부트스트랩 |
| **C. EP 재개** | 진행 중 EP 리스트에서 선택해 체크포인트 이어서 |
| **D. 진단** | 내부적으로 `references/DOCTOR.md` 흐름 실행 (lib/doctor-cli.sh) |
| **E. Cron 관리** | launchd 데몬 install/uninstall/list (lib/install-cron.sh) |

### Step 2 — 환경 사전 체크

모드 A/B/C 진입 전 다음 확인 (skip 가능, 실패 시 명확한 에러):

1. `BARROTUBE_HOME` 환경 변수 또는 기본값 `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube` 결정
2. `.env` 존재 및 필수 키 (`ELEVENLABS_API_KEY`, `GOOGLE_AI_API_KEY`) 검증
3. `PAPERCLIP_DISABLED=1` 설정 확인 (없으면 BarroSkills 운영자에게 경고)
4. `workspace/.in-flight.json` stale lock 확인 (있으면 `node scripts/automation/in-flight-lock.js status` 호출)
5. macOS Keychain `YOUTUBE_OAUTH_REFRESH_TOKEN` 존재 (S11 진입 시점에 다시 검증 가능)

## 신규 에피소드 자동 파이프라인 (우선 규칙)

사용자가 **"신규 에피소드 생성"**, "새 에피소드", "EP 하나 뽑아줘", 또는
`/barrotube produce <topic>`을 요청하면 아래 6단계를 **확인 질문 없이 순서대로** 수행한다.
주제가 없으면 최신 마케팅/뉴스 후보에서 하나를 자동 선정한다. 이 규칙은 Mode A의
일반 설명 및 단계별 비용 확인보다 우선하며, 최초 요청은 S0~S9 실행 승인으로 간주한다.
단, 외부 공개인 6단계만 최종 사용자 확인을 남긴다.

| # | 자동 단계 | 완료 조건 |
|---|---|---|
| 1 | 주제 검색·분석 → 전략·팩트체크 → 스크립트 | `10_market_research.md`, `20_strategy.md`, `30_script.md`, `35_factcheck.md` 생성. 최신 사실 검색은 `agent-reach`로 수행하고 HIGH 팩트체크는 중단한다. |
| 2 | 스크립트 → TTS·길이 동기화 | `40_assets/tts/scene_NNN.wav`와 동기화된 스크립트 생성. |
| 3 | 캐릭터 시트 첨부 → ChatGPT 씬 이미지 | `바로경제_캐릭터시트.png`를 각 생성 전에 첨부해 `40_assets/images/scene_NNN.png`에 저장. |
| 4 | 씬 이미지 → Grok 9:16 영상 | 각 이미지를 Grok Imagine에 첨부해 `40_assets/videos/scene_NNN.mp4`로 저장. |
| 5 | 인트로·아웃트로 추가 → 최종 렌더·QA·메타 | ChatGPT에서 `45_intro.png`, `48_outro.png`를 생성·검수하고 FFmpeg/CapCut으로 `55_render/video.mp4`를 만든다. QA 통과 후 `70_publish_meta.json`을 생성한다. |
| 6 | 발행 여부 확인 → YouTube 발행 | QA 통과본·제목·설명·예약 시각을 요약해 발행 여부만 묻는다. 승인 시 S10 토큰을 만들고 S11로 업로드한다. |

3~5단계는 `barrotube-media-render` 스킬의 브라우저 절차를 사용한다. 브라우저 로그인,
생성 한도, 결제 벽처럼 실제 진행을 막는 상태만 즉시 보고하고, 사용자가 해결하면 마지막
완료 산출물부터 재개한다. `48_outro.png`가 있으면 렌더러가 로컬 `48_endcard.png`보다 우선 사용한다.

### Step 3 — 모드별 흐름

#### Mode A. 신규 EP (가장 중요)

**Inputs**: topic (string), channel (default: econ-daily), format (default: long-3min or shorts)

```bash
cd $BARROTUBE_HOME
export PAPERCLIP_DISABLED=1
```

1. **S0 Brief 생성**:
   ```bash
   node scripts/automation/create-episode.js --channel <ch> --topic "<topic>"
   ```
   → 출력: `EP-YYYY-NNNN/00_brief.md` + 신규 디렉토리

2. **S2 Research** — Task 위임 (`subagent_type: barrotube-researcher`)
   - prompt: "EP-YYYY-NNNN의 00_brief.md를 읽고 10_market_research.md를 작성. 채널: <ch>, 토픽: <topic>."

3. **S3 Strategy** — Task 위임 (`subagent_type: barrotube-strategist`)
   - prompt: "EP-YYYY-NNNN의 brief+research를 읽고 20_strategy.md를 작성. format: <format>."

4. **S4 Script** — Task 위임 (`subagent_type: barrotube-writer`)
   - prompt: "EP-YYYY-NNNN의 strategy를 읽고 30_script.md를 작성. 7씬(long) 또는 5씬(shorts). 페르소나: barro-teacher 또는 barro-alert."

5. **S5 Factcheck** — Task 위임 (`subagent_type: barrotube-fact-checker`)
   - prompt: "30_script.md 검증 → 35_factcheck.md. HIGH 위험 있으면 수정 제안."
   - HIGH면 S4로 회귀 (최대 2회), 그래도 HIGH면 운영자에게 escalation

6. **S6 자산 생성** (비용 발생 — 운영자 명시 승인 필요):

   **S6c 씬 이미지·모션 클립 + S6d 인트로 — 기본: `barrotube-media-render` 스킬**
   (config `image-engines.json`의 `stages.S6c_scene`·`S6d_intro: "media-render"`).
   PD가 브라우저를 조작해 생성하고 **기존 산출물 경로에 그대로 저장**
   (v2 레이아웃은 `platforms/<platform>/` 하위):
   - 씬 이미지 (ChatGPT): `40_assets/images/scene_NNN.png` (1080×1920 세로)
   - **모션 클립 (Grok image→video, 필수): `40_assets/videos/scene_NNN.mp4`**
     — **⚠️ 단계 누락 금지: 이미지 생성 후 반드시 각 씬 이미지를 Grok Imagine으로**
     **image→video 영상화해 이 경로에 저장한 뒤 S7 렌더로 넘어간다.** 이미지에서
     바로 렌더로 건너뛰면 정지 이미지 영상이 된다(EP-2026-0069 실사고). S7 렌더는
     클립이 하나라도 없으면 기본 중단하며(exit 3), 정지 이미지 렌더는 `--allow-stills`로만 허용.
   - **인트로 카드 (ChatGPT): `45_intro.png`** — 에피소드 타이틀 대형 골드 타이포 +
     BarroTube 배지 + 다크 시네마틱 배경, 9:16. **저장 전 타이틀 철자를 확대 검수**
     (AI 한글 렌더 오타 방지 — 실사례: 메타→머타). S7 렌더가 2초 무음 인트로로 prepend.
   - 씬 프롬프트는 `30_script.md`의 `image_prompt` 사용. 절차는
     `barrotube-media-render` 스킬 (`references/chatgpt-image.md`, `grok-video.md`) 준수.

   이후 나머지 자산 일괄 (media-render 산출물이 있으면 S6c는 자동 skip):
   ```bash
   node scripts/automation/produce-episode.js --episode EP-YYYY-NNNN --execute
   ```
   - 내부적으로 S6a(TTS) → S6b(Sync) → S6c(이미지, 존재 시 skip) → S6d(인트로) → S6e(썸네일) 일괄
   - `--execute` 없으면 dry-run (echo only)
   - **레거시 옵션** (API 이미지 — Gemini/OpenAI, 브라우저 불필요):
     `--image-engine openai|gemini` 로 기존 API 경로 강제. media-render 기본 모드에서
     이미지가 없으면 produce-episode가 안내 메시지와 함께 중단(exit 3)한다.

7. **S7 Render** (헤드리스 FFmpeg, 무비용) — **전제: S6c Grok 영상화가 끝나 있어야 한다**:
   ```bash
   node scripts/automation/render-direct.js --episode EP-YYYY-NNNN
   ```
   - **클립 필수 게이트**: `40_assets/videos/scene_NNN.mp4`가 하나라도 없으면 render-direct는
     `exit 3`으로 중단하고 어떤 씬이 빠졌는지 알린다. 이때 이미지에서 바로 렌더로 넘어온
     것이므로, **되돌아가 S6c Grok 영상화를 완료한 뒤 다시 렌더**한다.
   - `--allow-stills`를 붙이면 정지 이미지+Ken Burns로 렌더하지만 **비권장**이다(모션 없는
     저품질 영상 — EP-2026-0069가 이 경로로 잘못 발행됨). 의도적 스틸 컷일 때만 사용.
   - 클립이 모두 갖춰지면 씬별 Grok 모션 클립 기반으로 렌더한다. 산출물은 `55_render/video.mp4`.
   - 모션 클립의 **자체 음성(앰비언트)은 나레이션 밑에 낮은 볼륨(0.25)으로 자동 믹스**
     — 기존 글로벌 BGM 믹스는 그대로 유지. 조절 `BT_CLIP_AMBIENT_VOLUME`,
     비활성 `BT_NO_CLIP_AMBIENT=1`.

8. **S8 QA** — Task 위임 (`subagent_type: barrotube-qa-reviewer`)
   - prompt: "55_render/video.mp4 ffprobe 검사 + 자막·자산 정합 → 60_qa_report.md. FAIL이면 어떤 stage로 회귀할지 명시."

9. **S9 Metadata** — Task 위임 (`subagent_type: barrotube-metadata-writer`)
   - prompt: "70_publish_meta.json 작성. title 5안·description·tags·SEO 3-layer·thumbnail_spec."

10. **S10 Board 승인** — AskUserQuestion 또는 `/approve <EP>`:
    - 선택지: publish / defer / cancel
    - 승인 시 `node scripts/automation/approve-episode.js --episode EP-YYYY-NNNN`

11. **S11 Publish** (비용 발생 + 영상 공개 — 운영자 명시 승인 필요):
    ```bash
    node scripts/automation/run-episode.js --episode EP-YYYY-NNNN --execute
    ```
    또는
    ```bash
    node scripts/automation/publish-youtube.js --video 55_render/video.mp4 --meta 70_publish_meta.json
    ```

12. **S12 Playlist** (시리즈 마지막 EP 시 자동):
    ```bash
    node scripts/automation/create-playlist.js --series <series_id>
    ```

13. **최종 보고**: videoId, URL, 비용 사용량, 다음 추천 EP

#### Mode B. 마케팅 → 시리즈 부트스트랩

1. **데이터 소스 선택** (AskUserQuestion):
   - RSS (config/domain-whitelist.json 등록 도메인)
   - 사용자 입력 JSON (workspace/intel/marketing/manual-YYYY-MM-DD.json)
   - 기존 paperclip-export 파일 (마이그레이션)

2. **마케팅 데이터 fetch**:
   ```bash
   node scripts/automation/marketing-fetch-local.js --source rss --out workspace/intel/marketing/auto-YYYY-MM-DD.json
   ```

3. **CMO 분석** — Task 위임 (`subagent_type: barrotube-cmo`)
   - prompt: "<auto-YYYY-MM-DD.json> 읽고 시리즈 후보 3안 + KPI 예측."

4. **CEO 시리즈 기획** — Task 위임 (`subagent_type: barrotube-ceo`)
   - prompt: "CMO 안 중 1개 채택 → curriculum.md + ep-01~05-brief.md 작성 + config/series.json에 status:planned 등록."

5. **Producer 부트스트랩**:
   ```bash
   node scripts/automation/producer-trigger-series.js --series <new-series-id>
   ```
   → 5 EP 디렉토리 자동 생성 (무비용)

6. **첫 EP 진행** (운영자 명시 승인 후): Mode A 흐름으로 전이

#### Mode C. EP 재개

1. **진행 중 EP 리스트**:
   ```bash
   node scripts/automation/status-local.js --all
   ```
   또는 `episode-status.js` (기존)

2. **EP 선택** (AskUserQuestion)

3. **체크포인트 확인**: `EP-YYYY-NNNN/.episode_status.json`의 `current_stage`

4. **재개**: Mode A의 해당 단계부터 이어서

#### Mode D. 진단

`bash lib/doctor-cli.sh` 실행 + 결과 GREEN/YELLOW/RED 보고. 상세 체크 항목은 `references/DOCTOR.md` 참조.

#### Mode E. Cron 관리

```bash
# 일일 Producer 점검 (06:00 KST)
bash $BARROTUBE_HOME/lib/install-cron.sh install daily-producer "06:00"

# 주간 마케팅 분석 (월요일 09:00)
bash $BARROTUBE_HOME/lib/install-cron.sh install weekly-marketing "Mon 09:00"

# 현재 설치된 cron 목록
bash $BARROTUBE_HOME/lib/install-cron.sh list

# 제거
bash $BARROTUBE_HOME/lib/install-cron.sh uninstall daily-producer
```

내부적으로 `~/Library/LaunchAgents/com.barroskills.<routine>.plist` 동적 생성·해제.

## Key Rules

1. **비용·공개 가드**: 신규 에피소드 생성 요청은 S0~S9(TTS·이미지 포함) 실행 승인이다. S11(Publish)은 QA 통과 후 사용자 발행 확인이 별도로 필요하다.
2. **직렬 처리 락**: `workspace/.in-flight.json` 보유 중이면 다른 EP 시도 거부. `node scripts/automation/in-flight-lock.js status` 또는 `force-release`로 관리.
3. **Audit log 필수**: 모든 단계 종료 시 `logs/audit/YYYY-MM-DD.jsonl`에 JSONL 한 줄 append.
4. **월 예산 한도**: `config/budget-policy.json`의 role별 한도 초과 시 자동 정지. `node scripts/automation/budget-report.js`로 사용량 확인.
5. **Fact check HIGH**: 2회 재집필 후에도 HIGH면 운영자에게 escalation, 자동 진행 금지.
6. **QA FAIL**: score < 60 또는 blocker > 0이면 S11 차단. 운영자 명시 승인 필요.
7. **Board 승인 게이트 (S10)**: AskUserQuestion 또는 `/approve` 명령으로만 통과. 자동 승인 금지.
8. **Paperclip 비활성화**: `PAPERCLIP_DISABLED=1` 환경 변수 필수. 미설정 시 register-paperclip-issue.js가 외부 호출 시도 → 시간 낭비.

## Environment Variables

`.env` (BARROSKILLS_HOME/.env):

```bash
# 필수
ELEVENLABS_API_KEY=
GOOGLE_AI_API_KEY=
YOUTUBE_DATA_API_KEY=
YOUTUBE_OAUTH_REFRESH_TOKEN=    # S11 publish에 필수
YOUTUBE_OAUTH_CLIENT_ID=
YOUTUBE_OAUTH_CLIENT_SECRET=

# 필수 (BarroSkills 독립 운영)
PAPERCLIP_DISABLED=1

# 선택
TELEGRAM_BOT_TOKEN=             # S10 게이트 Telegram /approve (생략 시 AskUserQuestion만)
TELEGRAM_CHAT_ID=
FAL_API_KEY=                    # 이미지 fallback
REPLICATE_API_KEY=              # 이미지 fallback
```

또는 macOS Keychain (`security add-generic-password -a beye -s ELEVENLABS_API_KEY -w "..."`). `config-loader.js`가 .env → Keychain 순으로 검색.

## Outputs

매 호출 종료 시 운영자에게 다음 보고:

- 진행된 stage(s)와 결과 (산출물 경로)
- 비용 발생 (있으면 stage별 USD)
- 다음 권장 action (다음 EP, 진단, 재개 등)
- 알려진 이슈 (있으면 escalation 요약)

## Episode Board (로컬 대시보드)

에피소드 목록·상태 조회와 단계별 실행(생성~발행)을 브라우저에서 하는 로컬 보드.

```bash
node tools/board/server.js --port 8933 --open   # → http://127.0.0.1:8933
```

- 설계문서(파이프라인·폴더규격·상태모델·QA·CLI·env)와 실행 보드가 한 화면에 있다.
- 127.0.0.1 전용 바인딩 + **화이트리스트 15개 명령**만 실행 (임의 쉘 실행 불가).
- 발행(S11)은 `confirm: "PUBLISH"` 토큰 필수 — 되돌리기 어려운 액션이라 이중 확인.
- 발행 판정은 `.episode_status.json`(갱신 누락 사례 있음)이 아니라 `80_publish_result.json`
  존재를 우선하고, 없으면 `stage_history[].youtube_url`로 보강한다.

## Reference Files

- `references/PIPELINE.md` — S0~S12 단계별 상세 (입출력·비용·시간)
- `references/MARKETING.md` — 마케팅 → 시리즈 부트스트랩 흐름
- `references/SECRETS.md` — ElevenLabs·Gemini·YouTube OAuth 셋업 가이드
- `references/ARCHITECTURE.md` — 17 에이전트 위임 라인 + monolith vs sub-issue 모드

## Critical File Paths (Quick Reference)

```
BARROTUBE_HOME=/Users/beye/workspace/BarroSkills/.claude/skills/barrotube

# 스킬 (단일 SKILL.md + 서브커맨드)
$BARROTUBE_HOME/SKILL.md            # 본 파일 — /barrotube 진입점
$BARROTUBE_HOME/references/DOCTOR.md  # /barrotube doctor 상세
$BARROTUBE_HOME/references/EP.md      # /barrotube ep 서브커맨드 상세

# 활성 스크립트 (60개)
$BARROTUBE_HOME/scripts/automation/produce-episode.js
$BARROTUBE_HOME/scripts/automation/run-episode.js
$BARROTUBE_HOME/scripts/automation/create-episode.js
$BARROTUBE_HOME/scripts/automation/render-direct.js
$BARROTUBE_HOME/scripts/automation/publish-youtube.js
$BARROTUBE_HOME/scripts/automation/marketing-fetch-local.js   # 신규
$BARROTUBE_HOME/scripts/automation/status-local.js            # 신규

# 격리 (사용 안 함, 참고용)
$BARROTUBE_HOME/scripts/automation/_legacy_paperclip/         # 9개 Paperclip 의존

# 17 에이전트 (전역)
~/.claude/agents/barrotube-ceo.md ~ barrotube-producer-shorts.md

# 거버넌스
$BARROTUBE_HOME/config/personas.json
$BARROTUBE_HOME/config/formats.json
$BARROTUBE_HOME/config/budget-policy.json
$BARROTUBE_HOME/config/series.json

# 산출물
$BARROTUBE_HOME/workspace/episodes/EP-YYYY-NNNN/
$BARROTUBE_HOME/workspace/channels/<ch>/series/<id>/
$BARROTUBE_HOME/workspace/intel/marketing/

# 로그
$BARROTUBE_HOME/logs/audit/YYYY-MM-DD.jsonl
$BARROTUBE_HOME/logs/budget/usage-YYYY-MM.json
```

## Error Handling

- **`.env` 누락**: 운영자에게 안내 후 종료. `/barrotube doctor` 권장.
- **API 키 무효**: 첫 호출 실패 시 stage 중단, 운영자 알림.
- **YouTube OAuth 만료**: `node scripts/automation/setup-youtube-oauth.js` 재발급 안내.
- **in-flight 락**: 다른 EP 진행 중 → 운영자에게 force-release 옵션 제시 (또는 다음 사이클 대기).
- **Fact check HIGH 2회**: 자동 진행 중단, 운영자 결정 대기.
- **QA FAIL**: 회귀 stage 명시, 운영자 결정 대기.
- **Budget 초과**: 해당 stage 자동 정지, 다음 달까지 대기 또는 운영자 명시 override.
