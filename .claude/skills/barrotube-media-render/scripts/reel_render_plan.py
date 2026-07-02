#!/usr/bin/env python3
"""Parse a BarroTube reel script.md into a per-cut render plan for batch image->video.

Looks for '### CUT N ...' blocks and extracts, per cut:
  - the still image path   (line: **이미지 파일:** `Image/ep01-cut1.png`)
  - the Grok motion prompt (line: **Grok 모션:** <motion + camera> 9:16.)
  - the on-screen caption  (line: **자막...:** `...`)  [optional]

Output: JSON list [{cut, slug, image, motion, caption}], sorted by cut.
The reel-batch loop (see references/reel-batch.md) consumes this directly.

Usage:
  python reel_render_plan.py <reel>/script.md [--image-root DIR]
"""
import sys, re, json, os, argparse


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

        plan.append({"cut": cut, "slug": slug, "image": img,
                     "motion": motion, "caption": caption,
                     "exists": os.path.exists(img)})

    plan.sort(key=lambda x: x["cut"])
    print(json.dumps(plan, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
