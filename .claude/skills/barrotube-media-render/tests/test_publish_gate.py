from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import publish_gate  # noqa: E402


class CorePublishGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.reel = Path(self.tmp.name) / "reel"; (self.reel / "Image").mkdir(parents=True)
        (self.reel / "Image" / "cut1.png").write_bytes(b"png")
        (self.reel / "56_capcut_export").mkdir(); (self.reel / "56_capcut_export" / "video.mp4").write_bytes(b"video")
        (self.reel / "70_publish_meta.instagram.json").write_text(json.dumps({
            "channel_id": "today.myo", "instagram_username": "today.myo",
            "caption": "hello", }), encoding="utf-8")

    def test_non_tty_approval_is_rejected_without_file(self) -> None:
        with patch.object(publish_gate.sys.stdin, "isatty", return_value=False):
            result = publish_gate.approve(self.reel, approver="operator")
        self.assertFalse(result["ok"]); self.assertEqual("invalid", result["status"])
        self.assertFalse((self.reel / publish_gate.APPROVAL_FILE).exists())

    def test_approval_round_trip_rehashes_artifacts(self) -> None:
        with (patch.object(publish_gate.sys.stdin, "isatty", return_value=True),
              patch("builtins.input", return_value="PUBLISH today.myo"),
              patch.object(publish_gate, "_secret", return_value=b"test-secret")):
            approved = publish_gate.approve(self.reel, approver="operator")
            verified = publish_gate.verify(self.reel)
        self.assertTrue(approved["ok"]); self.assertTrue(verified["ok"])
        self.assertEqual("today.myo", verified["channel"])

    def test_metadata_or_video_change_blocks_verification(self) -> None:
        with (patch.object(publish_gate.sys.stdin, "isatty", return_value=True),
              patch("builtins.input", return_value="PUBLISH today.myo"),
              patch.object(publish_gate, "_secret", return_value=b"test-secret")):
            self.assertTrue(publish_gate.approve(self.reel, approver="operator")["ok"])
            (self.reel / "56_capcut_export" / "video.mp4").write_bytes(b"changed")
            result = publish_gate.verify(self.reel)
        self.assertFalse(result["ok"]); self.assertEqual("blocked", result["status"])


if __name__ == "__main__": unittest.main()
