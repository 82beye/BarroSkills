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

## Output Convention

```text
<reel>/
  Image/<slug>.png
  video/<slug>.mp4
  55_render/video.mp4
  55_render/master-bgm-mix.m4a
  56_capcut_export/video.mp4
  distribution/reels/
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
