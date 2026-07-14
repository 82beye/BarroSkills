# CapCut reel export — FFmpeg master → CapCut draft → final MP4

Use this after all `video/<slug>.mp4` Grok clips exist.

## 1. Build the FFmpeg master

Create `55_render/video.mp4` from the Grok clips with:

- normalized vertical canvas, usually 1080x1920 / 30fps
- trimmed scene durations to the reel timeline
- short xfade/beat transitions
- one continuous master BGM/SFX track
- each Grok clip's OWN audio kept as a lowered-volume ambient layer under the
  BGM (2026-07-04 — `render_master_mix.py` default, volume 0.25, per-scene
  timeline offset + fade-out; drop with `--no-clip-audio`)

Keep music as one master audio bed. Do not merge separately generated per-scene BGM
tracks; they sound disconnected. The clip-ambient layer is NOT a per-scene BGM —
it is the scene's diegetic sound (wind, crowd, machines) laid quietly under the bed.

Timing:

```bash
python3 scripts/production_timer.py start <reel> ffmpeg_master --label "FFmpeg master mix"
# run the render script or ffmpeg command
python3 scripts/production_timer.py end <reel> ffmpeg_master
```

If running a direct command, use `production_timer.py run` instead of separate
start/end calls.

Expected outputs:

```
55_render/video.mp4
55_render/master-bgm-mix.m4a
55_render/master-bgm-mix.manifest.json
```

## 2. Create the CapCut draft

For BarroTube reels, the reliable draft shape is a single final `video.mp4` on the
timeline plus optional cut clips copied into project resources for manual editing.

Timing step id: `capcut_draft`.

Project path:

```
~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<PROJECT_NAME>/
```

Use an existing compatible draft as a template if the repo has no dedicated reel
draft builder:

1. Copy a known-good reel project folder, such as `BT-EP01-JOSEON-DJ-NIGHT`.
2. Replace `Resources/assets/videos/video.mp4` with the new `55_render/video.mp4`.
3. Copy `video/<slug>.mp4` files into `Resources/assets/videos/` for manual edit access.
4. Update `draft_info.json`:
   - `name`, `id`, `path`
   - `duration` to final microseconds
   - `materials.videos[0].path`, `duration`, `width`, `height`
   - first video track segment `target_timerange` and `source_timerange`
5. Update `draft_meta_info.json`:
   - `draft_name`, `draft_id`, `draft_fold_path`, `tm_duration`, modified timestamps

Validate:

```bash
jq '{name, id, duration, path, video_path: .materials.videos[0].path, tracks: (.tracks|length)}' "<draft>/draft_info.json"
ffprobe -v error -show_entries format=duration:stream=width,height,codec_name -of json "<draft>/Resources/assets/videos/video.mp4"
```

## 3. Export from CapCut

Prefer **CapCut 2**. If `/Applications/CapCut.app` shows an update-required dialog,
cancel and use `/Applications/CapCut 2.app`.

Timing step id: `capcut_export`. Start before opening/exporting in CapCut and end
after the exported file has been moved to `56_capcut_export/video.mp4`.

Computer Use sequence:

1. Open CapCut 2 and double-click the project row.
2. Confirm the timeline has the final 26s video.
3. Click top-right **내보내기**.
4. In the export dialog:
   - enable **동영상**
   - avoid audio-only/MP3 export
   - H.264 / mp4 / 30fps is OK
   - 4K export is acceptable for Reels; downscale later only if needed
5. Click **내보내기**.
6. When export completes, move the Desktop output to:

```
56_capcut_export/video.mp4
```

Do not click TikTok/YouTube publish buttons in the CapCut post-export share screen
unless the user explicitly asks for that.

## 4. Final package and QA

Regenerate platform distribution with the CapCut export as source:

Timing step ids: `distribution_package` and `final_qa`.

```bash
node ~/youtube-co/scripts/automation/build-distribution.js \
  --episode <reel> \
  --video <reel>/56_capcut_export/video.mp4 \
  --meta <reel>/70_publish_meta.instagram.json \
  --ticket <episode_id>
```

Verify:

```bash
ffprobe -v error -show_entries format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels -of json <reel>/56_capcut_export/video.mp4
ffmpeg -v info -i <reel>/56_capcut_export/video.mp4 -vf blackdetect=d=0.5:pix_th=0.10 -an -f null - 2>&1 | rg 'black_start|Duration|Video:' || true
ffmpeg -v info -i <reel>/56_capcut_export/video.mp4 -af volumedetect -vn -f null - 2>&1 | rg 'mean_volume|max_volume'
```

Make a six-frame contact sheet for visual QA:

```bash
ffmpeg -y -i <reel>/56_capcut_export/video.mp4 \
  -vf "select='eq(n,30)+eq(n,150)+eq(n,270)+eq(n,420)+eq(n,570)+eq(n,735)',scale=270:480,tile=6x1" \
  -frames:v 1 -update 1 <reel>/56_capcut_export/contact_sheet_6cuts.jpg
```

Final report must include:

- `<reel>/56_capcut_export/video.mp4`
- `<reel>/56_capcut_export/contact_sheet_6cuts.jpg`
- `<reel>/90_timing/production-timing.md`
- longest production step and total wall-clock time
