# Reel batch mode — ChatGPT stills → Grok clips → CapCut export

Use this when the input is **a whole reel** and the user wants the actual reel
finished. The full path is:

`script.md -> ChatGPT images -> Grok image-to-video clips -> FFmpeg master mix -> CapCut draft -> CapCut export`.

The reel folder shape:

```
~/BarroAiFactory/<handle>/barrotube/<reel>/
├── script.md            # CUT 1..N with **이미지 파일:** and **Grok 모션:** lines
├── Image/<slug>.png     # ChatGPT stills, one portrait image per cut
├── video/<slug>.mp4     # Grok clips, one per cut
├── 55_render/video.mp4  # FFmpeg master merge
├── 56_capcut_export/video.mp4
├── 90_timing/production-timing.json
├── 90_timing/production-timing.md
└── distribution/{reels,tiktok,youtube}/
```

## 0. Start timing

Initialize the timing record before the first production action:

```bash
python3 scripts/production_timer.py init <reel> --episode <EP-ID>
python3 scripts/production_timer.py start <reel> scene_plan --label "Scene plan"
```

For browser-controlled stages, manually bracket the stage:

```bash
python3 scripts/production_timer.py start <reel> chatgpt_image_cut1 --label "ChatGPT image cut 1"
# generate, download, validate Image/<slug>.png
python3 scripts/production_timer.py end <reel> chatgpt_image_cut1

python3 scripts/production_timer.py start <reel> grok_video_cut1 --label "Grok video cut 1"
# attach image, render, download, ffprobe video/<slug>.mp4
python3 scripts/production_timer.py end <reel> grok_video_cut1
```

For command-line stages, prefer `run`:

```bash
python3 scripts/production_timer.py run <reel> final_4k_export --label "Final 4K export" -- ffmpeg ...
```

Refresh or inspect the summary at any time:

```bash
python3 scripts/production_timer.py summary <reel> --markdown
```

## 1. Build or parse the plan

```bash
python scripts/reel_render_plan.py <reel>/script.md
```
Prints JSON `[{cut, slug, image, motion, caption, exists}]` sorted by cut.

If `exists:false`, generate the still with `references/chatgpt-image.md` first.
If the script only has scene descriptions, write explicit image prompts and save
them in `<reel>/prompts.md` before generating.

## 2. ChatGPT image loop — ONE cut at a time

For each cut:
1. Send a prompt beginning with `Create a single vertical 9:16 cinematic image.
   No text, no subtitles, no watermark.` Then add:
   `Use a wide-angle 24mm lens look inside the vertical 9:16 frame. Show the full
   body or full key object, include the surrounding environment, leave headroom and
   footroom, no tight close-up, no cropped limbs or props.`
2. Wait until a new portrait image appears.
3. Download through **이 이미지 공유 → 다운로드**.
4. Save with Playwright `download.saveAs("<reel>/Image/<slug>.png")`.
5. Validate with `file`; expected shape is portrait PNG, often `941 x 1672`.

After all images, make a quick contact sheet and visually check scene order.
End the `chatgpt_images` aggregate step after the sheet is checked, and keep
per-cut `chatgpt_image_cutN` steps when exact cut-level timing matters.

## 3. Grok render loop — ONE cut at a time

For each plan item, in order:
1. **Grok image→video.** Follow `references/grok-video.md`: verify 비디오/720p/10s/9:16,
   attach `image` using `input[type=file].setInputFiles(...)` if needed, type `motion`,
   send, poll **생성 중 NN%** to 100%, click **다운로드**.
2. **Save it:** with Playwright `download.saveAs("<reel>/video/<slug>.mp4")`, or use
   `scripts/move_media.py --kind video --slug <slug> --dest-root <reel>`.
3. Validate with `ffprobe`. Grok may output `720x1264` or similar portrait h264,
   often 10s; if one cut returns 6s, keep it only if it still covers the intended
   segment.
4. Only then move to the next cut. **Never fire two renders/downloads back to back**
   (see download-block guard below).
End each `grok_video_cutN` only after `ffprobe` confirms the saved clip. If a cut
must be regenerated, use a new step id such as `grok_video_cut4_retry1`.

## 4. Merge, CapCut, distribution

Follow `references/capcut-reel-export.md`.

Minimum expected verification:

```bash
ffprobe -v error -show_entries format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels -of json <reel>/56_capcut_export/video.mp4
ffmpeg -v info -i <reel>/56_capcut_export/video.mp4 -vf blackdetect=d=0.5:pix_th=0.10 -an -f null - 2>&1 | rg 'black_start|Duration|Video:' || true
ffmpeg -v info -i <reel>/56_capcut_export/video.mp4 -af volumedetect -vn -f null - 2>&1 | rg 'mean_volume|max_volume'
```

Final report should identify `56_capcut_export/video.mp4` as the publishable file.
Also report the timing file and longest step from `90_timing/production-timing.md`.

## Guards learned the hard way (this session) — DO NOT skip

These cost real time when ignored:

- **File-attach to Grok may be hidden.** If `browser_file_upload` says there is no
  related modal state, use Playwright `page.locator('input[type="file"]').first().setInputFiles(path)`.

- **Download-too-early duplicate trap.** If you grab the newest `<img>`/video before
  generation finishes, you silently download the **previous** cut again (two files, same
  bytes). Before downloading: **poll to completion** (label gone / 100%), and verify the
  target is the *new* one — for images check it's the **last unique src AND portrait**
  (`naturalHeight > naturalWidth` for 9:16); for video wait for the action panel. After a
  batch, md5 the outputs and re-grab any duplicates.

- **Signed ChatGPT URLs 403 outside the browser.** Do not `curl` the generated image
  URL from terminal. Use the UI download and `download.saveAs()`.
- **Multiple download guard.** Do one download at a time and wait until the file is
  saved before starting the next generation.

- **ChatGPT image quota (free tier).** After ~10 images, generation stops and an
  **upgrade modal** (Free/Go/Plus/Pro) appears instead of an image; the composer shows
  "이미지가 0개 남았습니다 … 초기화". **Never upgrade/pay.** Close the modal and report: wait for
  the daily reset, switch to an account with quota/Pro, or continue later. (A Pro account
  removes this.)

- **Grok SuperGrok paywall / quota** — same rule, see `references/grok-video.md`. Close,
  report, don't pay.

- **Account drift.** ChatGPT and Grok may be logged into *different* accounts (check the
  bottom-left avatar/email on each). Note it; don't fight the user's browser state.

- **CapCut export setting drift.** In the export dialog, ensure **동영상** is enabled
  and avoid audio-only MP3 export. Use CapCut 2 when available.

## Slug & ordering
Keep slugs as `<reel>-cutN` (or `<title>-sNN`) so `video/` sorts in cut order for the
merge step. The plan's `cut` integer is the source of truth for order.
