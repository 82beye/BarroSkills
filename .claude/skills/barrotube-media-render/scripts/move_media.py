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
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

from PIL import Image

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
VIDEO_EXTS = (".mp4",)


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
        if os.path.islink(p) or not os.path.isfile(p):
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


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


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
            stderr=subprocess.DEVNULL, timeout=30,
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
    except (subprocess.SubprocessError, OSError, ValueError, KeyError):
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
    ap.add_argument("--overwrite", action="store_true",
                    help="Explicitly replace an existing destination after verification")
    ap.add_argument("--max-age", type=int, default=600,
                    help="Only consider downloads modified within this many seconds (default 600)")
    args = ap.parse_args()
    if args.slug in (".", "..") or not re.fullmatch(r"[^/\\\x00-\x1f]+", args.slug):
        ap.error("--slug must be a single file name without path separators")

    if args.kind == "image":
        exts, subdir, prefer = IMAGE_EXTS, "Image", None
    else:
        exts, subdir, prefer = VIDEO_EXTS, "video", "grok-video-"

    src = args.source or newest_match(args.downloads, exts, prefer, args.max_age)
    if not src or os.path.islink(src) or not os.path.isfile(src):
        print(json.dumps({
            "ok": False,
            "error": f"no recent {args.kind} found in {args.downloads}",
            "hint": "Confirm the site's Download actually completed, or pass --source.",
        }, ensure_ascii=False))
        return 2

    # validate
    validation = {}
    if args.kind == "image":
        with Image.open(src) as img:
            ext = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}.get(img.format)
            if not ext or img.width <= 0 or img.height <= 0:
                raise ValueError("unsupported or invalid image")
            validation.update(format=img.format, width=img.width, height=img.height)
            img.verify()
        with Image.open(src) as img:
            img.load()
    else:
        info = ffprobe_video(src)
        if info and info.get("width") and info.get("height") and (info.get("duration") or 0) > 0:
            validation.update(info)
            # Grok nominally 720x1280; real downloads measure 720x1264 — both OK.
            if info.get("height") and info["height"] not in (1280, 1264):
                validation["note"] = f"height={info['height']} (expected 1280/1264 for 9:16/720p)"
        else:
            raise ValueError("video validation failed or ffprobe unavailable; original preserved")
        if os.path.splitext(src)[1].lower() != ".mp4":
            raise ValueError("expected an MP4 download; convert other containers separately")
        ext = ".mp4"

    dest_dir = args.dest_dir or os.path.join(args.dest_root, subdir)
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, args.slug + ext)

    if os.path.lexists(dest) and not args.overwrite:
        raise FileExistsError("destination exists; use --overwrite to replace it")
    if os.path.exists(dest) and os.path.samefile(src, dest):
        raise ValueError("source and destination must differ")
    expected_hash = sha256(src)
    fd, tmp = tempfile.mkstemp(prefix=".media-", suffix=ext, dir=dest_dir)
    os.close(fd)
    try:
        shutil.copyfile(src, tmp)
        if sha256(tmp) != expected_hash or sha256(src) != expected_hash:
            raise ValueError("source changed or copy hash mismatch; original preserved")
        with open(tmp, "rb") as copied:
            os.fsync(copied.fileno())
        if args.overwrite:
            os.replace(tmp, dest)
        else:
            os.link(tmp, dest)  # atomic no-overwrite, including dangling symlinks
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

    deleted = False
    delete_note = None
    if not args.no_delete:
        # verify the copy matches before removing the original
        if sha256(dest) == expected_hash and sha256(src) == expected_hash:
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
            delete_note = "hash mismatch after copy; left original in place"

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
    try:
        sys.exit(main())
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(2)
