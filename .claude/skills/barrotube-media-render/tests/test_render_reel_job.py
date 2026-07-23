#!/usr/bin/env python3
"""Focused regression checks for render_reel_job.py (temp directories only)."""
from __future__ import annotations

import fcntl
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / "scripts" / "render_reel_job.py"
PNG_HEADER = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
              + (1080).to_bytes(4, "big") + (1920).to_bytes(4, "big"))
SPEC = importlib.util.spec_from_file_location("render_reel_job", SCRIPT)
assert SPEC and SPEC.loader
JOB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(JOB)


class RenderJobV2Test(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.reel = Path(self.temp.name) / "reel"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_cli(self, *args: str) -> tuple[int, dict]:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *map(str, args)],
            capture_output=True, text=True, check=False)
        self.assertTrue(result.stdout.strip(), result.stderr)
        return result.returncode, json.loads(result.stdout.strip().splitlines()[-1])

    def write_script(self, *, image: bool = False, cuts: int = 1,
                     duration: float | None = None) -> None:
        self.reel.mkdir(parents=True, exist_ok=True)
        blocks = ["# fixture"]
        for number in range(1, cuts + 1):
            blocks.append(
                f"## CUT {number}\n"
                f"**이미지 파일:** `Image/cut{number}.png`\n"
                f"**이미지 지시:** image instruction {number}\n"
                f"**Grok 모션:** slow push in {number}\n"
                + (f"**길이:** {duration:.1f}s\n" if duration is not None else ""))
        (self.reel / "script.md").write_text(
            "\n\n".join(blocks), encoding="utf-8")
        if image:
            for number in range(1, cuts + 1):
                target = self.reel / "Image" / f"cut{number}.png"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(PNG_HEADER + f"image-{number}".encode())

    def make_clip(self, name: str, duration: float, color: str = "black") -> Path:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.skipTest("ffmpeg is required for media evidence fixtures")
        target = self.reel / "video" / f"{name}.mp4"
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i",
            f"color=c={color}:s=32x64:r=5:d={duration}", "-an", "-c:v", "mpeg4",
            str(target),
        ], check=True)
        return target

    def raw_job(self) -> dict:
        return json.loads((self.reel / JOB.JOB_FILE).read_text(encoding="utf-8"))

    def write_job(self, data: dict) -> None:
        self.reel.mkdir(parents=True, exist_ok=True)
        (self.reel / JOB.JOB_FILE).write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def make_v1(self) -> bytes:
        job = JOB.RenderJob(self.reel)
        data = job._fresh()
        data["schema"] = JOB.SCHEMA_V1
        data.pop("revision")
        data.pop("migration")
        for stage in data["stages"]:
            for key in ("inputs", "input_sha256", "output_sha256", "error_history",
                        "approvals", "stale", "stale_output_sha256", "qa_stale",
                        "grandfathered_qa_sha256"):
                stage.pop(key)
        raw = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode()
        self.reel.mkdir(parents=True, exist_ok=True)
        (self.reel / JOB.JOB_FILE).write_bytes(raw)
        return raw

    def complete_prefix(self, last: str) -> None:
        data = self.raw_job()
        for stage in data["stages"]:
            if JOB.STAGE_INDEX[stage["stage"]] <= JOB.STAGE_INDEX[last]:
                stage["status"] = "completed"
                stage["ended_at"] = JOB.now_iso()
        self.write_job(data)

    def test_v1_queries_do_not_migrate_and_first_mutation_backs_up_once(self) -> None:
        original = self.make_v1()
        for command in (("status", str(self.reel), "--json"),
                        ("next", str(self.reel))):
            code, payload = self.run_cli(*command)
            self.assertEqual(0, code)
            self.assertTrue(payload["ok"])
            self.assertEqual(original, (self.reel / JOB.JOB_FILE).read_bytes())
            self.assertFalse((self.reel / JOB.BACKUP_FILE).exists())

        code, _ = self.run_cli("start", self.reel, "R0")
        self.assertEqual(0, code)
        migrated = self.raw_job()
        self.assertEqual(JOB.SCHEMA, migrated["schema"])
        self.assertEqual(1, migrated["revision"])
        self.assertEqual(original, (self.reel / JOB.BACKUP_FILE).read_bytes())
        code, _ = self.run_cli("fail", self.reel, "R0", "--error-type", "other")
        self.assertEqual(4, code)
        self.assertEqual(original, (self.reel / JOB.BACKUP_FILE).read_bytes())

    def test_prerequisite_and_gate_approval_are_state_preserving_on_rejection(self) -> None:
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        before = self.raw_job()["revision"]
        code, payload = self.run_cli("start", self.reel, "R0.5")
        self.assertEqual(3, code)
        self.assertEqual("blocked", payload["status"])
        self.assertEqual(before, self.raw_job()["revision"])

        self.assertEqual(0, self.run_cli("start", self.reel, "R0")[0])
        self.assertEqual(0, self.run_cli("end", self.reel, "R0")[0])
        self.assertEqual(0, self.run_cli("start", self.reel, "R0.5")[0])
        before = self.raw_job()["revision"]
        code, _ = self.run_cli("end", self.reel, "R0.5")
        self.assertEqual(2, code)
        self.assertEqual(before, self.raw_job()["revision"])
        code, _ = self.run_cli("end", self.reel, "R0.5", "--approve", "operator: checked")
        self.assertEqual(0, code)
        approval = self.raw_job()["stages"][1]["approvals"][-1]
        self.assertEqual({"by", "at", "note"}, set(approval))
        self.assertEqual("operator", approval["by"])

    def test_r11_requires_separate_postmortem_and_explicit_end(self) -> None:
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.complete_prefix("R10")
        timing = self.reel / "90_timing"
        timing.mkdir()
        (timing / "production-timing.md").write_text("timer only", encoding="utf-8")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        r11 = self.raw_job()["stages"][JOB.STAGE_INDEX["R11"]]
        self.assertEqual("pending", r11["status"])
        self.assertEqual(2, self.run_cli("end", self.reel, "R11")[0])
        (timing / "postmortem.md").write_text("# postmortem", encoding="utf-8")
        self.assertEqual(0, self.run_cli("end", self.reel, "R11")[0])
        self.assertEqual("completed", self.raw_job()["stages"][-1]["status"])

    def test_output_hash_change_invalidates_downstream_qa(self) -> None:
        self.write_script(image=True)
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.complete_prefix("R0.5")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        report = self.reel / JOB.QA_REPORTS["R3"]
        report.write_text('{"ok":true}\n', encoding="utf-8")
        self.assertEqual(0, self.run_cli(
            "end", self.reel, "R3", "--approve", "qa: image report ok=true")[0])

        image = self.reel / "Image" / "cut1.png"
        image.write_bytes(PNG_HEADER + b"changed")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        data = self.raw_job()
        r2 = data["stages"][JOB.STAGE_INDEX["R2"]]
        r3 = data["stages"][JOB.STAGE_INDEX["R3"]]
        self.assertEqual("completed", r2["status"])
        self.assertIsInstance(r2["outputs"][0], dict)
        self.assertEqual(64, len(r2["outputs"][0]["sha256"]))
        self.assertEqual("pending", r3["status"])
        self.assertTrue(r3["stale"])
        self.assertTrue(r3["qa_stale"])
        code, payload = self.run_cli(
            "end", self.reel, "R3", "--approve", "qa: reuse old report")
        self.assertEqual(2, code)
        self.assertIn("fresh output evidence", payload["reason"])
        self.assertEqual("pending", self.raw_job()["stages"][JOB.STAGE_INDEX["R3"]]["status"])

    def test_missing_completed_output_invalidates_its_owner(self) -> None:
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        master = self.reel / "55_render" / "video.mp4"
        master.parent.mkdir(parents=True)
        shutil.copy2(self.make_clip("master", 4), master)
        self.complete_prefix("R6")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        master.unlink()
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        r6 = self.raw_job()["stages"][JOB.STAGE_INDEX["R6"]]
        self.assertEqual("pending", r6["status"])
        self.assertTrue(r6["stale"])

    def test_v1_completed_qa_is_not_retroactively_downgraded(self) -> None:
        self.make_v1()
        data = json.loads((self.reel / JOB.JOB_FILE).read_text(encoding="utf-8"))
        data["stages"][JOB.STAGE_INDEX["R3"]]["status"] = "completed"
        self.write_job(data)
        (self.reel / JOB.QA_REPORTS["R3"]).write_text('{"ok":false}\n', encoding="utf-8")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        r3 = self.raw_job()["stages"][JOB.STAGE_INDEX["R3"]]
        self.assertEqual("completed", r3["status"])
        self.assertEqual(64, len(r3["grandfathered_qa_sha256"]))

        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        r3 = self.raw_job()["stages"][JOB.STAGE_INDEX["R3"]]
        self.assertEqual("completed", r3["status"])

        (self.reel / JOB.QA_REPORTS["R3"]).write_text(
            '{"ok":false,"revision":2}\n', encoding="utf-8")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        r3 = self.raw_job()["stages"][JOB.STAGE_INDEX["R3"]]
        self.assertEqual("failed", r3["status"])
        self.assertIsNone(r3["grandfathered_qa_sha256"])

    def test_cut_attempt_and_error_history_are_preserved(self) -> None:
        self.write_script(image=False)
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.complete_prefix("R0.5")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        self.assertEqual(0, self.run_cli("start", self.reel, "R2", "--cut", "1")[0])
        code, _ = self.run_cli("fail", self.reel, "R2", "--cut", "1",
                               "--error-type", "other", "--message", "retry me")
        self.assertEqual(4, code)
        cut = self.raw_job()["cuts"][0]
        self.assertEqual(1, cut["attempts"]["R2"])
        self.assertEqual("retry me", cut["error_history"][-1]["message"])

    def test_corrupt_png_short_or_corrupt_mp4_and_duplicate_clips_are_rejected(self) -> None:
        self.reel.mkdir(parents=True)
        store = JOB.RenderJob(self.reel)
        corrupt_png = self.reel / "corrupt.png"
        corrupt_png.write_bytes(b"not a png" + b"x" * 32)
        self.assertIsNone(store.image_artifact(corrupt_png))

        corrupt_clip = self.reel / "video" / "corrupt.mp4"
        corrupt_clip.parent.mkdir()
        corrupt_clip.write_bytes(b"not an mp4")
        self.assertIsNone(store.clip_artifact(corrupt_clip))
        self.assertIsNone(store.clip_artifact(self.make_clip("short", 1)))
        for relative in (
            "55_render/video.mp4", "56_capcut_export/video.mp4",
            "distribution/reels/reel.mp4",
        ):
            destination = self.reel / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(corrupt_clip, destination)
        self.assertFalse(store.evidence("R6", [])[0])
        self.assertFalse(store.evidence("R7", [])[0])
        self.assertFalse(store.evidence("R9", [])[0])

        first = self.make_clip("cut1", 4)
        second = self.reel / "video" / "cut2.mp4"
        shutil.copy2(first, second)
        cuts = [
            {"cut": 1, "slug": "cut1", "image": str(self.reel / "Image/cut1.png")},
            {"cut": 2, "slug": "cut2", "image": str(self.reel / "Image/cut2.png")},
        ]
        complete, outputs, pending = store.evidence("R4", cuts)
        self.assertFalse(complete)
        self.assertEqual([2], pending)
        self.assertEqual(1, len(outputs))

    def test_motion_only_change_invalidates_r4_cut_but_keeps_r2(self) -> None:
        self.write_script(image=True)
        self.make_clip("cut1", 4)
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.complete_prefix("R5")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])

        script = self.reel / "script.md"
        script.write_text(
            script.read_text(encoding="utf-8").replace(
                "slow push in 1", "fast pan right"),
            encoding="utf-8")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        data = self.raw_job()
        r2 = data["stages"][JOB.STAGE_INDEX["R2"]]
        r4 = data["stages"][JOB.STAGE_INDEX["R4"]]
        self.assertEqual("completed", r2["status"])
        self.assertEqual([], r2["pending_cuts"])
        self.assertEqual("completed", data["stages"][JOB.STAGE_INDEX["R3"]]["status"])
        self.assertEqual("pending", r4["status"])
        self.assertEqual([1], r4["pending_cuts"])

    def test_completed_pipeline_survives_intentional_still_cleanup(self) -> None:
        self.write_script(image=True, cuts=2)
        self.make_clip("cut1", 4, "black")
        self.make_clip("cut2", 4, "white")
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.complete_prefix("R5")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        for image in (self.reel / "Image").glob("*.png"):
            image.unlink()

        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        data = self.raw_job()
        for sid in ("R2", "R3", "R4", "R5"):
            stage = data["stages"][JOB.STAGE_INDEX[sid]]
            self.assertEqual("completed", stage["status"], sid)
            self.assertEqual([], stage["pending_cuts"], sid)
            self.assertEqual({}, stage.get("stale_cuts", {}), sid)
            self.assertFalse(stage.get("stale", False), sid)

        script = self.reel / "script.md"
        script.write_text(script.read_text(encoding="utf-8").replace(
            "slow push in 2", "orbit cut two"), encoding="utf-8")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        data = self.raw_job()
        self.assertEqual("completed", data["stages"][JOB.STAGE_INDEX["R2"]]["status"])
        r4 = data["stages"][JOB.STAGE_INDEX["R4"]]
        self.assertEqual("pending", r4["status"])
        self.assertEqual([2], r4["pending_cuts"])

    def test_partial_still_cleanup_preserves_consumed_cuts_but_not_instruction_changes(self) -> None:
        self.write_script(image=True, cuts=2)
        self.make_clip("cut1", 4, "black")
        self.make_clip("cut2", 4, "white")
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.complete_prefix("R5")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])

        (self.reel / "Image" / "cut1.png").unlink()
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        data = self.raw_job()
        for sid in ("R2", "R3", "R4", "R5"):
            stage = data["stages"][JOB.STAGE_INDEX[sid]]
            self.assertEqual("completed", stage["status"], sid)
            self.assertEqual([], stage["pending_cuts"], sid)
            self.assertFalse(stage.get("stale", False), sid)

        script = self.reel / "script.md"
        script.write_text(script.read_text(encoding="utf-8").replace(
            "image instruction 1", "changed instruction 1"), encoding="utf-8")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        r2 = self.raw_job()["stages"][JOB.STAGE_INDEX["R2"]]
        self.assertEqual("pending", r2["status"])
        self.assertEqual([1], r2["pending_cuts"])

    def test_end_one_stale_cut_does_not_clear_other_stale_cuts(self) -> None:
        self.write_script(image=True, cuts=2)
        self.make_clip("cut1", 4, "black"); self.make_clip("cut2", 4, "white")
        master = self.reel / "55_render" / "video.mp4"; master.parent.mkdir(parents=True)
        shutil.copy2(self.reel / "video" / "cut1.mp4", master)
        export = self.reel / "56_capcut_export" / "video.mp4"; export.parent.mkdir(parents=True)
        shutil.copy2(master, export)
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.complete_prefix("R5"); self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        script = self.reel / "script.md"
        script.write_text(script.read_text(encoding="utf-8").replace(
            "image instruction 1", "changed instruction 1").replace(
            "image instruction 2", "changed instruction 2"), encoding="utf-8")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        stale = self.raw_job()["stages"][JOB.STAGE_INDEX["R2"]]
        self.assertEqual({"1", "2"}, set(stale["stale_cuts"]))
        self.assertEqual("pending", stale["status"])
        code, _ = self.run_cli("end", self.reel, "R2", "--cut", "1")
        self.assertEqual(0, code)
        stale = self.raw_job()["stages"][JOB.STAGE_INDEX["R2"]]
        self.assertEqual({"2"}, set(stale["stale_cuts"]))
        code, payload = self.run_cli("end", self.reel, "R2")
        self.assertEqual(3, code)
        self.assertIn("2", payload["reason"])

    def test_consumed_clip_cleanup_keeps_downstream_stages_fresh(self) -> None:
        self.write_script(image=True, cuts=2)
        self.make_clip("cut1", 4, "black"); self.make_clip("cut2", 4, "white")
        master = self.reel / "55_render" / "video.mp4"; master.parent.mkdir(parents=True)
        shutil.copy2(self.reel / "video" / "cut1.mp4", master)
        export = self.reel / "56_capcut_export" / "video.mp4"; export.parent.mkdir(parents=True)
        shutil.copy2(master, export)
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.complete_prefix("R8"); self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        for clip in (self.reel / "video").glob("*.mp4"): clip.unlink()
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        data = self.raw_job()
        for sid in ("R4", "R5", "R6", "R7", "R8"):
            stage = data["stages"][JOB.STAGE_INDEX[sid]]
            self.assertEqual("completed", stage["status"], sid)
            self.assertFalse(stage.get("stale", False), sid)

    def test_skip_requires_approval_and_r11_is_never_skippable(self) -> None:
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.assertEqual(0, self.run_cli("start", self.reel, "R0")[0])
        self.assertEqual(0, self.run_cli("end", self.reel, "R0")[0])
        self.assertEqual(0, self.run_cli("start", self.reel, "R0.5")[0])
        code, payload = self.run_cli("skip", self.reel, "R0.5")
        self.assertEqual(2, code); self.assertIn("approve", payload["reason"])
        self.complete_prefix("R10")
        code, payload = self.run_cli("skip", self.reel, "R11", "--approve", "operator: reason")
        self.assertEqual(2, code); self.assertIn("cannot be skipped", payload["reason"])

    def test_real_six_reel_migration_is_read_only_when_fixtures_exist(self) -> None:
        source_root = Path.home() / "BarroAiFactory" / "today.myo" / "barrotube"
        reels = sorted(source_root.glob("ep*/render-job.json"))
        if len(reels) < 6:
            self.skipTest("real six-reel migration fixtures are unavailable")
        for source in reels[:6]:
            target = Path(self.temp.name) / source.parent.name
            target.mkdir(parents=True)
            original = source.read_bytes(); (target / "render-job.json").write_bytes(original)
            store = JOB.RenderJob(target)
            self.assertEqual(original, store.path.read_bytes())
            data = store.sync(store.load()); store.save(data)
            self.assertEqual(JOB.SCHEMA, data["schema"])
            self.assertEqual(original, (target / JOB.BACKUP_FILE).read_bytes())
            self.assertNotEqual(original, (target / "render-job.json").read_bytes())

    def test_last_clip_and_still_cleanup_completes_in_progress_r4(self) -> None:
        self.write_script(image=True, cuts=2)
        self.make_clip("cut1", 4, "black")
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.complete_prefix("R3")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        self.assertEqual(0, self.run_cli("start", self.reel, "R4", "--cut", "2")[0])

        self.make_clip("cut2", 4, "white")
        (self.reel / "Image" / "cut2.png").unlink()
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        data = self.raw_job()
        for sid in ("R2", "R3", "R4"):
            stage = data["stages"][JOB.STAGE_INDEX[sid]]
            self.assertEqual("completed", stage["status"], sid)
            self.assertEqual([], stage["pending_cuts"], sid)
            self.assertFalse(stage.get("stale", False), sid)

    def test_duration_change_invalidates_r6_master_and_downstream(self) -> None:
        self.write_script(image=True, cuts=2, duration=3)
        first = self.make_clip("cut1", 4, "black")
        second = self.make_clip("cut2", 4, "white")
        bgm = self.reel / "40_assets" / "bgm" / "bed.wav"
        sfx = self.reel / "40_assets" / "sfx" / "whoosh.wav"
        bgm.parent.mkdir(parents=True)
        sfx.parent.mkdir(parents=True)
        bgm.write_bytes(b"bgm fixture")
        sfx.write_bytes(b"sfx fixture")
        render = self.reel / "55_render"
        render.mkdir()
        (render / "video.mp4").write_bytes(b"master fixture")
        (render / "master-bgm-mix.manifest.json").write_text(json.dumps({
            "clips": [str(first), str(second)],
            "scene_durations": [3.0, 3.0],
            "transition": {"type": "smoothleft", "seconds": 0.35},
            "bgm": {"source": str(bgm), "volume": 0.7},
            "sfx": [{"source": str(sfx), "volume": 0.3}],
            "clip_audio": {"volume": 0.2},
            "audio_master": "loudnorm=I=-16:TP=-1.5:LRA=11",
        }), encoding="utf-8")

        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.complete_prefix("R8")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        before = self.raw_job()
        r6_before = before["stages"][JOB.STAGE_INDEX["R6"]]
        self.assertEqual(
            {"video/cut1.mp4", "video/cut2.mp4", "40_assets/bgm/bed.wav",
             "40_assets/sfx/whoosh.wav"},
            {artifact["path"] for artifact in r6_before["inputs"]})

        script = self.reel / "script.md"
        script.write_text(script.read_text(encoding="utf-8").replace(
            "**길이:** 3.0s", "**길이:** 4.0s", 1), encoding="utf-8")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        data = self.raw_job()
        self.assertEqual("completed", data["stages"][JOB.STAGE_INDEX["R5"]]["status"])
        for sid in ("R6", "R7", "R8"):
            stage = data["stages"][JOB.STAGE_INDEX[sid]]
            self.assertEqual("pending", stage["status"], sid)
            self.assertTrue(stage["stale"], sid)
        self.assertNotEqual(r6_before["input_sha256"],
                            data["stages"][JOB.STAGE_INDEX["R6"]]["input_sha256"])

    def test_non_boolean_qa_ok_is_not_completion_evidence(self) -> None:
        self.write_script(image=True)
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        self.complete_prefix("R0.5")
        self.assertEqual(0, self.run_cli("sync", self.reel)[0])
        (self.reel / JOB.QA_REPORTS["R3"]).write_text(
            '{"ok":"false"}\n', encoding="utf-8")
        code, payload = self.run_cli(
            "end", self.reel, "R3", "--approve", "qa: malformed report")
        self.assertEqual(2, code)
        self.assertIn("completion evidence is missing", payload["reason"])
        self.assertEqual("pending", self.raw_job()["stages"][JOB.STAGE_INDEX["R3"]]["status"])

    def test_lock_and_cas_conflicts_exit_or_raise_recoverably(self) -> None:
        self.assertEqual(0, self.run_cli("init", self.reel)[0])
        with (self.reel / JOB.LOCK_FILE).open("a+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, payload = self.run_cli("sync", self.reel)
            self.assertEqual(4, code)
            self.assertIn("lock busy", payload["reason"])

        store = JOB.RenderJob(self.reel)
        stale = store.load()
        current = self.raw_job()
        current["revision"] += 1
        self.write_job(current)
        stale["episode"] = "CAS-STALE"
        with self.assertRaises(JOB.RecoverableError):
            store.save(stale)

    def test_keyboard_interrupt_uses_recoverable_failure_contract(self) -> None:
        stdout = io.StringIO()
        with patch.object(JOB, "build_parser", side_effect=KeyboardInterrupt), \
                redirect_stdout(stdout):
            code = JOB.main([])
        payload = json.loads(stdout.getvalue())
        self.assertEqual(4, code)
        self.assertEqual("recoverable_failure", payload["status"])


if __name__ == "__main__":
    unittest.main()
