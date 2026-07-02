#!/usr/bin/env python3
"""Preflight doctor — check the whole render environment BEFORE a long
production run, so a reel doesn't die at the last stage on a missing binary,
a dead Instagram token, or an absent CapCut template.

Writes `<reel>/00_preflight.media.json`. Top-level `ok` is true when no
error-level check failed. Check levels:

  error   blocks the run (ok:false)          — missing ffmpeg, no Downloads access
  warn    degraded but runnable              — no jq, BGM folder empty
  info    recorded facts                     — versions, paths
  manual  cannot be verified from a CLI      — ChatGPT/Grok login, Grok option bar;
          the browser worker must verify these at runtime (page state check)

Checks (automation plan §3): binaries (ffmpeg/ffprobe/jq/node/python3),
Downloads writable, CapCut 2 app + draft template, BGM/SFX resources,
Instagram token presence (+ optional --online Graph API validation),
reel folder structure, browser logins (manual).

Usage:
  python3 media_render_doctor.py <reel>
  python3 media_render_doctor.py <reel> --online          # validate IG token via API
  python3 media_render_doctor.py <reel> --template BT-EP04-SCHOOL-GUARDIAN

Exit 0 when ok:true, 1 when ok:false. Never prints secret values.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

REPORT_NAME = "00_preflight.media.json"
SCHEMA = "barrotube.preflight.v1"

BINARIES = {
    "ffmpeg": "error", "ffprobe": "error", "node": "error",
    "python3": "error", "jq": "warn",
}
CAPCUT_APPS = ["/Applications/CapCut 2.app", "/Applications/CapCut.app"]
CAPCUT_DRAFTS = Path.home() / "Movies/CapCut/User Data/Projects/com.lveditor.draft"
DEFAULT_ENV_FILE = Path.home() / "youtube-co/.env"
TOKEN_KEYS = ["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_GRAPH_API_TOKEN"]
USER_ID_KEYS = ["INSTAGRAM_IG_USER_ID", "INSTAGRAM_USER_ID"]
AUDIO_EXTS = (".mp3", ".m4a", ".wav", ".aac", ".flac")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class Doctor:
    def __init__(self, reel: Path):
        self.reel = reel
        self.checks: list[dict] = []

    def add(self, check_id: str, ok: bool, level: str, detail: str) -> None:
        self.checks.append({"id": check_id, "ok": ok, "level": level, "detail": detail})

    def error(self, cid: str, d: str) -> None: self.add(cid, False, "error", d)
    def warn(self, cid: str, d: str) -> None: self.add(cid, False, "warn", d)
    def passed(self, cid: str, d: str = "") -> None: self.add(cid, True, "info", d)
    def manual(self, cid: str, d: str) -> None: self.add(cid, True, "manual", d)

    def write(self) -> dict:
        ok = not any(c["level"] == "error" and not c["ok"] for c in self.checks)
        data = {
            "schema": SCHEMA,
            "ok": ok,
            "generated_at": now_iso(),
            "reel_dir": str(self.reel),
            "errors": sum(1 for c in self.checks if c["level"] == "error" and not c["ok"]),
            "warnings": sum(1 for c in self.checks if c["level"] == "warn" and not c["ok"]),
            "manual_checks": sum(1 for c in self.checks if c["level"] == "manual"),
            "checks": self.checks,
        }
        path = self.reel / REPORT_NAME
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        data["report"] = str(path)
        return data


def load_env_file(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines. Values are kept in memory only, never printed."""
    env: dict[str, str] = {}
    if not path.is_file():
        return env
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


def keychain_has(key: str) -> bool:
    """Presence check via macOS Keychain metadata — never reads the value."""
    if sys.platform != "darwin" or not shutil.which("security"):
        return False
    return subprocess.run(
        ["security", "find-generic-password", "-s", key],
        capture_output=True, timeout=10).returncode == 0


def keychain_read(key: str) -> str:
    """Read a secret value from Keychain (kept in memory only, never printed)."""
    try:
        out = subprocess.check_output(
            ["security", "find-generic-password", "-s", key, "-w"],
            stderr=subprocess.DEVNULL, timeout=10)
        return out.decode().strip()
    except (subprocess.SubprocessError, OSError):
        return ""


def find_secret(env: dict[str, str], keys: list[str]) -> tuple[str, str] | None:
    """Mirror config-loader.js getSecret(): .env file -> process.env -> Keychain.
    Returns (key, source) without exposing the value."""
    for k in keys:
        if env.get(k):
            return k, "env file"
        if os.environ.get(k):
            return k, "process env"
        if keychain_has(k):
            return k, "macOS Keychain"
    return None


def secret_value(env: dict[str, str], key: str) -> str:
    return env.get(key) or os.environ.get(key) or keychain_read(key)


def value_of(env: dict[str, str], key: str) -> str:
    return os.environ.get(key) or env.get(key, "")


def check_binaries(doc: Doctor) -> None:
    for name, level in BINARIES.items():
        path = shutil.which(name)
        if path:
            doc.passed(f"binary:{name}", path)
        elif level == "error":
            doc.error(f"binary:{name}", "not found on PATH — required for render/QA")
        else:
            doc.warn(f"binary:{name}", "not found on PATH (used by CapCut draft validation)")


def check_downloads(doc: Doctor) -> None:
    dl = Path.home() / "Downloads"
    if not dl.is_dir():
        doc.error("downloads", f"{dl} does not exist")
        return
    try:
        with tempfile.NamedTemporaryFile(dir=dl, prefix=".doctor-", delete=True):
            pass
        doc.passed("downloads", f"{dl} writable")
    except OSError as e:
        doc.error("downloads", f"{dl} not writable: {e}")


def check_capcut(doc: Doctor, template: str | None) -> None:
    installed = [a for a in CAPCUT_APPS if Path(a).is_dir()]
    if not installed:
        doc.warn("capcut_app", "CapCut not installed — CapCut draft/export stages unavailable")
    elif CAPCUT_APPS[0] in installed:
        doc.passed("capcut_app", installed[0])
    else:
        doc.warn("capcut_app", f"only legacy {installed[0]} — newer drafts may demand an update; "
                               "prefer CapCut 2")

    if not CAPCUT_DRAFTS.is_dir():
        doc.warn("capcut_drafts", f"draft folder missing: {CAPCUT_DRAFTS}")
        return
    if template:
        t = CAPCUT_DRAFTS / template
        if (t / "draft_info.json").is_file():
            doc.passed("capcut_template", str(t))
        else:
            doc.error("capcut_template", f"template '{template}' not found or has no draft_info.json")
    else:
        usable = [p.name for p in CAPCUT_DRAFTS.iterdir()
                  if (p / "draft_info.json").is_file()]
        if usable:
            doc.passed("capcut_template", f"{len(usable)} draft project(s) usable as template")
        else:
            doc.warn("capcut_template", "no existing draft with draft_info.json to clone")


def check_assets(doc: Doctor, reel: Path) -> None:
    for kind in ("bgm", "sfx"):
        d = reel / "40_assets" / kind
        files = [p for p in d.rglob("*") if p.suffix.lower() in AUDIO_EXTS] if d.is_dir() else []
        if files:
            doc.passed(f"assets:{kind}", f"{len(files)} file(s) under {d}")
        else:
            doc.warn(f"assets:{kind}", f"no audio under {d} — FFmpeg master mix (R6) will need it")


def check_instagram(doc: Doctor, env_file: Path, online: bool) -> None:
    # Same resolution chain as youtube-co config-loader.js getSecret():
    # .env file -> process.env -> macOS Keychain.
    env = load_env_file(env_file)
    token = find_secret(env, TOKEN_KEYS)
    user = find_secret(env, USER_ID_KEYS)
    if not token:
        doc.warn("ig_token", f"no {'/'.join(TOKEN_KEYS)} in {env_file}, process env, "
                             "or macOS Keychain — R10 publish will fail")
        return
    token_key, token_src = token
    doc.passed("ig_token", f"{token_key} present via {token_src}; value not shown")
    if user:
        doc.passed("ig_user_id", f"{user[0]} present via {user[1]}")
    else:
        doc.warn("ig_user_id", f"no {'/'.join(USER_ID_KEYS)} found — publish script may require it")

    if not online:
        doc.manual("ig_token_validity", "presence only — run with --online to validate via Graph API")
        return
    host = value_of(env, "INSTAGRAM_GRAPH_HOST") or "graph.instagram.com"
    ver = value_of(env, "INSTAGRAM_GRAPH_VERSION") or "v21.0"
    token = secret_value(env, token_key)
    url = f"https://{host}/{ver}/me?fields=id&access_token={token}"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            ok_id = json.loads(resp.read().decode()).get("id")
            doc.passed("ig_token_validity", f"Graph API /me OK (id present: {bool(ok_id)})")
    except urllib.error.HTTPError as e:
        doc.error("ig_token_validity", f"Graph API {e.code} — token invalid/expired ({host}/{ver})")
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        doc.warn("ig_token_validity", f"could not reach Graph API: {e}")


def check_reel_structure(doc: Doctor, reel: Path) -> None:
    if not (reel / "script.md").is_file():
        doc.warn("reel:script", "script.md missing — R0/R1 (topic/script) not done yet")
        return
    doc.passed("reel:script", str(reel / "script.md"))
    helper = Path(__file__).resolve().parent / "reel_render_plan.py"
    try:
        out = subprocess.check_output(
            [sys.executable, str(helper), str(reel / "script.md")],
            stderr=subprocess.DEVNULL, timeout=30)
        plan = json.loads(out)
        if plan:
            missing = [c["cut"] for c in plan if not c.get("exists")]
            doc.passed("reel:cuts", f"{len(plan)} cuts parsed"
                       + (f"; stills missing for cuts {missing} (R2 pending)" if missing else ""))
        else:
            doc.warn("reel:cuts", "script.md parsed to 0 cuts — check CUT block format")
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError) as e:
        doc.warn("reel:cuts", f"cut plan parse failed: {e}")
    for sub in ("Image", "video"):
        d = reel / sub
        doc.passed(f"reel:{sub}", f"{d} {'exists' if d.is_dir() else 'will be created on demand'}")


def check_browser(doc: Doctor) -> None:
    doc.manual("browser:chatgpt_login",
               "verify at runtime: open chatgpt.com, composer visible + avatar logged in "
               "(references/chatgpt-image.md step 1)")
    doc.manual("browser:grok_login",
               "verify at runtime: open grok.com/imagine, prompt bar visible + account "
               "bottom-left (references/grok-video.md step 1)")
    doc.manual("browser:grok_options",
               "verify at runtime: option bar shows 비디오/720p/10s/9:16 selected "
               "(zoomed screenshot, filled pills)")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("reel", help="reel directory (report is written here)")
    parser.add_argument("--online", action="store_true",
                        help="validate the Instagram token against the Graph API")
    parser.add_argument("--template", help="required CapCut draft template project name")
    parser.add_argument("--env-file", default=str(DEFAULT_ENV_FILE),
                        help=f"dotenv file with Instagram keys (default {DEFAULT_ENV_FILE})")
    args = parser.parse_args()

    reel = Path(args.reel).expanduser().resolve()
    if not reel.is_dir():
        print(json.dumps({"ok": False, "error": f"reel directory not found: {reel}"}))
        return 2

    doc = Doctor(reel)
    check_binaries(doc)
    check_downloads(doc)
    check_capcut(doc, args.template)
    check_assets(doc, reel)
    check_instagram(doc, Path(args.env_file).expanduser(), args.online)
    check_reel_structure(doc, reel)
    check_browser(doc)

    data = doc.write()
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0 if data["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
