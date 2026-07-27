import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "reel_render_plan.py"


class ReelRenderPlanTest(unittest.TestCase):
    def parse(self, markdown: str) -> list[dict]:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "script.md"
            path.write_text(markdown, encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(path)],
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(result.stdout)

    def test_same_line_motion(self):
        plan = self.parse(
            "### CUT 1\n**이미지 파일:** `Image/cut-1.png`\n"
            "**Grok 모션:** 고양이가 걷고 카메라가 따라간다.\n"
        )
        self.assertEqual(plan[0]["motion"], "고양이가 걷고 카메라가 따라간다.")

    def test_multiline_motion_stops_at_next_field(self):
        boundaries = (
            "**자막:** `첫 만남`", "**자막**: `첫 만남`",
            "**길이:** 2.5s", "**길이**: 2.5s",
        )
        for boundary in boundaries:
            with self.subTest(boundary=boundary):
                plan = self.parse(
                    "### CUT 1\n**이미지 파일:** `Image/cut-1.png`\n"
                    "**Grok 모션:**\n고양이가 천천히 걷는다.\n"
                    f"카메라는 낮게 추적한다.\n{boundary}\n"
                )
                self.assertEqual(
                    plan[0]["motion"],
                    "고양이가 천천히 걷는다. 카메라는 낮게 추적한다.",
                )


if __name__ == "__main__":
    unittest.main()
