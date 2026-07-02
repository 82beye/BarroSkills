#!/usr/bin/env python3
"""Track BarroTube reel production time by pipeline step.

The timer writes two files under a reel directory:

  90_timing/production-timing.json
  90_timing/production-timing.md

Use the CLI for browser/manual stages:

  python3 production_timer.py start <reel> chatgpt_images --label "ChatGPT images"
  python3 production_timer.py end <reel> chatgpt_images
  python3 production_timer.py run <reel> ffmpeg_master -- ffmpeg ...

Import ProductionTimer from render scripts for automatic timing.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator


TIMING_DIR = "90_timing"
TIMING_JSON = "production-timing.json"
TIMING_MD = "production-timing.md"


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value)


def seconds_between(started_at: str | None, ended_at: str | None) -> float | None:
    started = parse_time(started_at)
    ended = parse_time(ended_at)
    if not started or not ended:
        return None
    return round((ended - started).total_seconds(), 3)


def fmt_duration(seconds: float | int | None) -> str:
    if seconds is None:
        return ""
    seconds = int(round(float(seconds)))
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}h {minutes}m {secs}s"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


class ProductionTimer:
    def __init__(self, reel_dir: str | Path):
        self.reel_dir = Path(reel_dir).expanduser().resolve()
        self.timing_dir = self.reel_dir / TIMING_DIR
        self.json_path = self.timing_dir / TIMING_JSON
        self.md_path = self.timing_dir / TIMING_MD

    def load(self) -> dict[str, Any]:
        if self.json_path.exists():
            return json.loads(self.json_path.read_text(encoding="utf-8"))
        return {
            "schema": "barrotube.production_timing.v1",
            "reel_dir": str(self.reel_dir),
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "steps": [],
            "events": [],
        }

    def save(self, data: dict[str, Any]) -> None:
        data["updated_at"] = now_iso()
        self.timing_dir.mkdir(parents=True, exist_ok=True)
        self.json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        self.md_path.write_text(self.to_markdown(data), encoding="utf-8")

    def find_step(self, data: dict[str, Any], step_id: str) -> dict[str, Any] | None:
        for step in data["steps"]:
            if step.get("id") == step_id:
                return step
        return None

    def start(self, step_id: str, label: str | None = None, note: str | None = None) -> dict[str, Any]:
        data = self.load()
        step = self.find_step(data, step_id)
        if step is None:
            step = {
                "id": step_id,
                "label": label or step_id,
                "status": "running",
                "started_at": now_iso(),
                "ended_at": None,
                "duration_seconds": None,
                "notes": [],
            }
            data["steps"].append(step)
        else:
            step["label"] = label or step.get("label") or step_id
            step["status"] = "running"
            step["started_at"] = now_iso()
            step["ended_at"] = None
            step["duration_seconds"] = None
        if note:
            step.setdefault("notes", []).append(note)
        self.save(data)
        return step

    def end(self, step_id: str, status: str = "completed", note: str | None = None) -> dict[str, Any]:
        data = self.load()
        step = self.find_step(data, step_id)
        if step is None:
            step = {
                "id": step_id,
                "label": step_id,
                "started_at": None,
                "notes": [],
            }
            data["steps"].append(step)
        step["status"] = status
        step["ended_at"] = now_iso()
        step["duration_seconds"] = seconds_between(step.get("started_at"), step.get("ended_at"))
        if note:
            step.setdefault("notes", []).append(note)
        self.save(data)
        return step

    def event(self, label: str, note: str | None = None) -> dict[str, Any]:
        data = self.load()
        event = {"at": now_iso(), "label": label, "note": note or ""}
        data["events"].append(event)
        self.save(data)
        return event

    @contextlib.contextmanager
    def step(self, step_id: str, label: str | None = None, note: str | None = None) -> Iterator[None]:
        self.start(step_id, label, note)
        try:
            yield
        except Exception as exc:
            self.end(step_id, "failed", f"{type(exc).__name__}: {exc}")
            raise
        else:
            self.end(step_id)

    def to_markdown(self, data: dict[str, Any]) -> str:
        steps = data.get("steps", [])
        completed = [s for s in steps if s.get("started_at") and s.get("ended_at")]
        first_start = min((parse_time(s["started_at"]) for s in completed), default=None)
        last_end = max((parse_time(s["ended_at"]) for s in completed), default=None)
        wall_seconds = round((last_end - first_start).total_seconds(), 3) if first_start and last_end else None
        active_seconds = round(sum(float(s.get("duration_seconds") or 0) for s in completed), 3)
        bottleneck = max(completed, key=lambda s: float(s.get("duration_seconds") or 0), default=None)

        lines = [
            "# Production Timing",
            "",
            f"- Reel: `{data.get('reel_dir', self.reel_dir)}`",
            f"- Created: `{data.get('created_at', '')}`",
            f"- Updated: `{data.get('updated_at', '')}`",
            f"- Wall-clock total: `{fmt_duration(wall_seconds)}`",
            f"- Sum of completed steps: `{fmt_duration(active_seconds)}`",
        ]
        if bottleneck:
            lines.append(
                f"- Longest step: `{bottleneck.get('label') or bottleneck.get('id')}` "
                f"({fmt_duration(bottleneck.get('duration_seconds'))})"
            )
        lines.extend([
            "",
            "| Step | Status | Started | Ended | Duration | Notes |",
            "| --- | --- | --- | --- | ---: | --- |",
        ])
        for step in steps:
            notes = "<br>".join(step.get("notes") or [])
            lines.append(
                "| {label} | {status} | {started} | {ended} | {duration} | {notes} |".format(
                    label=step.get("label") or step.get("id"),
                    status=step.get("status") or "",
                    started=step.get("started_at") or "",
                    ended=step.get("ended_at") or "",
                    duration=fmt_duration(step.get("duration_seconds")),
                    notes=notes.replace("|", "\\|"),
                )
            )
        events = data.get("events") or []
        if events:
            lines.extend(["", "## Events", ""])
            for event in events:
                note = f" - {event.get('note')}" if event.get("note") else ""
                lines.append(f"- `{event.get('at')}` {event.get('label')}{note}")
        lines.append("")
        return "\n".join(lines)


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def cmd_init(args: argparse.Namespace) -> int:
    timer = ProductionTimer(args.reel)
    data = timer.load()
    if args.episode:
        data["episode"] = args.episode
    if args.note:
        data.setdefault("events", []).append({"at": now_iso(), "label": "init", "note": args.note})
    timer.save(data)
    print_json({"ok": True, "json": str(timer.json_path), "markdown": str(timer.md_path)})
    return 0


def cmd_start(args: argparse.Namespace) -> int:
    step = ProductionTimer(args.reel).start(args.step, args.label, args.note)
    print_json({"ok": True, "step": step})
    return 0


def cmd_end(args: argparse.Namespace) -> int:
    step = ProductionTimer(args.reel).end(args.step, args.status, args.note)
    print_json({"ok": True, "step": step})
    return 0


def cmd_event(args: argparse.Namespace) -> int:
    event = ProductionTimer(args.reel).event(args.label, args.note)
    print_json({"ok": True, "event": event})
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    if not args.command:
        raise SystemExit("run requires a command after --")
    timer = ProductionTimer(args.reel)
    started = time.monotonic()
    timer.start(args.step, args.label, args.note)
    proc = subprocess.run(args.command)
    elapsed = round(time.monotonic() - started, 3)
    status = "completed" if proc.returncode == 0 else "failed"
    timer.end(args.step, status, f"command_exit={proc.returncode}; elapsed_monotonic={elapsed}s")
    return proc.returncode


def cmd_summary(args: argparse.Namespace) -> int:
    timer = ProductionTimer(args.reel)
    data = timer.load()
    timer.save(data)
    if args.markdown:
        print(timer.md_path.read_text(encoding="utf-8"))
    else:
        print_json(data)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init", help="create timing files")
    p.add_argument("reel")
    p.add_argument("--episode")
    p.add_argument("--note")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("start", help="mark a production step as started")
    p.add_argument("reel")
    p.add_argument("step")
    p.add_argument("--label")
    p.add_argument("--note")
    p.set_defaults(func=cmd_start)

    p = sub.add_parser("end", help="mark a production step as ended")
    p.add_argument("reel")
    p.add_argument("step")
    p.add_argument("--status", default="completed", choices=["completed", "failed", "skipped"])
    p.add_argument("--note")
    p.set_defaults(func=cmd_end)

    p = sub.add_parser("event", help="add a timestamped note")
    p.add_argument("reel")
    p.add_argument("label")
    p.add_argument("--note")
    p.set_defaults(func=cmd_event)

    p = sub.add_parser("run", help="time a shell command")
    p.add_argument("reel")
    p.add_argument("step")
    p.add_argument("--label")
    p.add_argument("--note")
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("summary", help="print timing data and refresh markdown")
    p.add_argument("reel")
    p.add_argument("--markdown", action="store_true")
    p.set_defaults(func=cmd_summary)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if getattr(args, "command", None) and args.command[:1] == ["--"]:
        args.command = args.command[1:]
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
