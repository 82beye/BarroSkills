/**
 * card-composition.js — 인트로·아웃트로 카드의 텍스트를 HyperFrames 로 합성한다.
 *
 * 왜 필요한가. 카드 텍스트를 이미지 모델에게 그리게 하면 두 가지가 깨진다.
 *   1) 한글 오타 — "메타"가 "머타"로 나온 사례가 있고, 그래서 여태 "저장 전 타이틀을
 *      확대해서 눈으로 검수" 라는 수동 절차가 붙어 있었다.
 *   2) 뜻이 어긋남 — vision 검증은 철자만 본다. EP-2026-0093 인트로는 +2.42% 상승
 *      회차인데 빨간 폭락 차트와 LED "N/A" 를 그려 놓고 "철자 정확" 으로 통과했다.
 * 배경 그림만 모델에게 맡기고 글자는 여기서 얹으면 둘 다 사라진다.
 *
 * 문안 규칙 (발행본 EP-2026-0085 기준):
 *   인트로·썸네일 = **자극적인 타이틀**. 대비·반전 구조에 수치를 박는다.
 *       "사상 최고치인데 AMD는 왜 8% 빠졌나" / 부제 "실적은 다 이겼는데"
 *   아웃트로     = **정의**. 그 회차가 무엇이었는지 한 줄로 규정한다.
 *       "이젠 얼마 버나가 아니라 얼마 쓰나를 본다"
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANVAS = { w: 1080, h: 1920, fps: 30 };

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 카드 타이포 정본은 config/cards.json 이다. 폰트를 바꾸려면 거기만 고친다 —
 * 스크립트마다 문자열을 박아 두면 인트로와 아웃트로가 갈라진다.
 */
export function loadCardConfig(kind = 'intro') {
  try {
    const cfg = JSON.parse(readFileSync(join(SKILL_DIR, 'config', 'cards.json'), 'utf-8'));
    return cfg[kind] || {};
  } catch {
    return {};
  }
}

export const CARD_STYLE = {
  base: '#FFFFFF',
  /** 수치·핵심 구절. 하락·경고 회차에 쓴다. */
  alert: '#FF4D4D',
  /** 상승·중립 회차의 강조. */
  accent: '#FFC53D',
  sub: '#C9D3DF',
  badgeBg: '#FFC53D',
  badgeFg: '#0A0A0A',
  scrim: 'rgba(6, 10, 18, 0.62)',
};

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 타이틀 한 줄의 글자 크기. 카드는 자막보다 크게 간다 — 썸네일로 축소돼도 읽혀야 한다.
 * 줄바꿈은 문안이 `|` 로 지정하거나, 없으면 공백 기준으로 균등 분할한다.
 */
export function layoutTitle(title, { maxLines = 3 } = {}) {
  const explicit = String(title).includes('|');
  const lines = explicit
    ? String(title).split('|').map(s => s.trim()).filter(Boolean)
    : balance(String(title).trim(), maxLines);
  const longest = Math.max(...lines.map(l => l.replace(/\s/g, '').length), 1);
  const usable = CANVAS.w - 2 * 72;
  // 한글 한 글자 ≈ 1em. 가장 긴 줄이 폭 안에 들어오는 최대 크기.
  const fontSize = Math.max(56, Math.min(124, Math.floor(usable / longest)));
  return { lines, fontSize };
}

function balance(text, maxLines) {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return [text];
  const target = Math.min(maxLines, Math.max(2, Math.ceil(text.length / 12)));
  const per = Math.ceil(parts.length / target);
  const out = [];
  for (let i = 0; i < parts.length; i += per) out.push(parts.slice(i, i + per).join(' '));
  return out.slice(0, maxLines);
}

/** `**강조**` 구간을 색으로 감싼다. 나머지는 흰색. */
export function markupTitle(line, color) {
  return escapeHtml(line)
    .replace(/\*\*([^*]+)\*\*/g, `<em style="color:${color}">$1</em>`);
}

/**
 * 예능 자막 처리(treatment).
 *
 * 폰트만 바꿔서는 예능 느낌이 안 난다 — 그 톤은 글자꼴보다 **처리**에서 온다.
 * 굵은 외곽선, 아래로 밀린 하드 그림자, 강조어 뒤의 컬러 칩, 살짝 기운 각도가 요소다.
 *
 *   stroke   외곽선 두께(px). paint-order 로 획 안쪽을 먹지 않게 한다.
 *   shadow   'soft' | 'hard' | 'none'. hard 는 오프셋만 준 그림자 — 예능 자막의 그 입체감.
 *   chip     강조어 뒤에 라운드 배경. 색은 tone 을 따른다.
 *   tilt     줄 기울기(deg). 홀짝으로 부호를 바꿔 리듬을 만든다.
 *   gradient 본문에 금색 그라데이션.
 */
export function treatmentCss(t = {}, color) {
  const {
    stroke = 0, strokeColor = '#0A0A0A', shadow = 'soft', chip = false,
    tilt = 0, gradient = false, invert = false,
  } = t;
  const css = [];
  if (stroke > 0) {
    css.push(`-webkit-text-stroke: ${stroke}px ${strokeColor};`);
    css.push('paint-order: stroke fill;');
  }
  if (shadow === 'hard') css.push(`text-shadow: 0 ${Math.max(6, stroke)}px 0 rgba(0,0,0,0.85);`);
  else if (shadow === 'soft') css.push('text-shadow: 0 6px 22px rgba(0,0,0,0.75);');
  else css.push('text-shadow: none;');
  if (invert) css.push('color: #0A0A0A;');
  if (gradient) {
    css.push('background: linear-gradient(180deg, #FFF2C4 0%, #FFC53D 55%, #E8912B 100%);');
    css.push('-webkit-background-clip: text; background-clip: text;');
    // 그라데이션을 글자에 채우려면 글자색을 비워야 하는데, 그러면 외곽선까지 사라진다.
    // 외곽선은 아래 .tline::after 로 따로 그리지 않고 stroke 를 포기한다 — 둘은 함께 못 쓴다.
    css.push('-webkit-text-fill-color: transparent;');
  }
  // 칩은 글자를 덮지 않게 세로 여백을 주고 inline-block 으로 띄운다.
  const emCss = chip
    ? `.tline em { display: inline-block; background: ${color}; color: #0A0A0A; `
      + '-webkit-text-fill-color: #0A0A0A; padding: .04em .2em .1em; border-radius: .12em; '
      + '-webkit-text-stroke: 0; text-shadow: none; }'
    : '';
  const tiltCss = tilt
    ? `.tline:nth-child(odd) { transform: rotate(${-tilt}deg); } `
      + `.tline:nth-child(even) { transform: rotate(${tilt}deg); }`
    : '';
  return { line: css.join(' '), extra: `${emCss}\n      ${tiltCss}` };
}

/**
 * 카드 컴포지션. 여러 문안을 1초씩 이어 붙여 한 번의 렌더로 N 종을 뽑을 수 있다
 * (스냅샷 시각 = index + 0.5). 브라우저를 N 번 띄우지 않으려는 것이다.
 *
 * @param {object} o
 * @param {Array<{title:string, sub?:string}>} o.variants
 * @param {string} o.imageRel  배경 그림
 * @param {string} o.fontRel
 * @param {string} o.gsapRel
 * @param {string} [o.badge]   채널 배지 문구
 * @param {string} [o.tone]    'alert' | 'accent'
 */
export function buildCardComposition({
  variants, imageRel, fontRel, gsapRel, badge = '바로경제', tone = 'alert',
  /**
   * 시스템 폰트 이름. 주면 @font-face 대신 이 패밀리를 쓴다 — HyperFrames 가 렌더 시
   * 알아서 임베드한다(실측: Apple SD Gothic Neo 52MB). 폰트를 여러 개 비교할 때
   * 파일을 일일이 복사하지 않아도 된다.
   */
  fontFamily = null,
  /** 예능 자막 처리. treatmentCss 참조. */
  treatment = {},
  /** 아웃트로용. ['구독','좋아요','알림'] 같은 CTA 버튼 줄. */
  cta = null,
  /** CTA 위에 놓는 한 줄. */
  ctaLead = '',
  /** 카드 맨 아래 면책 문구. */
  disclaimer = '',
}) {
  if (!Array.isArray(variants) || !variants.length) throw new Error('variants 가 있어야 한다');
  if (!imageRel || !gsapRel) throw new Error('imageRel·gsapRel 이 있어야 한다');
  if (!fontRel && !fontFamily) throw new Error('fontRel 또는 fontFamily 가 있어야 한다');
  const color = CARD_STYLE[tone] || CARD_STYLE.alert;
  const total = variants.length;
  const FAM = fontFamily ? `"${fontFamily}", sans-serif` : '"BarroKR", sans-serif';
  const TR = treatmentCss(treatment, color);

  // 아웃트로의 CTA 줄. 첫 항목만 채워 강조하고 나머지는 테두리만 — 유튜브 UI 관례를 따른다.
  const ctaBlock = cta && cta.length
    ? `      <div id="cta" class="clip" data-start="0" data-duration="${total}" data-track-index="${total + 1}">\n`
      + (ctaLead ? `        <div class="cta-lead">${escapeHtml(ctaLead)}</div>\n` : '')
      + `        <div class="cta-row">${cta.map((c, i) => `<span class="cta-btn${i === 0 ? ' primary' : ''}">${escapeHtml(c)}</span>`).join('')}</div>\n`
      + (disclaimer ? `        <div class="cta-note">${escapeHtml(disclaimer)}</div>\n` : '')
      + `      </div>\n`
    : '';

  const nodes = variants.map((v, i) => {
    const { lines, fontSize } = layoutTitle(v.title);
    const body = lines.map(l => `<div class="tline">${markupTitle(l, color)}</div>`).join('');
    const sub = v.sub ? `<div class="sub">${escapeHtml(v.sub)}</div>` : '';
    return `      <div id="c${i}" class="card clip" data-start="${i}" data-duration="1" `
      + `data-track-index="${i + 2}" style="font-size:${fontSize}px">\n`
      + `        <div class="title">${body}</div>\n${sub ? `        ${sub}\n` : ''}`
      + `      </div>`;
  });

  return `<!doctype html>
<html lang="ko" data-resolution="portrait">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${CANVAS.w}, height=${CANVAS.h}" />
    <script src="${gsapRel}"></script>
    <style>
${fontRel ? `      @font-face {
        font-family: "BarroKR";
        src: url("${fontRel}") format("opentype");
        font-weight: 900;
        font-display: block;
      }` : ''}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${CANVAS.w}px; height: ${CANVAS.h}px; overflow: hidden; background: #060A12; }
      #root { position: relative; width: ${CANVAS.w}px; height: ${CANVAS.h}px; }
      #plate {
        position: absolute; inset: 0;
        background-image: url("${imageRel}");
        background-size: cover; background-position: center;
      }
      /* 상단을 눌러 글자를 읽히게 한다. 그림 자체는 건드리지 않는다. */
      #scrim {
        position: absolute; left: 0; right: 0; top: 0; height: 58%;
        background: linear-gradient(180deg, ${CARD_STYLE.scrim} 0%, ${CARD_STYLE.scrim} 46%, rgba(6,10,18,0) 100%);
      }
      .card {
        position: absolute; left: 72px; right: 72px; top: 120px;
        font-family: ${FAM}; font-weight: 900; text-align: center;
      }
      /* display 는 block 이어야 한다. inline-block 으로 두면 줄들이 나란히 붙어
         "사상 최고치인데AMD는 왜" 처럼 줄바꿈이 사라진다(2026-08-14 실측, 폰트 폭이
         좁을수록 잘 터진다). transform 은 block 에도 적용되므로 기울임은 그대로 먹는다. */
      .tline {
        display: block;
        color: ${CARD_STYLE.base}; line-height: 1.24; word-break: keep-all;
        ${TR.line}
      }
      .tline em { font-style: normal; }
      ${TR.extra}
      .sub {
        margin-top: 22px; font-size: 0.42em; color: ${CARD_STYLE.sub};
        letter-spacing: -0.5px; text-shadow: 0 4px 14px rgba(0,0,0,0.7);
      }
      #cta {
        position: absolute; left: 72px; right: 72px; bottom: 220px; text-align: center;
        font-family: ${FAM};
      }
      .cta-lead { font-size: 40px; color: ${CARD_STYLE.sub}; margin-bottom: 22px; }
      .cta-row { display: flex; gap: 20px; justify-content: center; }
      .cta-btn {
        padding: 18px 34px; border-radius: 999px; font-size: 42px;
        color: #FFFFFF; border: 4px solid rgba(255,255,255,0.55);
      }
      .cta-btn.primary { background: #FF3B30; border-color: #FF3B30; }
      .cta-note { margin-top: 26px; font-size: 28px; color: rgba(201,211,223,0.75); }
      #badge {
        position: absolute; left: 50%; transform: translateX(-50%); bottom: 118px;
        padding: 14px 34px; border-radius: 999px;
        background: ${CARD_STYLE.badgeBg}; color: ${CARD_STYLE.badgeFg};
        font-family: ${FAM}; font-weight: 900; font-size: 40px;
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}"
         data-width="${CANVAS.w}" data-height="${CANVAS.h}" data-fps="${CANVAS.fps}">
      <div id="plate" class="clip" data-start="0" data-duration="${total}" data-track-index="0"></div>
      <div id="scrim" class="clip" data-start="0" data-duration="${total}" data-track-index="1"></div>
${nodes.join('\n')}
${ctaBlock}      <div id="badge" class="clip" data-start="0" data-duration="${total}" data-track-index="${total + 2}">${escapeHtml(badge)}</div>
    </div>
    <script>
      // 이 등록이 없으면 렌더가 프레임을 한 장도 못 뜨고 무한 대기한다 (references/MOTION.md).
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
}
