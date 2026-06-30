---
date: 2026-06-30
tags:
  - decision
  - reels
  - pipeline
---

# Reels Production Pipeline

## Context

The working EP02 pipeline proved that ChatGPT stills, Grok image-to-video, FFmpeg master mix, and CapCut 2 export can produce a publishable Reel.

## Decision

Standardize the BarroTube Reels pipeline as:

```text
ChatGPT stills -> Grok clips -> FFmpeg master mix -> CapCut 2 export -> Instagram Reels API publish
```

## Consequences

- `56_capcut_export/video.mp4` is the publishable source.
- BGM/SFX should be mixed as one continuous master bed.
- API posting should save `80_publish_result.instagram.json`.
