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
   - 모션 클립(선택) → `40_assets/videos/scene_NNN.mp4`
   - **씬 길이는 Grok 클립(≈10초)에 맞춰 설계.** 예전엔 클립이 TTS보다 짧으면 `-stream_loop`
     로 **반복 재생**해 같은 장면이 되풀이됐다. 이제 render-direct가 `setpts`로 **재생속도를
     조절**해 클립 한 번 재생으로 씬 길이를 채운다(반복 없음; `BT_CLIP_FIT_MODE=loop`로 옛
     동작 복구). 단 씬 나레이션이 너무 길면 과한 슬로모가 되므로, **한 씬 나레이션은 ~10초
     클립 하나 분량(대략 60~90자)** 으로 유지하고, 내용이 많으면 **씬을 쪼개 최대 7씬까지**
     분리한다(쇼츠 기본 5씬, 밀도 높으면 6~7씬). 이렇게 하면 리타임 배율이 0.8~1.2x 근처로
     유지돼 모션이 자연스럽다.
   - **인트로 카드 → `45_intro.png`** — 타이틀 대형 골드 타이포 + 채널 배지 +
     다크 배경, 9:16. **저장 전 타이틀 철자를 확대(zoom) 검수** — AI 한글 렌더
     오타가 실제로 발생한다(실사례: "메타"→"머타"). 오타면 재생성.
   - Downloads 경유 시: `move_media.py --dest-dir <dir> --slug scene_001|45_intro`
   - 씬 프롬프트 소스는 `30_script.md`의 `image_prompt`. 나머지(엔진 선택·skip
     로직)는 barrotube 쪽 `config/image-engines.json`이 관장한다.
   - **Grok 스틸 첨부(CLI/claude-in-chrome)**: `file_upload`가 호스트 경로를 거부하고
     localhost fetch는 CSP에 막힌다 — **macOS 클립보드로 우회**:
     `osascript -e 'set the clipboard to (read (POSIX file "<png>") as «class PNGf»)'`
     후 프롬프트창 클릭 + `Cmd+V`. 원본 무손실 첨부 확인됨.

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
  loop over all scenes if the user asks for the whole short).
- `aspect / resolution / duration` — default **9:16 / 720p / 10s** (Grok short).

## Prerequisites (check first, don't assume)

- A **browser-automation tool with a logged-in session**. Prefer **Playwright MCP**
  when it is available and already logged into ChatGPT/Grok; it supports direct
  `download.saveAs()` and hidden file input upload. Use `chrome:control-chrome`
  only when Playwright lacks the needed login/session or file upload state.
  This skill cannot run as a purely background task because generation requires
  visible state checks.
- The user is **signed in** to both https://chatgpt.com and https://grok.com/imagine.
- **Folder access** to: the project's `Image/` and `video/` output folders, and the
  browser's **Downloads** folder (that's where the sites' Download buttons save).
  Default project layout (per-channel convention):
  `~/BarroAiFactory/<handle>/barrotube/Image` and `.../barrotube/video`, and for a reel,
  `~/BarroAiFactory/<handle>/barrotube/<reel>/Image` + `.../<reel>/video`. If a folder
  isn't mounted, request it.
- **Environment matters for file attach.** Attaching a still to Grok (image→video) needs
  browser control that can select or upload local files. In Codex, prefer Chrome with the
  user's logged-in profile; if file upload is blocked by the current browser surface, ask
  the user to drag the still into Grok or fall back to text→video (see
  `references/reel-batch.md`).
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
  Always frame for vertical reels with a **wide-angle 24mm look**: full-body or
  full-object view, enough headroom/footroom, clear surrounding environment, no tight
  close-up, and no cropped limbs or key props. This keeps the scene readable inside
  a 9:16 frame.
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

**Attach the character reference (REQUIRED when the channel has a sheet).** Before
typing the prompt, attach the channel's official character sheet so the mascot
matches exactly — 바로경제 = `~/BarroTubeData/workspace/docs/바로경제_캐릭터시트.png`
(constants: `~/BarroTubeData/CLAUDE.md`, channel `character-dna.md`, `role.md`).
Attach via macOS clipboard, then paste into the composer:
`osascript -e 'set the clipboard to (read (POSIX file "<sheet.png>") as «class PNGf»)'`
→ click composer → Cmd+V (retry once if the first paste no-ops). Then start the
prompt with `Use the attached character sheet as the exact reference for the mascot`
and describe only scene/pose/expression/props. Full steps + fallback:
`references/chatgpt-image.md` Step 0.

**Consistency rules that actually held up (EP-2026-0065/0066, 마시):**
- **Re-anchor once per episode, then let context carry it.** Attach the sheet for
  **scene 1** in a fresh/continuing ChatGPT conversation; scenes 2–N in that **same
  chat** stay on-model from conversation context without re-attaching. Re-attach only
  if the mascot visibly drifts.
- **Background is SEPARATE from the character.** The sheet defines the character *only*.
  Put the scene's look in an explicit `BACKGROUND (…, SEPARATE from the character): …`
  block (channel navy-cinematic palette — see the channel `scene-backgrounds.md` /
  `CLAUDE.md`), so a plain-white "clean light background" doesn't leak in. This was an
  explicit operator correction: "배경은 캐릭터 시트와 별개로 진행되어야 해".
- **⚠️ Retrieval trap — the attached sheet pollutes "grab the last portrait image".**
  ChatGPT **generated** images come back at the model's portrait size (observed
  **941×1672**), but the **attached character sheet** sits in the DOM at its *own*
  size (observed **1024×1535**), and a long conversation also holds cached/older
  portrait `<img>` layers. A JS "download the last portrait `<img>`" heuristic then
  silently saves the **sheet** (or a previous scene) instead of the new render.
  → **Use the detail-view download, which is unambiguous:** click the new image to open
  its detail/editor view (title like "…의 순간"), click the **top-right ⬇**, then retrieve
  the newest `ChatGPT Image *.png` via History+Finder (Downloads gotcha below). Always
  **eyeball the saved file** — if it's the turnaround sheet or the wrong scene, re-grab.
  (The JS `<a download>` blob-fetch trick works for ChatGPT stills *if* you filter to the
  generated size and confirm it's the newest, but it is fragile in long chats — prefer
  detail-view download.)
- **Intro/outro cards: navy background from ChatGPT, Korean title composited, not typed.**
  ChatGPT garbles Korean text, so generate the card as a **text-free** navy 마스코트
  background (mascot lower-center, top ~55% left empty) and burn the Korean title +
  channel badge (+ 구독/좋아요 CTA on the endcard) with PIL (`AppleSDGothicNeo` Bold,
  index 6). Brand intro/outro backgrounds can be **reused across episodes** — only the
  title text changes. `48_outro.png` doubles as `48_endcard.png` so render-direct
  appends it with BGM continuing.

Timing rule: start `chatgpt_image_cutN` before sending the prompt and end it only
after the file has been saved and validated.

### Step 2 — Generate the video on Grok Imagine

Follow `references/grok-video.md`. In short: open grok.com/imagine, set the option
bar to **비디오 / 720p / 10s / 9:16** and verify it. Then:

- **Image→video (preferred for visual continuity):** attach the ChatGPT image you just
  saved (the "+" in the prompt bar) and give a short **motion** prompt, or
- **Text→video (fallback):** just type `video_prompt`.

Send, watch the **"생성 중 NN%"** progress to 100%, then click **다운로드** and save to
`video/<slug>.mp4`.

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

- `55_render/video.mp4` — FFmpeg master merge for QA and draft input.
- CapCut draft under `~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<project>/`.
- `56_capcut_export/video.mp4` — final CapCut export.
- `distribution/{reels,tiktok,youtube}/video.mp4` symlinks to the CapCut export.

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
  (try later, switch account, use ChatGPT for the still only).
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
  **⚠️ Copy the WAL too, or a just-finished download is invisible.** A freshly completed
  download's `downloads` row often lives only in Chrome's **History-wal**, not yet in the
  `History` file — so `cp History <tmp>.db` alone returns the *previous* download. Copy all
  three next to each other before querying: `cp History <tmp>.db; cp History-wal <tmp>.db-wal;
  cp History-shm <tmp>.db-shm`. Bit me on every Grok video (the button downloads fine but the
  row hadn't flushed). Also: **the JS `<a download>` blob-fetch does NOT work for Grok videos**
  — they play via MediaSource (MSE), so `fetch(video.currentSrc)` returns **0 bytes**. Grok
  videos must use the on-page **다운로드** button + this History(+WAL)+Finder retrieval.
- **CapCut 2 vs CapCut.** Open drafts with CapCut 2. The older CapCut app may show an
  update-required dialog for projects created by newer CapCut.

## Output

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
