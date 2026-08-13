#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import reel_autopilot as target  # noqa: E402


class ReelAutopilotContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.reel = Path(self.tmp.name) / "reel"
        self.reel.mkdir()

    def test_r0_blocks_for_a_human_when_intel_is_unusable(self) -> None:
        """R0 은 주제를 지어내지 않는다.

        경쟁 인텔이 없거나 쓸 만한 키워드가 없으면 topic_from_intel.py 가 exit 3 을
        내고, autopilot 은 그것을 blocked(manual) 핸드오프로 옮겨야 한다.
        여기서 임의 주제를 만들면 근거 없는 릴이 파이프라인을 타고 끝까지 간다.
        """
        blocked = json.dumps({
            "ok": False, "stage": "R0", "blocked": True,
            "error": "no competitor analysis within 3d",
            "next_action": "run competitor-pipeline.sh",
        })
        with patch.object(target, "run", return_value=(3, blocked, "")):
            code, out, _ = target.run([sys.executable, str(target.TOPIC_FROM_INTEL), str(self.reel)])
        self.assertEqual(3, code)
        payload = target.parse_json_output(out)
        self.assertTrue(payload["blocked"])

    def test_r0_is_classified_as_deterministic_and_r05_is_not(self) -> None:
        """R0(주제 선택)은 결정론이지만 R0.5(사실 검증)는 모델이 필요하다."""
        self.assertIn("R0", target.DETERMINISTIC)
        self.assertNotIn("R0.5", target.DETERMINISTIC)
        # 브라우저·GUI·HITL 정지점은 그대로여야 한다
        self.assertEqual({"R2", "R4"}, target.BROWSER)
        self.assertEqual({"R7"}, target.GUI)
        self.assertEqual({"R10"}, target.HITL)

    def test_topic_from_intel_path_is_wired(self) -> None:
        self.assertTrue(target.TOPIC_FROM_INTEL.is_file(),
                        f"missing {target.TOPIC_FROM_INTEL}")

    def test_job_json_reads_final_json_line_and_keeps_return_code(self) -> None:
        output = 'human summary\n{"ok":false,"status":"recoverable_failure"}\n'
        with patch.object(target, "run", return_value=(4, output, "")):
            result = target.job_json(self.reel, "sync")
        self.assertEqual(result["status"], "recoverable_failure")
        self.assertEqual(result["_code"], 4)

        for code, status in ((2, "usage_or_config"), (3, "blocked"),
                             (4, "recoverable_failure"), (5, "fatal")):
            with self.subTest(code=code):
                failure = target.job_failure(
                    {"ok": False, "_code": code, "reason": "x"}, "R1", "job")
                self.assertEqual(failure["status"], status)

    def test_failed_or_invalid_doctor_never_touches_job_state(self) -> None:
        state = self.reel / "render-job.json"
        state.write_text('{"sentinel":true}\n', encoding="utf-8")
        before = state.read_bytes()

        cases = (
            (1, json.dumps({"ok": False}), ""),
            (0, "not json", ""),
        )
        for doctor_result in cases:
            with self.subTest(doctor_result=doctor_result[:2]):
                job = Mock()
                with patch.object(target, "run", return_value=doctor_result), \
                     patch.object(target, "job_json", job):
                    result = target.autopilot(self.reel, None, False, False, 20)
                self.assertEqual(result["status"], "fatal")
                self.assertEqual(result["stage"], "preflight")
                self.assertEqual(state.read_bytes(), before)
                job.assert_not_called()

    def test_qa_gate_is_explicitly_approved_after_success(self) -> None:
        calls: list[tuple[str, ...]] = []
        syncs = iter((
            {"ok": True, "_code": 0, "stages": {},
             "next": {"stage": "R3", "status": "pending"}},
            {"ok": True, "_code": 0, "stages": {},
             "next": {"stage": "R2", "status": "pending", "pending_cuts": [1]}},
        ))

        def fake_job(_reel: Path, *args: str) -> dict:
            calls.append(args)
            if args[0] == "sync":
                return next(syncs)
            return {"ok": True, "_code": 0, "stage": args[1] if len(args) > 1 else None}

        with patch.object(target, "run", return_value=(0, '{"ok":true}', "")), \
             patch.object(target, "job_json", side_effect=fake_job), \
             patch.object(target, "qa", return_value={"ok": True, "_exit": 0}):
            result = target.autopilot(self.reel, None, False, False, 20)

        self.assertEqual(result["status"], "blocked")
        self.assertIn(("end", "R3", "--approve",
                       "autopilot: deterministic QA ok=true"), calls)

    def test_qa_nonzero_exit_never_approves_even_when_payload_says_ok(self) -> None:
        calls: list[tuple[str, ...]] = []

        def fake_job(_reel: Path, *args: str) -> dict:
            calls.append(args)
            if args[0] == "sync":
                return {"ok": True, "_code": 0, "stages": {},
                        "next": {"stage": "R3", "status": "pending"}}
            return {"ok": True, "_code": 0,
                    "stage": args[1] if len(args) > 1 else None}

        with patch.object(target, "run", return_value=(0, '{"ok":true}', "")), \
             patch.object(target, "job_json", side_effect=fake_job), \
             patch.object(target, "qa", return_value={"ok": True, "_exit": 1}):
            result = target.autopilot(self.reel, None, False, False, 20)

        self.assertEqual(result["status"], "recoverable_failure")
        self.assertFalse(any(call[0] == "end" for call in calls))
        self.assertTrue(any(call[:2] == ("fail", "R3") for call in calls))

    def test_distribution_atomically_replaces_changes_and_noops_when_identical(self) -> None:
        final = self.reel / "56_capcut_export" / "video.mp4"
        final.parent.mkdir()
        final.write_bytes(b"new-final")
        dest = self.reel / "distribution" / "reels" / f"{self.reel.name}.mp4"
        dest.parent.mkdir(parents=True)
        dest.write_bytes(b"old-final")

        real_replace = target.os.replace
        with patch.object(target.os, "replace", wraps=real_replace) as replaced:
            self.assertTrue(target.do_distribution(self.reel, None)["ok"])
            replaced.assert_called_once()
            self.assertEqual(dest.read_bytes(), b"new-final")
            replaced.reset_mock()
            self.assertTrue(target.do_distribution(self.reel, None)["ok"])
            replaced.assert_not_called()
        self.assertEqual(list(dest.parent.glob(f".{dest.name}.*")), [])

    def test_r10_handoff_is_manual_and_hash_gated(self) -> None:
        def fake_job(_reel: Path, *args: str) -> dict:
            if args[0] == "sync":
                return {"ok": True, "_code": 0, "stages": {},
                        "next": {"stage": "R10", "status": "pending"}}
            return {"ok": True, "_code": 0}

        with patch.object(target, "run", return_value=(0, '{"ok":true}', "")), \
             patch.object(target, "job_json", side_effect=fake_job):
            result = target.autopilot(self.reel, None, False, False, 20)

        action = result["next_action"]
        self.assertIn("scripts/publish_gate.py", action)
        self.assertIn("manual", action)
        self.assertNotIn("publish-process.sh", action)
        self.assertNotIn("publish-instagram-reels.js", action)

    def test_r11_writes_postmortem_then_explicitly_ends(self) -> None:
        calls: list[tuple[str, ...]] = []

        def fake_job(_reel: Path, *args: str) -> dict:
            calls.append(args)
            if args[0] == "sync":
                return {"ok": True, "_code": 0, "stages": {"R11": "pending"},
                        "next": {"stage": "R11", "status": "pending"}}
            if args[0] == "status":
                return {"ok": True, "_code": 0, "cuts": [], "stages": [{
                    "stage": "R11", "name": "postmortem/timing",
                    "status": "in_progress", "attempts": 1,
                }]}
            return {"ok": True, "_code": 0,
                    "stage": args[1] if len(args) > 1 else None}

        with patch.object(target, "run", return_value=(0, '{"ok":true}', "")), \
             patch.object(target, "job_json", side_effect=fake_job):
            result = target.autopilot(self.reel, "EP-1", False, False, 20)

        self.assertEqual(result["status"], "completed")
        self.assertTrue((self.reel / "90_timing" / "postmortem.md").is_file())
        self.assertFalse((self.reel / "90_timing" / "production-timing.md").exists())
        self.assertLess(calls.index(("status", "--json")), calls.index(("end", "R11")))

    def test_main_maps_all_exit_classes_and_ends_with_compact_json(self) -> None:
        cases = (
            (target.outcome("completed", None, "done"), 0),
            (target.outcome("blocked", "R2", "browser"), 3),
            (target.outcome("recoverable_failure", "R3", "qa"), 4),
            (target.outcome("fatal", "preflight", "doctor"), 5),
        )
        for result, expected in cases:
            with self.subTest(status=result["status"]):
                stdout = io.StringIO()
                with patch.object(sys, "argv", ["reel_autopilot.py", str(self.reel)]), \
                     patch.object(target, "autopilot", return_value=result), \
                     redirect_stdout(stdout):
                    code = target.main()
                last = stdout.getvalue().splitlines()[-1]
                payload = json.loads(last)
                self.assertEqual(code, expected)
                self.assertEqual(payload["status"], result["status"])
                self.assertIn("stage", payload)
                self.assertIn("reason", payload)
                self.assertEqual(last, json.dumps(payload, ensure_ascii=False,
                                                  separators=(",", ":")))

        stdout = io.StringIO()
        missing = self.reel / "missing"
        with patch.object(sys, "argv", ["reel_autopilot.py", str(missing), "--json"]), \
             redirect_stdout(stdout):
            code = target.main()
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stdout.getvalue().splitlines()[-1])["status"],
                         "usage_or_config")

        stdout = io.StringIO()
        with patch.object(sys, "argv", ["reel_autopilot.py"]), redirect_stdout(stdout), \
             self.assertRaises(SystemExit) as stopped:
            target.main()
        self.assertEqual(stopped.exception.code, 2)
        self.assertEqual(json.loads(stdout.getvalue().splitlines()[-1])["status"],
                         "usage_or_config")


if __name__ == "__main__":
    unittest.main()
