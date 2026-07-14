#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
carousel_job.py — 캐러셀(1:1 4~5컷) 결정론 파이프라인.

릴스에 render_reel_job.py + reel_autopilot.py + qa_reel_media.py 가 있듯이,
캐러셀에는 이 파일 하나가 상태머신 + 빌더 + QA + 발행메타를 담당한다.

핵심 설계: 캐러셀 슬라이드의 소스는 세 종류다.
  file:<경로>      이미 만든(=QA 통과한) 릴스 스틸을 재사용  → 브라우저 불필요, 캐릭터 드리프트 0
  video:<경로>#t=S 릴스 클립의 한 프레임을 뽑아 씀 (ffmpeg)  → 브라우저 불필요
  generate:<프롬프트>  새 이미지가 필요 → 브라우저(ChatGPT) 필요 → build 가 pending 으로 남기고 멈춤

회상·정리형 캐러셀(주간 리캡, 사용설명서, 성장 앨범)은 앞의 두 종류만으로 완성된다.
그래서 이 스크립트는 headless·무결제·비가역행위 없이 C0~C3 을 끝까지 몰고,
generate 소스가 있거나 발행(C4) 차례면 그 앞에서 정확히 멈춘다.

Stages
  C0 script   script.md (SLIDE 블록) 존재
  C1 slides   slides/slide-N.png (1080x1080) 생성
  C2 qa       60_qa_report.carousel.json (§6 캐러셀 5항목 중 자동검증 가능분)
  C3 meta     70_publish_meta.instagram.json + caption.md
  C4 publish  HITL — 이 스크립트는 절대 게시하지 않는다

Usage
  python3 carousel_job.py plan   <dir>                 # script.md → carousel-job.json
  python3 carousel_job.py build  <dir> [--force]       # 슬라이드 렌더
  python3 carousel_job.py qa     <dir>
  python3 carousel_job.py meta   <dir>
  python3 carousel_job.py sync   <dir>                 # 파일 실측 → 단계 상태(JSON)
  python3 carousel_job.py autopilot <dir> [--episode BT-EP07]
"""
import argparse, hashlib, json, os, re, subprocess, sys, textwrap
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
SCHEMA = "barrotube.carousel_job.v1"
CANVAS = 1080                      # 1:1 정방형
STAGES = [("C0", "script"), ("C1", "slides"), ("C2", "qa"), ("C3", "meta"), ("C4", "publish")]
MIN_SLIDES, MAX_SLIDES = 4, 5      # 설계문서 §4: 캐러셀 = 1:1 4~5컷

# §6 캐러셀 QA 5항목 중 '캡션' 항목: mayo 실문구 표절 금지 (다른 계정 문구 복제 방지)
FORBIDDEN_CAPTION = ["mayo", "마요", "@mayo"]


def now():
    return datetime.now(KST).isoformat(timespec="seconds")


def die(msg, code=1):
    print("✗ " + msg, file=sys.stderr)
    sys.exit(code)


# ── 폰트 ─────────────────────────────────────────────────────────────────────
def _font(size, bold=False):
    from PIL import ImageFont
    cands = [("/System/Library/Fonts/AppleSDGothicNeo.ttc", 6 if bold else 2),
             ("/System/Library/Fonts/AppleSDGothicNeo.ttc", 0),
             ("/System/Library/Fonts/Supplemental/AppleGothic.ttf", 0)]
    for path, idx in cands:
        if not os.path.exists(path):
            continue
        try:
            return ImageFont.truetype(path, size, index=idx)
        except Exception:
            continue
    return ImageFont.load_default()


# ── script.md 파싱 ───────────────────────────────────────────────────────────
FIELD = {
    "out":      r"이미지 파일",
    "source":   r"이미지 소스",
    "headline": r"헤드라인",
    "sub":      r"서브",
    "crop":     r"크롭",
}


def _field(block, key):
    m = re.search(r"^\s*-\s*\*\*%s:?\*\*[:\s]*(.+)$" % FIELD[key], block, re.M)
    if not m:
        return None
    v = m.group(1).strip()
    return v.strip("`").strip()


def parse_script(path):
    """script.md 의 '## SLIDE n' 블록 → 슬라이드 목록. 발행 메타도 함께 뽑는다."""
    md = open(path, encoding="utf-8").read()
    blocks = re.split(r"^##\s+SLIDE\s+", md, flags=re.M)[1:]
    slides = []
    for b in blocks:
        head = b.splitlines()[0]
        m = re.match(r"(\d+)\s*(?:—|-|·)?\s*(.*)", head)
        if not m:
            continue
        n = int(m.group(1))
        src = _field(b, "source")
        slides.append({
            "n": n,
            "title": m.group(2).strip(),
            "out": _field(b, "out") or ("slides/slide-%d.png" % n),
            "source": src or "",
            "source_kind": ("generate" if (src or "").startswith("generate:")
                            else "video" if (src or "").startswith("video:")
                            else "file" if src else "missing"),
            "headline": _field(b, "headline") or "",
            "sub": _field(b, "sub") or "",
            "crop": (_field(b, "crop") or "upper").lower(),
        })
    slides.sort(key=lambda s: s["n"])

    cap = re.search(r"^\s*-\s*\*\*인스타 캡션\*\*[:\s]*(.+)$", md, re.M)
    tags = re.search(r"^\s*-\s*\*\*해시태그\*\*[:\s]*(.+)$", md, re.M)
    title = re.search(r"^#\s+(.+)$", md, re.M)
    return {
        "title": title.group(1).strip() if title else "",
        "slides": slides,
        "caption": cap.group(1).strip() if cap else "",
        "hashtags": tags.group(1).strip() if tags else "",
    }


# ── job json ────────────────────────────────────────────────────────────────
def job_path(d):
    return os.path.join(d, "carousel-job.json")


def load_job(d):
    p = job_path(d)
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else None


def save_job(d, job):
    job["updated_at"] = now()
    with open(job_path(d), "w", encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False, indent=2)


def cmd_plan(d, episode=None):
    sp = os.path.join(d, "script.md")
    if not os.path.exists(sp):
        die("script.md 없음: %s (C0 미완 — 대본부터 써야 한다)" % sp)
    parsed = parse_script(sp)
    if not parsed["slides"]:
        die("script.md 에 '## SLIDE n' 블록이 없다 — 캐러셀 대본 포맷이 아니다")
    job = load_job(d) or {"schema": SCHEMA, "created_at": now()}
    job.update({
        "schema": SCHEMA,
        "carousel_dir": os.path.abspath(d),
        "episode": episode or job.get("episode") or os.path.basename(os.path.abspath(d)),
        "title": parsed["title"],
        "caption": parsed["caption"],
        "hashtags": parsed["hashtags"],
        "slides": parsed["slides"],
    })
    save_job(d, job)
    print("✓ plan — 슬라이드 %d컷 (%s)" % (
        len(parsed["slides"]),
        ", ".join("%d:%s" % (s["n"], s["source_kind"]) for s in parsed["slides"])))
    return job


# ── 슬라이드 렌더 ────────────────────────────────────────────────────────────
def _resolve(d, rel):
    """소스 경로는 캐러셀 폴더 기준 상대경로 또는 절대경로."""
    return rel if os.path.isabs(rel) else os.path.normpath(os.path.join(d, rel))


def _load_source(d, slide, tmpdir):
    from PIL import Image
    src = slide["source"]
    kind = slide["source_kind"]
    if kind == "file":
        p = _resolve(d, src)
        if not os.path.isfile(p):
            return None, "소스 파일 없음: %s" % src
        return Image.open(p).convert("RGB"), None
    if kind == "video":
        body = src[len("video:"):]
        path, _, t = body.partition("#t=")
        p = _resolve(d, path)
        if not os.path.isfile(p):
            return None, "소스 영상 없음: %s" % path
        os.makedirs(tmpdir, exist_ok=True)
        out = os.path.join(tmpdir, "frame-%d.png" % slide["n"])
        cmd = ["ffmpeg", "-y", "-ss", (t or "0"), "-i", p, "-frames:v", "1", out]
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode != 0 or not os.path.exists(out):
            return None, "ffmpeg 프레임 추출 실패: %s" % path
        return Image.open(out).convert("RGB"), None
    if kind == "generate":
        return None, "generate 소스 — 브라우저(ChatGPT) 필요. build 가 처리하지 않는다"
    return None, "이미지 소스 미지정"


def _cover_square(img, crop="upper"):
    """9:16 → 1:1 커버 크롭. 고양이 얼굴이 보통 상단~중앙이라 기본 앵커는 upper."""
    from PIL import Image
    w, h = img.size
    side = min(w, h)
    if w >= h:
        left = (w - side) // 2
        box = (left, 0, left + side, side)
    else:
        anchor = {"top": 0.0, "upper": 0.28, "center": 0.5, "lower": 0.72, "bottom": 1.0}.get(crop, 0.28)
        top = int((h - side) * anchor)
        box = (0, top, side, top + side)
    return img.crop(box).resize((CANVAS, CANVAS), Image.LANCZOS)


def _wrap(draw, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= max_w or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def render_slide(d, slide, total, badge, tmpdir):
    from PIL import Image, ImageDraw
    img, err = _load_source(d, slide, tmpdir)
    if err:
        return None, err
    canvas = _cover_square(img, slide.get("crop", "upper"))

    # 하단 그라디언트 밴드 — 자막 가독성 (인스타 1:1 세이프존 안쪽)
    band_h = 360
    grad = Image.new("L", (1, band_h))
    for y in range(band_h):
        grad.putpixel((0, y), int(235 * (y / band_h) ** 1.35))
    grad = grad.resize((CANVAS, band_h))
    dark = Image.new("RGB", (CANVAS, band_h), (11, 13, 18))
    canvas.paste(dark, (0, CANVAS - band_h), grad)

    dr = ImageDraw.Draw(canvas)
    pad = 64

    # 배지 (좌상단) — 채널/화 표기
    fb = _font(34, bold=True)
    bw = dr.textlength(badge, font=fb) + 44
    dr.rounded_rectangle([pad, pad, pad + bw, pad + 60], radius=30, fill=(11, 13, 18, 255))
    dr.text((pad + 22, pad + 12), badge, font=fb, fill=(255, 214, 122))

    # 페이지 인디케이터 (우상단)
    fp = _font(30, bold=True)
    pg = "%d / %d" % (slide["n"], total)
    pw = dr.textlength(pg, font=fp) + 36
    dr.rounded_rectangle([CANVAS - pad - pw, pad, CANVAS - pad, pad + 54], radius=27, fill=(11, 13, 18))
    dr.text((CANVAS - pad - pw + 18, pad + 11), pg, font=fp, fill=(236, 240, 246))

    # 헤드라인 + 서브
    y = CANVAS - band_h + 78
    fh = _font(58, bold=True)
    for ln in _wrap(dr, slide["headline"], fh, CANVAS - pad * 2)[:2]:
        dr.text((pad, y), ln, font=fh, fill=(255, 255, 255))
        y += 70
    if slide["sub"]:
        fs = _font(38)
        y += 8
        for ln in _wrap(dr, slide["sub"], fs, CANVAS - pad * 2)[:2]:
            dr.text((pad, y), ln, font=fs, fill=(198, 206, 218))
            y += 48

    out = _resolve(d, slide["out"])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    canvas.save(out, "PNG")
    return out, None


def cmd_build(d, force=False):
    job = load_job(d) or cmd_plan(d)
    n = len(job["slides"])
    badge = job.get("badge") or "오늘묘 · %s" % (job.get("episode") or "")
    tmp = os.path.join(d, ".tmp_frames")
    made, pending, errors = [], [], []
    for s in job["slides"]:
        out = _resolve(d, s["out"])
        if os.path.exists(out) and not force:
            made.append(s["out"])
            continue
        if s["source_kind"] == "generate":
            pending.append({"slide": s["n"], "prompt": s["source"][len("generate:"):].strip(),
                            "out": s["out"]})
            continue
        p, err = render_slide(d, s, n, badge, tmp)
        (made.append(s["out"]) if p else errors.append("slide %d: %s" % (s["n"], err)))
    if os.path.isdir(tmp):
        for f in os.listdir(tmp):
            os.remove(os.path.join(tmp, f))
        os.rmdir(tmp)

    job["pending_slides"] = pending
    save_job(d, job)
    for e in errors:
        print("✗ " + e, file=sys.stderr)
    print("✓ build — 슬라이드 %d/%d 생성%s" % (len(made), n,
          (" · generate 대기 %d컷 (브라우저 필요)" % len(pending)) if pending else ""))
    if pending:
        print("  → 브라우저 세션에서 barrotube-media-render 로 생성:")
        for p in pending:
            print("     slide %d → %s" % (p["slide"], p["out"]))
    return not errors and not pending


# ── QA (§6 캐러셀 5항목) ─────────────────────────────────────────────────────
def _md5(p):
    return hashlib.md5(open(p, "rb").read()).hexdigest()


def cmd_qa(d):
    from PIL import Image
    job = load_job(d) or cmd_plan(d)
    slides = job["slides"]
    checks = []

    def add(cid, level, ok, detail):
        checks.append({"id": cid, "level": level, "ok": bool(ok), "detail": detail})

    # 1. 사양: 1:1 · 4~5컷 · 순서
    paths = [_resolve(d, s["out"]) for s in slides]
    missing = [s["out"] for s, p in zip(slides, paths) if not os.path.isfile(p)]
    add("count", "error", MIN_SLIDES <= len(slides) <= MAX_SLIDES and not missing,
        "슬라이드 %d컷 (기준 %d~%d)%s" % (len(slides), MIN_SLIDES, MAX_SLIDES,
                                      (" · 누락 " + ", ".join(missing)) if missing else ""))
    sizes = []
    for p in paths:
        if os.path.isfile(p):
            sizes.append(Image.open(p).size)
    add("square", "error", bool(sizes) and all(w == h == CANVAS for w, h in sizes),
        "정방형 %dx%d: %s" % (CANVAS, CANVAS, ", ".join("%dx%d" % s for s in sizes) or "없음"))
    add("order", "error", [s["n"] for s in slides] == list(range(1, len(slides) + 1)),
        "컷 순서 1..N 연속")
    hashes = [_md5(p) for p in paths if os.path.isfile(p)]
    add("dupes", "error", len(set(hashes)) == len(hashes), "슬라이드 중복 없음")

    # 2. DNA 3요소 — 소스가 QA 통과 릴스 자산이면 상속, 아니면 사람이 확인
    inherited, unknown = [], []
    for s in slides:
        src = s["source"]
        if s["source_kind"] in ("file", "video"):
            base = _resolve(d, src[6:].split("#")[0] if s["source_kind"] == "video" else src)
            reel = os.path.dirname(os.path.dirname(base))
            rep = os.path.join(reel, "60_qa_report.images.json")
            ok = False
            if os.path.isfile(rep):
                try:
                    ok = bool(json.load(open(rep, encoding="utf-8")).get("ok"))
                except Exception:
                    ok = False
            (inherited if ok else unknown).append(s["n"])
        else:
            unknown.append(s["n"])
    add("dna_inherited", "warn", not unknown,
        "DNA: QA통과 릴스 자산 상속 %s%s" % (inherited or "없음",
        (" · 사람 확인 필요 " + str(unknown)) if unknown else ""))

    # 3. 1컷 훅
    first = slides[0] if slides else {}
    add("hook", "warn", bool(first.get("headline")), "1컷 훅 문구: %s" % (first.get("headline") or "없음"))

    # 4. 마지막 컷 = 반전 또는 다음 화 예고
    last = slides[-1] if slides else {}
    tail = (last.get("headline", "") + " " + last.get("sub", ""))
    add("cliffhanger", "warn", any(k in tail for k in ("?", "예고", "다음", "내일", "(")),
        "마지막 컷 예고/반전: %s" % (tail.strip() or "없음"))

    # 5. 캡션 — 1인칭 훅 + 타 계정 실문구 미사용
    cap = job.get("caption", "")
    add("caption_exists", "error", bool(cap), "인스타 캡션 초안 존재")
    hit = [w for w in FORBIDDEN_CAPTION if w.lower() in cap.lower()]
    add("caption_clean", "error", not hit, "금지 문구 미사용%s" % ((" · 발견: " + ", ".join(hit)) if hit else ""))
    add("caption_first_person", "warn",
        any(k in cap for k in ("나", "내", "임", "냥", "함")), "1인칭 톤 유지")

    ok = all(c["ok"] for c in checks if c["level"] == "error")
    report = {"schema": "barrotube.qa_report.carousel.v1", "carousel_dir": os.path.abspath(d),
              "episode": job.get("episode"), "generated_at": now(), "ok": ok, "checks": checks}
    with open(os.path.join(d, "60_qa_report.carousel.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    for c in checks:
        print("  %s %-18s %s" % ("✓" if c["ok"] else ("✗" if c["level"] == "error" else "⚠"),
                                 c["id"], c["detail"]))
    print(("✓ QA PASS" if ok else "✗ QA FAIL") + " → 60_qa_report.carousel.json")
    return ok


# ── 발행 메타 ────────────────────────────────────────────────────────────────
def cmd_meta(d):
    job = load_job(d) or cmd_plan(d)
    slides = job["slides"]
    tags = [t.strip() for t in re.split(r"[·,\s]+", job.get("hashtags", "")) if t.startswith("#")]
    meta = {
        "schema": "barrotube.publish_meta.instagram.v1",
        "episode": job.get("episode"),
        "media_type": "carousel",
        "generated_at": now(),
        "assets": [s["out"] for s in slides],
        "caption": job.get("caption", ""),
        "hashtags": tags,
        "alt_texts": [(s["headline"] + (" — " + s["sub"] if s["sub"] else "")) for s in slides],
        "publish": {"status": "ready", "requires_human_approval": True,
                    "note": "게시는 tools/publish-process.sh 로 사람이 승인·처리 (HITL)"},
    }
    with open(os.path.join(d, "70_publish_meta.instagram.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    with open(os.path.join(d, "caption.md"), "w", encoding="utf-8") as f:
        f.write("# %s — 인스타 캡션\n\n%s\n\n%s\n" % (job.get("title", ""), meta["caption"],
                                                   " ".join(tags)))
    print("✓ meta — 70_publish_meta.instagram.json · caption.md (해시태그 %d개)" % len(tags))
    return True


# ── 상태 동기화 (보드/브리지가 읽는 진실원천) ────────────────────────────────
def cmd_sync(d, as_json=False):
    have_script = os.path.isfile(os.path.join(d, "script.md"))
    job = load_job(d)
    slides = (job or {}).get("slides", [])
    built = [s for s in slides if os.path.isfile(_resolve(d, s["out"]))]
    qa_path = os.path.join(d, "60_qa_report.carousel.json")
    qa = json.load(open(qa_path, encoding="utf-8")) if os.path.isfile(qa_path) else None
    meta_ok = os.path.isfile(os.path.join(d, "70_publish_meta.instagram.json"))

    status = {
        "C0": "completed" if have_script else "pending",
        "C1": "completed" if (slides and len(built) == len(slides)) else
              ("in_progress" if built else "pending"),
        "C2": ("completed" if (qa and qa.get("ok")) else
               ("qa_failed" if qa else "pending")),
        "C3": "completed" if meta_ok else "pending",
        "C4": "hitl",   # 게시는 언제나 사람 승인
    }
    out = {"schema": SCHEMA, "carousel_dir": os.path.abspath(d),
           "episode": (job or {}).get("episode"),
           "stages": [{"stage": s, "name": n, "status": status[s]} for s, n in STAGES],
           "slides_total": len(slides), "slides_built": len(built),
           "pending_generate": [s["n"] for s in slides if s["source_kind"] == "generate"
                                and not os.path.isfile(_resolve(d, s["out"]))],
           "qa_ok": (qa or {}).get("ok"), "meta": meta_ok}
    if job:
        job["stage_status"] = status
        save_job(d, job)
    print(json.dumps(out, ensure_ascii=False, indent=None if as_json else 2))
    return out


def cmd_autopilot(d, episode=None):
    """headless 로 갈 수 있는 데까지: plan → build → qa → meta. 게시(C4)는 절대 안 함."""
    print("── 캐러셀 오토파일럿: %s" % d)
    cmd_plan(d, episode)
    done = cmd_build(d)
    if not done:
        print("⏸ 멈춤 — generate 소스(브라우저 필요) 또는 렌더 실패. 위 목록 처리 후 재실행.")
        cmd_sync(d)
        return False
    ok = cmd_qa(d)
    if not ok:
        print("⏸ 멈춤 — QA FAIL. 슬라이드/캡션 수정 후 재실행.")
        cmd_sync(d)
        return False
    cmd_meta(d)
    cmd_sync(d)
    print("✅ C0~C3 완료 — 남은 건 발행(C4·HITL): 보드의 📤 게시 요청 → tools/publish-process.sh")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["plan", "build", "qa", "meta", "sync", "autopilot"])
    ap.add_argument("dir")
    ap.add_argument("--episode")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    if not os.path.isdir(a.dir):
        die("폴더 없음: %s" % a.dir)
    if a.cmd == "plan":
        cmd_plan(a.dir, a.episode)
    elif a.cmd == "build":
        sys.exit(0 if cmd_build(a.dir, a.force) else 2)
    elif a.cmd == "qa":
        sys.exit(0 if cmd_qa(a.dir) else 2)
    elif a.cmd == "meta":
        cmd_meta(a.dir)
    elif a.cmd == "sync":
        cmd_sync(a.dir, a.json)
    else:
        sys.exit(0 if cmd_autopilot(a.dir, a.episode) else 2)


if __name__ == "__main__":
    main()
