#!/usr/bin/env python3
"""Reel autopilot — the deterministic slice of the barrotube-reel-director loop.

This is the Layer-1 driver's *safe half*: it reads render-job.json and drives a
reel through every stage that can be completed **without a browser, without a
human, and without any irreversible action**, then stops cleanly at the first
gate it must not cross on its own (a ChatGPT/Grok browser stage, a CapCut GUI
export, or the HITL Instagram publish) and reports the exact next action.

It never drives a browser, never publishes, never deletes a file, never pays.
Those live behind explicit handoffs so a non-interactive run (cron, headless,
this very session) can carry a reel as far as automation honestly allows and
hand a precise baton to an interactive `claude --chrome` session or a human.

What it can do headless (deterministic stages):
  R3 image QA      -> qa_reel_media.py images     (writes 60_qa_report.images.json)
  R5 video QA      -> qa_reel_media.py videos     (writes 60_qa_report.videos.json)
  R6 FFmpeg master -> render_master_mix.py         (only with --allow-render + BGM,
                       or skipped when a CapCut export already exists)
  R8 final QA      -> qa_reel_media.py final       (writes 60_qa_report.media.json)
  R9 distribution  -> copy final into distribution/reels/ + write publish meta
  R11 postmortem   -> write 90_timing/production-timing.md from job state

Where it stops (handoff, never crossed autonomously):
  R2 ChatGPT images / R4 Grok videos  -> needs interactive claude --chrome
  R7 CapCut export (when missing)     -> needs the CapCut GUI
  R10 Instagram publish               -> HITL, explicit human approval
  any QA gate ok:false                -> needs a re-render/re-roll first

Usage:
  python3 reel_autopilot.py <reel> [--episode EP-ID] [--allow-render]
                            [--online-doctor] [--max-steps N] [--json]

Exit code 0 always (a clean stop is not an error); read the JSON `blocked`/`done`
fields for outcome. Prints a human summary unless --json.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
JOB = HERE / "render_reel_job.py"
QA = HERE / "qa_reel_media.py"
DOCTOR = HERE / "media_render_doctor.py"
MASTER = HERE / "render_master_mix.py"

# stages this driver may complete on its own (headless, deterministic, reversible)
DETERMINISTIC = {"R1", "R3", "R5", "R6", "R8", "R9", "R11"}
# stages that require a browser worker (interactive claude --chrome)
BROWSER = {"R2", "R4"}
# stages that require a GUI app we cannot drive headless
GUI = {"R7"}
# stages behind an explicit human gate
HITL = {"R10"}


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def run(cmd: list[str], timeout: int = 600) -> tuple[int, str, str]:
    try:
        p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True,
                           timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except (subprocess.SubprocessError, OSError) as e:
        return 1, "", str(e)


def job_json(reel: Path, *args: str) -> dict:
    """Run a render_reel_job.py subcommand and parse its JSON stdout.

    render_reel_job.py's CLI is `<command> <reel> [opts]`, so args[0] is the
    subcommand and the reel path is inserted right after it.
    """
    code, out, err = run([sys.executable, JOB, args[0], str(reel), *args[1:]])
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {"ok": False, "error": err or out or "no output", "_code": code}


def qa(reel: Path, mode: str) -> dict:
    code, out, err = run([sys.executable, QA, mode, str(reel)])
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        data = {"ok": False, "error": err or out}
    data["_exit"] = code
    return data


# ---------- best-effort publish meta from a today.myo / BarroTube script.md ----------

def extract_publish_meta(reel: Path, episode: str | None) -> dict | None:
    """Pull an Instagram caption + hashtags out of script.md's 발행 메타 block.

    Recognises the today.myo layout ('- **인스타 캡션**: ...', '- **해시태그**: ...')
    and a couple of common variants. Returns None if nothing usable is found so
    the caller can leave an honest TODO instead of a fabricated caption.
    """
    md = reel / "script.md"
    if not md.is_file():
        return None
    text = md.read_text(encoding="utf-8")

    def grab(*labels: str) -> str | None:
        for lab in labels:
            m = re.search(rf"[-*]\s*\*\*{lab}\*\*\s*[:：]\s*(.+)", text)
            if m:
                return m.group(1).strip()
        return None

    caption = grab("인스타 캡션", "인스타그램 캡션", "캡션", "caption", "Instagram Caption")
    tags_line = grab("해시태그", "hashtags", "Hashtags", "태그")
    title = None
    m = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    if m:
        title = m.group(1).strip()

    if not caption and not tags_line:
        return None

    # hashtags: split on whitespace / middots, keep tokens, normalise to '#tag'
    hashtags: list[str] = []
    if tags_line:
        for tok in re.split(r"[\s·•,]+", tags_line):
            tok = tok.strip().lstrip("#")
            if tok:
                hashtags.append("#" + tok)

    return {
        "episode_id": episode,
        "channel_id": reel.parents[1].name if len(reel.parents) >= 2 else None,
        "format": "reels",
        "title": title,
        "platforms": {
            "reels": {
                "caption": caption or "",
                "hashtags": hashtags,
                "attribution": "",
            }
        },
        "video": "56_capcut_export/video.mp4",
        "created_at": now_iso(),
        "_note": "auto-extracted from script.md 발행 메타 — REVIEW caption ending "
                 "before R10 publish (HITL).",
    }


# ---------- stage handlers ----------

def final_video_path(reel: Path) -> Path | None:
    for rel in ("56_capcut_export/video.mp4", "55_render/video.mp4"):
        p = reel / rel
        if p.is_file():
            return p
    return None


def do_distribution(reel: Path, episode: str | None) -> dict:
    """R9: copy the final export into distribution/reels/ + ensure publish meta."""
    final = final_video_path(reel)
    if not final:
        return {"ok": False, "reason": "no final video (56_capcut_export or 55_render)"}
    slug = (episode or reel.name).replace("/", "_")
    dest_dir = reel / "distribution" / "reels"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{slug}.mp4"
    if not dest.is_file():
        shutil.copy2(final, dest)
    written = [str(dest)]

    meta_path = reel / "70_publish_meta.instagram.json"
    meta_status = "exists"
    if not meta_path.is_file():
        meta = extract_publish_meta(reel, episode)
        if meta:
            meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                 encoding="utf-8")
            written.append(str(meta_path))
            meta_status = "generated from script.md (review before publish)"
        else:
            meta_status = "MISSING — could not extract caption; write it before R10"
    return {"ok": True, "written": written, "publish_meta": meta_status}


def do_postmortem(reel: Path, episode: str | None, job: dict) -> dict:
    """R11: write a timing/postmortem markdown from the job state (honest about
    whether per-stage timing was instrumented)."""
    tdir = reel / "90_timing"
    tdir.mkdir(parents=True, exist_ok=True)
    stages = job.get("stages", [])
    lines = [
        f"# {episode or reel.name} — production timing / postmortem",
        "",
        f"- generated: {now_iso()}",
        f"- reel: `{reel}`",
        f"- cuts: {len(job.get('cuts', []))}",
        "",
        "## Stage status (from render-job.json)",
        "",
        "| stage | name | status | attempts |",
        "| --- | --- | --- | --- |",
    ]
    for s in stages:
        lines.append(f"| {s['stage']} | {s['name']} | {s['status']} | {s['attempts']} |")
    lines += [
        "",
        "## Notes",
        "",
        "- Per-stage wall-clock timing was not instrumented for this episode "
        "(built before production_timer wiring); statuses above are the source of truth.",
        "- Future episodes: wire production_timer.py step boundaries in the browser "
        "workers to populate real durations here.",
        "",
    ]
    md = tdir / "production-timing.md"
    md.write_text("\n".join(lines), encoding="utf-8")
    return {"ok": True, "written": [str(md)]}


# ---------- the driver loop ----------

def autopilot(reel: Path, episode: str | None, allow_render: bool,
              online_doctor: bool, max_steps: int) -> dict:
    log: list[dict] = []

    def note(stage: str, action: str, **kw: Any) -> None:
        log.append({"stage": stage, "action": action, **kw})

    # 0. ensure job + preflight
    init = job_json(reel, "init", *(["--episode", episode] if episode else []))
    if not init.get("ok"):
        return {"ok": False, "fatal": "init failed", "detail": init}

    dcmd = [sys.executable, DOCTOR, str(reel)]
    if online_doctor:
        dcmd.append("--online")
    dcode, dout, _ = run(dcmd)
    try:
        doctor = json.loads(dout)
        note("preflight", "doctor", ok=doctor.get("ok"),
             report=str(reel / "00_preflight.media.json"))
    except json.JSONDecodeError:
        note("preflight", "doctor", ok=None, warning="doctor produced no JSON")

    # 1. drive
    steps = 0
    while steps < max_steps:
        steps += 1
        st = job_json(reel, "sync")
        nxt = st.get("next", {})
        stage = nxt.get("stage")

        if stage is None:
            return {"ok": True, "done": True, "reason": "all stages complete",
                    "stages": st.get("stages"), "log": log}

        status = nxt.get("status")

        # a failed QA gate blocks — needs a re-render/re-roll, not this driver
        if status == "failed":
            return {"ok": True, "done": False, "blocked": stage,
                    "blocked_kind": "qa_failed",
                    "reason": f"{stage} failed: {(nxt.get('error') or {}).get('type')}",
                    "next_action": "inspect the QA report, re-roll/re-render the "
                                   "failing cut, then re-run autopilot",
                    "stages": st.get("stages"), "log": log}

        # browser stages — hand off to interactive claude --chrome
        if stage in BROWSER:
            kind = "ChatGPT images" if stage == "R2" else "Grok videos"
            return {"ok": True, "done": False, "blocked": stage,
                    "blocked_kind": "browser",
                    "reason": f"{stage} ({kind}) needs a logged-in browser; "
                              f"pending cuts: {nxt.get('pending_cuts')}",
                    "next_action": "run `claude --chrome` and invoke the "
                                   "barrotube-media-render skill on this reel "
                                   "(or `bash tools/media-process.sh` for today.myo)",
                    "stages": st.get("stages"), "log": log}

        # R6 FFmpeg master — skip when a CapCut export already exists (today.myo route)
        if stage == "R6":
            if (reel / "56_capcut_export" / "video.mp4").is_file():
                job_json(reel, "skip", "R6", "--note",
                         "CapCut-composed route: FFmpeg master subsumed by CapCut export (R7)")
                note("R6", "skipped", reason="CapCut export present")
                continue
            if (reel / "55_render" / "video.mp4").is_file():
                note("R6", "already-rendered")
                continue  # sync will complete it next loop
            if not allow_render:
                return {"ok": True, "done": False, "blocked": "R6",
                        "blocked_kind": "needs_render",
                        "reason": "no 55_render/video.mp4 and no CapCut export",
                        "next_action": "run render_master_mix.py (needs BGM), or "
                                       "compose in CapCut, then re-run autopilot "
                                       "(pass --allow-render to attempt FFmpeg master)",
                        "stages": st.get("stages"), "log": log}
            # allow_render: attempt the common FFmpeg master (best-effort)
            job_json(reel, "start", "R6")
            code, out, err = run([sys.executable, MASTER, "--reel", str(reel),
                                  "--episode", episode or reel.name])
            if code == 0 and (reel / "55_render" / "video.mp4").is_file():
                note("R6", "rendered", via="render_master_mix.py")
                continue
            job_json(reel, "fail", "R6", "--error-type", "other",
                     "--message", (err or out or "render failed")[:300])
            return {"ok": True, "done": False, "blocked": "R6",
                    "blocked_kind": "render_failed",
                    "reason": "render_master_mix.py did not produce 55_render/video.mp4",
                    "next_action": "render_master_mix usually needs --bgm; run it "
                                   "manually with a BGM bed, or compose in CapCut",
                    "detail": (err or out)[:500], "stages": st.get("stages"), "log": log}

        # R7 CapCut export — cannot drive the GUI headless
        if stage in GUI:
            return {"ok": True, "done": False, "blocked": stage,
                    "blocked_kind": "gui",
                    "reason": "CapCut export not found (56_capcut_export/video.mp4)",
                    "next_action": "build/export the CapCut draft (see "
                                   "capcut-reel-export.md / capcut-draft-automation), "
                                   "then re-run autopilot",
                    "stages": st.get("stages"), "log": log}

        # R3 / R5 / R8 QA gates
        if stage in ("R3", "R5", "R8"):
            mode = {"R3": "images", "R5": "videos", "R8": "final"}[stage]
            job_json(reel, "start", stage)
            r = qa(reel, mode)
            if r.get("ok"):
                note(stage, "qa_pass", mode=mode,
                     report=r.get("report") or r.get("stages"))
                continue  # sync will mark completed from the ok:true report
            # QA failed — record and stop
            job_json(reel, "fail", stage, "--error-type", "qa_failed",
                     "--message", f"{mode} QA ok:false")
            return {"ok": True, "done": False, "blocked": stage,
                    "blocked_kind": "qa_failed",
                    "reason": f"{stage} {mode} QA failed",
                    "next_action": f"inspect {reel}/60_qa_report.{mode}.json, fix the "
                                   f"error-level checks, then re-run autopilot",
                    "qa": r, "stages": st.get("stages"), "log": log}

        # R9 distribution
        if stage == "R9":
            job_json(reel, "start", "R9")
            d = do_distribution(reel, episode)
            if d.get("ok"):
                note("R9", "packaged", **d)
                continue
            return {"ok": True, "done": False, "blocked": "R9",
                    "blocked_kind": "distribution",
                    "reason": d.get("reason"), "next_action": "ensure a final video exists",
                    "stages": st.get("stages"), "log": log}

        # R10 Instagram publish — HITL, never autonomous
        if stage in HITL:
            meta = reel / "70_publish_meta.instagram.json"
            return {"ok": True, "done": False, "blocked": "R10",
                    "blocked_kind": "hitl_publish",
                    "reason": "Instagram publish requires explicit human approval",
                    "next_action": "review 70_publish_meta.instagram.json (caption!), "
                                   "confirm the Instagram token is set, then publish "
                                   "via the HITL path (publish-process.sh / "
                                   "publish-instagram-reels.js). Autopilot will not post.",
                    "publish_meta_present": meta.is_file(),
                    "stages": st.get("stages"), "log": log}

        # R11 postmortem/timing
        if stage == "R11":
            job_json(reel, "start", "R11")
            full = job_json(reel, "status", "--json")
            do_postmortem(reel, episode, full)
            note("R11", "postmortem_written")
            continue

        # unknown manual stage still pending (R0/R0.5 without a script) — hand off
        return {"ok": True, "done": False, "blocked": stage,
                "blocked_kind": "manual",
                "reason": f"{stage} is a manual stage still pending",
                "next_action": "resolve the topic/script stage (R0/R0.5/R1) first",
                "stages": st.get("stages"), "log": log}

    return {"ok": True, "done": False, "blocked": "max_steps",
            "reason": f"stopped after {max_steps} steps (guard)", "log": log}


def human_summary(res: dict, reel: Path) -> str:
    lines = [f"● reel: {reel}"]
    for e in res.get("log", []):
        lines.append(f"  ✓ {e['stage']:<4} {e['action']}"
                     + (f" — {e.get('reason','')}" if e.get('reason') else ""))
    if res.get("done"):
        lines.append("● DONE — all stages complete.")
    elif res.get("blocked"):
        lines.append(f"● STOP at {res['blocked']} [{res.get('blocked_kind')}]")
        lines.append(f"    why : {res.get('reason')}")
        lines.append(f"    next: {res.get('next_action')}")
    elif res.get("fatal"):
        lines.append(f"● FATAL: {res['fatal']}")
    if res.get("stages"):
        done = sum(1 for v in res["stages"].values() if v in ("completed", "skipped"))
        lines.append(f"● progress: {done}/{len(res['stages'])} stages done")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("reel")
    ap.add_argument("--episode")
    ap.add_argument("--allow-render", action="store_true",
                    help="attempt render_master_mix.py at R6 (needs a BGM bed)")
    ap.add_argument("--online-doctor", action="store_true",
                    help="validate the Instagram token via Graph API during preflight")
    ap.add_argument("--max-steps", type=int, default=20)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    reel = Path(args.reel).expanduser().resolve()
    if not reel.is_dir():
        print(json.dumps({"ok": False, "error": f"not a directory: {reel}"}))
        return 2

    res = autopilot(reel, args.episode, args.allow_render, args.online_doctor,
                    args.max_steps)
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(human_summary(res, reel))
    return 0


if __name__ == "__main__":
    sys.exit(main())
