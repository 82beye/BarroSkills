#!/usr/bin/env python3
"""Local, resumable state machine for one BarroTube reel render job.

The file `<reel>/render-job.json` is the SSOT.  Query commands are read-only;
mutations are protected by a non-blocking reel lock and revision CAS.

Exit codes: 0 success, 2 usage/config, 3 blocked prerequisite/handoff,
4 recoverable failure (including lock/CAS), 5 fatal failure.
Every command prints exactly one JSON object on stdout.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

JOB_FILE = "render-job.json"
BACKUP_FILE = "render-job.v1.bak.json"
LOCK_FILE = "render-job.json.lock"
SCHEMA_V1 = "barrotube.render_job.v1"
SCHEMA = "barrotube.render_job.v2"

ERROR_TYPES = [
    "quota_or_paywall", "download_blocked", "stale_download", "option_drift",
    "account_drift", "file_attach_unavailable", "not_logged_in", "qa_failed",
    "connection_lost", "tls_block", "tcc_denied", "timeout", "other",
]
RECOVERABLE = {
    "quota_or_paywall", "stale_download", "option_drift", "account_drift",
    "file_attach_unavailable", "qa_failed", "connection_lost", "timeout", "other",
}

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
STAGE_INDEX = {stage["id"]: i for i, stage in enumerate(STAGES)}
QA_REPORTS = {
    "R3": "60_qa_report.images.json",
    "R5": "60_qa_report.videos.json",
    "R8": "60_qa_report.media.json",
}
DONE = ("completed", "skipped")


class JobError(Exception):
    exit_code = 5
    status = "fatal"

    def __init__(self, reason: str, stage: str | None = None):
        super().__init__(reason)
        self.reason = reason
        self.stage = stage


class ConfigError(JobError):
    exit_code = 2
    status = "usage_or_config"


class BlockedError(JobError):
    exit_code = 3
    status = "blocked"


class RecoverableError(JobError):
    exit_code = 4
    status = "recoverable_failure"


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ConfigError(message)


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def response(*, ok: bool, status: str, stage: str | None = None,
             reason: str | None = None, **extra: Any) -> dict:
    return {"ok": ok, "status": status, "stage": stage, "reason": reason, **extra}


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                   separators=(",", ":")).encode())


def load_cut_plan(reel: Path) -> list[dict]:
    """Reuse the deterministic reel parser without importing its CLI globals."""
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
        self.lock_path = self.reel / LOCK_FILE
        self.backup_path = self.reel / BACKUP_FILE
        self._loaded = False
        self._loaded_exists = False
        self._loaded_raw: bytes | None = None
        self._loaded_revision: int | None = None
        self._loaded_schema: str | None = None

    # ---------- persistence ----------

    def exists(self) -> bool:
        return self.path.is_file()

    @contextmanager
    def locked(self) -> Iterator[None]:
        self.reel.mkdir(parents=True, exist_ok=True)
        lock = self.lock_path.open("a+")
        try:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RecoverableError(f"reel lock busy: {self.lock_path}") from exc
            yield
        finally:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
            finally:
                lock.close()

    def load(self) -> dict:
        if self.exists():
            try:
                raw = self.path.read_bytes()
                data = json.loads(raw)
            except (OSError, json.JSONDecodeError) as exc:
                raise JobError(f"cannot read {self.path}: {exc}") from exc
            if not isinstance(data, dict):
                raise JobError(f"invalid job root in {self.path}")
            schema = data.get("schema", SCHEMA_V1)
            if schema not in (SCHEMA_V1, SCHEMA):
                raise ConfigError(f"unsupported job schema: {schema}")
            revision = data.get("revision") if schema == SCHEMA else None
            if schema == SCHEMA and (not isinstance(revision, int) or revision < 0):
                raise JobError("v2 job has invalid revision")
            self._loaded_exists = True
            self._loaded_raw = raw
            self._loaded_schema = schema
            self._loaded_revision = revision
        else:
            data = self._fresh()
            self._loaded_exists = False
            self._loaded_raw = None
            self._loaded_schema = None
            self._loaded_revision = None
        self._loaded = True
        return data

    def _fresh_stage(self, definition: dict) -> dict:
        return {
            "stage": definition["id"], "name": definition["name"],
            "kind": definition["kind"], "gate": definition.get("gate", False),
            "hitl": definition.get("hitl", False), "status": "pending",
            "started_at": None, "ended_at": None, "attempts": 0,
            "inputs": [], "input_sha256": None, "outputs": [],
            "output_sha256": None, "pending_cuts": [], "error": None,
            "error_history": [], "approvals": [], "notes": [],
            "stale": False, "stale_output_sha256": None, "qa_stale": False,
            "grandfathered_qa_sha256": None,
            "stale_cuts": {},
        }

    def _fresh(self) -> dict:
        timestamp = now_iso()
        return {
            "schema": SCHEMA, "revision": 0, "reel_dir": str(self.reel),
            "episode": None, "created_at": timestamp, "updated_at": timestamp,
            "topic": {"title": None, "status": "pending", "fact_check": None},
            "cuts": [], "stages": [self._fresh_stage(s) for s in STAGES],
            "migration": None,
        }

    def ensure_v2(self, data: dict) -> dict:
        old_schema = data.get("schema", SCHEMA_V1)
        if old_schema == SCHEMA_V1:
            data["schema"] = SCHEMA
            data["revision"] = 0
            data["migration"] = {
                "from": SCHEMA_V1, "at": now_iso(), "legacy_baseline_pending": True,
            }
        elif old_schema != SCHEMA:
            raise ConfigError(f"unsupported job schema: {old_schema}")
        data.setdefault("revision", 0)
        data.setdefault("migration", None)
        data.setdefault("cuts", [])
        data.setdefault("stages", [])

        by_id = {s.get("stage"): s for s in data["stages"] if isinstance(s, dict)}
        normalized = []
        for definition in STAGES:
            base = self._fresh_stage(definition)
            current = by_id.get(definition["id"], {})
            base.update(current)
            base["name"] = definition["name"]
            base["kind"] = definition["kind"]
            base["gate"] = definition.get("gate", False)
            base["hitl"] = definition.get("hitl", False)
            base.setdefault("error_history", [])
            if base.get("error") and not base["error_history"]:
                base["error_history"] = [base["error"]]
            base.setdefault("approvals", [])
            base.setdefault("inputs", [])
            base.setdefault("input_sha256", None)
            base.setdefault("output_sha256", None)
            base.setdefault("stale", False)
            base.setdefault("stale_output_sha256", None)
            base.setdefault("qa_stale", False)
            base.setdefault("grandfathered_qa_sha256", None)
            base.setdefault("stale_cuts", {})
            base["outputs"] = [self._coerce_artifact(x) for x in base.get("outputs", [])]
            normalized.append(base)
        data["stages"] = normalized

        for cut in data["cuts"]:
            cut.setdefault("attempts", {"R2": 0, "R4": 0})
            if isinstance(cut["attempts"], int):
                cut["attempts"] = {"R2": cut["attempts"], "R4": 0}
            cut.setdefault("error_history", [])
            cut.setdefault("evidence", {})
        return data

    def _coerce_artifact(self, value: Any) -> dict:
        if isinstance(value, dict):
            return {
                "path": value.get("path"), "sha256": value.get("sha256"),
                "bytes": value.get("bytes"), "ffprobe": value.get("ffprobe") or {},
            }
        path = Path(str(value))
        return self.artifact(path) or {
            "path": str(path), "sha256": None, "bytes": None, "ffprobe": {},
        }

    def _write_backup_once(self, raw: bytes) -> None:
        if self.backup_path.exists():
            return
        fd, temp_name = tempfile.mkstemp(prefix=f".{BACKUP_FILE}.", dir=self.reel)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temp_name, self.backup_path)
            except FileExistsError:
                pass
        finally:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass

    def save(self, data: dict) -> None:
        if not self._loaded:
            raise JobError("save requires load first")
        current_raw = self.path.read_bytes() if self.path.is_file() else None
        if self._loaded_exists:
            if current_raw is None:
                raise RecoverableError("CAS conflict: job disappeared after load")
            try:
                current = json.loads(current_raw)
            except json.JSONDecodeError as exc:
                raise RecoverableError("CAS conflict: job became unreadable") from exc
            if self._loaded_schema == SCHEMA:
                if current.get("revision") != self._loaded_revision:
                    raise RecoverableError(
                        f"CAS conflict: expected revision {self._loaded_revision}, "
                        f"found {current.get('revision')}")
            elif current_raw != self._loaded_raw:
                raise RecoverableError("CAS conflict: v1 job changed after load")
        elif current_raw is not None:
            raise RecoverableError("CAS conflict: job appeared after load")

        if self._loaded_schema == SCHEMA_V1 and self._loaded_raw is not None:
            self._write_backup_once(self._loaded_raw)
        self.ensure_v2(data)
        base_revision = self._loaded_revision if self._loaded_schema == SCHEMA else 0
        data["revision"] = int(base_revision or 0) + 1
        data["updated_at"] = now_iso()
        payload = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode()
        fd, temp_name = tempfile.mkstemp(prefix=f".{JOB_FILE}.", dir=self.reel)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, self.path)
        finally:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
        self._loaded_exists = True
        self._loaded_raw = payload
        self._loaded_schema = SCHEMA
        self._loaded_revision = data["revision"]

    @staticmethod
    def stage_of(data: dict, stage_id: str) -> dict:
        for stage in data.get("stages", []):
            if stage.get("stage") == stage_id:
                return stage
        raise ConfigError(f"unknown stage: {stage_id}", stage_id)

    # ---------- evidence ----------

    def ffprobe(self, path: Path) -> dict:
        if path.suffix.lower() != ".mp4":
            return {}
        try:
            output = subprocess.check_output([
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=codec_name,width,height:format=duration",
                "-of", "json", str(path),
            ], stderr=subprocess.DEVNULL, timeout=20)
            payload = json.loads(output)
            stream = (payload.get("streams") or [{}])[0]
            return {
                "duration": float((payload.get("format") or {}).get("duration", 0)),
                "codec": stream.get("codec_name"), "w": stream.get("width"),
                "h": stream.get("height"),
            }
        except (subprocess.SubprocessError, json.JSONDecodeError, OSError, ValueError):
            return {}

    def artifact(self, path: Path) -> dict | None:
        if not path.is_file():
            return None
        try:
            digest = hashlib.sha256()
            size = 0
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    size += len(chunk)
                    digest.update(chunk)
            try:
                label = str(path.resolve().relative_to(self.reel))
            except ValueError:
                label = str(path.resolve())
            return {"path": label, "sha256": digest.hexdigest(), "bytes": size,
                    "ffprobe": self.ffprobe(path)}
        except OSError:
            return None

    def image_artifact(self, path: Path) -> dict | None:
        artifact = self.artifact(path)
        if not artifact:
            return None
        try:
            with path.open("rb") as stream:
                header = stream.read(24)
        except OSError:
            return None
        if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n" \
                or header[12:16] != b"IHDR" \
                or int.from_bytes(header[16:20], "big") < 1 \
                or int.from_bytes(header[20:24], "big") < 1:
            return None
        return artifact

    def clip_artifact(self, path: Path) -> dict | None:
        artifact = self.artifact(path)
        probe = (artifact or {}).get("ffprobe") or {}
        if not artifact or not probe.get("codec") or not probe.get("w") \
                or not probe.get("h") or float(probe.get("duration") or 0) < 3:
            return None
        return artifact

    @staticmethod
    def artifact_digest(artifacts: list[dict], extra: Any = None) -> str:
        material = [{"path": a.get("path"), "sha256": a.get("sha256")}
                    for a in artifacts]
        return sha256_json({"artifacts": material, "extra": extra})

    def qa_ok(self, stage_id: str) -> bool | None:
        name = QA_REPORTS.get(stage_id)
        if not name:
            return None
        path = self.reel / name
        if not path.is_file():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or not isinstance(payload.get("ok"), bool):
                return None
            return payload["ok"]
        except (json.JSONDecodeError, OSError):
            return None

    def evidence(self, stage_id: str, cuts: list[dict]) -> tuple[bool, list[dict], list[int]]:
        reel = self.reel

        def found(*paths: Path) -> tuple[bool, list[dict], list[int]]:
            outputs = [item for item in (self.artifact(path) for path in paths) if item]
            return bool(paths) and len(outputs) == len(paths), outputs, []

        def found_clips(*paths: Path) -> tuple[bool, list[dict], list[int]]:
            outputs = [item for item in (self.clip_artifact(path) for path in paths) if item]
            return bool(paths) and len(outputs) == len(paths), outputs, []

        if stage_id == "R1":
            return found(reel / "script.md") if cuts else (False, [], [])
        if stage_id == "R2":
            pending, outputs = [], []
            seen: set[str] = set()
            for cut in cuts:
                output = self.image_artifact(Path(cut["image"])) \
                    or self.clip_artifact(reel / "video" / f"{cut['slug']}.mp4")
                if not output or output["sha256"] in seen:
                    pending.append(cut["cut"])
                else:
                    seen.add(output["sha256"])
                    outputs.append(output)
            return bool(cuts) and not pending, outputs, pending
        if stage_id == "R4":
            pending, outputs = [], []
            seen: set[str] = set()
            for cut in cuts:
                output = self.clip_artifact(reel / "video" / f"{cut['slug']}.mp4")
                if not output or output["sha256"] in seen:
                    pending.append(cut["cut"])
                else:
                    seen.add(output["sha256"])
                    outputs.append(output)
            return bool(cuts) and not pending, outputs, pending
        if stage_id in QA_REPORTS:
            path = reel / QA_REPORTS[stage_id]
            output = self.artifact(path)
            return self.qa_ok(stage_id) is True, ([output] if output else []), []
        if stage_id == "R6":
            return found_clips(reel / "55_render" / "video.mp4")
        if stage_id == "R7":
            return found_clips(reel / "56_capcut_export" / "video.mp4")
        if stage_id == "R9":
            directory = reel / "distribution" / "reels"
            paths = sorted(directory.glob("*.mp4")) if directory.is_dir() else []
            outputs = [item for item in (self.clip_artifact(path) for path in paths) if item]
            return bool(outputs), outputs, []
        if stage_id == "R10":
            try:
                from publish_gate import verify
                result = verify(reel)
            except (ImportError, OSError, ValueError):
                result = {"ok": False}
            return bool(result.get("ok")), [], []
        if stage_id == "R11":
            return found(reel / "90_timing" / "postmortem.md")
        return False, [], []

    def input_snapshot(self, stage_id: str, cuts: list[dict]) -> tuple[list[dict], str]:
        reel = self.reel
        paths: list[Path] = []
        extra: Any = None
        if stage_id == "R2":
            extra = [{key: cut.get(key) for key in
                      ("cut", "slug", "image", "image_instruction", "shot_type", "framing")}
                     for cut in cuts]
        elif stage_id == "R3":
            paths = [Path(cut["image"]) for cut in cuts]
        elif stage_id == "R4":
            paths = [Path(cut["image"]) for cut in cuts]
            extra = [{"cut": cut.get("cut"), "motion": cut.get("motion", "")}
                     for cut in cuts]
        elif stage_id in ("R5", "R6"):
            paths = [reel / "video" / f"{cut['slug']}.mp4" for cut in cuts]
            if stage_id == "R6":
                manifest: dict[str, Any] = {}
                manifest_path = reel / "55_render" / "master-bgm-mix.manifest.json"
                try:
                    loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
                    manifest = loaded if isinstance(loaded, dict) else {}
                except (OSError, json.JSONDecodeError):
                    pass

                def source_path(value: Any) -> Path | None:
                    if not isinstance(value, str) or not value:
                        return None
                    candidate = Path(value).expanduser()
                    return candidate if candidate.is_absolute() else reel / candidate

                manifest_clips = manifest.get("clips")
                if isinstance(manifest_clips, list) and manifest_clips:
                    resolved = [source_path(value) for value in manifest_clips]
                    paths = [path for path in resolved if path is not None]

                bgm = manifest.get("bgm") if isinstance(manifest.get("bgm"), dict) else {}
                bgm_path = source_path(bgm.get("source") or bgm.get("path"))
                sfx_rows = manifest.get("sfx") if isinstance(manifest.get("sfx"), list) else []
                sfx_paths = [source_path(row.get("source") or row.get("path") or row.get("file"))
                             for row in sfx_rows if isinstance(row, dict)]
                if not bgm_path:
                    audio = reel / "40_assets" / "bgm"
                    bgm_path = next(iter(sorted(
                        path for path in audio.rglob("*") if path.is_file()
                        and path.suffix.lower() in (".mp3", ".m4a", ".wav", ".aac", ".flac")
                    )), None) if audio.is_dir() else None
                if not any(sfx_paths):
                    audio = reel / "40_assets" / "sfx"
                    default_sfx = next(iter(sorted(
                        path for path in audio.rglob("*") if path.is_file()
                        and path.suffix.lower() in (".mp3", ".m4a", ".wav", ".aac", ".flac")
                    )), None) if audio.is_dir() else None
                    sfx_paths = [default_sfx] if default_sfx else []
                paths += [path for path in [bgm_path, *sfx_paths] if path is not None]

                transition = manifest.get("transition")
                transition = transition if isinstance(transition, dict) else {
                    "type": "smoothleft", "seconds": 0.35 if len(cuts) > 1 else 0.0,
                }
                clip_audio = manifest.get("clip_audio")
                clip_audio = clip_audio if isinstance(clip_audio, dict) else {}
                extra = {
                    "cuts": [{"cut": cut.get("cut"), "slug": cut.get("slug"),
                              "duration": cut.get("duration")} for cut in cuts],
                    "config": {
                        "transition": transition,
                        "bgm_volume": bgm.get("volume", 0.82),
                        "sfx_volume": next((row.get("volume") for row in sfx_rows
                                            if isinstance(row, dict) and row.get("volume") is not None),
                                           0.42 if sfx_paths else None),
                        "clip_audio_volume": clip_audio.get("volume", 0.25),
                        "audio_master": manifest.get(
                            "audio_master", "loudnorm=I=-16:TP=-1.5:LRA=11"),
                    },
                }
        elif stage_id == "R7":
            master = reel / "55_render" / "video.mp4"
            paths = [master] if master.is_file() else [
                reel / "video" / f"{cut['slug']}.mp4" for cut in cuts]
        elif stage_id in ("R8", "R9"):
            final = reel / "56_capcut_export" / "video.mp4"
            paths = [final if final.is_file() else reel / "55_render" / "video.mp4"]
        elif stage_id == "R10":
            final = reel / "56_capcut_export" / "video.mp4"
            paths = [final if final.is_file() else reel / "55_render" / "video.mp4",
                     reel / "70_publish_meta.instagram.json"]
        elif stage_id == "R11":
            paths = [reel / "90_timing" / "production-timing.json"]
        artifacts = [item for item in (self.artifact(path) for path in paths) if item]
        return artifacts, self.artifact_digest(artifacts, extra)

    def _merge_cuts(self, data: dict, plan: list[dict]) -> None:
        old = {cut.get("cut"): cut for cut in data.get("cuts", [])}
        merged = []
        for item in plan:
            cut = old.get(item["cut"], {})
            cut.update({
                "cut": item["cut"], "slug": item["slug"], "image": item["image"],
                "video": str(self.reel / "video" / f"{item['slug']}.mp4"),
                "motion": item.get("motion", ""), "caption": item.get("caption", ""),
            })
            cut.setdefault("attempts", {"R2": 0, "R4": 0})
            cut.setdefault("error_history", [])
            cut.setdefault("evidence", {})
            merged.append(cut)
        data["cuts"] = merged

    def _cut_snapshot(self, cut: dict, item: dict) -> dict:
        image = self.image_artifact(Path(cut["image"]))
        video = self.clip_artifact(Path(cut["video"]))
        motion_sha = sha256_bytes(item.get("motion", "").encode())
        prior_r2 = (cut.get("evidence") or {}).get("R2") or {}
        prior_r4 = (cut.get("evidence") or {}).get("R4") or {}
        prior_r2_output = prior_r2.get("output")
        prior_r4_artifact = prior_r4.get("input")
        if not prior_r4_artifact and str((prior_r2_output or {}).get("path", "")).lower() \
                .endswith(".png"):
            prior_r4_artifact = prior_r2_output
        consumed_input = image or (prior_r4_artifact if video else None)
        prior_r4_input = prior_r4.get("input_sha256")
        r4_input = prior_r4_input if not image and video and prior_r4_input \
            and prior_r4.get("motion_sha256") == motion_sha else sha256_json({
            "image_sha256": consumed_input.get("sha256") if consumed_input else None,
            "motion": item.get("motion", ""),
        })
        consumed_output = image or (prior_r2_output if video and prior_r2_output else video)
        return {
            "R2": {
                "input_sha256": sha256_json({key: item.get(key) for key in
                                               ("cut", "slug", "image", "image_instruction",
                                                "shot_type", "framing")}),
                # Once a still has been consumed, its valid clip is durable
                # downstream proof; cleanup must not trigger a paid re-render.
                "output": consumed_output,
            },
            "R4": {
                "input_sha256": r4_input,
                "motion_sha256": motion_sha,
                "input": consumed_input,
                "output": video,
            },
        }

    def _cut_evidence(self, data: dict, plan: list[dict]) -> None:
        by_number = {item["cut"]: item for item in plan}
        for cut in data.get("cuts", []):
            cut["evidence"] = self._cut_snapshot(
                cut, by_number.get(cut["cut"], cut))

    @staticmethod
    def prerequisites_done(data: dict, stage_id: str) -> bool:
        index = STAGE_INDEX[stage_id]
        statuses = {stage.get("stage"): stage.get("status") for stage in data["stages"]}
        return all(statuses.get(stage["id"]) in DONE for stage in STAGES[:index])

    def require_prerequisites(self, data: dict, stage_id: str) -> None:
        index = STAGE_INDEX.get(stage_id)
        if index is None:
            raise ConfigError(f"unknown stage: {stage_id}", stage_id)
        missing = [definition["id"] for definition in STAGES[:index]
                   if self.stage_of(data, definition["id"]).get("status") not in DONE]
        if missing:
            raise BlockedError(f"prerequisites incomplete: {', '.join(missing)}", stage_id)

    def _invalidate_from(self, data: dict, index: int, reason: str,
                         snapshots: dict[str, tuple[list[dict], str, list[dict], str]]) -> None:
        timestamp = now_iso()
        for stage in data["stages"][index:]:
            sid = stage["stage"]
            if not stage.get("stale"):
                stage["notes"].append(f"invalidated: {reason}")
                stage["stale_output_sha256"] = snapshots[sid][3]
            stage["status"] = "pending"
            stage["ended_at"] = None
            stage["error"] = None
            stage["stale"] = True
            stage["invalidated_at"] = timestamp
            if sid in QA_REPORTS:
                stage["qa_stale"] = True

    def sync(self, data: dict) -> dict:
        """Refresh evidence; never auto-complete manual, gate, HITL, or R11."""
        self.ensure_v2(data)
        plan = load_cut_plan(self.reel)
        if plan:
            self._merge_cuts(data, plan)
        cuts = plan or data.get("cuts", [])
        migration = data.get("migration") or {}
        legacy_baseline = bool(migration.get("legacy_baseline_pending"))
        plan_by_cut = {item["cut"]: item for item in plan}
        cut_changes: dict[str, dict[str, str | None]] = {"R2": {}, "R4": {}}
        if not legacy_baseline:
            for cut in data.get("cuts", []):
                current = self._cut_snapshot(cut, plan_by_cut.get(cut["cut"], cut))
                previous = cut.get("evidence") or {}
                for sid in ("R2", "R4"):
                    old_input = (previous.get(sid) or {}).get("input_sha256")
                    if old_input and old_input != current[sid]["input_sha256"]:
                        old_output = (previous.get(sid) or {}).get("output") or {}
                        cut_changes[sid][str(cut["cut"])] = old_output.get("sha256")

        cut_snapshots = {str(cut["cut"]): self._cut_snapshot(
            cut, plan_by_cut.get(cut["cut"], cut)) for cut in data.get("cuts", [])}
        consumed_cleanup = any(
            self.image_artifact(Path(cut["image"])) is None
            and self.clip_artifact(Path(cut["video"])) is not None
            and (cut_snapshots.get(str(cut["cut"]), {}).get("R4") or {}).get("input")
            for cut in data.get("cuts", []))
        consumed_clip_cleanup = any(
            self.clip_artifact(Path(cut["video"])) is None
            and ((cut.get("evidence") or {}).get("R4") or {}).get("output")
            and self.clip_artifact(self.reel / "55_render" / "video.mp4")
            for cut in data.get("cuts", []))

        snapshots: dict[str, tuple[list[dict], str, list[dict], str]] = {}
        complete_by_stage: dict[str, bool] = {}
        pending_by_stage: dict[str, list[int]] = {}
        for stage in data["stages"]:
            sid = stage["stage"]
            complete, outputs, pending = self.evidence(sid, cuts)
            inputs, input_hash = self.input_snapshot(sid, cuts)
            if consumed_cleanup and sid == "R2":
                outputs = [snapshot["R2"]["output"] for snapshot in cut_snapshots.values()
                           if snapshot["R2"].get("output")]
            if consumed_cleanup and sid in ("R3", "R4"):
                inputs = [snapshot["R4"]["input"] for snapshot in cut_snapshots.values()
                          if snapshot["R4"].get("input")]
                extra = None if sid == "R3" else [
                    {"cut": cut.get("cut"), "motion": cut.get("motion", "")}
                    for cut in cuts]
                input_hash = self.artifact_digest(inputs, extra)
            if consumed_clip_cleanup and sid == "R4":
                prior = [((cut.get("evidence") or {}).get("R4") or {}).get("output")
                         for cut in data.get("cuts", [])]
                prior = [item for item in prior if item]
                if prior:
                    complete, pending, outputs = True, [], prior
                    inputs = [((cut.get("evidence") or {}).get("R4") or {}).get("input")
                              for cut in data.get("cuts", [])]
                    inputs = [item for item in inputs if item]
                    input_hash = self.stage_of(data, "R4").get("input_sha256") or input_hash
            if consumed_clip_cleanup and sid in ("R5", "R6"):
                source_stage = self.stage_of(data, sid)
                if source_stage.get("status") in DONE and source_stage.get("inputs"):
                    inputs = source_stage["inputs"]
                    input_hash = source_stage.get("input_sha256") or input_hash
            output_hash = self.artifact_digest(outputs)
            snapshots[sid] = (inputs, input_hash, outputs, output_hash)
            complete_by_stage[sid] = complete
            pending_by_stage[sid] = pending

        for sid, changed in cut_changes.items():
            self.stage_of(data, sid).setdefault("stale_cuts", {}).update(changed)

        earliest: tuple[int, str] | None = None
        if not legacy_baseline:
            for sid, changed in cut_changes.items():
                if changed:
                    earliest = (STAGE_INDEX[sid], f"{sid} cut input SHA-256 changed")
                    break
            for index, stage in enumerate(data["stages"]):
                sid = stage["stage"]
                _, input_hash, _, output_hash = snapshots[sid]
                old_input = stage.get("input_sha256")
                old_output = stage.get("output_sha256")
                if old_input and old_input != input_hash:
                    candidate = (index, f"{sid} input SHA-256 changed")
                    if earliest is None or candidate[0] < earliest[0]:
                        earliest = candidate
                elif stage.get("status") in DONE and old_output \
                        and old_output != output_hash:
                    if sid == "R1" and complete_by_stage[sid]:
                        continue
                    # A replaced output is the new owner evidence and only makes
                    # consumers stale. A missing output makes its owner stale too.
                    start = index if sid == "R4" else (index + 1 if complete_by_stage[sid] else index)
                    if start < len(STAGES):
                        candidate = (start, f"{sid} output SHA-256 changed")
                        if earliest is None or candidate[0] < earliest[0]:
                            earliest = candidate
        if earliest:
            self._invalidate_from(data, earliest[0], earliest[1], snapshots)

        for index, stage in enumerate(data["stages"]):
            sid = stage["stage"]
            inputs, input_hash, outputs, output_hash = snapshots[sid]
            stage["inputs"] = inputs
            stage["input_sha256"] = input_hash
            stage["outputs"] = outputs
            stage["output_sha256"] = output_hash
            stale_cuts = stage.setdefault("stale_cuts", {})
            if sid in ("R2", "R4"):
                by_cut = {str(cut["cut"]): self._cut_snapshot(
                    cut, plan_by_cut.get(cut["cut"], cut))[sid]
                    for cut in data.get("cuts", [])}
                for cut_number, old_output in list(stale_cuts.items()):
                    current_output = (by_cut.get(cut_number) or {}).get("output") or {}
                    if current_output.get("sha256") \
                            and current_output.get("sha256") != old_output:
                        del stale_cuts[cut_number]
            stage["pending_cuts"] = sorted(set(pending_by_stage[sid]) | {
                int(number) for number in stale_cuts
            })

            report_sha = outputs[0].get("sha256") if sid in QA_REPORTS and outputs else None
            if legacy_baseline and stage.get("status") in DONE and report_sha:
                stage["grandfathered_qa_sha256"] = report_sha
            grandfathered = bool(report_sha) and report_sha == stage.get(
                "grandfathered_qa_sha256")
            if report_sha and stage.get("grandfathered_qa_sha256") and not grandfathered:
                stage["grandfathered_qa_sha256"] = None

            if sid in QA_REPORTS and self.qa_ok(sid) is False \
                    and not grandfathered \
                    and stage.get("status") not in ("failed", "skipped"):
                error = {"type": "qa_failed", "message": f"{QA_REPORTS[sid]} ok=false",
                         "cut": None, "recoverable": True, "at": now_iso()}
                stage["status"] = "failed"
                stage["error"] = error
                stage["error_history"].append(error)
                continue

            guarded = stage["kind"] == "manual" or stage.get("gate") \
                or stage.get("hitl") or sid == "R11"
            if guarded or stage.get("status") == "failed":
                continue
            if stage.get("status") in ("pending", "in_progress") \
                    and complete_by_stage[sid] and not stage["pending_cuts"] \
                    and self.prerequisites_done(data, sid):
                stale_hash = stage.get("stale_output_sha256")
                if stage.get("stale") and stale_hash == output_hash:
                    continue
                stage["status"] = "completed"
                stage["ended_at"] = stage.get("ended_at") or now_iso()
                stage["stale"] = False
                stage["stale_output_sha256"] = None
                stage["stale_cuts"] = {}
                stage["notes"].append("auto: hash-bound outputs found on disk")

        if legacy_baseline:
            migration["legacy_baseline_pending"] = False
            migration["baseline_at"] = now_iso()
            data["migration"] = migration
        self._cut_evidence(data, cuts)
        return data

    # ---------- queries ----------

    def next_stage(self, data: dict) -> dict:
        for stage in data.get("stages", []):
            if stage.get("status") in DONE:
                continue
            item = {
                "stage": stage.get("stage"), "name": stage.get("name"),
                "status": stage.get("status"), "kind": stage.get("kind"),
                "gate": stage.get("gate", False), "hitl": stage.get("hitl", False),
                "pending_cuts": stage.get("pending_cuts", []),
                "attempts": stage.get("attempts", 0), "error": stage.get("error"),
            }
            if stage.get("status") == "failed":
                item["action"] = "retry allowed" if (stage.get("error") or {}).get(
                    "recoverable", True) else "needs human (not recoverable)"
            elif stage.get("hitl"):
                item["action"] = "HITL: explicit approval required"
            else:
                item["action"] = "start"
            return item
        return {"stage": None, "action": "all stages complete", "status": "done"}

    def failed(self, data: dict) -> list[dict]:
        return [{
            "stage": stage.get("stage"), "name": stage.get("name"),
            "attempts": stage.get("attempts", 0),
            "pending_cuts": stage.get("pending_cuts", []),
            "error": stage.get("error"), "error_history": stage.get("error_history", []),
        } for stage in data.get("stages", []) if stage.get("status") == "failed"]

    def cut_of(self, data: dict, number: int, stage_id: str) -> dict:
        if self.stage_of(data, stage_id).get("kind") != "per_cut":
            raise ConfigError(f"--cut is only valid for per-cut stages, not {stage_id}", stage_id)
        for cut in data.get("cuts", []):
            if cut.get("cut") == number:
                return cut
        raise ConfigError(f"unknown cut: {number}", stage_id)


def parse_approval(value: str | None, stage: str) -> dict:
    actor, separator, note = (value or "").partition(":")
    if not separator or not actor.strip() or not note.strip():
        raise ConfigError("--approve must be 'by: reason'", stage)
    return {"by": actor.strip(), "at": now_iso(), "note": note.strip()}


def require_approval(stage: dict, value: str | None) -> dict | None:
    if stage.get("gate") or stage.get("hitl"):
        return parse_approval(value, stage["stage"])
    if value:
        return parse_approval(value, stage["stage"])
    return None


def command_result(stage: dict | None = None, **extra: Any) -> dict:
    return response(ok=True, status="completed", stage=(stage or {}).get("stage"),
                    reason=None,
                    **({"stage_status": stage.get("status")} if stage else {}),
                    **extra)


# ---------- CLI commands ----------

def cmd_init(args) -> tuple[int, dict]:
    job = RenderJob(args.reel)
    with job.locked():
        data = job.load()
        job.ensure_v2(data)
        if args.episode:
            data["episode"] = args.episode
        data = job.sync(data)
        job.save(data)
    return 0, command_result(job=str(job.path), episode=data.get("episode"),
                             cuts=len(data.get("cuts", [])), next=job.next_stage(data),
                             revision=data["revision"])


def cmd_sync(args) -> tuple[int, dict]:
    job = RenderJob(args.reel)
    if not job.exists():
        raise ConfigError(f"no {JOB_FILE} — run init first")
    with job.locked():
        data = job.sync(job.load())
        job.save(data)
    return 0, command_result(
        stages={stage["stage"]: stage["status"] for stage in data["stages"]},
        next=job.next_stage(data), revision=data["revision"])


def cmd_next(args) -> tuple[int, dict]:
    job = RenderJob(args.reel)
    if not job.exists():
        raise ConfigError(f"no {JOB_FILE} — run init first")
    data = job.load()  # deliberately read-only: no sync, migration, or save
    item = job.next_stage(data)
    return 0, response(ok=True, status="completed", stage=item.get("stage"),
                       reason=None, stage_status=item.get("status"), **{
                           key: value for key, value in item.items()
                           if key not in ("status", "stage")})


def cmd_start(args) -> tuple[int, dict]:
    job = RenderJob(args.reel)
    with job.locked():
        data = job.sync(job.load())
        stage = job.stage_of(data, args.stage)
        job.require_prerequisites(data, args.stage)
        if stage.get("status") in DONE:
            raise ConfigError(f"stage already {stage['status']}", args.stage)
        stage["status"] = "in_progress"
        stage["started_at"] = now_iso()
        stage["attempts"] = int(stage.get("attempts", 0)) + 1
        stage["error"] = None
        if args.note:
            stage["notes"].append(args.note)
        if args.cut is not None:
            cut = job.cut_of(data, args.cut, args.stage)
            cut["attempts"][args.stage] = int(cut["attempts"].get(args.stage, 0)) + 1
            stage["notes"].append(
                f"working cut {args.cut} (attempt {cut['attempts'][args.stage]})")
        job.save(data)
    return 0, command_result(stage, attempts=stage["attempts"], revision=data["revision"])


def _verify_r10(job: RenderJob) -> dict:
    try:
        from publish_gate import verify
    except ImportError as exc:
        raise ConfigError("approval verifier unavailable", "R10") from exc
    result = verify(job.reel)
    if not result.get("ok"):
        raise ConfigError(
            result.get("reason") or "valid approval required", "R10"
        )
    return result


def cmd_end(args) -> tuple[int, dict]:
    job = RenderJob(args.reel)
    with job.locked():
        data = job.sync(job.load())
        stage = job.stage_of(data, args.stage)
        job.require_prerequisites(data, args.stage)
        approval = require_approval(stage, args.approve)
        if args.cut is None and stage.get("stale") and stage.get("kind") != "manual" \
                and stage.get("stale_output_sha256") == stage.get("output_sha256"):
            raise ConfigError(f"{args.stage} requires fresh output evidence", args.stage)
        if args.cut is not None:
            job.cut_of(data, args.cut, args.stage)
            stage.setdefault("stale_cuts", {}).pop(str(args.cut), None)
            if stage["pending_cuts"]:
                stage["status"] = "in_progress"
            else:
                stage["status"] = "completed"
                stage["ended_at"] = now_iso()
        else:
            remaining_stale = sorted(int(number) for number in stage.get("stale_cuts", {}))
            if remaining_stale:
                raise BlockedError(
                    f"{args.stage} has stale cuts: {', '.join(map(str, remaining_stale))}",
                    args.stage,
                )
            if args.stage == "R10":
                receipt = _verify_r10(job)
            if args.stage == "R11" and not (job.reel / "90_timing" / "postmortem.md").is_file():
                raise ConfigError("R11 requires 90_timing/postmortem.md", "R11")
            complete, _, pending = job.evidence(args.stage, load_cut_plan(job.reel))
            if stage["kind"] != "manual" and not complete:
                raise ConfigError(f"{args.stage} completion evidence is missing", args.stage)
            stage["pending_cuts"] = pending
            stage["status"] = "completed"
            stage["ended_at"] = now_iso()
        if args.note:
            stage["notes"].append(args.note)
        if approval:
            stage["approvals"].append(approval)
        stage["stale"] = False
        stage["stale_output_sha256"] = None
        if args.cut is None:
            stage["stale_cuts"] = {}
        stage["qa_stale"] = False
        job.save(data)
    return 0, command_result(stage, pending_cuts=stage["pending_cuts"],
                             next=job.next_stage(data), revision=data["revision"])


def cmd_fail(args) -> tuple[int, dict]:
    job = RenderJob(args.reel)
    with job.locked():
        data = job.sync(job.load())
        stage = job.stage_of(data, args.stage)
        cut = job.cut_of(data, args.cut, args.stage) if args.cut is not None else None
        error = {
            "type": args.error_type, "message": args.message or "", "cut": args.cut,
            "recoverable": args.error_type in RECOVERABLE, "at": now_iso(),
        }
        stage["status"] = "failed"
        stage["ended_at"] = now_iso()
        stage["error"] = error
        stage["error_history"].append(error)
        if cut is not None:
            cut["error_history"].append({"stage": args.stage, **error})
        if args.note:
            stage["notes"].append(args.note)
        job.save(data)
    code = 4 if error["recoverable"] else 5
    result_status = "recoverable_failure" if error["recoverable"] else "fatal"
    return code, response(ok=False, status=result_status, stage=args.stage,
                          reason=error["message"] or error["type"], error=error,
                          attempts=stage["attempts"], revision=data["revision"])


def cmd_skip(args) -> tuple[int, dict]:
    job = RenderJob(args.reel)
    with job.locked():
        data = job.sync(job.load())
        stage = job.stage_of(data, args.stage)
        job.require_prerequisites(data, args.stage)
        if args.stage == "R11":
            raise ConfigError("R11 cannot be skipped; write postmortem.md and end it", "R11")
        approval = require_approval(stage, args.approve)
        stage["status"] = "skipped"
        stage["ended_at"] = now_iso()
        stage["notes"].append(args.note or "skipped by operator")
        if approval:
            stage["approvals"].append(approval)
        stage["stale"] = False
        stage["stale_cuts"] = {}
        job.save(data)
    return 0, command_result(stage, next=job.next_stage(data), revision=data["revision"])


def cmd_retry(args) -> tuple[int, dict]:
    job = RenderJob(args.reel)
    if not job.exists():
        raise ConfigError(f"no {JOB_FILE} — run init first")
    data = job.load()
    return 0, command_result(failed=job.failed(data))


def cmd_status(args) -> tuple[int, dict]:
    job = RenderJob(args.reel)
    if not job.exists():
        raise ConfigError(f"no {JOB_FILE} — run init first")
    data = job.load()  # deliberately read-only: no migration or save
    if args.json:
        result = dict(data)
        result.update({"ok": True, "status": "completed", "stage": None, "reason": None})
        return 0, result
    result = response(
        ok=True, status="completed", stage=None, reason=None,
        reel=data.get("reel_dir"), episode=data.get("episode"), topic=data.get("topic"),
        cuts=len(data.get("cuts", [])), stages=[{
            "stage": stage.get("stage"), "name": stage.get("name"),
            "status": stage.get("status"), "attempts": stage.get("attempts", 0),
            **({"pending_cuts": stage.get("pending_cuts")}
               if stage.get("pending_cuts") else {}),
            **({"error": stage["error"].get("type")} if stage.get("error") else {}),
        } for stage in data.get("stages", [])], next=job.next_stage(data),
        revision=data.get("revision"))
    return 0, result


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    command = sub.add_parser("init", help="create or migrate render-job.json")
    command.add_argument("reel")
    command.add_argument("--episode")
    command.set_defaults(func=cmd_init)

    command = sub.add_parser("sync", help="refresh hash-bound disk evidence")
    command.add_argument("reel")
    command.set_defaults(func=cmd_sync)

    command = sub.add_parser("next", help="read-only first actionable stage")
    command.add_argument("reel")
    command.set_defaults(func=cmd_next)

    command = sub.add_parser("start", help="mark a stage in_progress")
    command.add_argument("reel")
    command.add_argument("stage")
    command.add_argument("--cut", type=int)
    command.add_argument("--note")
    command.set_defaults(func=cmd_start)

    command = sub.add_parser("end", help="explicitly complete a stage or cut")
    command.add_argument("reel")
    command.add_argument("stage")
    command.add_argument("--cut", type=int)
    command.add_argument("--note")
    command.add_argument("--approve", help="required for gate/HITL: 'by: reason'")
    command.set_defaults(func=cmd_end)

    command = sub.add_parser("fail", help="record a standard failure")
    command.add_argument("reel")
    command.add_argument("stage")
    command.add_argument("--cut", type=int)
    command.add_argument("--error-type", required=True, choices=ERROR_TYPES)
    command.add_argument("--message")
    command.add_argument("--note")
    command.set_defaults(func=cmd_fail)

    command = sub.add_parser("skip", help="skip a stage by explicit decision")
    command.add_argument("reel")
    command.add_argument("stage")
    command.add_argument("--note")
    command.add_argument("--approve", help="required for gate/HITL: 'by: reason'")
    command.set_defaults(func=cmd_skip)

    command = sub.add_parser("retry", help="read-only failed-stage list")
    command.add_argument("reel")
    command.set_defaults(func=cmd_retry)

    command = sub.add_parser("status", help="read-only job status")
    command.add_argument("reel")
    command.add_argument("--json", action="store_true")
    command.set_defaults(func=cmd_status)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        code, payload = args.func(args)
    except JobError as exc:
        code = exc.exit_code
        payload = response(ok=False, status=exc.status, stage=exc.stage, reason=exc.reason)
    except KeyboardInterrupt:
        code = 4
        payload = response(ok=False, status="recoverable_failure", stage=None,
                           reason="interrupted")
    except Exception as exc:  # final CLI boundary: never lose the JSON contract
        code = 5
        payload = response(ok=False, status="fatal", stage=None,
                           reason=f"{type(exc).__name__}: {exc}")
    print_json(payload)
    return code


if __name__ == "__main__":
    sys.exit(main())
