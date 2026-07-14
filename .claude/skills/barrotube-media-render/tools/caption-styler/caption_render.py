#!/usr/bin/env python3
"""
Caption Styler — 세그먼트(자막+타이밍) → 투명 캡션 PNG 시퀀스 렌더.
릴스 자막 스타일 프리셋 지원. ffmpeg overlay로 영상에 합성한다.

스타일 프리셋:
  - nanum_pastel : 나훔템플릿 '파스텔 말 자막' 재현. 파스텔 라운드 pill + 굵은 검은 글자
                   + 얇은 외곽선, pill 팝인 애니메이션. (YouTube TPIsjnh_pHE 분석 기반)
  - pop_word     : 단어별 팝인 + 악센트 하이라이트(흰 글자/스크림). (v2)

사용:
  python caption_render.py <spec.json> <outdir>
spec.json = { "canvas":[1080,1920], "fps":30, "style":"nanum_pastel",
              "segments":[{"start":0.0,"dur":10.04,"text":"어… 뭐야 저 인간"}, ...],
              "font": "(옵션) 폰트파일 경로", "font_index": 6 }
"""
import json, os, sys, math
from PIL import Image, ImageDraw, ImageFont

APPLE = '/System/Library/Fonts/AppleSDGothicNeo.ttc'

PRESETS = {
    "nanum_pastel": {
        "font": APPLE, "font_index": 6,          # SD Gothic Neo Bold
        "text_color": (20, 20, 20), "outline": (255, 255, 255, 200), "outline_w": 2,
        "pill": True, "pill_colors": [(233, 229, 150), (234, 201, 232)],  # 노랑, 분홍 (교대)
        "pill_alpha": 235, "pill_radius_ratio": 0.5, "pad_x": 0.36, "pad_y": 0.30,
        "pill_border": (0, 0, 0, 60), "pill_border_w": 2,
        "pos_y": 0.72, "anim": "pill_pop",       # 하단(0=위,1=아래)
        "line_gap": 0.18,
    },
    "pop_word": {
        "font": APPLE, "font_index": 6,
        "text_color": (255, 255, 255), "accent": (255, 214, 120),
        "outline": (0, 0, 0, 235), "outline_w": 4, "shadow": True,
        "pill": False, "scrim": True, "pos_y": 0.70, "anim": "word_pop", "line_gap": 0.18,
    },
}

def ease_out_back(x):
    c1, c3 = 1.70158, 2.70158
    return 1 + c3*(x-1)**3 + c1*(x-1)**2

def render(spec, outdir):
    W, H = spec.get("canvas", [1080, 1920])
    fps = spec.get("fps", 30)
    st = dict(PRESETS[spec["style"]])
    if spec.get("font"): st["font"] = spec["font"]
    if spec.get("font_index") is not None: st["font_index"] = spec["font_index"]
    segs = spec["segments"]
    os.makedirs(outdir, exist_ok=True)

    fsize = spec.get("font_size", int(W * 0.062))
    font = ImageFont.truetype(st["font"], fsize, index=st.get("font_index", 0))
    total = max(s["start"] + s["dur"] for s in segs)
    nframes = round((total + spec.get("tail", 0.1)) * fps)

    # 각 세그먼트 레이아웃 사전계산
    def measure(text):
        tmp = Image.new("RGBA", (4, 4)); d = ImageDraw.Draw(tmp)
        bb = d.textbbox((0, 0), text, font=font, stroke_width=st.get("outline_w", 0))
        return bb

    for f in range(nframes):
        t = f / fps
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        seg = next((s for s in segs if s["start"] <= t < s["start"] + s["dur"]), None)
        if seg:
            age = t - seg["start"]
            _render_caption(img, d, seg["text"], age, W, H, font, st, fsize)
        img.save(os.path.join(outdir, f"f{f:04d}.png"))
    return nframes, (W, H)

def _pill_pop_state(age):
    POP = 0.34
    if age < POP:
        p = age / POP
        return 0.72 + ease_out_back(p) * 0.28, min(1.0, p * 1.7)
    return 1.0, 1.0

def _render_caption(img, d, text, age, W, H, font, st, fsize):
    # 줄바꿈: 폭 초과 시 공백 기준 2줄
    def line_w(s):
        bb = d.textbbox((0, 0), s, font=font, stroke_width=st.get("outline_w", 0)); return bb[2] - bb[0]
    maxw = W * 0.86
    lines = [text]
    if line_w(text) > maxw and " " in text:
        words = text.split(" ")
        best, bi = 1e9, 1
        for k in range(1, len(words)):
            a = line_w(" ".join(words[:k])); b = line_w(" ".join(words[k:]))
            if max(a, b) < best: best, bi = max(a, b), k
        lines = [" ".join(words[:bi]), " ".join(words[bi:])]

    scale, alpha = (1.0, 1.0)
    if st.get("anim") == "pill_pop":
        scale, alpha = _pill_pop_state(age)

    asc, desc = font.getmetrics()
    lh = asc + desc
    gap = int(lh * st.get("line_gap", 0.18))
    block_h = lh * len(lines) + gap * (len(lines) - 1)
    cy0 = int(H * st["pos_y"]) - block_h // 2

    # 각 줄을 자체 레이어에 그린 뒤 scale/alpha 적용(pill 팝)
    for li, line in enumerate(lines):
        bb = d.textbbox((0, 0), line, font=font, stroke_width=st.get("outline_w", 0))
        tw = bb[2] - bb[0]
        pad_x = int(lh * st.get("pad_x", 0.36)); pad_y = int(lh * st.get("pad_y", 0.30))
        pill_w = tw + 2 * pad_x; pill_h = lh + 2 * pad_y
        layer = Image.new("RGBA", (pill_w + 8, pill_h + 8), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ox, oy = 4, 4
        if st.get("pill"):
            col = st["pill_colors"][li % len(st["pill_colors"])]
            r = int(pill_h * st.get("pill_radius_ratio", 0.5))
            ld.rounded_rectangle([ox, oy, ox + pill_w, oy + pill_h], radius=r,
                                 fill=col + (st.get("pill_alpha", 235),),
                                 outline=st.get("pill_border"), width=st.get("pill_border_w", 0))
        tx = ox + pad_x - bb[0]; ty = oy + pad_y - bb[1]
        if st.get("shadow"):
            for dx, dy in [(0, 3), (0, 4)]:
                ld.text((tx + dx, ty + dy), line, font=font, fill=(0, 0, 0, 120),
                        stroke_width=st.get("outline_w", 0), stroke_fill=(0, 0, 0, 120))
        ld.text((tx, ty), line, font=font, fill=st["text_color"] if len(st["text_color"]) == 4 else st["text_color"] + (255,),
                stroke_width=st.get("outline_w", 0), stroke_fill=st.get("outline", (0, 0, 0, 255)))
        # scale/alpha
        if scale != 1.0:
            nw, nh = max(1, int(layer.width * scale)), max(1, int(layer.height * scale))
            layer = layer.resize((nw, nh), Image.LANCZOS)
        if alpha < 1.0:
            layer.putalpha(layer.split()[3].point(lambda v: int(v * alpha)))
        cx = (W - layer.width) // 2
        cy = cy0 + li * (lh + gap) - (layer.height - (lh + 2 * int(lh * st.get('pad_y', 0.30)))) // 2
        img.alpha_composite(layer, (cx, cy))

if __name__ == "__main__":
    spec = json.load(open(sys.argv[1])); n, sz = render(spec, sys.argv[2])
    print(f"rendered {n} frames @ {sz[0]}x{sz[1]} style={spec['style']}")
