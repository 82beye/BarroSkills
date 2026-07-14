#!/usr/bin/env python3
"""Common FFmpeg master renderer for BarroTube reels — replaces the per-episode
render_epXX_master.py copies with one parameterized script.

What it does (extracted from the proven EP03/EP04 renders, which differ only in
scene durations, volumes and slugs):

  - normalize every Grok clip to a 1080x1920 / 30fps vertical canvas
  - trim each scene to its timeline duration
  - chain xfade transitions (default smoothleft / 0.35s)
  - lay ONE continuous BGM bed (looped, faded in/out) under the whole reel
  - keep each clip's OWN audio (Grok ambient) as a lowered-volume layer,
    delayed to its timeline position (default volume 0.25; --no-clip-audio to drop)
  - place a whoosh SFX at every transition point
  - master the mix with loudnorm (I=-16, TP=-1.5, LRA=11)
  - write 55_render/video.mp4, master-bgm-mix.m4a sidecar,
    master-bgm-mix.manifest.json, and production_timer steps

Usage:
  # clips auto-derived from script.md cut order, one duration for all scenes:
  python3 render_master_mix.py --reel <reel> --episode BT-EP05 --duration-each 4.6

  # explicit control (the automation plan §5 interface):
  python3 render_master_mix.py --reel <reel> --episode BT-EP05 \
      --clips video/ep05-cut1.mp4 video/ep05-cut2.mp4 ... \
      --durations 4.6,4.6,4.6,4.7,4.6,4.6 \
      --bgm 40_assets/bgm/Voltaic.mp3 --sfx 40_assets/sfx/whoosh.mp3 \
      --out 55_render/video.mp4

Exit 0 on success; prints a JSON summary. Use --dry-run to inspect the ffmpeg
command without rendering.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

W, H = 1080, 1920
FPS = 30
AUDIO_MASTER = "loudnorm=I=-16:TP=-1.5:LRA=11"
AUDIO_EXTS = (".mp3", ".m4a", ".wav", ".aac", ".flac")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"Command failed: {' '.join(cmd[:8])} ...\n{proc.stderr[-2200:]}")


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


def find_audio(reel: Path, kind: str) -> Path | None:
    d = reel / "40_assets" / kind
    if not d.is_dir():
        return None
    files = sorted(p for p in d.rglob("*") if p.suffix.lower() in AUDIO_EXTS)
    return files[0] if files else None


def has_audio_stream(path: Path) -> bool:
    if not shutil.which("ffprobe"):
        return False
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path)],
            stderr=subprocess.DEVNULL, timeout=30)
        return bool(out.strip())
    except (subprocess.SubprocessError, OSError):
        return False


def offsets_from_durations(durations: list[float], transition: float) -> list[float]:
    """Transition start times on the final timeline (SFX placement points)."""
    offsets = []
    cumulative = durations[0]
    for idx in range(1, len(durations)):
        offsets.append(cumulative - transition)
        cumulative += durations[idx] - transition
    return offsets


def build_filter(n: int, durations: list[float], transition: float, xfade: str,
                 final_duration: float, bgm_volume: float, sfx_volume: float,
                 with_sfx: bool, clip_audio_flags: list[bool] | None = None,
                 clip_audio_volume: float = 0.25) -> tuple[str, str]:
    """Return (filter_complex, video_out_label).

    clip_audio_flags[i]=True keeps clip i's own audio (Grok ambient) as a
    lowered-volume layer delayed to its timeline start — the BGM bed and SFX
    stay exactly as before; ambient is an additional amix input."""
    parts: list[str] = []
    for idx, dur in enumerate(durations):
        parts.append(
            f"[{idx}:v]trim=0:{dur},setpts=PTS-STARTPTS,"
            f"scale=w='if(gt(a,{W}/{H}),-2,{W})':h='if(gt(a,{W}/{H}),{H},-2)',"
            f"crop={W}:{H},fps={FPS},format=yuv420p[v{idx}]"
        )

    offsets = offsets_from_durations(durations, transition)
    if n == 1:
        vout = "v0"
    else:
        parts.append(f"[v0][v1]xfade=transition={xfade}:duration={transition}:offset={offsets[0]:.3f}[x1]")
        for idx in range(2, n):
            parts.append(
                f"[x{idx - 1}][v{idx}]xfade=transition={xfade}:"
                f"duration={transition}:offset={offsets[idx - 1]:.3f}[x{idx}]"
            )
        vout = f"x{n - 1}"

    bgm_idx = n  # input order: clips..., bgm, [sfx]
    parts.append(
        f"[{bgm_idx}:a]atrim=0:{final_duration + 1:.3f},asetpts=PTS-STARTPTS,"
        f"volume={bgm_volume},afade=t=in:st=0:d=0.5,"
        f"afade=t=out:st={max(0, final_duration - 0.8):.3f}:d=0.8[bgm]"
    )

    # 클립 자체 음성(앰비언트) — 씬 시작 오프셋에 맞춰 낮은 볼륨으로 깔기
    amb_labels: list[str] = []
    if clip_audio_flags and any(clip_audio_flags):
        starts = [0.0]
        for i in range(1, n):
            starts.append(starts[i - 1] + durations[i - 1] - transition)
        for i in range(n):
            if not clip_audio_flags[i]:
                continue
            ms = int(starts[i] * 1000)
            parts.append(
                f"[{i}:a]atrim=0:{durations[i]},asetpts=PTS-STARTPTS,"
                f"volume={clip_audio_volume},afade=t=out:st={max(0, durations[i] - 0.4):.3f}:d=0.4,"
                f"adelay={ms}|{ms}[camb{i}]"
            )
            amb_labels.append(f"[camb{i}]")

    mix_labels: list[str] = []
    if with_sfx and offsets:
        sfx_idx = n + 1
        k = len(offsets)
        labels = "".join(f"[w{i}]" for i in range(1, k + 1))
        parts.append(f"[{sfx_idx}:a]asplit={k}{labels}")
        for i, offset in enumerate(offsets, start=1):
            ms = int(offset * 1000)
            parts.append(
                f"[w{i}]atrim=0:0.75,asetpts=PTS-STARTPTS,"
                f"volume={sfx_volume},adelay={ms}|{ms}[s{i}]"
            )
        mix_labels = [f"[s{i}]" for i in range(1, k + 1)]

    extra = mix_labels + amb_labels
    if extra:
        parts.append(
            f"[bgm]{''.join(extra)}amix=inputs={len(extra) + 1}:duration=first:"
            f"dropout_transition=0:normalize=0,{AUDIO_MASTER}[aout]"
        )
    else:
        parts.append(f"[bgm]{AUDIO_MASTER}[aout]")

    return ";".join(parts), vout


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reel", required=True, help="reel directory")
    parser.add_argument("--episode", required=True, help="episode id for the manifest")
    parser.add_argument("--clips", nargs="*", default=None,
                        help="clip paths in scene order (default: video/<slug>.mp4 from script.md cut order)")
    parser.add_argument("--durations", default=None,
                        help="comma-separated per-scene seconds, e.g. 4.6,4.6,4.7")
    parser.add_argument("--duration-each", type=float, default=None,
                        help="one duration applied to every scene (alternative to --durations)")
    parser.add_argument("--bgm", default=None,
                        help="BGM audio (default: first audio under <reel>/40_assets/bgm)")
    parser.add_argument("--sfx", default=None,
                        help="transition whoosh (default: first audio under <reel>/40_assets/sfx; omit with --no-sfx)")
    parser.add_argument("--no-sfx", action="store_true", help="skip transition SFX")
    parser.add_argument("--clip-audio-volume", type=float, default=0.25,
                        help="volume for each clip's own audio laid under the BGM (default 0.25)")
    parser.add_argument("--no-clip-audio", action="store_true",
                        help="drop the clips' own audio entirely (pre-2026-07-04 behavior)")
    parser.add_argument("--transition", type=float, default=0.35, help="xfade seconds (default 0.35)")
    parser.add_argument("--xfade", default="smoothleft", help="xfade transition type (default smoothleft)")
    parser.add_argument("--bgm-volume", type=float, default=0.82)
    parser.add_argument("--sfx-volume", type=float, default=0.42)
    parser.add_argument("--out", default=None, help="output mp4 (default <reel>/55_render/video.mp4)")
    parser.add_argument("--no-timer", action="store_true",
                        help="skip production_timer integration (e.g. test renders)")
    parser.add_argument("--dry-run", action="store_true", help="print the ffmpeg command and exit")
    args = parser.parse_args()

    reel = Path(args.reel).expanduser().resolve()
    if not reel.is_dir():
        raise SystemExit(f"reel directory not found: {reel}")
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg not found on PATH (run media_render_doctor.py)")

    # cut plan — single source of truth for slugs AND per-cut durations
    plan = load_cut_plan(reel)

    # clips: explicit or derived from the cut plan
    if args.clips:
        clips = [(reel / c if not Path(c).is_absolute() else Path(c)) for c in args.clips]
    else:
        clips = [reel / "video" / f"{c['slug']}.mp4" for c in plan]
        if not clips:
            raise SystemExit("no --clips given and no cuts parsed from script.md")
    missing = [str(p) for p in clips if not p.is_file()]
    if missing:
        raise SystemExit(f"missing clips: {missing}")
    n = len(clips)

    # durations: explicit CLI wins; else per-cut 길이/duration from script.md;
    # else a flat fallback. Per-cut durations are how the shot-composition system
    # trims each source clip (6~10s) down to its 2~4s cut length.
    if args.durations:
        durations = [float(x) for x in args.durations.split(",") if x.strip()]
    elif args.duration_each:
        durations = [args.duration_each] * n
    elif plan and all(c.get("duration") for c in plan) and len(plan) == n:
        durations = [float(c["duration"]) for c in plan]
    else:
        raise SystemExit("provide --durations or --duration-each "
                         "(script.md has no complete per-cut 길이/duration fields)")
    if len(durations) != n:
        raise SystemExit(f"{len(durations)} durations for {n} clips")

    bgm = Path(args.bgm).expanduser() if args.bgm else find_audio(reel, "bgm")
    if not bgm or not bgm.is_file():
        raise SystemExit("no BGM found — pass --bgm or put audio under 40_assets/bgm/")
    sfx = None
    if not args.no_sfx:
        sfx = Path(args.sfx).expanduser() if args.sfx else find_audio(reel, "sfx")

    out = Path(args.out).expanduser() if args.out else reel / "55_render" / "video.mp4"
    if not out.is_absolute():
        out = reel / out
    out.parent.mkdir(parents=True, exist_ok=True)

    transition = args.transition if n > 1 else 0.0
    final_duration = sum(durations) - transition * (n - 1)
    offsets = offsets_from_durations(durations, transition) if n > 1 else []

    clip_audio_flags = [False] * n
    if not args.no_clip_audio:
        clip_audio_flags = [has_audio_stream(c) for c in clips]

    filter_complex, vout = build_filter(
        n, durations, transition, args.xfade, final_duration,
        args.bgm_volume, args.sfx_volume, with_sfx=bool(sfx),
        clip_audio_flags=clip_audio_flags, clip_audio_volume=args.clip_audio_volume)

    cmd = ["ffmpeg", "-y", "-hide_banner", "-nostdin"]
    for clip in clips:
        cmd += ["-i", str(clip)]
    cmd += ["-stream_loop", "-1", "-i", str(bgm)]
    if sfx:
        cmd += ["-i", str(sfx)]
    cmd += [
        "-filter_complex", filter_complex,
        "-map", f"[{vout}]", "-map", "[aout]",
        "-t", f"{final_duration:.3f}",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-r", str(FPS), "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(out),
    ]

    if args.dry_run:
        print(json.dumps({"ok": True, "dry_run": True, "final_duration": round(final_duration, 3),
                          "cmd": cmd}, ensure_ascii=False, indent=2))
        return 0

    timer = None
    if not args.no_timer:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from production_timer import ProductionTimer
        timer = ProductionTimer(reel)
        timer.start("ffmpeg_master", "FFmpeg master BGM/SFX mix")

    try:
        run(cmd)
        sidecar = out.parent / "master-bgm-mix.m4a"
        run([
            "ffmpeg", "-y", "-hide_banner", "-nostdin",
            "-stream_loop", "-1", "-i", str(bgm),
            "-t", f"{final_duration:.3f}",
            "-af", f"volume={args.bgm_volume},afade=t=in:st=0:d=0.5,"
                   f"afade=t=out:st={max(0, final_duration - 0.8):.3f}:d=0.8,{AUDIO_MASTER}",
            "-c:a", "aac", "-b:a", "192k", str(sidecar),
        ])
    except SystemExit:
        if timer:
            timer.end("ffmpeg_master", "failed", "ffmpeg exited non-zero")
        raise

    manifest = {
        "schema": "barrotube.master_mix.v1",
        "episode": args.episode,
        "generated_at": now_iso(),
        "renderer": "render_master_mix.py",
        "duration": round(final_duration, 3),
        "video": str(out),
        "canvas": {"width": W, "height": H, "fps": FPS},
        "transition": {"type": args.xfade, "seconds": transition},
        "scene_durations": durations,
        "timing": {
            "json": str(reel / "90_timing" / "production-timing.json"),
            "markdown": str(reel / "90_timing" / "production-timing.md"),
        },
        "bgm": {"source": str(bgm), "volume": args.bgm_volume},
        "clip_audio": {
            "enabled": any(clip_audio_flags),
            "volume": args.clip_audio_volume,
            "clips_with_audio": sum(clip_audio_flags),
        },
        "audio_master": AUDIO_MASTER,
        "sfx": ([{
            "source": str(sfx), "volume": args.sfx_volume,
            "placement_seconds": [round(x, 3) for x in offsets],
        }] if sfx else []),
        "clips": [str(p) for p in clips],
    }
    manifest_path = out.parent / "master-bgm-mix.manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    if timer:
        timer.end("ffmpeg_master", "completed",
                  f"{n} clips -> {final_duration:.2f}s master")

    print(json.dumps({"ok": True, "video": str(out), "sidecar": str(sidecar),
                      "manifest": str(manifest_path),
                      "duration": round(final_duration, 3), "clips": n},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
