#!/usr/bin/env python3
"""Turn a barrotube/ShortsGen script (YAML or JSON) into an image prompt and a
video prompt for one scene.

barrotube writes the script; this skill renders it. This helper makes the
script->prompt mapping deterministic so every run frames the scene the same way.

Usage:
  python barrotube_to_prompts.py script.yaml                 # hero scene (0)
  python barrotube_to_prompts.py script.yaml --scene 1
  python barrotube_to_prompts.py script.yaml --style "감성 VLOG"

Output: JSON {slug, scene_index, image_prompt, video_prompt} on stdout.

If barrotube's field names differ from the defaults, edit the ALIASES below —
that's the single place to adapt.
"""
import argparse
import json
import os
import re
import sys

# Field-name aliases (barrotube versions vary). First match wins.
ALIASES = {
    "title": ["title", "제목", "name"],
    "style": ["style", "스타일", "tone"],
    "scenes": ["scenes", "scene", "씬", "장면", "shots"],
    "narration": ["narration", "나레이션", "voiceover", "vo", "text", "script"],
    "keywords": ["broll_keywords", "b_roll", "broll", "keywords", "키워드", "visual"],
    "duration": ["duration", "sec", "seconds", "길이"],
}

# style -> look appended to the image prompt
STYLE_LOOK = {
    "감성 VLOG": "지브리 스타일, 손그림 느낌, 따뜻한 햇살, 영화 같은 분위기",
    "정보형": "깨끗한 스튜디오 조명, 선명한 디테일, 정보 전달용 일러스트",
    "리뷰형": "제품 클로즈업, 자연광, 사실적인 질감",
    "다이나믹": "강한 대비, 역동적 구도, 시네마틱 컬러그레이딩",
}
DEFAULT_LOOK = "선명하고 균형 잡힌 구도, 자연광, 고품질"
COMPOSITION_RULE = (
    "vertical 9:16 frame, wide-angle 24mm lens look, full-body or full-object view, "
    "show the surrounding environment clearly, keep the main subject fully inside frame "
    "with headroom and footroom, no tight close-up, no cropped body parts"
)


def pick(d, key):
    for a in ALIASES[key]:
        if isinstance(d, dict) and a in d and d[a] not in (None, "", []):
            return d[a]
    return None


def load_script(path):
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    # Prefer YAML; fall back to JSON. (n8n exports are JSON.)
    try:
        import yaml  # type: ignore
        return yaml.safe_load(raw)
    except ModuleNotFoundError:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            sys.stderr.write(
                "PyYAML not installed and file is not JSON. "
                "Install it with: pip install pyyaml\n")
            raise SystemExit(3)


def slugify(title, idx):
    base = (title or "scene").strip()
    # keep unicode letters/digits, turn separators into hyphens
    base = re.sub(r"[\s_/]+", "-", base)
    base = re.sub(r"[^\w\-]", "", base, flags=re.UNICODE)
    base = base.strip("-") or "scene"
    return f"{base}-s{idx + 1:02d}"


def as_keyword_str(kw):
    if isinstance(kw, list):
        return ", ".join(str(k) for k in kw)
    return str(kw or "")


def build_prompts(script, scene_index, style_override):
    title = pick(script, "title") or "Untitled"
    style = style_override or pick(script, "style") or ""
    look = STYLE_LOOK.get(style.strip(), DEFAULT_LOOK)

    scenes = pick(script, "scenes")
    if isinstance(scenes, dict):
        scenes = [scenes]
    if not scenes:
        # treat the whole doc as a single scene (e.g. a bare prompt object)
        scenes = [script]
    if scene_index < 0 or scene_index >= len(scenes):
        raise SystemExit(f"scene {scene_index} out of range (have {len(scenes)})")

    scene = scenes[scene_index]
    narration = pick(scene, "narration") or ""
    keywords = as_keyword_str(pick(scene, "keywords"))

    subject = ", ".join(p for p in [narration.strip(), keywords.strip()] if p)
    if not subject:
        subject = title

    image_prompt = f"{subject}. {COMPOSITION_RULE}. {look}"
    video_prompt = (
        f"{subject}. 피사체가 자연스럽게 움직이고(바람, 물결, 걸음/달림 등), "
        f"옆에서 함께 따라가는 트래킹 카메라. {look}. 부드럽고 영화 같은 10초 모션"
    )

    return {
        "slug": slugify(title, scene_index),
        "scene_index": scene_index,
        "style": style or None,
        "image_prompt": image_prompt,
        "video_prompt": video_prompt,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("script", help="Path to barrotube YAML or JSON script")
    ap.add_argument("--scene", type=int, default=0, help="Scene index (default 0 = hero)")
    ap.add_argument("--style", default=None, help="Override style (감성 VLOG / 정보형 / 리뷰형 / 다이나믹)")
    args = ap.parse_args()

    if not os.path.isfile(args.script):
        raise SystemExit(f"file not found: {args.script}")

    script = load_script(args.script)
    if not isinstance(script, (dict, list)):
        raise SystemExit("could not parse script into an object")
    if isinstance(script, list):
        script = {"scenes": script}

    result = build_prompts(script, args.scene, args.style)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
