#!/usr/bin/env python3
"""Hash-bound HITL approval and duplicate gate for media rendering.

macOS only: approval signatures use the user's Keychain item. This core gate
does not publish; the experimental publisher executor is held separately.
"""
from __future__ import annotations

import argparse
import fcntl
import getpass
import hashlib
import hmac
import json
import math
import secrets
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

APPROVAL_FILE = "30_approval.json"
LEDGER_FILE = "90_publish_ledger.json"
APPROVAL_SCHEMA = "barrotube.publish_approval.v1"
LEDGER_SCHEMA = "barrotube.publish_ledger.v1"
DEFAULT_TTL_HOURS = 24.0
SECRET_SERVICE = "barrotube-media-render.publish-approval"
SIGNED_FIELDS = ("schema", "approval_id", "channel", "approver", "approved_at",
                 "expires_at", "ttl_hours", "video_path", "video_sha256",
                 "video_bytes", "meta_path", "meta_sha256", "meta_bytes",
                 "caption_sha256", "instagram_username", "instagram_user_id",
                 "consumed_at", "transaction_id", "revoked_at", "revoke_reason")
LEDGER_SIGNED_FIELDS = ("transaction_id", "status", "channel", "video_sha256",
                        "meta_sha256", "caption_sha256", "approved_by", "approval_id",
                        "approval_signature", "reserved_at", "completed_at", "publisher",
                        "ig_user_id", "account_username", "expected_instagram_username",
                        "expected_instagram_user_id", "launch_started_at",
                        "launch_authorization_sha256", "media_id", "permalink", "error")
VIDEO_CANDIDATES = ("platforms/shorts/56_capcut_export/video.mp4",
                    "platforms/shorts/55_render/video.mp4", "56_capcut_export/video.mp4",
                    "55_render/video.mp4")
META_CANDIDATES = ("platforms/shorts/70_publish_meta.json",
                   "70_publish_meta.instagram.json", "70_publish_meta.json")


class GateConfigError(ValueError): pass
class GateBlocked(RuntimeError): pass


def _result(ok: bool, status: str, reason: str, **extra: Any) -> dict[str, Any]:
    return {"ok": ok, "status": status, "stage": "R10", "reason": reason, **extra}


def _utc_now(value: datetime | None = None) -> datetime:
    value = value or datetime.now(timezone.utc)
    if value.tzinfo is None or value.utcoffset() is None:
        raise GateConfigError("current time must include a timezone")
    return value.astimezone(timezone.utc).replace(microsecond=0)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_iso(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise GateBlocked(f"approval has no valid {field}")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GateBlocked(f"approval has invalid {field}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise GateBlocked(f"approval {field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _clean_label(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 200:
        raise GateConfigError(f"invalid {field}")
    value = value.strip()
    if any(ord(char) < 32 for char in value):
        raise GateConfigError(f"invalid {field}")
    return value


def _resolve_reel(reel: str | Path) -> Path:
    path = Path(reel).expanduser().resolve()
    if not path.is_dir(): raise GateConfigError(f"reel directory not found: {path}")
    return path


def _resolve_file(reel: Path, value: str | Path | None, candidates: tuple[str, ...], field: str) -> Path:
    if value is not None:
        path = Path(value).expanduser()
        path = path if path.is_absolute() else reel / path
        path = path.resolve()
        if not path.is_file(): raise GateConfigError(f"{field} file not found: {path}")
        return path
    for relative in candidates:
        path = (reel / relative).resolve()
        if path.is_file(): return path
    raise GateConfigError(f"{field} file not found")


def _read_meta(path: Path) -> dict[str, Any]:
    try: value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateConfigError(f"invalid publish metadata JSON: {path}") from exc
    if not isinstance(value, dict): raise GateConfigError("publish metadata must be an object")
    return value


def _resolve_channel(explicit: str | None, meta: dict[str, Any]) -> str:
    value = explicit or meta.get("channel_id") or meta.get("channel")
    value = _clean_label(value, "channel").lstrip("@").casefold()
    if explicit and (meta.get("channel_id") or meta.get("channel")):
        source = str(meta.get("channel_id") or meta.get("channel")).lstrip("@").casefold()
        if value != source: raise GateConfigError("requested channel does not match metadata")
    return value


def _identity(meta: dict[str, Any]) -> tuple[str | None, str | None]:
    reels = (meta.get("platforms") or {}).get("reels") if isinstance(meta.get("platforms"), dict) else {}
    reels = reels if isinstance(reels, dict) else {}
    username = meta.get("instagram_username") or reels.get("instagram_username")
    user_id = meta.get("instagram_user_id") or meta.get("ig_user_id") or reels.get("instagram_user_id")
    if username is not None: username = _clean_label(str(username), "instagram_username").lstrip("@").casefold()
    if user_id is not None: user_id = _clean_label(str(user_id), "instagram_user_id")
    if username is None and user_id is None: raise GateConfigError("metadata must bind Instagram account")
    return username, user_id


def _sha256(path: Path) -> tuple[str, int]:
    before = path.stat(); digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""): digest.update(chunk)
    after = path.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        raise GateConfigError(f"file changed while hashing: {path}")
    return digest.hexdigest(), after.st_size


def _sha256_text(value: str) -> str: return hashlib.sha256(value.encode()).hexdigest()


def _caption(meta: dict[str, Any]) -> str:
    reels = (meta.get("platforms") or {}).get("reels") if isinstance(meta.get("platforms"), dict) else {}
    reels = reels if isinstance(reels, dict) else {}
    base = reels.get("caption") or meta.get("caption") or meta.get("summary") or meta.get("description") or meta.get("title") or ""
    tags = reels.get("hashtags") or meta.get("hashtags") or meta.get("tags") or []
    tags = tags if isinstance(tags, list) else []
    hashtags = [f"#{str(tag or '').strip().lstrip('#')}" for tag in tags if str(tag or '').strip()]
    attribution = reels.get("attribution") or meta.get("attribution") or ""
    return "\n\n".join(str(value).strip() for value in (base, attribution, " ".join(hashtags)) if str(value).strip())[:2200]


def _security(arguments: list[str], action: str) -> subprocess.CompletedProcess[str]:
    security = shutil.which("security") if sys.platform == "darwin" else None
    if not security: raise GateConfigError("macOS Keychain is required for approval signing")
    try: return subprocess.run([security, *arguments], capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired as exc: raise GateConfigError(f"Keychain timed out during {action}") from exc


def _secret(create: bool) -> bytes:
    account = getpass.getuser()
    found = _security(["find-generic-password", "-a", account, "-s", SECRET_SERVICE, "-w"], "key lookup")
    if found.returncode == 0 and found.stdout.strip(): return found.stdout.strip().encode()
    if not create: raise GateConfigError(f"approval signing key not found: {SECRET_SERVICE}")
    value = secrets.token_urlsafe(48)
    made = _security(["add-generic-password", "-U", "-a", account, "-s", SECRET_SERVICE, "-T", "", "-w", value], "key creation")
    if made.returncode != 0: raise GateConfigError("could not create approval signing key")
    return value.encode()


def _signature(value: dict[str, Any], secret: bytes) -> str:
    payload = json.dumps({key: value.get(key) for key in SIGNED_FIELDS}, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def _ledger_signature(value: dict[str, Any], secret: bytes) -> str:
    payload = json.dumps({key: value.get(key) for key in LEDGER_SIGNED_FIELDS}, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def _context(reel: str | Path, video: str | Path | None, meta: str | Path | None, channel: str | None) -> dict[str, Any]:
    root = _resolve_reel(reel); video_path = _resolve_file(root, video, VIDEO_CANDIDATES, "video"); meta_path = _resolve_file(root, meta, META_CANDIDATES, "meta")
    meta_json = _read_meta(meta_path); username, user_id = _identity(meta_json); video_hash, video_bytes = _sha256(video_path); meta_hash, meta_bytes = _sha256(meta_path)
    return {"reel": root, "channel": _resolve_channel(channel, meta_json), "video_path": video_path, "video_sha256": video_hash, "video_bytes": video_bytes, "meta_path": meta_path, "meta_sha256": meta_hash, "meta_bytes": meta_bytes, "caption_sha256": _sha256_text(_caption(meta_json)), "instagram_username": username, "instagram_user_id": user_id}


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"; fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with open(fd, "w", encoding="utf-8", closefd=True) as stream: stream.write(payload); stream.flush()
        Path(temporary).replace(path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _load(path: Path, kind: str) -> dict[str, Any]:
    try: value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc: raise GateConfigError(f"invalid {kind}: {path}") from exc
    if not isinstance(value, dict): raise GateConfigError(f"{kind} must be an object")
    return value


def _ledger(path: Path, secret: bytes) -> dict[str, Any]:
    if not path.exists(): return {"schema": LEDGER_SCHEMA, "entries": []}
    value = _load(path, "publish ledger")
    if value.get("schema") != LEDGER_SCHEMA or not isinstance(value.get("entries"), list): raise GateConfigError("unsupported publish ledger schema")
    for entry in value["entries"]:
        if not isinstance(entry, dict) or not all(isinstance(entry.get(key), str) for key in ("channel", "video_sha256", "caption_sha256")): raise GateConfigError("invalid publish ledger entry")
        if entry.get("signature") and not hmac.compare_digest(str(entry["signature"]), _ledger_signature(entry, secret)): raise GateBlocked("publish ledger entry signature is invalid")
    return value


@contextmanager
def _lock(reel: Path) -> Iterator[None]:
    fd = reel.joinpath(f"{LEDGER_FILE}.lock").open("a+")
    try: fcntl.flock(fd, fcntl.LOCK_EX); yield
    finally: fcntl.flock(fd, fcntl.LOCK_UN); fd.close()


def _public(context: dict[str, Any]) -> dict[str, Any]:
    root = context["reel"]
    return {key: (str(context[key].relative_to(root)) if key in ("video_path", "meta_path") else context[key]) for key in ("channel", "video_path", "video_sha256", "meta_path", "meta_sha256", "caption_sha256")}


def _verify_context(reel: str | Path, video: str | Path | None, meta: str | Path | None, channel: str | None, now: datetime | None = None) -> dict[str, Any]:
    context = _context(reel, video, meta, channel); path = context["reel"] / APPROVAL_FILE
    if not path.is_file(): raise GateBlocked("approval not found")
    approval = _load(path, "approval"); secret = _secret(False)
    if approval.get("schema") != APPROVAL_SCHEMA or not hmac.compare_digest(str(approval.get("signature", "")), _signature(approval, secret)): raise GateBlocked("approval signature is missing or invalid")
    if approval.get("revoked_at") or approval.get("consumed_at") or approval.get("transaction_id"): raise GateBlocked("approval is revoked or already consumed")
    if approval.get("channel") != context["channel"]: raise GateBlocked("approval channel does not match")
    for key in ("instagram_username", "instagram_user_id", "video_sha256", "meta_sha256"):
        if approval.get(key) != context[key]: raise GateBlocked(f"approval {key} does not match")
    checked = _utc_now(now); approved = _parse_iso(approval.get("approved_at"), "approved_at"); expires = _parse_iso(approval.get("expires_at"), "expires_at")
    if approved > checked or checked >= expires: raise GateBlocked("approval expired or is in the future")
    return {**context, "approval": approval, "approval_path": path, "secret": secret}


def _duplicate(ledger: dict[str, Any], context: dict[str, Any]) -> bool:
    return any((entry.get("channel"), entry.get("video_sha256"), entry.get("caption_sha256")) == (context["channel"], context["video_sha256"], context["caption_sha256"]) and entry.get("status", "published") not in ("cancelled", "revoked") for entry in ledger["entries"])


def approve(reel: str | Path, *, video: str | Path | None = None, meta: str | Path | None = None, channel: str | None = None, approver: str, ttl: float = DEFAULT_TTL_HOURS, now: datetime | None = None) -> dict[str, Any]:
    try:
        if not sys.stdin.isatty(): raise GateConfigError("approve requires an interactive TTY")
        approver = _clean_label(approver, "approver"); context = _context(reel, video, meta, channel)
        if not math.isfinite(ttl) or ttl <= 0: raise GateConfigError("ttl must be positive")
        print(f"channel={context['channel']}\nvideo_sha256={context['video_sha256']}\nmeta_sha256={context['meta_sha256']}\ncaption_sha256={context['caption_sha256']}", file=sys.stderr)
        if not hmac.compare_digest(input(f"Type 'PUBLISH {context['channel']}': ").strip(), f"PUBLISH {context['channel']}"): raise GateConfigError("approval confirmation did not match")
        approved = _utc_now(now); approval = {"schema": APPROVAL_SCHEMA, "approval_id": secrets.token_hex(16), "channel": context["channel"], "approver": approver, "approved_at": _iso(approved), "expires_at": _iso(approved + timedelta(hours=ttl)), "ttl_hours": ttl, "video_path": str(context["video_path"].relative_to(context["reel"])), "video_sha256": context["video_sha256"], "video_bytes": context["video_bytes"], "meta_path": str(context["meta_path"].relative_to(context["reel"])), "meta_sha256": context["meta_sha256"], "meta_bytes": context["meta_bytes"], "caption_sha256": context["caption_sha256"], "instagram_username": context["instagram_username"], "instagram_user_id": context["instagram_user_id"], "consumed_at": None, "transaction_id": None}
        secret = _secret(True); approval["signature_alg"] = "hmac-sha256"; approval["signature"] = _signature(approval, secret)
        with _lock(context["reel"]):
            if _duplicate(_ledger(context["reel"] / LEDGER_FILE, secret), context): raise GateBlocked("this channel/video/caption combination was already published")
            _atomic_json(context["reel"] / APPROVAL_FILE, approval)
        return _result(True, "approved", "approval recorded", approver=approver, **_public(context))
    except GateBlocked as exc: return _result(False, "blocked", str(exc))
    except (GateConfigError, OSError, EOFError) as exc: return _result(False, "invalid", str(exc))


def verify(reel: str | Path, *, video: str | Path | None = None, meta: str | Path | None = None, channel: str | None = None, now: datetime | None = None) -> dict[str, Any]:
    try:
        context = _verify_context(reel, video, meta, channel, now); return _result(True, "approved", "approval valid", approver=context["approval"]["approver"], **_public(context))
    except GateBlocked as exc: return _result(False, "blocked", str(exc))
    except (GateConfigError, OSError) as exc: return _result(False, "invalid", str(exc))


verify_approval = verify


class ContractArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        print(json.dumps(_result(False, "invalid", message), separators=(",", ":"))); raise SystemExit(2)


def build_parser() -> argparse.ArgumentParser:
    parser = ContractArgumentParser(description=__doc__); commands = parser.add_subparsers(dest="command", required=True)
    for name, function in (("approve", "record interactive approval"), ("verify", "verify approval and duplicate gate")):
        sub = commands.add_parser(name, help=function); sub.add_argument("reel"); sub.add_argument("--video"); sub.add_argument("--meta"); sub.add_argument("--channel")
        if name == "approve": sub.add_argument("--approver", required=True); sub.add_argument("--ttl", type=float, default=DEFAULT_TTL_HOURS)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv); common = {"video": args.video, "meta": args.meta, "channel": args.channel}
    result = approve(args.reel, approver=args.approver, ttl=args.ttl, **common) if args.command == "approve" else verify(args.reel, **common)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":"))); return 0 if result["ok"] else 3 if result["status"] == "blocked" else 2


if __name__ == "__main__": raise SystemExit(main())
