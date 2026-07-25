#!/usr/bin/env python3
"""
render-karaoke-png.py — 카라오케 자막 PNG 렌더링 (PIL)

이 ffmpeg 빌드에는 libass/drawtext가 없어 텍스트는 전부 PNG로 구워 오버레이한다
(render-subtitle.py 와 동일한 제약). 이 스크립트는 한 문구(phrase)의 "진행 상태"를
한 장의 투명 PNG로 그린다 — 앞에서부터 highlight 개의 단어는 강조색, 나머지는 기본색.
render-direct.js 가 단어 시간창마다 highlight 값을 1,2,3…으로 올려가며 여러 장을 만들고,
그 PNG들을 시간 오버레이하면 TTS 싱크에 맞춰 글자색이 순차로 바뀌는 카라오케가 된다.

레이아웃(줄바꿈·박스·중앙정렬)은 highlight 값과 무관하게 결정적이므로, 상태가 바뀌어도
글자 위치는 고정되고 색만 변한다. render-subtitle.py 의 박스/스트로크 스타일을 맞췄다.

Usage:
  render-karaoke-png.py "<phrase text>" <out.png> --highlight N
      [--width 1080] [--fontsize 60] [--maxlines 3]
      [--base "#FFFFFF"] [--hl "#FF9A1F"] [--outline "#081320"]
"""

import sys
import argparse
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    '/System/Library/Fonts/AppleSDGothicNeo.ttc',
    '/System/Library/Fonts/Supplemental/NanumGothic.ttc',
    '/System/Library/Fonts/Helvetica.ttc',
]


def pick_font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def hex_rgba(s, alpha=255):
    s = s.lstrip('#')
    if len(s) == 3:
        s = ''.join(c * 2 for c in s)
    r, g, b = int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    return (r, g, b, alpha)


def layout(words, font, max_width, space_w):
    """단어(공백 분리)를 max_width 안에서 그리디 줄바꿈. 각 단어의 (global idx, line, x offset within line) 반환.
    반환: lines = [[(idx, word, w)], ...], 각 라인은 단어 목록."""
    lines = [[]]
    cur_w = 0
    for idx, w in enumerate(words):
        bbox = font.getbbox(w)
        ww = bbox[2] - bbox[0]
        add = ww if not lines[-1] else space_w + ww
        if lines[-1] and cur_w + add > max_width:
            lines.append([(idx, w, ww)])
            cur_w = ww
        else:
            lines[-1].append((idx, w, ww))
            cur_w += add
    return [ln for ln in lines if ln]


def render(text, out_path, highlight, width, fontsize, maxlines,
           base_hex, hl_hex, outline_hex, padding_x=40, line_spacing=12):
    words = text.split()
    if not words:
        # 빈 텍스트: 1x1 투명 (오버레이해도 무해)
        Image.new('RGBA', (1, 1), (0, 0, 0, 0)).save(out_path, 'PNG')
        return 1

    font = pick_font(fontsize)
    max_text_width = width - padding_x * 2
    space_w = font.getbbox(' ')[2] - font.getbbox(' ')[0] or fontsize // 3

    lines = layout(words, font, max_text_width, space_w)
    # 줄 수 초과 시 폰트 축소 (render-subtitle.py 와 동일 정책)
    attempts = 0
    while len(lines) > maxlines and fontsize > 36 and attempts < 6:
        fontsize -= 4
        font = pick_font(fontsize)
        space_w = font.getbbox(' ')[2] - font.getbbox(' ')[0] or fontsize // 3
        lines = layout(words, font, max_text_width, space_w)
        attempts += 1

    ascent, descent = font.getmetrics()
    line_h = ascent + descent
    total_h = line_h * len(lines) + line_spacing * (len(lines) - 1)
    img_h = total_h + 30 * 2

    img = Image.new('RGBA', (width, img_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 라인별 폭 (중앙 정렬용)
    def line_width(ln):
        return sum(w for _, _, w in ln) + space_w * (len(ln) - 1)

    max_line_w = max(line_width(ln) for ln in lines)
    box_x0 = (width - max_line_w) // 2 - 24
    box_x1 = box_x0 + max_line_w + 48
    draw.rounded_rectangle([box_x0, 10, box_x1, img_h - 10], radius=12, fill=(0, 0, 0, 140))

    base = hex_rgba(base_hex)
    hl = hex_rgba(hl_hex)
    outline = hex_rgba(outline_hex)
    stroke = max(2, fontsize // 18)

    y = 30
    for ln in lines:
        lw = line_width(ln)
        x = (width - lw) // 2
        for idx, w, ww in ln:
            color = hl if idx < highlight else base
            draw.text((x, y), w, font=font, fill=color,
                      stroke_width=stroke, stroke_fill=outline)
            x += ww + space_w
        y += line_h + line_spacing

    img.save(out_path, 'PNG')
    return img_h


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('text')
    p.add_argument('out')
    p.add_argument('--highlight', type=int, default=0)
    p.add_argument('--width', type=int, default=1080)
    p.add_argument('--fontsize', type=int, default=60)
    p.add_argument('--maxlines', type=int, default=3)
    p.add_argument('--base', default='#FFFFFF')
    p.add_argument('--hl', default='#FF9A1F')
    p.add_argument('--outline', default='#081320')
    a = p.parse_args()
    h = render(a.text, a.out, a.highlight, a.width, a.fontsize, a.maxlines,
               a.base, a.hl, a.outline)
    print(f'{a.out}:{h}', flush=True)
