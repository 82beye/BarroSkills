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

## Image Prompt Rule (shot-role aware)

The old blanket "wide 24mm, no tight close-up" rule made every cut look the same
(see today.myo EP01: three identical palm close-ups → loose). Branch by the cut's
**shot role** instead — a reel needs a scale spread, not one scale repeated.

Every scene always requests: `single vertical 9:16 cinematic image. No text, no
subtitles, no watermark.` Then, by shot type:

```text
# EW / W  (establishing/wide — at least 1 per reel)
Use a wide-angle 24mm lens look inside the vertical 9:16 frame.
Show the full body or full key object, include the surrounding environment,
leave headroom and footroom, no cropped limbs or props.

# M / CU  (medium / close-up)
Frame the subject from the waist up (M) or head-and-shoulders (CU);
keep one clear focal point, natural depth, environment softly present.

# ECU / detail insert  (at least 2 per reel — the spice)
Macro / extreme close-up of ONE detail (eye reflection, paw pad, gripping
toes, twitching nose, trembling whiskers). Shallow depth of field, tight crop
intentional. This is where cropped framing is CORRECT, not a defect.
```

Rule: **no two adjacent cuts share the same shot size + angle** (jump ≥2 sizes or
change the angle), and every reel carries ≥1 EW/W plus ≥2 ECU inserts. Vary the
Grok camera move per cut too (push-in / pull-back / tilt / whip-pan / pan /
tracking / rack-focus / top-down). Full system: today.myo 설계문서 §4 / §6.

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
