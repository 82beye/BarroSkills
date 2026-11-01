import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/move_media.py"


class MoveMediaTest(unittest.TestCase):
    def test_validation_and_atomic_copy_preserve_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "download.png"
            dest = root / "output"
            Image.new("RGB", (18, 32), "orange").save(source)
            original = source.read_bytes()

            def run(*args):
                return subprocess.run([
                    sys.executable, str(SCRIPT), "--kind", "image", "--slug", "scene_001",
                    "--source", str(source), "--dest-dir", str(dest), *args,
                ], capture_output=True, text=True, timeout=20)

            for slug in ("../escape", "/absolute", "folder/name", "folder\\name"):
                self.assertNotEqual(run("--slug", slug).returncode, 0)
                self.assertEqual(source.read_bytes(), original)
            result = run("--no-delete")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(json.loads(result.stdout)["ok"])
            self.assertEqual((dest / "scene_001.png").read_bytes(), original)
            self.assertTrue(source.exists())

            Image.new("RGB", (18, 32), "blue").save(source)
            replacement = source.read_bytes()
            self.assertNotEqual(run().returncode, 0, "existing output requires explicit overwrite")
            self.assertEqual((dest / "scene_001.png").read_bytes(), original)
            self.assertEqual(source.read_bytes(), replacement)
            self.assertEqual(run("--overwrite").returncode, 0)
            self.assertEqual((dest / "scene_001.png").read_bytes(), replacement)
            self.assertFalse(source.exists())

            source.write_bytes(b"\x89PNG\r\n\x1a\ntruncated")
            self.assertNotEqual(run("--overwrite").returncode, 0)
            self.assertTrue(source.exists())
            self.assertEqual((dest / "scene_001.png").read_bytes(), replacement)

            (dest / "scene_001.png").unlink()
            external = root / "external.png"
            external.write_bytes(original)
            (dest / "scene_001.png").symlink_to(external)
            Image.new("RGB", (18, 32), "blue").save(source)
            self.assertNotEqual(run().returncode, 0)
            self.assertEqual(external.read_bytes(), original)
            self.assertFalse(list(dest.glob(".media-*")))


if __name__ == "__main__":
    unittest.main()
