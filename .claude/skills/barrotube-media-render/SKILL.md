---
name: barrotube-media-render
description: >-
  Render BarroTube/ShortsGen media by driving the user's logged-in browser:
  create a ChatGPT image, animate it in Grok Imagine as a 9:16 720p 10s video,
  download the files, move them into Image/ and video/ folders, merge the reel,
  create a CapCut draft, and export the final MP4. Use for requests like
  "이 대본으로 영상까지 뽑아줘", "barrotube 프롬프트로 쇼츠 만들어",
  "ChatGPT로 이미지 만들고 Grok으로 영상 생성해줘", "render this scene",
  "make a 9:16 short clip", "generate the image then animate it". Also use when
  a reel must be finished end-to-end through Playwright MCP, ChatGPT image
  download, Grok image-to-video download, FFmpeg master mix, and CapCut export:
  "ep01 릴스 영상까지 만들어", "컷별 이미지로 grok 영상 일괄 생성",
  "CapCut으로 렌더링까지", "render all cuts of this reel".
---

# barrotube-media-render

Turn a **barrotube/ShortsGen prompt** into **finished media on disk** by piloting
the user's logged-in browser: generate the still on **ChatGPT**, animate/render the
clip on **Grok Imagine** (720p / 10s / 9:16), download both, merge the reel with
one master BGM/SFX mix, create a **CapCut** project, and export the final MP4.

This skill is the *render* half of the pipeline. **barrotube writes the prompt;
this skill produces the files.** It deliberately does the parts that are fiddly and
easy to get wrong — option toggles, waiting for generation, and getting the bytes
off the page and into the right folder.

## When to use

Use this when the user has (or wants) a BarroTube reel/short and needs actual
image, video, CapCut draft, or exported MP4 files rendered. Typical asks:
"이 씬으로 영상까지", "barrotube 대본 렌더해줘", "이미지 만들고 그걸로 10초 영상",
"CapCut으로 최종 렌더", "make the short for scene 2". If the user only gives a
topic, write the reel script first, then render.

## Two consumption modes (standalone is the default identity)

이 스킬은 **단독 실행이 기본**이며, barrotube 스킬이 이를 참조하는 것은 단방향
의존이다 (barrotube가 없어도 이 스킬은 완전하게 동작한다).

1. **Standalone — 릴/Instagram 채널 모드 (기본).** 입력은 reel `script.md` +
   `Image/` 스틸; 산출은 `<reel>/Image/<slug>.png`, `<reel>/video/<slug>.mp4`,
   `55_render/` → CapCut export → Instagram publish. 이 문서의 전 워크플로우와
   `scripts/` 전부(상태머신 `render_reel_job.py`, QA `qa_reel_media.py`,
   preflight `media_render_doctor.py`, 공용 렌더러 `render_master_mix.py` 포함)가
   이 모드 기준이다. 예: takitani.lab 인스타 릴 채널 운영.

2. **barrotube EP 모드 (S6c 씬 + S6d 인트로 소비자).** barrotube 스킬의 에피소드
   파이프라인이 씬 이미지·모션 클립·인트로 카드 생성을 이 스킬에 위임한다.
   브라우저 절차는 동일하되 **산출 경로만 EP 규약을 따른다**
   (v2 레이아웃은 `EP-YYYY-NNNN/platforms/<platform>/` 하위):
   - 씬 이미지 → `40_assets/images/scene_NNN.png`
   - 모션 클립 → `40_assets/videos/scene_NNN.mp4`
   - **신규 Shorts S6c 완료 게이트:** ChatGPT 씬 이미지 5장 + 모션 클립 5개(각 5/5).
     모션 클립의 **기본 엔진은 로컬 HyperFrames** 다 — 브라우저가 필요 없다.
     `node scripts/automation/generate-motion.js --episode <dir> --platform shorts`
     (barrotube 스킬). 승인된 스틸 자체를 헤드리스 크롬으로 움직이므로 캐릭터 드리프트가
     0 이고 길이가 TTS 에 정확히 맞는다. Grok image-to-video 는 `BT_MOTION_ENGINE=none`
     일 때 또는 피사체 자체가 움직여야 하는 컷에서 명시적으로 쓴다. 근거·게이트·실측은
     `barrotube/references/MOTION.md`.
   - **인트로 카드 → `45_intro.png`** — 타이틀 대형 골드 타이포 + 채널 배지 +
     다크 배경, 9:16. **저장 전 타이틀 철자를 확대(zoom) 검수** — AI 한글 렌더
     오타가 실제로 발생한다(실사례: "메타"→"머타"). 오타면 재생성.
   - Downloads 경유 시: `move_media.py --dest-dir <dir> --slug scene_001|45_intro`
   - 씬 프롬프트 소스는 `30_script.md`의 `image_prompt`. 나머지(엔진 선택·skip
     로직)는 barrotube 쪽 `config/image-engines.json`이 관장한다.
   - **브라우저 이미지 수락 기준:** 마시는 씬 동작의 주어이자 중앙의 주인공이어야 한다.
     구석 스티커·워터마크 크기면 다시 생성한다. 설명 씬은 기본 크림-화이트, 정장은
     정책·비즈니스 상황에만 쓰고, 행동·CTA 씬은 크림/네이비/오렌지 계열의 상황별
     착장을 쓴다. 전 씬 정장 반복은 거부한다. 방향성을 설명하는 씬·인트로·썸네일에는
     레버·다이얼·갈림길·스위치·화살표 중 하나의 **방향 트리거**를 중심 오브젝트로 둔다.
   - 기존 시리즈의 인트로·썸네일은 최근 완료 EP 최대 3개의 실제 이미지를 먼저 비교해
     캐릭터 크기, 헤드라인 위치, 배경 톤을 맞춘다. 일반 템플릿으로 임의 재해석하지 않는다.
   - **스틸 첨부(claude-in-chrome) — 정본은 「세션 폴더로 복사 후 `file_upload`」다.**
     `file_upload` 가 거부하는 건 파일이 아니라 **경로**다. 세션이 공유하지 않은 위치
     (`~/BarroTubeData/...` 등)는 막히지만, 세션 스크래치패드로 **복사한 뒤** 그 경로로
     올리면 통과한다. 2026-08-17 실측: 캐릭터 시트(1.7MB)를 스크래치패드로 복사해
     ChatGPT 컴포저의 숨은 input 에 4회 연속 성공, 썸네일·`Remove image` 로 확인.
     ```
     cp <원본.png> "$SCRATCHPAD/sheet.png"
     find(tabId, "hidden file input element for uploading attachments")  # ref 확보
     file_upload(tabId, ref, ["$SCRATCHPAD/sheet.png"])
     ```
     합계 10MB 미만이어야 한다. 첨부 판정은 반환값이 아니라 썸네일/`Remove image` 로 한다.
   - **클립보드(Cmd+V)는 폴백으로만 쓴다.** 붙기는 하지만 클립보드는 공유 전역 상태라
     긴 실행 중 다른 작업이 덮어쓴다 — 2026-08-17 실측: 파이프라인이 시트를 적재한 뒤
     에이전트 작업 도중 텍스트로 바뀌어 있었다(`clipboard info` 로 확인). 붙여넣기
     직전에 반드시 다시 적재하고, 그래도 썸네일이 안 뜨면 위 `file_upload` 경로로 가라.
     `osascript -e 'set the clipboard to (read (POSIX file "<png>") as «class PNGf»)'`
   - **첨부 가능 여부는 표면마다 다르다 — 섞어 읽지 마라.** 위 클립보드 우회는
     **claude-in-chrome**(대화형 세션)에서 확인된 것이다. **codex 의 Chrome 표면에서는
     세 경로가 모두 막힌다**: Playwright 숨은 input 주입(보안 정책), 컴포저 파일 선택
     UI(선택 이벤트 미발생), Cmd+V(붙여도 썸네일·`Remove image` 안 뜸).
     2026-08-17 auto-pipeline 무인 실행에서 codex 가 클립보드를 직접 재적재한 뒤
     Cmd+V 까지 시도했으나 실패했다 — 두 번 연속, 서로 다른 호출에서.
     따라서 **cron(codex) 경로는 시트 첨부를 전제할 수 없다.** 시트가 필요한 생성은
     대화형 세션에서 하거나, 이미지 API 폴백(크레딧 필요)에 맡겨야 한다.
     외부 Playwright MCP 로 우회할 수도 없다 — codex 의 `control-chrome` 스킬이
     "Do not use external MCP browser-control tools" 로 금지하고, 승인 모드를 `auto` 로
     열어도 호출이 취소된다(2026-08-17 실측).
   - **첨부 권한은 사이트마다 갈린다 (2026-08-18 실측).** codex 가 직접 안내한
     `chrome://extensions → ChatGPT 확장 → 세부정보 → 「파일 URL에 대한 액세스 허용」`
     은 **ChatGPT 에만** 듣는다. 같은 권한을 켠 상태에서도 Grok 은
     "로컬 파일 선택이 확장 표면에서 열리지 않아" 로 막힌다 — 그 확장의 관할이 아니기 때문이다.
     즉 **Grok image→video 는 여전히 대화형 claude-in-chrome 의 `file_upload` 로만 확실하다.**
     "권한 켜면 다 풀린다" 고 넘겨짚지 마라 — ChatGPT 와 Grok 을 따로 확인해야 한다.
   - **씬 이미지는 되고 Grok 모션은 안 되는 이유.** 씬 이미지는 시트 **한 장**만 있으면
     되므로, 시트가 이미 첨부된 **시드 대화**에서 이어 요청해 첨부를 우회한다
     (`barrotube/config/image-engines.json` 의 `media_render.chatgpt_seed_conversation`).
     Grok image→video 는 **컷마다 다른 스틸**을 올려야 해서 같은 우회가 성립하지 않는다.
     그래서 **무인 실행의 모션은 로컬 HyperFrames 로 나가고**, auto-pipeline 이
     `🎞 모션 N컷이 HyperFrames 폴백` 텔레그램을 보낸다. Grok 모션이 필요하면 그 알림을
     받은 뒤 대화형 세션에서 교체한다(EP-0096·0097 실제로 그렇게 처리).
     같은 이유로 auto-pipeline 의 Grok **이미지** 패스는 기본 꺼져 있다 —
     첨부가 되는 표면에서만 `BT_GROK_IMAGE=1` 로 켠다.
   - **프롬프트는 영문으로 입력한다.** 브라우저 자동화로 한글을 타이핑하면 공백이 사라지고
     (`이대화맨위에첨부한…`) 뒤 문장이 통째로 잘리는 일이 있다(2026-08-17 ChatGPT·실측).
     image_prompt 는 원래 영문이므로, 앞에 붙이는 지시문만 영문으로 쓰면 된다.

어느 모드든 브라우저 절차(`references/`)와 가드(Gotchas)는 공통이다.

## Inputs

One of:

1. **barrotube YAML** (preferred) — the ShortsGen script schema:
   `title, hook, scenes[](narration, duration, broll_keywords), captions[]`.
   See `references/barrotube-schema.md` for the exact shape and how each field maps
   to an image prompt and a video prompt.
2. **A direct scene description** — free text the user typed.
3. **A whole reel (batch)** — a `script.md` with `CUT 1..N` blocks (each having an
   `**이미지 파일:**` path and a `**Grok 모션:**` prompt) plus an `Image/` folder of 9:16
  stills, one per cut, or no stills yet. The user wants **every cut** rendered
  and exported. This is the BarroMarketing→BarroTube handoff shape. → use
  **Reel batch mode** (`references/reel-batch.md`); parse with
  `scripts/reel_render_plan.py` when stills already exist.

Optional knobs (with sensible defaults):

- `style` — 감성 VLOG / 정보형 / 리뷰형 / 다이나믹 (controls tone of the visual prompt).
- `scene_index` — which scene to render (default: the hero scene, i.e. the first, or
  process all scenes if the user asks for the whole short).
- `aspect / resolution / duration` — default **9:16 / 720p / 10s** (Grok short).

## Prerequisites (check first, don't assume)

- A **browser-automation tool with a logged-in session**. Prefer **Playwright MCP**
  when it is available and already logged into ChatGPT/Grok; it supports direct
  `download.saveAs()` and hidden file input upload. Use `chrome:control-chrome`
  only when Playwright lacks the needed login/session or file upload state.
  Browser-less headless execution is unsupported. A non-interactive orchestrator
  may run this skill only when it has a logged-in Playwright/Chrome control surface
  and performs the same visible state checks before accepting each asset.
- The user is **signed in** to both https://chatgpt.com and https://grok.com/imagine.
- 로그인 판정은 URL이나 하위 worker의 문장만으로 하지 않는다. 기존 탭을 한 번 선택해
  **composer와 계정 프로필 컨트롤이 함께 보이는지** 확인한다. 둘이 보이면 로그인 상태다.
  명시적 로그인 폼/캡차가 보이고 composer가 없을 때만 중단하며, 그 탭을 전면에 남긴다.
- **Folder access** to: the project's `Image/` and `video/` output folders, and the
  browser's **Downloads** folder (that's where the sites' Download buttons save).
  Default project layout (per-channel convention):
  `~/BarroAiFactory/<handle>/barrotube/Image` and `.../barrotube/video`, and for a reel,
  `~/BarroAiFactory/<handle>/barrotube/<reel>/Image` + `.../<reel>/video`. If a folder
  isn't mounted, request it.
- **Environment matters for file attach.** Attaching a still to Grok (image→video) needs
  browser control that can select or upload local files. In Codex, prefer Chrome with the
  user's logged-in profile; if file upload is blocked by the current browser surface, ask
  the user to drag the still into Grok. Text→video is a standalone/legacy fallback only;
  it does not complete S6c for a new BarroTube Short (see `references/reel-batch.md`).
- `ffmpeg`/`ffprobe` for final merge, stream validation, contact sheets, and BGM/SFX
  master mix.
- CapCut 2 installed when the user asks for CapCut draft/export. Prefer
  `/Applications/CapCut 2.app`; older `/Applications/CapCut.app` can reject newer
  drafts with an update dialog.

## Workflow

Before work starts, initialize production timing for the reel:

```bash
python3 scripts/production_timer.py init <reel> --episode <EP-ID>
python3 scripts/production_timer.py start <reel> scene_plan --label "Scene plan"
```

Every major step must be wrapped with `production_timer.py start/end`, including
browser-driven waiting time. For shell commands, prefer:

```bash
python3 scripts/production_timer.py run <reel> ffmpeg_master --label "FFmpeg master mix" -- ffmpeg ...
```

The expected timing outputs are:

- `<reel>/90_timing/production-timing.json`
- `<reel>/90_timing/production-timing.md`

Work one cut at a time:

1. Build the image and motion prompts.
2. Generate/download the still from ChatGPT into `Image/<slug>.png`.
3. Upload that still to Grok Imagine, generate/download `video/<slug>.mp4`.
4. After all cuts, merge with one master BGM/SFX track.
5. Create/open a CapCut draft and export the final MP4.

Use Playwright MCP `browser_run_code_unsafe` for fragile UI operations such as
`download.saveAs()` and `input[type=file].setInputFiles(...)`, and use screenshots
or contact sheets to verify visual state before proceeding.

### Step 0 — Build the prompts from the script

Read the barrotube YAML and turn the chosen scene into two prompts:

- **image_prompt** — a vivid still describing subject + setting + `broll_keywords` +
  `style`, ending with a concrete look (e.g. "지브리 스타일, 손그림 느낌, 영화 같은 분위기").
  For vertical reels, make Masi the dominant central actor with a readable face and
  full-body pose. Keep one scene object and the surrounding environment secondary,
  with comfortable headroom and footroom. This keeps the scene readable inside 9:16
  without camera-spec or frame-percentage instructions that image models ignore.
- **video_prompt** — the same scene but describing **motion + camera** (what moves,
  wind, water, a tracking shot), because video models need movement cues.

You can do this by hand, or run the helper for a deterministic mapping:

```bash
python scripts/barrotube_to_prompts.py <script.yaml> --scene 0 --style "감성 VLOG"
```

It prints JSON: `{ "slug", "image_prompt", "video_prompt" }`. Use `slug` for filenames.
Mapping details and editable rules: `references/barrotube-schema.md`.

### Step 1 — Generate the image on ChatGPT

Follow `references/chatgpt-image.md` for the exact, verified UI steps. In short:
open chatgpt.com, **attach the channel character sheet** (see below), type an
explicit image-generation prompt, wait for a portrait image to appear, open the
image share/download modal, then save it to `Image/<slug>.png` (Playwright
`download.saveAs()` when available; claude-in-chrome uses the History+Finder
retrieval, see "Downloads land on disk" gotcha).

Batch에서는 컷마다 새 ChatGPT 대화를 열고 같은 캐릭터 시트를 다시 첨부한다. 동일
대화에 같은 파일을 재첨부하면 "이미 이 파일을 업로드했습니다"로 거부될 수 있다.
첨부 chip을 확인한 뒤에만 전송하고, 저장·검증 후 share dialog를 닫고 다음 컷으로 간다.

**Attach the character reference (REQUIRED when the channel has a sheet).** Before
typing the prompt, attach the channel's official character sheet so the mascot
matches exactly — 바로경제 = `~/BarroTubeData/workspace/docs/바로경제_캐릭터시트.png`
(constants: `~/BarroTubeData/CLAUDE.md`, channel `character-dna.md`, `role.md`).
With Playwright, use `#upload-photos`/the hidden file input and verify the attachment
chip. With claude-in-chrome or when that input fails, paste through the macOS clipboard
and verify the same chip. Then start the prompt with
`Use the attached character sheet as the exact reference for the mascot` and describe
only scene/pose/expression/props. Full steps + fallback:
`references/chatgpt-image.md` Step 0.

Timing rule: start `chatgpt_image_cutN` before sending the prompt and end it only
after the file has been saved and validated.

### Step 2 — Generate the video on Grok Imagine

Follow `references/grok-video.md`. In short: open grok.com/imagine, set the option
bar to **비디오 / 720p / 10s / 9:16 / Video audio ON** and verify it. `Video audio`
버튼은 보이는 것만으로 충분하지 않으며 매 컷 `aria-pressed="true"`여야 한다. Then:

- **Image→video (required for new BarroTube Shorts):** attach the ChatGPT image you just
  saved (the "+" in the prompt bar) and give a short **motion** prompt.
- **Text→video (standalone/legacy only):** just type `video_prompt`. It is not accepted
  as new Shorts S6c completion evidence or by publish QA.

Send, watch the **"생성 중 NN%"** progress to 100%, then click **다운로드** and save to
`video/<slug>.mp4`.

업로드 완료는 filename locator가 아니라 `Remove image` 버튼/첨부 thumbnail로 판정한다.
제출 직후 `/imagine` URL이 잠시 남을 수 있으므로 URL 반환만으로 실패 처리하지 말고 새
`/imagine/post/<id>` 또는 현재 생성 진행 표시를 기다린다. 다운로드 후 `ffprobe`에서
H.264 세로 영상과 **AAC 오디오 스트림**이 모두 보여야 수락한다. 오디오가 없으면 파일을
완료로 세지 말고 `Video audio`를 켠 뒤 같은 컷을 다시 생성한다.

Timing rule: start `grok_video_cutN` before attaching the image/prompt and end it
only after the downloaded video passes `ffprobe`.

### Step 3 — File the outputs into the project folders

Move each download out of `~/Downloads` into the right folder, validate, rename by slug,
and (with approval) remove the original:

```bash
# image
python scripts/move_media.py --kind image --slug <slug> \
  --dest-root /Users/beye/BarroAiFactory
# video
python scripts/move_media.py --kind video --slug <slug> \
  --dest-root /Users/beye/BarroAiFactory
```

`move_media.py` picks the newest matching file in Downloads (png for image,
`grok-video-*.mp4`/mp4 for video), verifies it (PNG signature / `ffprobe` for the mp4:
expect ~720×1280, ~10s), copies it to `Image/<slug>.png` or `video/<slug>.mp4`, and
prints the final path. See its `--help`.

**Deleting the Downloads original may require approval** depending on the current sandbox
or browser surface. If deletion fails or is denied, leave the original and keep the copied
project file; tell the user it is also still in Downloads. Use `--no-delete` when you want
to avoid deletion entirely.

### Step 4 — Merge and CapCut export

For a whole reel, follow `references/capcut-reel-export.md` after all Grok clips
exist. The expected outputs are:

In barrotube EP mode, S7 starts only after new Shorts have image-to-video clips 5/5.
It fails by default when any clip is missing and retimes each clip to the matching TTS
duration instead of looping it. `--allow-stills` is an explicit legacy-only exception;
its output must fail publish QA.

- `55_render/video.mp4` — FFmpeg master merge for QA and draft input.
- `55_render/video.mp4` is produced by the HyperFrames caption pass by default (see below).
- CapCut draft under `~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<project>/`.
- `56_capcut_export/video.mp4` — final CapCut export.
- `distribution/{reels,tiktok,youtube}/video.mp4` symlinks to the CapCut export.

### Caption layer — HyperFrames (pilot, opt-in)

Burned-in captions are PNGs baked by a Python/PIL script, because this ffmpeg build has no
libass/drawtext. That leaves exactly one possible effect: the colour changes. Animated
captions — word pop, per-word activation, size change, coloured chips — are impossible there.

HyperFrames renders the caption layer in headless Chrome instead, so anything CSS can do works:

```bash
# 1) render WITHOUT captions, 2) lay that video under a HyperFrames caption composition
node ../barrotube/scripts/automation/render-with-captions.js \
  --episode workspace/episodes/EP-YYYY-NNNN --platform shorts --keep-base
```

Two things matter for anyone extending this:

- **Put the finished render underneath, not the scene clips.** Scene clips alone drop the intro
  card, outro pad, endcard and the ducked BGM — the sample stops resembling what ships.
  `render-direct.js` takes `BT_SUBTITLE_MODE=none` for exactly this; without it the captions
  double up.
- **A `<video>` background beats an alpha overlay.** The first build rendered captions to an
  alpha WebM and composited with ffmpeg; VP9-with-alpha encoding was the slowest step in the
  whole pipeline. HyperFrames accepts `<video>` as a clip, so it is one pass and the source
  audio survives (measured `hasAudio=true`, AAC in the output). Note `--resolution` cannot be
  combined with alpha output, but is fine on this path.

Style, measured colours, the karaoke sweep and the traps: `../barrotube/references/CAPTIONS.md`.

This is the **default** S7 path (`BT_CAPTION_ENGINE=hyperframes`); it writes the usual
`55_render/video.mp4`, so QA, approval and publish are unchanged. `BT_CAPTION_ENGINE=pil` goes
back to the Python PNG subtitles. Motion still comes from **Grok** — this layer only draws text.

### Intro / outro cards — also HyperFrames text

The same rule covers the cards: the browser (or the image API) supplies **only the artwork**;
every Korean glyph is composited locally. That kills the misspelling class outright — the old
procedure literally said "zoom in and proofread the title before saving" because a model once
rendered 메타 as 머타 — and it kills the subtler failure where the vision check passes the
spelling while the picture contradicts the episode (a +2.42% up day drawn as a red crash chart).

```bash
node ../barrotube/scripts/automation/generate-cards.js --episode <dir> --platform shorts
```

Copy rules, confirmed by the operator on 2026-08-14:

| Card | Job | Example |
|---|---|---|
| intro / thumbnail | a **provocative title** — contrast or reversal with a number in it | 「사상 최고치인데 AMD는 왜 **8% 빠졌나**」 |
| outro | a **definition** — one line stating what the episode was | 「이젠 얼마 버나가 아니라 **얼마 쓰나**를 본다」 |

Typography lives in `barrotube/config/cards.json`, not in the scripts — put it in two places and
the intro and the outro drift apart. Bold comes from the outline (`-webkit-text-stroke` +
`paint-order`), because the display fonts ship a single weight and ignore `font-weight`.

## Reel batch mode (render a whole reel)

When the input is a reel, follow **`references/reel-batch.md`**. Quick shape:

```bash
REEL=~/BarroAiFactory/<handle>/barrotube/<reel>
python scripts/reel_render_plan.py "$REEL/script.md"     # -> [{cut, slug, image, motion, caption, exists}]
# if stills are missing, generate them on ChatGPT first.
# then ONE cut at a time (never two downloads back to back):
#   Grok image→video: attach <image>, type <motion>, 9:16/720p/10s, wait 100%, download
#   python scripts/move_media.py --kind video --slug <slug> --dest-root "$REEL"   # -> video/<slug>.mp4
# after all clips: FFmpeg master mix -> CapCut draft -> CapCut export -> distribution package
```
Report final `56_capcut_export/video.mp4`, contact sheet, and stream validation.

## Carousel mode (1:1, 4~5 slides) — `scripts/carousel_job.py`

A carousel is **not a reel with square crops** — it is its own C0~C4 state machine, and its
default source of imagery is **assets you already shipped**, not new generations:

```bash
CAR=~/BarroAiFactory/today.myo/daily/first-week
python3 scripts/carousel_job.py autopilot "$CAR" --episode BT-EP07
#   C0 script.md ('## SLIDE n' blocks)  → C1 slides/slide-N.png (1080x1080)
#   → C2 60_qa_report.carousel.json     → C3 70_publish_meta.instagram.json + caption.md
#   → C4 publish = HITL (this script never posts)
```

Each slide declares its **이미지 소스** and that decides whether a browser is needed at all:

| source | meaning | browser? |
|---|---|---|
| `../../barrotube/ep01_x/Image/ep01-cut1.png` | reuse a QA-passed reel still | ❌ no |
| `video:../../barrotube/ep04_x/video/ep04-cut5.mp4#t=1.4` | pull a frame from a shipped clip (ffmpeg) | ❌ no |
| `generate:<prompt>` | genuinely new art | ✅ ChatGPT |

Recap/album/manual-style carousels (weekly recap, growth album, "how to use my human")
should use the first two: **zero character drift, zero generation cost, and the recap
narrative literally wants the old shots.** `build` renders the 1:1 canvas, cover-crops with a
per-slide `크롭` anchor (`upper` by default — cat faces sit high in 9:16 frames), lays a
gradient caption band, and stamps the episode badge + `n/N` page indicator.

`qa` writes the §6-carousel 5-item report: 1:1 spec / count / order / md5-dupes / caption
forbidden-phrases are **automatic**; the **DNA 3요소** check is *inherited* when a slide's
source reel has `60_qa_report.images.json: ok` and otherwise left as "human must look".
`sync --json` is what a board/bridge reads — it derives C0~C4 purely from files on disk.

## Gotchas learned the hard way (read these — they save a lot of flailing)

- **No still anchor = character drift.** A reel whose clips were made text→video (empty
  `Image/`) will silently change the character. Measured on today.myo ep04: 4 of 6 Grok
  clips came back as a *different cat* (fluffy white long-hair instead of the locked silver
  tabby short-hair). Always image→video, and if `Image/` is empty for a reel that has clips,
  treat those clips as unverified — check frames before reusing them anywhere (e.g. a recap
  carousel).
- **Don't curl ChatGPT image URLs.** `backend-api/estuary/content?...` URLs usually
  require browser cookies and return 403 from terminal. Use the page's download
  button with Playwright `download.saveAs()`.
- **Don't return base64 through tools.** Base64 output is blocked and screenshots are
  not the full-resolution asset.
- **Grok paywall.** On some accounts, clicking generate pops a **SuperGrok** subscription
  modal (especially when a daily/free quota is spent). **Never purchase or start a paid
  trial on the user's behalf.** Close the modal, report it, and offer alternatives
  (try later, switch account, use ChatGPT for the still only). For a new BarroTube Short,
  still-only output leaves S6c blocked until all five Grok clips exist.
- **Grok options can already be correct.** The option bar often defaults to a prior
  selection — zoom in and *verify* 비디오/720p/10s/9:16 rather than blindly clicking.
- **Account drift.** The logged-in account may differ between runs (check the
  bottom-left avatar/email). That's the user's browser state — note it, don't fight it.
- **Video takes time.** Grok shows a percentage; poll with short waits (≤10s each) and
  re-screenshot until 100%. Don't assume it's done.
- **Filenames.** Grok saves as `grok-video-<uuid>.mp4`; ChatGPT as a long localized name.
  Always rename by `slug` on the way into the project folder so scenes stay ordered.
- **Download-too-early duplicate trap.** Grabbing the newest image/video before generation
  finishes silently downloads the **previous** item again (duplicate bytes). Poll to
  completion first; for images verify it's the **last unique src AND portrait** for 9:16;
  md5 a batch afterward and re-grab duplicates.
- **Chrome multi-download block.** Two+ quick downloads trip Chrome's "여러 파일 다운로드"
  block, then **all** downloads from that site are blocked for the session (even the UI
  button). Do **one at a time, ~2s apart.** If blocked, user must allow it in the address
  bar / restart Chrome — page automation can't clear it.
- **ChatGPT image quota.** Free tier stops after ~10 images and shows an upgrade modal
  ("이미지가 0개 남았습니다"). **Don't pay.** Wait for reset, use a Pro/quota account, or continue
  later.
- **Grok file upload may not expose a modal.** If `browser_file_upload` says there is
  no modal state, use `page.locator('input[type="file"]').first().setInputFiles(path)`.
- **claude-in-chrome: attach an image via macOS clipboard, not file paths.** `file_upload`
  rejects host paths and `localhost`/`base64` bridges are blocked. To attach a still or the
  character sheet to ChatGPT or Grok: `osascript -e 'set the clipboard to (read (POSIX file
  "<png>") as «class PNGf»)'` then click the composer + **Cmd+V**. The **first paste right
  after a fresh page load no-ops** — retry the click+Cmd+V in a separate action and confirm
  the thumbnail. Same flakiness applies to the first text `type` after navigation.
- **claude-in-chrome: downloads DO land on disk — Bash just can't `ls` them.** macOS TCC
  blocks the Bash process from readdir/read of `~/Downloads` (so `ls` shows empty, `cp` gives
  "Operation not permitted"), but the browser download itself succeeds. Retrieve it by reading
  the exact path from Chrome's History DB and copying via Finder (which has TCC access):
  `sqlite3 <~/Library/Application Support/Google/Chrome/Default/History copy> "SELECT target_path
  FROM downloads WHERE target_path LIKE '%ChatGPT Image%' (or '%grok-video%') ORDER BY start_time
  DESC LIMIT 1"` → `osascript -e 'tell application "Finder" to set name of (duplicate ((POSIX
  file "<src>") as alias) to ((POSIX file "<destdir>") as alias) with replacing) to "scene_001.png"'`.
  (Grok public **images** are also curl-able at `imagine-public.x.ai/imagine-public/images/<postid>.jpg`;
  Grok **videos** and ChatGPT estuary URLs need this download+Finder path.)
- **CapCut 2 vs CapCut.** Open drafts with CapCut 2. The older CapCut app may show an
  update-required dialog for projects created by newer CapCut.
- **Attach the character sheet, or stop. Never fall back to a text-only description.**
  2026-08-14: all three codex attachment paths failed (extension file access blocked,
  clipboard isolated from the automation context, `setInputFiles` not attempted first),
  the agent silently used the DNA text instead, and every scene came out with a fat body,
  an invented suit and a painterly style. The measured body/head width ratio was 0.85~1.0
  against a published baseline of 0.57~0.68. **Prompt wording cannot fix a missing sheet** —
  five rounds of prompt edits changed nothing until the sheet was actually attached.
  Order: Playwright hidden file input → composer file picker → clipboard → **stop and report**.
- **`setInputFiles` returning is not attachment.** Wait for `Remove image` or the thumbnail.
- **ChatGPT: select the 이미지 만들기 tool every time.** A plain prompt routes to the normal
  answer path — generation hangs or returns something off-spec. The reference used to say
  "click the chip **or** start the prompt with 'Create a…'"; that `or` was the loophole.
- **ChatGPT composer: a newline submits.** Type the whole prompt on one line, or the first
  paragraph gets sent alone and the rest is lost.
- **ChatGPT 무료 한도는 배치 중간에 걸린다.** 2026-08-15 실측: 씬 2장 뒤에 「내일 AM 10:18까지
  기능이 제한됩니다」 + Pro 업그레이드 배너가 뜨고 이미지 도구가 막혔다. **결제하지 마라.**
  스틸 엔진은 이 순서로 내려간다 — ChatGPT 「이미지 만들기」 → **Grok Imagine 「이미지」**
  (`references/grok-image.md`, 시트 첨부 + `@Image1` 참조, 1008×1792 출력) → gpt-image-1 API
  (`/v1/images/edits` 로 같은 시트 첨부, auto-pipeline Phase 7 이 자동 수행) → Gemini.
  Gemini 는 텍스트 DNA 뿐이라 드리프트가 있다 — 최후 수단이다.
- **Grok Imagine 은 첨부만으로 시트를 안 쓴다.** 프롬프트에서 `@` → `Image 1` 로 명시
  참조해야 한다. 그리고 첨부하는 순간 종횡비가 Auto 로 리셋되니 매 컷 9:16 을 다시 잡아라
  (메뉴는 좌표가 한 행씩 밀린다 — ref 로 클릭). 다운로드는 JPEG 이고 CORS 때문에
  programmatic blob 폴백이 0 바이트를 준다.
- **Grok Imagine: press Enter to submit.** Clicking the submit arrow intermittently drops
  the typed prompt (the composer clears, the image stays attached, nothing generates).
  Download lives in the post-details panel, not on the player.
- **Stale `playwright-mcp` processes break tab control.** 10 instances (some 10 days old)
  were holding the same user-data-dir; every browser step timed out with
  "탭 제어가 반복 시간 초과". `pkill -f playwright-mcp` before a long browser run.
- **Grok motion clips have no audio track — that is fine.** `render-direct.js` probes with
  `probeHasAudio()` and mixes TTS only when the clip is silent.
- **Grok clips are 720x1264 / 10.04s — always.** The scene is retimed to the TTS length, so a
  14.8s scene plays its 10.04s clip at **0.68×** (visible slow motion) and the 720-wide frame is
  upscaled to 1080. Measured across EP-0091/0092, all ten clips. The local HyperFrames engine
  renders 1080x1920 at the exact scene length, so neither happens.
- **A file in `videos/` is not proof of motion.** `render-direct.js` turns Ken Burns *off* when a
  clip exists, so a still-frame clip ships a frozen scene — and a count-only check passes it 5/5.
  QA now compares the clip's own first/last frames (`Motion liveness`, BLOCK).

## Output

## Render job termination contract

`render_reel_job.py` ends every command with compact JSON. Exit codes are stable:

- `0` — completed or accepted
- `2` — invalid usage/configuration, missing approval, or missing evidence
- `3` — blocked by prerequisite, stale state, or gate decision
- `4` — recoverable failure (retry is safe)
- `5` — fatal failure (manual intervention required)

`end` never clears unrelated stale cut records; resolve each cut explicitly first.
R11 cannot be skipped and requires a separate `90_timing/postmortem.md` before end.

- `Image/<slug>.png` — the still (ChatGPT).
- `video/<slug>.mp4` — the 9:16 / 720p / ~10s clip (Grok).
- `55_render/video.mp4` — FFmpeg master merge.
- `56_capcut_export/video.mp4` — final CapCut export.
- `distribution/{reels,tiktok,youtube}/` — platform package.
- `90_timing/production-timing.json` and `.md` — production time by stage.

Report both final paths and a one-line note of anything notable (paywall hit, account
used, quota, longest production step). When rendering a whole short, repeat per scene with `<slug>` like
`<title>-s01`, `<title>-s02`, … so downstream FFmpeg merge (barrotube/ShortsGen render
step ④) can pick them up in order.
