---
created: 2026-06-30
tags:
  - operations
  - render-pipeline
  - capcut
---

# BarroTube Reels 제작 파이프라인

## Current Pipeline

```text
scene plan
-> ChatGPT image generation
-> Grok image-to-video
-> FFmpeg master BGM/SFX mix
-> CapCut 2 draft
-> CapCut export
-> distribution package
-> Instagram Reels publish
```

Automation gap analysis and implementation plan:

- [[barrotube-media-render-automation-plan|BarroTube Media Render 자동 운영 갭 분석 및 구현 계획]]

## Timing Convention

Start timing before the first production action and keep it updated through final QA:

```bash
python3 /Users/beye/workspace/BarroSkills/.claude/skills/barrotube-media-render/scripts/production_timer.py init <reel> --episode <EP-ID>
python3 /Users/beye/workspace/BarroSkills/.claude/skills/barrotube-media-render/scripts/production_timer.py start <reel> scene_plan --label "Scene plan"
python3 /Users/beye/workspace/BarroSkills/.claude/skills/barrotube-media-render/scripts/production_timer.py end <reel> scene_plan
```

Use one step per slow production stage:

- `scene_plan`
- `chatgpt_image_cutN`
- `image_contact_sheet`
- `grok_video_cutN`
- `ffmpeg_master`
- `capcut_draft`
- `capcut_export`
- `distribution_package`
- `final_qa`
- `instagram_publish`

Timing outputs:

```text
<reel>/90_timing/production-timing.json
<reel>/90_timing/production-timing.md
```

Final reports should include total wall-clock time and the longest step.

## Output Convention

```text
<reel>/
  Image/<slug>.png
  video/<slug>.mp4
  55_render/video.mp4
  55_render/master-bgm-mix.m4a
  56_capcut_export/video.mp4
  distribution/reels/
  90_timing/production-timing.json
  90_timing/production-timing.md
  70_publish_meta.instagram.json
  80_publish_result.instagram.json
```

## Image Prompt Rule

Every scene should request:

```text
Create a single vertical 9:16 cinematic image. No text, no subtitles, no watermark.
Use a wide-angle 24mm lens look inside the vertical 9:16 frame.
Show the full body or full key object, include the surrounding environment,
leave headroom and footroom, no tight close-up, no cropped limbs or props.
```

## BGM Rule

Use one continuous master music bed. Do not generate or merge separate BGM tracks per scene unless the concept explicitly needs it.

## CapCut Rule

- Use `/Applications/CapCut 2.app`.
- Final export path: `56_capcut_export/video.mp4`.
- Verify stream, black frames, audio volume, and contact sheet before publishing.

## Instagram Publishing Rule

- Preferred: API publishing via `publish-instagram-reels.js`.
- If local resumable upload fails with `video_url is required`, expose the export through a temporary HTTPS URL and publish with `--video-url`.
- Shut down temporary file server and tunnel after publish is complete.
