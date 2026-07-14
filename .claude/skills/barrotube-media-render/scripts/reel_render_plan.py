#!/usr/bin/env python3
"""Parse a BarroTube reel script.md into a per-cut render plan for batch image->video.

Looks for '### CUT N ...' blocks and extracts, per cut:
  - the still image path   (line: **이미지 파일:** `Image/ep01-cut1.png`)
  - the Grok motion prompt (line: **Grok 모션:** <motion + camera> 9:16.)
  - the on-screen caption  (line: **자막...:** `...`)  [optional]
  - shot composition fields (all optional — the shot-composition system):
      **샷:** / **shot_type:**   shot size + angle (e.g. "ECU / detail insert")
      **프레이밍:** / **framing:** framing prose fed into the image prompt
      **길이:** / **duration:**   per-cut seconds (float) — render trims the source clip to this
      **역할:** / **role:**       hero | insert
      **이미지 지시:**            the detailed still-generation instruction prose
    When **길이** is absent, duration is inferred from the heading
    (e.g. '... · 2.2s' or '(0.0 ~ 3.3s)').

Output: JSON list [{cut, slug, image, motion, caption, shot_type, framing,
duration, role, image_instruction, exists}], sorted by cut.
The reel-batch loop (see references/reel-batch.md) consumes this directly, and
render_master_mix.py reads `duration` to time each cut without --durations.

Usage:
  python reel_render_plan.py <reel>/script.md [--image-root DIR]
"""
import sys, re, json, os, argparse


def _field(block, *labels):
    """Value of a '**label:** value' line for any of the given labels, else ''.

    Tolerant of today.myo's real formats: colon inside the bold (**샷:**),
    a parenthetical qualifier before the colon (**이미지 지시(...):**), and
    list markers. Matches a line that *starts* with the label."""
    pat = "|".join(labels)
    m = re.search(r"(?mi)^[\s\-*>]*\**\s*(?:%s)[^:：\n]*[:：]\**\s*(.+)$" % pat, block)
    return m.group(1).strip().rstrip("*").strip() if m else ""


def _to_float(s):
    m = re.search(r"[\d]+(?:\.[\d]+)?", s or "")
    return float(m.group(0)) if m else None


def _duration_from_heading(heading):
    """Infer seconds from a cut heading: '· 2.2s' or '(0.0 ~ 3.3s)' (end-start)."""
    rng = re.search(r"\(?\s*([\d.]+)\s*[~\-–]\s*([\d.]+)\s*s", heading)
    if rng:
        return round(float(rng.group(2)) - float(rng.group(1)), 3)
    one = re.search(r"·\s*([\d.]+)\s*s", heading) or re.search(r"([\d.]+)\s*s\b", heading)
    return float(one.group(1)) if one else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("script", help="path to the reel script.md")
    ap.add_argument("--image-root", default=None,
                    help="resolve relative image paths against this dir (default: the script's own folder)")
    a = ap.parse_args()

    text = open(a.script, encoding="utf-8").read()
    root = a.image_root or os.path.dirname(os.path.abspath(a.script))

    # Split on headings like '### CUT 1', '## CUT 2', etc.
    blocks = re.split(r"(?mi)^#{2,4}\s*CUT\s*", text)[1:]
    plan = []
    for b in blocks:
        num_m = re.match(r"(\d+)", b)
        cut = int(num_m.group(1)) if num_m else len(plan) + 1
        img_m = (re.search(r"이미지\s*파일[^`]*`([^`]+)`", b)
                 or re.search(r"`([^`]+\.(?:png|jpe?g))`", b, re.I))
        if not img_m:
            continue  # not a renderable cut block
        mot_m = re.search(r"(?:Grok\s*모션|motion)\s*[:：]\s*(.+)", b)
        cap_m = re.search(r"자막[^:：\n]*[:：]\s*(.+)", b)

        def clean(s):
            # strip leading markdown bold/colon artifacts left by '**label:** value'
            return re.sub(r"^[*\s:：]+", "", s).strip().rstrip("*").strip()

        img = img_m.group(1).strip()
        if not os.path.isabs(img):
            img = os.path.normpath(os.path.join(root, img))
        slug = os.path.splitext(os.path.basename(img))[0]
        motion = clean(mot_m.group(1)) if mot_m else ""
        caption = clean(cap_m.group(1)) if cap_m else ""

        # shot-composition fields (all optional)
        heading = b.split("\n", 1)[0]
        shot_type = _field(b, "샷", "shot_type", "shot")
        framing = _field(b, "프레이밍", "framing")
        image_instruction = _field(b, r"이미지\s*지시", "image_instruction")
        role_raw = _field(b, "역할", "role").lower()
        role = ("insert" if "insert" in role_raw
                else "hero" if "hero" in role_raw
                else role_raw or None)
        duration = _to_float(_field(b, "길이", "duration")) or _duration_from_heading(heading)

        plan.append({"cut": cut, "slug": slug, "image": img,
                     "motion": motion, "caption": caption,
                     "shot_type": shot_type, "framing": framing,
                     "duration": duration, "role": role,
                     "image_instruction": image_instruction,
                     "exists": os.path.exists(img)})

    plan.sort(key=lambda x: x["cut"])
    print(json.dumps(plan, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
