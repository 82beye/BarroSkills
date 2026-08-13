#!/usr/bin/env python3
"""topic_from_intel.py — R0: 경쟁 인텔에서 릴 주제 후보를 뽑는다.

barrotube 스킬의 경쟁 인텔 분석(analysis-YYYY-MM-DD.json)을 읽어
<reel>/00_topic.json 을 만든다. 결정론적이며 LLM 도 네트워크도 쓰지 않는다.

선정 규칙 (우선순위):
  1. blue_ocean_keywords — 수요는 있는데 경쟁이 얕은 키워드가 최우선
  2. content_gaps        — 2개 이상 채널이 다뤘고 우리는 안 다룬 주제
  둘 다 outliers 에 걸린 주제는 제외한다 (이미 소진된 화제).

이 스크립트는 주제를 '고르기만' 한다. 사실 검증은 R0.5 가 별도로 하며,
거기서 HIGH 위험이 나오면 다음 후보로 넘어가는 것은 호출자 책임이다.

Exit codes (render_reel_job.py 규약과 동일):
  0  00_topic.json 작성 완료
  2  설정·인자 오류
  3  blocked — 쓸 만한 인텔이 없다 (사람이 주제를 정해야 한다)

Usage:
  python3 topic_from_intel.py <reel_dir> [--date YYYY-MM-DD] [--intel-dir PATH]
  python3 topic_from_intel.py <reel_dir> --dry-run
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
# barrotube 는 형제 스킬이다. workspace 는 ~/BarroTubeData 로 가는 심볼릭이지만
# Path 가 따라가므로 그대로 쓴다.
DEFAULT_INTEL_DIR = SKILL_ROOT.parent / "barrotube" / "workspace" / "intel" / "competitors"

MAX_INTEL_AGE_DAYS = 3
MAX_CANDIDATES = 5


def emit(payload: dict, code: int) -> int:
    """stdout 에 JSON 하나만 낸다 (render_reel_job.py 와 같은 계약)."""
    print(json.dumps(payload, ensure_ascii=False))
    return code


def newest_analysis(intel_dir: Path, date: str | None) -> Path | None:
    if date:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            return None
        base = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        for back in range(MAX_INTEL_AGE_DAYS + 1):
            d = (base - timedelta(days=back)).strftime("%Y-%m-%d")
            path = intel_dir / f"analysis-{d}.json"
            if path.is_file():
                return path
        return None

    if not intel_dir.is_dir():
        return None
    files = sorted(p for p in intel_dir.glob("analysis-*.json")
                   if re.fullmatch(r"analysis-\d{4}-\d{2}-\d{2}\.json", p.name))
    return files[-1] if files else None


def outlier_terms(analysis: dict) -> set[str]:
    """이상치 영상 제목에 등장한 토큰 — 이미 소진된 화제라 후보에서 뺀다."""
    terms: set[str] = set()
    for o in analysis.get("outliers", []):
        for tok in re.findall(r"[가-힣A-Za-z0-9]{2,}", o.get("title", "")):
            terms.add(tok.lower())
    return terms


def build_candidates(analysis: dict) -> list[dict]:
    burned = outlier_terms(analysis)
    out: list[dict] = []

    for b in analysis.get("blue_ocean_keywords", []):
        kw = b.get("keyword", "")
        if not kw or any(t in burned for t in kw.lower().split()):
            continue
        out.append({
            "topic": kw,
            "source": "blue_ocean",
            "score": b.get("score"),
            "competition": b.get("competition"),
            "evidence": b.get("evidence", [])[:3],
        })

    for g in analysis.get("content_gaps", []):
        term = g.get("term", "")
        if not term or any(t in burned for t in term.lower().split()):
            continue
        if any(c["topic"] == term for c in out):
            continue
        out.append({
            "topic": term,
            "source": "content_gap",
            "score": g.get("gap_score"),
            "comp_df": g.get("comp_df"),
            "evidence": [e.get("videoId") for e in g.get("evidence", [])][:3],
        })

    return out[:MAX_CANDIDATES]


def positive_features(analysis: dict) -> list[str]:
    return [f["feature"] for f in analysis.get("patterns", {}).get("title_features", [])
            if f.get("direction") == "positive"]


def main() -> int:
    ap = argparse.ArgumentParser(description="Pick a reel topic from competitor intel")
    ap.add_argument("reel")
    ap.add_argument("--date")
    ap.add_argument("--intel-dir")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="overwrite an existing 00_topic.json")
    args = ap.parse_args()

    reel = Path(args.reel).expanduser()
    if not reel.is_dir():
        return emit({"ok": False, "stage": "R0", "error": f"reel dir not found: {reel}"}, 2)

    intel_dir = Path(args.intel_dir).expanduser() if args.intel_dir else DEFAULT_INTEL_DIR
    target = reel / "00_topic.json"

    if target.is_file() and not args.force and not args.dry_run:
        existing = json.loads(target.read_text(encoding="utf-8"))
        return emit({"ok": True, "stage": "R0", "skipped": "00_topic.json already exists",
                     "topic": existing.get("topic")}, 0)

    path = newest_analysis(intel_dir, args.date)
    if path is None:
        return emit({
            "ok": False, "stage": "R0", "blocked": True,
            "error": f"no competitor analysis within {MAX_INTEL_AGE_DAYS}d under {intel_dir}",
            "next_action": "run `bash lib/competitor-pipeline.sh` in the barrotube skill, "
                           "or write 00_topic.json by hand",
        }, 3)

    try:
        analysis = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return emit({"ok": False, "stage": "R0", "error": f"unreadable analysis: {exc}"}, 2)

    candidates = build_candidates(analysis)
    if not candidates:
        return emit({
            "ok": False, "stage": "R0", "blocked": True,
            "error": "analysis has no usable blue-ocean or gap terms",
            "source": str(path),
            "next_action": "widen the competitor set or write 00_topic.json by hand",
        }, 3)

    chosen = candidates[0]
    payload = {
        "schema": "barrotube.reel_topic.v1",
        "topic": chosen["topic"],
        "angle": None,  # R0.5 통과 후 strategist 가 채운다
        "source": chosen["source"],
        "score": chosen.get("score"),
        "evidence": chosen.get("evidence", []),
        "intel_date": analysis.get("date"),
        "intel_file": str(path),
        "title_features_positive": positive_features(analysis),
        "fact_check_required": True,
        "alternates": candidates[1:],
        "picked_at": datetime.now(timezone.utc).isoformat(),
    }

    if args.dry_run:
        return emit({"ok": True, "stage": "R0", "dry_run": True, "would_write": str(target),
                     "topic": payload["topic"], "source": payload["source"],
                     "alternates": [c["topic"] for c in candidates[1:]]}, 0)

    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return emit({"ok": True, "stage": "R0", "written": str(target),
                 "topic": payload["topic"], "source": payload["source"],
                 "intel_date": payload["intel_date"],
                 "alternates": [c["topic"] for c in candidates[1:]]}, 0)


if __name__ == "__main__":
    sys.exit(main())
