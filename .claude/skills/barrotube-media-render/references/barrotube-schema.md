# barrotube / ShortsGen script schema → prompt mapping

This skill consumes the script that **barrotube produces**. In the BarroTube/ShortsGen
pipeline the script step (LLM → YAML) emits this shape (see project COWORK_SETUP.md ②):

```yaml
title: "여름 바다 감성 쇼츠"
hook: "여름이 끝나기 전에 꼭 봐야 할 장면"
style: "감성 VLOG"          # 감성 VLOG | 정보형 | 리뷰형 | 다이나믹 (optional)
scenes:
  - narration: "둘은 바다 위를 달렸다"
    duration: 10              # seconds (shorts: 15~30 total, ~6-10s per clip)
    broll_keywords: ["바다", "노을", "달리는 아이들", "물보라"]
  - narration: "..."
    duration: 8
    broll_keywords: ["..."]
captions: ["...", "..."]      # optional burn-in caption lines
```

Field names can vary a little between barrotube versions (e.g. `b_roll`, `keywords`,
`scene`/`scenes`). The helper `scripts/barrotube_to_prompts.py` is tolerant of common
aliases; if barrotube's real output differs, adjust the alias lists at the top of that
script — that's the one place to edit.

## How fields become prompts

For the chosen scene, build two prompts:

**image_prompt** = subject/setting from `narration` + `broll_keywords`, plus a concrete
look driven by `style`:

Always include this composition rule before the style look:

`vertical 9:16 frame, wide-angle 24mm lens look, full-body or full-object view, show
the surrounding environment clearly, keep the main subject fully inside frame with
headroom and footroom, no tight close-up, no cropped body parts or key props`

This prevents the vertical crop from losing the location, props, or full character.

| style      | look appended to the image prompt                                  |
|------------|--------------------------------------------------------------------|
| 감성 VLOG  | 지브리 스타일, 손그림 느낌, 따뜻한 햇살, 영화 같은 분위기            |
| 정보형     | 깨끗한 스튜디오 조명, 선명한 디테일, 정보 전달용 일러스트           |
| 리뷰형     | 제품 클로즈업, 자연광, 사실적인 질감                                |
| 다이나믹   | 강한 대비, 역동적 구도, 시네마틱 컬러그레이딩                       |

**video_prompt** = the same scene rewritten around **motion + camera**: what moves
(wind, water, hair, walking/running), plus a camera move (tracking shot, slow push-in).
Video models need movement cues or they produce a near-still clip. Keep it ~1–2 sentences.

## Slug / filenames

Derive a `slug` from `title` + scene index so scenes stay ordered and downstream FFmpeg
merge can find them: e.g. `여름바다감성쇼츠-s01`. ASCII-fold and lowercase if you want
filesystem-safe names. `barrotube_to_prompts.py` returns a ready `slug`.

## Whole-short vs hero-scene

- Default: render the **hero scene** (first scene) — one image + one clip.
- If the user wants the **whole short**, loop over `scenes[]`, render each with
  `-sNN` slugs, and let the barrotube/ShortsGen render step ④ (FFmpeg) stitch the
  clips + narration + captions into the final 9:16 mp4.
