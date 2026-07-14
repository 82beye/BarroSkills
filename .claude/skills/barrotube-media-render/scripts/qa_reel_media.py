#!/usr/bin/env python3
"""Reel media QA gate — deterministic checks that feed render_reel_job.py.

Three QA stages, each writing the report file the state machine's gate reads:

  images  (R3)  -> <reel>/60_qa_report.images.json
  videos  (R5)  -> <reel>/60_qa_report.videos.json
  final   (R8)  -> <reel>/60_qa_report.media.json
                   + <reel>/56_capcut_export/contact_sheet_6cuts.jpg

A report's top-level `ok` is true only when no error-level check failed;
warnings are recorded but do not block. render_reel_job.py `sync` marks the
stage completed when `ok:true`, failed (qa_failed) when `ok:false` — so this
script IS the gate: publish cannot proceed past a failing report.

Checks (from the automation plan §4):
  images: count matches cuts, PNG signature, portrait orientation, md5 dupes
  videos: count matches cuts, resolution/duration/codec via ffprobe, md5 dupes
  final : resolution/duration/fps/audio stream, blackdetect, volumedetect,
          subtitle stream (info), contact sheet generation

Usage:
  python3 qa_reel_media.py images <reel>
  python3 qa_reel_media.py videos <reel>
  python3 qa_reel_media.py final  <reel> [--force-contact-sheet]
  python3 qa_reel_media.py all    <reel>

Exit code 0 when the requested report(s) end ok:true, 1 otherwise.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SCHEMA = "barrotube.qa_report.v1"
REPORT_FILES = {
    "images": "60_qa_report.images.json",
    "videos": "60_qa_report.videos.json",
    "final": "60_qa_report.media.json",
}
# Grok nominally renders 720x1280, but real downloads measure 720x1264 —
# both are known-good. Anything else portrait is a warning, landscape an error.
# Grok clips are either 6s or 10s (the only two options); the shot-composition
# system trims them down in the render, so a 6s source is fully valid. Only a
# sub-3s source signals a real truncation.
GROK_EXPECT = {"width": 720, "heights": (1280, 1264),
               "dur_warn": (5.5, 12.0), "dur_min": 3.0}


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def png_size(path: Path) -> tuple[int, int] | None:
    try:
        with open(path, "rb") as f:
            if f.read(8) != b"\x89PNG\r\n\x1a\n":
                return None
            f.read(4)
            if f.read(4) != b"IHDR":
                return None
            return struct.unpack(">II", f.read(8))
    except OSError:
        return None


def ffprobe(path: Path) -> dict | None:
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries",
             "stream=index,codec_type,codec_name,width,height,r_frame_rate,"
             "sample_rate,channels",
             "-show_entries", "format=duration",
             "-of", "json", str(path)],
            stderr=subprocess.DEVNULL, timeout=60)
        return json.loads(out)
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return None


def video_stream(info: dict) -> dict | None:
    for s in info.get("streams", []):
        if s.get("codec_type") == "video":
            return s
    return None


def has_stream(info: dict, kind: str) -> bool:
    return any(s.get("codec_type") == kind for s in info.get("streams", []))


def fps_of(stream: dict) -> float | None:
    raw = stream.get("r_frame_rate", "")
    m = re.match(r"(\d+)/(\d+)", raw)
    if m and int(m.group(2)):
        return round(int(m.group(1)) / int(m.group(2)), 2)
    return None


def load_cut_plan(reel: Path) -> list[dict]:
    script_md = reel / "script.md"
    if not script_md.is_file():
        return []
    helper = Path(__file__).resolve().parent / "reel_render_plan.py"
    try:
        out = subprocess.check_output(
            [sys.executable, str(helper), str(script_md)],
            stderr=subprocess.DEVNULL, timeout=30)
        plan = json.loads(out)
        return plan if isinstance(plan, list) else []
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return []


class Report:
    def __init__(self, stage: str, reel: Path):
        self.stage = stage
        self.reel = reel
        self.checks: list[dict] = []

    def add(self, check_id: str, ok: bool, level: str, detail: str) -> None:
        self.checks.append({"id": check_id, "ok": ok, "level": level, "detail": detail})

    def error(self, check_id: str, detail: str) -> None:
        self.add(check_id, False, "error", detail)

    def warn(self, check_id: str, detail: str) -> None:
        self.add(check_id, False, "warn", detail)

    def passed(self, check_id: str, detail: str = "") -> None:
        self.add(check_id, True, "info", detail)

    def info(self, check_id: str, detail: str) -> None:
        self.add(check_id, True, "info", detail)

    def write(self) -> dict:
        ok = not any(c["level"] == "error" and not c["ok"] for c in self.checks)
        data = {
            "schema": SCHEMA,
            "stage": self.stage,
            "ok": ok,
            "generated_at": now_iso(),
            "reel_dir": str(self.reel),
            "errors": sum(1 for c in self.checks if c["level"] == "error" and not c["ok"]),
            "warnings": sum(1 for c in self.checks if c["level"] == "warn" and not c["ok"]),
            "checks": self.checks,
        }
        path = self.reel / REPORT_FILES[self.stage]
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        data["report"] = str(path)
        return data


def dupe_check(rep: Report, files: list[Path], what: str) -> None:
    """md5 duplicate detection — catches the download-too-early trap."""
    seen: dict[str, str] = {}
    dupes = []
    for p in files:
        digest = md5(p)
        if digest in seen:
            dupes.append(f"{p.name} == {seen[digest]}")
        else:
            seen[digest] = p.name
    if dupes:
        rep.error(f"{what}_md5_unique", "duplicate bytes: " + "; ".join(dupes))
    else:
        rep.passed(f"{what}_md5_unique", f"{len(files)} files, all unique")


def qa_images(reel: Path) -> dict:
    rep = Report("images", reel)
    cuts = load_cut_plan(reel)
    if not cuts:
        rep.error("cut_plan", "script.md missing or no CUT blocks parsed")
        return rep.write()
    rep.passed("cut_plan", f"{len(cuts)} cuts parsed")

    existing = [Path(c["image"]) for c in cuts if Path(c["image"]).is_file()]
    missing = [f"cut{c['cut']}" for c in cuts if not Path(c["image"]).is_file()]
    if missing:
        rep.error("image_count", f"missing stills for: {', '.join(missing)}")
    else:
        rep.passed("image_count", f"{len(existing)}/{len(cuts)} stills present")

    for p in existing:
        size = png_size(p)
        if size is None:
            rep.error(f"png_signature:{p.name}", "not a valid PNG")
            continue
        w, h = size
        if h > w:
            rep.passed(f"portrait:{p.name}", f"{w}x{h}")
        else:
            rep.error(f"portrait:{p.name}", f"{w}x{h} is not portrait (9:16 required)")

    if existing:
        dupe_check(rep, existing, "images")
    return rep.write()


def qa_videos(reel: Path) -> dict:
    rep = Report("videos", reel)
    cuts = load_cut_plan(reel)
    if not cuts:
        rep.error("cut_plan", "script.md missing or no CUT blocks parsed")
        return rep.write()
    rep.passed("cut_plan", f"{len(cuts)} cuts parsed")

    clips = [reel / "video" / f"{c['slug']}.mp4" for c in cuts]
    existing = [p for p in clips if p.is_file()]
    missing = [p.name for p in clips if not p.is_file()]
    if missing:
        rep.error("video_count", f"missing clips: {', '.join(missing)}")
    else:
        rep.passed("video_count", f"{len(existing)}/{len(cuts)} clips present")

    if existing and not shutil.which("ffprobe"):
        rep.error("ffprobe", "ffprobe unavailable — cannot validate video streams")
        return rep.write()

    for p in existing:
        info = ffprobe(p)
        vs = video_stream(info) if info else None
        if not info or not vs:
            rep.error(f"probe:{p.name}", "ffprobe found no video stream")
            continue
        w, h = vs.get("width"), vs.get("height")
        dur = float(info.get("format", {}).get("duration") or 0)
        codec = vs.get("codec_name")
        if not (w and h and h > w):
            rep.error(f"portrait:{p.name}", f"{w}x{h} is not portrait")
        elif w == GROK_EXPECT["width"] and h in GROK_EXPECT["heights"]:
            rep.passed(f"resolution:{p.name}", f"{w}x{h}")
        else:
            rep.warn(f"resolution:{p.name}",
                     f"{w}x{h} (expected {GROK_EXPECT['width']}x"
                     f"{'/'.join(map(str, GROK_EXPECT['heights']))})")
        if dur < GROK_EXPECT["dur_min"]:
            rep.error(f"duration:{p.name}", f"{dur:.2f}s — too short, likely truncated")
        elif not (GROK_EXPECT["dur_warn"][0] <= dur <= GROK_EXPECT["dur_warn"][1]):
            rep.warn(f"duration:{p.name}", f"{dur:.2f}s (expected ~10s)")
        else:
            rep.passed(f"duration:{p.name}", f"{dur:.2f}s")
        if codec == "h264":
            rep.passed(f"codec:{p.name}", codec)
        else:
            rep.warn(f"codec:{p.name}", f"{codec} (expected h264)")

    if existing:
        dupe_check(rep, existing, "videos")
    return rep.write()


def ffmpeg_scan(path: Path, vf_or_af: list[str], pattern: str) -> list[str] | None:
    """Run an ffmpeg analysis filter and grep its stderr. None if ffmpeg missing."""
    if not shutil.which("ffmpeg"):
        return None
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(path),
             *vf_or_af, "-f", "null", "-"],
            capture_output=True, text=True, timeout=300)
        return re.findall(pattern, proc.stderr)
    except (subprocess.SubprocessError, OSError):
        return []


def qa_final(reel: Path, force_contact_sheet: bool = False) -> dict:
    rep = Report("final", reel)
    final = reel / "56_capcut_export" / "video.mp4"
    if not final.is_file():
        final = reel / "55_render" / "video.mp4"
        if final.is_file():
            rep.warn("final_source", "no CapCut export; validating 55_render/video.mp4")
        else:
            rep.error("final_exists", "no 56_capcut_export/video.mp4 nor 55_render/video.mp4")
            return rep.write()
    rep.passed("final_exists", str(final))

    if not shutil.which("ffprobe"):
        rep.error("ffprobe", "ffprobe unavailable — cannot validate final video")
        return rep.write()

    info = ffprobe(final)
    vs = video_stream(info) if info else None
    if not info or not vs:
        rep.error("probe", "ffprobe found no video stream")
        return rep.write()

    w, h = vs.get("width"), vs.get("height")
    dur = float(info.get("format", {}).get("duration") or 0)
    fps = fps_of(vs)
    if w and h and h > w:
        rep.passed("portrait", f"{w}x{h}")
        if (w, h) not in ((1080, 1920), (2160, 3840)):
            rep.warn("resolution", f"{w}x{h} (expected 1080x1920 or 4K 2160x3840)")
    else:
        rep.error("portrait", f"{w}x{h} is not portrait")
    if dur >= 5.0:
        rep.passed("duration", f"{dur:.2f}s")
    else:
        rep.error("duration", f"{dur:.2f}s — implausibly short for a reel")
    if fps:
        (rep.passed if 24 <= fps <= 61 else rep.warn)("fps", f"{fps}")
    else:
        rep.warn("fps", "could not parse frame rate")

    if has_stream(info, "audio"):
        rep.passed("audio_stream", "present")
    else:
        rep.error("audio_stream", "no audio stream in final video")
    rep.info("subtitle_stream",
             "present" if has_stream(info, "subtitle") else "none (burn-in assumed)")

    blacks = ffmpeg_scan(final, ["-vf", "blackdetect=d=0.5:pix_th=0.10", "-an"],
                         r"black_start:[\d.]+")
    if blacks is None:
        rep.warn("blackdetect", "ffmpeg unavailable — skipped")
    elif blacks:
        rep.warn("blackdetect", f"{len(blacks)} black segment(s) ≥0.5s — verify intentional")
    else:
        rep.passed("blackdetect", "no black segments ≥0.5s")

    vols = ffmpeg_scan(final, ["-af", "volumedetect", "-vn"],
                       r"(mean_volume: [-\d.]+ dB|max_volume: [-\d.]+ dB)")
    if vols is None:
        rep.warn("volumedetect", "ffmpeg unavailable — skipped")
    elif vols:
        mean = next((v for v in vols if "mean" in v), "")
        m = re.search(r"mean_volume: ([-\d.]+)", mean)
        if m and float(m.group(1)) < -50:
            rep.error("volumedetect", f"{'; '.join(vols)} — audio is near-silent")
        else:
            rep.passed("volumedetect", "; ".join(vols))
    else:
        rep.warn("volumedetect", "no volume stats parsed")

    # contact sheet: one tile per cut (N-aware; falls back to 6 if no cut plan)
    n_cuts = len(load_cut_plan(reel)) or 6
    sheet = reel / "56_capcut_export" / f"contact_sheet_{n_cuts}cuts.jpg"
    if sheet.is_file() and not force_contact_sheet:
        rep.passed("contact_sheet", f"exists: {sheet}")
    elif not shutil.which("ffmpeg"):
        rep.warn("contact_sheet", "ffmpeg unavailable — cannot generate")
    elif dur <= 0:
        rep.warn("contact_sheet", "unknown duration — cannot sample frames")
    else:
        sheet.parent.mkdir(parents=True, exist_ok=True)
        rate = n_cuts / dur
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-hide_banner", "-nostdin", "-i", str(final),
                 "-vf", f"fps={rate:.6f},scale=270:480,tile={n_cuts}x1",
                 "-frames:v", "1", "-update", "1", str(sheet)],
                capture_output=True, timeout=300, check=True)
            rep.passed("contact_sheet", f"generated: {sheet}")
        except (subprocess.SubprocessError, OSError) as e:
            rep.warn("contact_sheet", f"generation failed: {e}")
    return rep.write()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stage", choices=["images", "videos", "final", "all"])
    parser.add_argument("reel", help="reel directory containing script.md")
    parser.add_argument("--force-contact-sheet", action="store_true",
                        help="regenerate the contact sheet even if one exists")
    args = parser.parse_args()

    reel = Path(args.reel).expanduser().resolve()
    if not reel.is_dir():
        print(json.dumps({"ok": False, "error": f"not a directory: {reel}"}))
        return 2

    stages = ["images", "videos", "final"] if args.stage == "all" else [args.stage]
    results = []
    for stage in stages:
        if stage == "images":
            results.append(qa_images(reel))
        elif stage == "videos":
            results.append(qa_videos(reel))
        else:
            results.append(qa_final(reel, args.force_contact_sheet))

    out = results[0] if len(results) == 1 else {
        "ok": all(r["ok"] for r in results),
        "stages": {r["stage"]: {"ok": r["ok"], "errors": r["errors"],
                                "warnings": r["warnings"], "report": r["report"]}
                   for r in results},
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
