#!/usr/bin/env python3
"""Reel render job state machine — the deterministic Layer-2 state store that
the barrotube-reel-director agent (Layer 1) reads and writes.

Owns `<reel>/render-job.json`: one entry per R-stage (R0 topic .. R11
postmortem), per-cut tracking for image (R2) and video (R4) stages, and an
evidence-based `sync` that marks stages completed from files on disk so a
stopped job resumes exactly where it left off (idempotent skip).

Judgement stays out of this script: it never drives a browser, never retries
by itself, never publishes. It answers "what is done, what failed, what's
next" and records what the director decides.

Usage:
  python3 render_reel_job.py init   <reel> [--episode EP-ID]
  python3 render_reel_job.py sync   <reel>            # re-scan outputs on disk
  python3 render_reel_job.py next   <reel>            # first actionable stage (JSON)
  python3 render_reel_job.py start  <reel> <stage> [--cut N] [--note ...]
  python3 render_reel_job.py end    <reel> <stage> [--cut N] [--note ...]
  python3 render_reel_job.py fail   <reel> <stage> [--cut N] --error-type T [--message ...]
  python3 render_reel_job.py skip   <reel> <stage> [--note ...]
  python3 render_reel_job.py retry  <reel>            # list failed stages/cuts
  python3 render_reel_job.py status <reel> [--json]

Exit code 0 on success. All commands print JSON on stdout.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

JOB_FILE = "render-job.json"
SCHEMA = "barrotube.render_job.v1"

# error_type vocabulary — must stay in sync with the automation plan's
# "Gotchas → worker 감지 스펙 매핑" table.
ERROR_TYPES = [
    "quota_or_paywall",
    "download_blocked",
    "stale_download",
    "option_drift",
    "account_drift",
    "file_attach_unavailable",
    "not_logged_in",
    "qa_failed",
    "other",
]

# error_types the director may retry without human help
RECOVERABLE = {"quota_or_paywall", "stale_download", "option_drift", "account_drift",
               "file_attach_unavailable", "qa_failed", "other"}

# Stage registry. kind:
#   auto      — sync completes it from evidence on disk
#   manual    — only start/end/skip move it (director judgement / HITL)
#   per_cut   — auto, but completion = every cut's expected file exists
STAGES = [
    {"id": "R0",   "name": "topic discovery",     "kind": "manual"},
    {"id": "R0.5", "name": "topic fact-check",    "kind": "manual", "gate": True},
    {"id": "R1",   "name": "script/prompts",      "kind": "auto"},
    {"id": "R2",   "name": "ChatGPT images",      "kind": "per_cut"},
    {"id": "R3",   "name": "image QA",            "kind": "auto", "gate": True},
    {"id": "R4",   "name": "Grok videos",         "kind": "per_cut"},
    {"id": "R5",   "name": "video QA",            "kind": "auto", "gate": True},
    {"id": "R6",   "name": "FFmpeg master",       "kind": "auto"},
    {"id": "R7",   "name": "CapCut export",       "kind": "auto"},
    {"id": "R8",   "name": "final QA",            "kind": "auto", "gate": True},
    {"id": "R9",   "name": "distribution",        "kind": "auto"},
    {"id": "R10",  "name": "Instagram publish",   "kind": "auto", "hitl": True},
    {"id": "R11",  "name": "postmortem/timing",   "kind": "auto"},
]

QA_REPORTS = {
    "R3": "60_qa_report.images.json",
    "R5": "60_qa_report.videos.json",
    "R8": "60_qa_report.media.json",
}

DONE = ("completed", "skipped")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def load_cut_plan(reel: Path) -> list[dict]:
    """Reuse reel_render_plan.py (deterministic parser) via subprocess."""
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


class RenderJob:
    def __init__(self, reel_dir: str | Path):
        self.reel = Path(reel_dir).expanduser().resolve()
        self.path = self.reel / JOB_FILE

    # ---------- persistence ----------

    def exists(self) -> bool:
        return self.path.is_file()

    def load(self) -> dict:
        if self.exists():
            return json.loads(self.path.read_text(encoding="utf-8"))
        return self._fresh()

    def _fresh(self) -> dict:
        return {
            "schema": SCHEMA,
            "reel_dir": str(self.reel),
            "episode": None,
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "topic": {"title": None, "status": "pending", "fact_check": None},
            "cuts": [],
            "stages": [
                {
                    "stage": s["id"],
                    "name": s["name"],
                    "kind": s["kind"],
                    "gate": s.get("gate", False),
                    "hitl": s.get("hitl", False),
                    "status": "pending",
                    "started_at": None,
                    "ended_at": None,
                    "attempts": 0,
                    "outputs": [],
                    "pending_cuts": [],
                    "error": None,
                    "notes": [],
                }
                for s in STAGES
            ],
        }

    def save(self, data: dict) -> None:
        data["updated_at"] = now_iso()
        self.reel.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    @staticmethod
    def stage_of(data: dict, stage_id: str) -> dict:
        for s in data["stages"]:
            if s["stage"] == stage_id:
                return s
        raise SystemExit(f"unknown stage: {stage_id} (valid: {[x['id'] for x in STAGES]})")

    # ---------- evidence scan (the idempotent-skip core) ----------

    def qa_ok(self, stage_id: str) -> bool | None:
        """True/False from the stage's QA report file, None if absent/unreadable."""
        name = QA_REPORTS.get(stage_id)
        if not name:
            return None
        p = self.reel / name
        if not p.is_file():
            return None
        try:
            return bool(json.loads(p.read_text(encoding="utf-8")).get("ok"))
        except (json.JSONDecodeError, OSError):
            return None

    def evidence(self, stage_id: str, cuts: list[dict]) -> tuple[bool, list[str], list[int]]:
        """Return (complete, outputs, pending_cuts) for auto/per_cut stages."""
        r = self.reel

        def found(*paths: Path) -> tuple[bool, list[str], list[int]]:
            existing = [str(p) for p in paths if p.is_file()]
            return (len(existing) == len(paths) and len(paths) > 0, existing, [])

        if stage_id == "R1":
            ok = (r / "script.md").is_file() and len(cuts) > 0
            return ok, ([str(r / "script.md")] if ok else []), []
        if stage_id == "R2":
            pend = [c["cut"] for c in cuts if not Path(c["image"]).is_file()]
            outs = [c["image"] for c in cuts if Path(c["image"]).is_file()]
            return (len(cuts) > 0 and not pend), outs, pend
        if stage_id == "R4":
            pend, outs = [], []
            for c in cuts:
                v = r / "video" / f"{c['slug']}.mp4"
                (outs.append(str(v)) if v.is_file() else pend.append(c["cut"]))
            return (len(cuts) > 0 and not pend), outs, pend
        if stage_id in QA_REPORTS:
            ok = self.qa_ok(stage_id)
            p = r / QA_REPORTS[stage_id]
            return (ok is True), ([str(p)] if p.is_file() else []), []
        if stage_id == "R6":
            return found(r / "55_render" / "video.mp4")
        if stage_id == "R7":
            return found(r / "56_capcut_export" / "video.mp4")
        if stage_id == "R9":
            d = r / "distribution" / "reels"
            vids = sorted(str(p) for p in d.glob("*.mp4")) if d.is_dir() else []
            return bool(vids), vids, []
        if stage_id == "R10":
            return found(r / "80_publish_result.instagram.json")
        if stage_id == "R11":
            return found(r / "90_timing" / "production-timing.md")
        return False, [], []

    def sync(self, data: dict) -> dict:
        """Re-scan disk evidence. Upgrades pending/in_progress -> completed when
        outputs exist; refreshes pending_cuts; NEVER downgrades an explicit
        completed/skipped, and never clears a failed status (retry is explicit)."""
        cuts = load_cut_plan(self.reel)
        if cuts:
            data["cuts"] = [
                {"cut": c["cut"], "slug": c["slug"], "image": c["image"],
                 "video": str(self.reel / "video" / f"{c['slug']}.mp4"),
                 "motion": c.get("motion", ""), "caption": c.get("caption", "")}
                for c in cuts
            ]

        # A script on disk is evidence the topic was decided and approved:
        # auto-complete the manual R0/R0.5 unless explicitly failed/rejected.
        if (self.reel / "script.md").is_file() and cuts:
            for sid in ("R0", "R0.5"):
                st = self.stage_of(data, sid)
                if st["status"] == "pending":
                    st["status"] = "completed"
                    st["ended_at"] = st["ended_at"] or now_iso()
                    st["notes"].append("auto: script.md exists, topic evidently approved")
            if data["topic"]["status"] == "pending":
                data["topic"]["status"] = "approved"

        for st in data["stages"]:
            if st["kind"] == "manual":
                continue
            complete, outputs, pending_cuts = self.evidence(st["stage"], cuts)
            st["outputs"] = outputs
            st["pending_cuts"] = pending_cuts
            if st["status"] in ("pending", "in_progress") and complete:
                st["status"] = "completed"
                st["ended_at"] = st["ended_at"] or now_iso()
                st["notes"].append("auto: outputs found on disk")
            # QA gate regression: report exists and says not ok -> failed
            if st["stage"] in QA_REPORTS and self.qa_ok(st["stage"]) is False \
                    and st["status"] not in ("failed", "skipped"):
                st["status"] = "failed"
                st["error"] = {"type": "qa_failed", "message": f"{QA_REPORTS[st['stage']]} ok=false",
                               "cut": None, "recoverable": True, "at": now_iso()}
        return data

    # ---------- queries ----------

    def next_stage(self, data: dict) -> dict:
        for st in data["stages"]:
            if st["status"] in DONE:
                continue
            item = {
                "stage": st["stage"], "name": st["name"], "status": st["status"],
                "kind": st["kind"], "gate": st["gate"], "hitl": st["hitl"],
                "pending_cuts": st["pending_cuts"], "attempts": st["attempts"],
                "error": st["error"],
            }
            if st["status"] == "failed":
                err = st["error"] or {}
                item["action"] = ("retry allowed" if err.get("recoverable", True)
                                  else "needs human (not recoverable)")
            elif st["hitl"]:
                item["action"] = "HITL: requires explicit human approval before start"
            else:
                item["action"] = "start"
            return item
        return {"stage": None, "action": "all stages complete", "status": "done"}

    def failed(self, data: dict) -> list[dict]:
        return [
            {"stage": st["stage"], "name": st["name"], "attempts": st["attempts"],
             "pending_cuts": st["pending_cuts"], "error": st["error"]}
            for st in data["stages"] if st["status"] == "failed"
        ]


# ---------- CLI commands ----------

def cmd_init(args) -> int:
    job = RenderJob(args.reel)
    data = job.load()
    if args.episode:
        data["episode"] = args.episode
    data = job.sync(data)
    job.save(data)
    print_json({"ok": True, "job": str(job.path), "episode": data["episode"],
                "cuts": len(data["cuts"]), "next": job.next_stage(data)})
    return 0


def cmd_sync(args) -> int:
    job = RenderJob(args.reel)
    if not job.exists():
        print_json({"ok": False, "error": f"no {JOB_FILE} — run init first"})
        return 2
    data = job.sync(job.load())
    job.save(data)
    print_json({"ok": True,
                "stages": {s["stage"]: s["status"] for s in data["stages"]},
                "next": job.next_stage(data)})
    return 0


def cmd_next(args) -> int:
    job = RenderJob(args.reel)
    if not job.exists():
        print_json({"ok": False, "error": f"no {JOB_FILE} — run init first"})
        return 2
    data = job.sync(job.load())
    job.save(data)
    print_json({"ok": True, **job.next_stage(data)})
    return 0


def cmd_start(args) -> int:
    job = RenderJob(args.reel)
    data = job.load()
    st = job.stage_of(data, args.stage)
    st["status"] = "in_progress"
    st["started_at"] = now_iso()
    st["attempts"] += 1
    st["error"] = None
    if args.note:
        st["notes"].append(args.note)
    if args.cut is not None:
        st["notes"].append(f"working cut {args.cut} (attempt {st['attempts']})")
    job.save(data)
    print_json({"ok": True, "stage": st["stage"], "status": st["status"],
                "attempts": st["attempts"]})
    return 0


def cmd_end(args) -> int:
    job = RenderJob(args.reel)
    data = job.load()
    st = job.stage_of(data, args.stage)
    if args.note:
        st["notes"].append(args.note)
    if args.cut is not None:
        # per-cut progress: re-scan; stage completes only when all cuts exist
        data = job.sync(data)
        st = job.stage_of(data, args.stage)
        if st["pending_cuts"]:
            st["status"] = "in_progress"
    else:
        st["status"] = "completed"
        st["ended_at"] = now_iso()
        data = job.sync(data)
        st = job.stage_of(data, args.stage)
    job.save(data)
    print_json({"ok": True, "stage": st["stage"], "status": st["status"],
                "pending_cuts": st["pending_cuts"], "next": job.next_stage(data)})
    return 0


def cmd_fail(args) -> int:
    job = RenderJob(args.reel)
    data = job.load()
    st = job.stage_of(data, args.stage)
    st["status"] = "failed"
    st["ended_at"] = now_iso()
    st["error"] = {
        "type": args.error_type,
        "message": args.message or "",
        "cut": args.cut,
        "recoverable": args.error_type in RECOVERABLE,
        "at": now_iso(),
    }
    if args.note:
        st["notes"].append(args.note)
    job.save(data)
    print_json({"ok": True, "stage": st["stage"], "status": "failed",
                "error": st["error"], "attempts": st["attempts"]})
    return 0


def cmd_skip(args) -> int:
    job = RenderJob(args.reel)
    data = job.load()
    st = job.stage_of(data, args.stage)
    st["status"] = "skipped"
    st["ended_at"] = now_iso()
    st["notes"].append(args.note or "skipped by operator")
    job.save(data)
    print_json({"ok": True, "stage": st["stage"], "status": "skipped",
                "next": job.next_stage(data)})
    return 0


def cmd_retry(args) -> int:
    job = RenderJob(args.reel)
    if not job.exists():
        print_json({"ok": False, "error": f"no {JOB_FILE} — run init first"})
        return 2
    data = job.sync(job.load())
    job.save(data)
    print_json({"ok": True, "failed": job.failed(data)})
    return 0


def cmd_status(args) -> int:
    job = RenderJob(args.reel)
    if not job.exists():
        print_json({"ok": False, "error": f"no {JOB_FILE} — run init first"})
        return 2
    data = job.load()
    if args.json:
        print_json(data)
        return 0
    print_json({
        "ok": True,
        "reel": data["reel_dir"],
        "episode": data["episode"],
        "topic": data["topic"],
        "cuts": len(data["cuts"]),
        "stages": [
            {"stage": s["stage"], "name": s["name"], "status": s["status"],
             "attempts": s["attempts"],
             **({"pending_cuts": s["pending_cuts"]} if s["pending_cuts"] else {}),
             **({"error": s["error"]["type"]} if s["error"] else {})}
            for s in data["stages"]
        ],
        "next": job.next_stage(data),
    })
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init", help="create render-job.json (safe to re-run)")
    p.add_argument("reel")
    p.add_argument("--episode")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("sync", help="re-scan disk evidence, refresh stage statuses")
    p.add_argument("reel")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("next", help="first actionable stage (director's dispatch input)")
    p.add_argument("reel")
    p.set_defaults(func=cmd_next)

    p = sub.add_parser("start", help="mark a stage in_progress (attempts += 1)")
    p.add_argument("reel")
    p.add_argument("stage")
    p.add_argument("--cut", type=int)
    p.add_argument("--note")
    p.set_defaults(func=cmd_start)

    p = sub.add_parser("end", help="mark a stage (or one cut) done; verifies via sync")
    p.add_argument("reel")
    p.add_argument("stage")
    p.add_argument("--cut", type=int)
    p.add_argument("--note")
    p.set_defaults(func=cmd_end)

    p = sub.add_parser("fail", help="record a failure with a standard error_type")
    p.add_argument("reel")
    p.add_argument("stage")
    p.add_argument("--cut", type=int)
    p.add_argument("--error-type", required=True, choices=ERROR_TYPES)
    p.add_argument("--message")
    p.add_argument("--note")
    p.set_defaults(func=cmd_fail)

    p = sub.add_parser("skip", help="mark a stage skipped (operator decision)")
    p.add_argument("reel")
    p.add_argument("stage")
    p.add_argument("--note")
    p.set_defaults(func=cmd_skip)

    p = sub.add_parser("retry", help="list failed stages/cuts awaiting retry")
    p.add_argument("reel")
    p.set_defaults(func=cmd_retry)

    p = sub.add_parser("status", help="summarize the job")
    p.add_argument("reel")
    p.add_argument("--json", action="store_true", help="dump the raw job file")
    p.set_defaults(func=cmd_status)

    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
