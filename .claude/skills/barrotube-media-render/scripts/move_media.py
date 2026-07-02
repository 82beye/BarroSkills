#!/usr/bin/env python3
"""Move a freshly downloaded image/video out of ~/Downloads into the project's
Image/ or video/ folder, validate it, and rename it by slug.

Why this exists: the browser sites (ChatGPT, Grok) save via their own Download
button into the browser's Downloads folder. The reliable, lossless way to file
the result is to grab the newest matching download and move it — not to scrape
bytes off the page (that path is blocked / lossy).

Examples:
  python move_media.py --kind image --slug summer-sea-s01
  python move_media.py --kind video --slug summer-sea-s01 \
      --dest-root /Users/beye/BarroAiFactory
  python move_media.py --kind video --slug clip --no-delete   # keep the original

Exit code 0 on success, non-zero on failure. Prints a JSON summary on stdout.
"""
import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import time

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
VIDEO_EXTS = (".mp4", ".mov", ".webm", ".m4v")


def newest_match(folder, exts, prefer_prefix=None, max_age_sec=None):
    """Return the newest file in `folder` whose extension is in `exts`.
    If `prefer_prefix` files exist (e.g. 'grok-video-'), prefer the newest of those.
    `max_age_sec` optionally restricts to recently-modified files (safety)."""
    candidates = []
    try:
        entries = os.listdir(folder)
    except FileNotFoundError:
        return None
    now = time.time()
    for name in entries:
        p = os.path.join(folder, name)
        if not os.path.isfile(p):
            continue
        if not name.lower().endswith(exts):
            continue
        mtime = os.path.getmtime(p)
        if max_age_sec is not None and (now - mtime) > max_age_sec:
            continue
        candidates.append((mtime, p, name))
    if not candidates:
        return None
    if prefer_prefix:
        preferred = [c for c in candidates if c[2].lower().startswith(prefer_prefix)]
        if preferred:
            return max(preferred)[1]
    return max(candidates)[1]


def is_png(path):
    try:
        with open(path, "rb") as f:
            return f.read(8) == b"\x89PNG\r\n\x1a\n"
    except OSError:
        return False


def png_size(path):
    try:
        with open(path, "rb") as f:
            f.read(8)
            f.read(4)
            if f.read(4) != b"IHDR":
                return None
            w, h = struct.unpack(">II", f.read(8))
            return w, h
    except OSError:
        return None


def ffprobe_video(path):
    """Return dict(width,height,duration,codec) using ffprobe, or None if unavailable."""
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height,codec_name",
                "-show_entries", "format=duration",
                "-of", "json", path,
            ],
            stderr=subprocess.DEVNULL,
        )
        data = json.loads(out)
        stream = (data.get("streams") or [{}])[0]
        fmt = data.get("format") or {}
        dur = fmt.get("duration")
        return {
            "width": stream.get("width"),
            "height": stream.get("height"),
            "codec": stream.get("codec_name"),
            "duration": round(float(dur), 2) if dur else None,
        }
    except (subprocess.CalledProcessError, ValueError, KeyError):
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kind", required=True, choices=["image", "video"])
    ap.add_argument("--slug", required=True,
                    help="Output base name (without extension), e.g. summer-sea-s01")
    ap.add_argument("--dest-root", default=os.path.expanduser("~/BarroAiFactory"),
                    help="Project root that contains Image/ and video/ (default: ~/BarroAiFactory)")
    ap.add_argument("--dest-dir", default=None,
                    help="Exact destination directory, bypassing the Image/video convention "
                         "(e.g. barrotube EP mode: <ep>/40_assets/images with --slug scene_001)")
    ap.add_argument("--downloads", default=os.path.expanduser("~/Downloads"),
                    help="Browser downloads folder to pull the newest file from")
    ap.add_argument("--source", default=None,
                    help="Explicit source file (skip the newest-in-Downloads search)")
    ap.add_argument("--no-delete", action="store_true",
                    help="Keep the original in Downloads (default: try to remove it)")
    ap.add_argument("--max-age", type=int, default=600,
                    help="Only consider downloads modified within this many seconds (default 600)")
    args = ap.parse_args()

    if args.kind == "image":
        exts, subdir, prefer = IMAGE_EXTS, "Image", None
    else:
        exts, subdir, prefer = VIDEO_EXTS, "video", "grok-video-"

    src = args.source or newest_match(args.downloads, exts, prefer, args.max_age)
    if not src or not os.path.isfile(src):
        print(json.dumps({
            "ok": False,
            "error": f"no recent {args.kind} found in {args.downloads}",
            "hint": "Confirm the site's Download actually completed, or pass --source.",
        }, ensure_ascii=False))
        return 2

    # validate
    validation = {}
    if args.kind == "image":
        validation["png"] = is_png(src)
        size = png_size(src) if validation["png"] else None
        if size:
            validation["width"], validation["height"] = size
        ext = ".png" if validation.get("png") else os.path.splitext(src)[1].lower()
    else:
        info = ffprobe_video(src)
        if info:
            validation.update(info)
            # Grok nominally 720x1280; real downloads measure 720x1264 — both OK.
            if info.get("height") and info["height"] not in (1280, 1264):
                validation["note"] = f"height={info['height']} (expected 1280/1264 for 9:16/720p)"
        else:
            validation["ffprobe"] = "unavailable (trusting browser download)"
        ext = ".mp4"

    dest_dir = args.dest_dir or os.path.join(args.dest_root, subdir)
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, args.slug + ext)

    shutil.copy2(src, dest)

    deleted = False
    delete_note = None
    if not args.no_delete:
        # verify the copy matches before removing the original
        if os.path.getsize(dest) == os.path.getsize(src):
            try:
                os.remove(src)
                deleted = True
            except PermissionError:
                delete_note = ("could not delete original (Operation not permitted). "
                               "In Cowork, approve deletion for the Downloads folder "
                               "(allow_cowork_file_delete), then re-run, or leave it.")
            except OSError as e:
                delete_note = f"could not delete original: {e}"
        else:
            delete_note = "size mismatch after copy; left original in place"

    print(json.dumps({
        "ok": True,
        "kind": args.kind,
        "source": src,
        "dest": dest,
        "bytes": os.path.getsize(dest),
        "validation": validation,
        "original_deleted": deleted,
        "delete_note": delete_note,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
