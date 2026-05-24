/**
 * BarroTube Thumbnail Composer (v1 — 2026-05-16)
 *
 * Gemini가 생성한 base 이미지 위에 한글 텍스트·인용 사진·기업 로고를 후처리 합성.
 * 한글 폰트는 sharp의 librsvg + SVG @font-face base64 임베드로 렌더링.
 *
 * Input:  thumbnail-spec.schema.json v2 (headline_text, keyword_number, accent_color,
 *         background_style, featured_person, brand_logos, mascot_emotion)
 * Output: 1080×1920 PNG (Shorts 세로)
 *
 * 사용:
 *   import { composeThumbnail } from './lib/thumbnail-composer.js';
 *   await composeThumbnail({
 *     baseImagePath: 'path/to/gemini-base.png',
 *     spec: { headline_text: '코스피 7000 돌파', keyword_number: '7000', ... },
 *     outPath: 'path/to/47_thumbnail.png'
 *   });
 */

import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const FONT_DIR = join(ROOT, 'assets', 'fonts');
const ASSETS_DIR = join(ROOT, 'workspace', 'assets');

export const CANVAS_W = 1080;
export const CANVAS_H = 1920;

export const ACCENT_COLORS = {
  yellow: '#FFD60A',
  red: '#FF3B30',
  green: '#34C759',
  white: '#FFFFFF'
};

const BACKGROUND_STYLES = {
  dark: { type: 'overlay-rect', fill: '#0A0A0A', opacity: 0.55, vignette: true },
  news: { type: 'overlay-rect', fill: '#15192B', opacity: 0.65, vignette: false },
  flat: { type: 'noop' }
};

const _fontCache = {};
function loadFontBase64(weight) {
  if (_fontCache[weight]) return _fontCache[weight];
  const path = join(FONT_DIR, `NotoSansKR-${weight}.otf`);
  if (!existsSync(path)) {
    throw new Error(`Font missing: ${path}. Run scripts/automation/build-fonts.js or place NotoSansKR-${weight}.otf manually.`);
  }
  _fontCache[weight] = readFileSync(path).toString('base64');
  return _fontCache[weight];
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function buildTextSvg({
  text,
  weight = 'Bold',
  fontSize = 120,
  fill = '#FFFFFF',
  stroke = '#000000',
  strokeWidth = 8,
  shadowOffset = 8,
  width = CANVAS_W,
  height = 280
}) {
  const b64 = loadFontBase64(weight);
  const fontFamily = `BarroSansKR-${weight}`;
  const cx = width / 2;
  const cy = height / 2 + fontSize / 3.2;
  const escaped = escapeXml(text);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style>
      @font-face {
        font-family: '${fontFamily}';
        src: url(data:font/otf;base64,${b64}) format('opentype');
      }
    </style>
    <filter id="ds" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
      <feOffset dx="${shadowOffset}" dy="${shadowOffset}" result="off"/>
      <feComponentTransfer in="off" result="off2"><feFuncA type="linear" slope="0.6"/></feComponentTransfer>
      <feMerge><feMergeNode in="off2"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <text x="${cx}" y="${cy}" text-anchor="middle" font-family="${fontFamily},sans-serif" font-size="${fontSize}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" paint-order="stroke fill" fill="${fill}" filter="url(#ds)">${escaped}</text>
</svg>`;
}

function loadManifest() {
  const p = join(ASSETS_DIR, 'manifest.json');
  if (!existsSync(p)) throw new Error(`Asset manifest missing: ${p}`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

async function loadFeaturedPersonLayer(spec) {
  if (!spec.featured_person || spec.featured_person.treatment !== 'photo-citation') return null;
  const manifest = loadManifest();
  const fig = manifest.public_figures.find(f => f.id === spec.featured_person.id);
  if (!fig || !fig.image_path) return null;
  const figPath = join(ASSETS_DIR, fig.image_path);
  if (!existsSync(figPath)) return null;

  const size = spec.featured_person.size || 'medium';
  const W = { small: 280, medium: 440, large: 600 }[size];
  const position = spec.featured_person.position || 'right';
  const left = position === 'left' ? 80 : position === 'center' ? Math.floor((CANVAS_W - W) / 2) : CANVAS_W - W - 80;
  const top = Math.floor((CANVAS_H - W) / 2) + 80;

  // 둥근 모서리 + 백색 테두리
  const personBuf = await sharp(figPath).resize(W, W, { fit: 'cover', position: 'top' }).png().toBuffer();
  const radius = Math.floor(W * 0.12);
  const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"><rect width="${W}" height="${W}" rx="${radius}" ry="${radius}" fill="white"/></svg>`;
  const rounded = await sharp(personBuf).composite([{ input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();

  // 외곽 흰 테두리
  const borderW = W + 16;
  const borderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${borderW}" height="${borderW}"><rect width="${borderW}" height="${borderW}" rx="${radius + 8}" ry="${radius + 8}" fill="white"/></svg>`;
  const border = await sharp(Buffer.from(borderSvg)).png().toBuffer();
  const composed = await sharp(border).composite([{ input: rounded, top: 8, left: 8 }]).png().toBuffer();

  return { input: composed, top: top - 8, left: left - 8 };
}

async function loadBrandLogoLayers(spec) {
  if (!Array.isArray(spec.brand_logos) || spec.brand_logos.length === 0) return [];
  const manifest = loadManifest();
  const layers = [];
  for (const logoSpec of spec.brand_logos.slice(0, 3)) {
    const lg = manifest.brand_logos.find(l => l.id === logoSpec.id);
    if (!lg || !lg.logo_path) continue;
    const logoPath = join(ASSETS_DIR, lg.logo_path);
    if (!existsSync(logoPath)) continue;
    const W = logoSpec.size === 'medium' ? 200 : 130;
    let svg = readFileSync(logoPath, 'utf-8');
    // SimpleIcons SVG는 검은 단색. 어두운 배경용 화이트 틴트.
    svg = svg.replace(/fill="[^"]*"/g, 'fill="#FFFFFF"');
    if (!/width=/.test(svg)) svg = svg.replace(/<svg /, `<svg width="${W}" height="${W}" `);
    else svg = svg.replace(/width="\d+"/, `width="${W}"`).replace(/height="\d+"/, `height="${W}"`);
    const POS_MAP = {
      'top-left': { top: 80, left: 80 },
      'top-right': { top: 80, left: CANVAS_W - W - 80 },
      'bottom-left': { top: CANVAS_H - W - 200, left: 80 },
      'bottom-right': { top: CANVAS_H - W - 200, left: CANVAS_W - W - 80 }
    };
    let pos = POS_MAP[logoSpec.position] || POS_MAP['top-right'];
    // 다중 로고 stack — top-right 자동 우측 오프셋
    if (logoSpec.position === 'top-right' || !logoSpec.position) {
      pos = { ...pos, top: pos.top + layers.length * (W + 30) };
    }
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    layers.push({ input: buf, top: pos.top, left: pos.left });
  }
  return layers;
}

export async function composeThumbnail({ baseImagePath, spec, outPath }) {
  if (!existsSync(baseImagePath)) throw new Error(`base image not found: ${baseImagePath}`);
  if (!spec || typeof spec !== 'object') throw new Error('spec required');

  const base = sharp(baseImagePath).resize(CANVAS_W, CANVAS_H, { fit: 'cover', position: 'center' });
  const composites = [];

  // 1) Background style overlay
  const bgStyle = BACKGROUND_STYLES[spec.background_style] || BACKGROUND_STYLES.flat;
  if (bgStyle.type === 'overlay-rect') {
    const vig = bgStyle.vignette
      ? `<defs><radialGradient id="vig" cx="50%" cy="50%" r="70%"><stop offset="0%" stop-color="black" stop-opacity="0"/><stop offset="100%" stop-color="black" stop-opacity="0.65"/></radialGradient></defs><rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#vig)"/>`
      : '';
    const rectSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}"><rect width="${CANVAS_W}" height="${CANVAS_H}" fill="${bgStyle.fill}" opacity="${bgStyle.opacity}"/>${vig}</svg>`;
    composites.push({ input: Buffer.from(rectSvg), top: 0, left: 0 });
  }

  // 2) Featured person (photo-citation)
  const personLayer = await loadFeaturedPersonLayer(spec);
  if (personLayer) composites.push(personLayer);

  // 3) Brand logos
  const logoLayers = await loadBrandLogoLayers(spec);
  for (const l of logoLayers) composites.push(l);

  // 3.5) Series badge (intro mode 또는 명시) — intro면 하단, 그 외 우상단
  if (spec.series_badge_text) {
    const b64 = loadFontBase64('Bold');
    const badgeText = String(spec.series_badge_text);
    const badgeWidth = Math.min(560, 24 + badgeText.length * 28);
    const badgeHeight = 70;
    const badgeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${badgeWidth}" height="${badgeHeight}"><defs><style>@font-face{font-family:'BBadge';src:url(data:font/otf;base64,${b64}) format('opentype');}</style></defs><rect x="0" y="0" width="${badgeWidth}" height="${badgeHeight}" rx="14" ry="14" fill="#FFD60A" opacity="0.95"/><text x="${badgeWidth/2}" y="48" text-anchor="middle" fill="#0A0A0A" font-family="BBadge,sans-serif" font-size="32" font-weight="bold">${escapeXml(badgeText)}</text></svg>`;
    const isIntroBadge = !!spec.is_intro;
    const badgeTop = isIntroBadge ? CANVAS_H - badgeHeight - 110 : 80;  // intro: bottom, thumbnail: top
    const badgeLeft = isIntroBadge ? Math.floor((CANVAS_W - badgeWidth) / 2) : CANVAS_W - badgeWidth - 80; // intro: center
    composites.push({ input: Buffer.from(badgeSvg), top: badgeTop, left: badgeLeft });
  }

  // 4) Headline text — intro 모드면 더 크게(1줄 강조), thumbnail이면 표준
  const isIntro = !!spec.is_intro;
  if (spec.headline_text) {
    // intro mode: 텍스트 길이별 auto wrap + TOP 영역 배치 (Gemini base의 negative space)
    let lines;
    let fontSize;
    if (isIntro) {
      const len = spec.headline_text.length;
      if (len <= 8) {
        lines = [spec.headline_text];
        fontSize = 130;
      } else if (len <= 14) {
        lines = [spec.headline_text];
        fontSize = 100;
      } else {
        // 공백 기준 split, 균등 분할
        const parts = spec.headline_text.split(' ').filter(Boolean);
        const mid = Math.ceil(parts.length / 2);
        lines = [parts.slice(0, mid).join(' '), parts.slice(mid).join(' ')];
        fontSize = 90;
      }
    } else {
      lines = [spec.headline_text];
      fontSize = 130;
    }
    const lineHeight = Math.floor(fontSize * 1.25);
    const blockTop = isIntro ? 80 : 240;  // intro: 화면 상단 5% (base의 negative space)
    for (let i = 0; i < lines.length; i++) {
      const sv = buildTextSvg({
        text: lines[i],
        weight: isIntro ? 'Black' : 'Bold',
        fontSize,
        fill: '#FFFFFF',
        stroke: '#000000',
        strokeWidth: isIntro ? 12 : 10,
        shadowOffset: isIntro ? 10 : 8,
        width: CANVAS_W,
        height: lineHeight + 30
      });
      composites.push({ input: Buffer.from(sv), top: blockTop + i * lineHeight, left: 0 });
    }
  }

  // 5) Keyword number — intro 모드에선 생략 (1.5초 노출이라 단일 메시지)
  if (!isIntro && spec.keyword_number) {
    const accent = ACCENT_COLORS[spec.accent_color] || ACCENT_COLORS.yellow;
    const sv = buildTextSvg({
      text: spec.keyword_number,
      weight: 'Black',
      fontSize: 260,
      fill: accent,
      stroke: '#000000',
      strokeWidth: 14,
      shadowOffset: 12,
      width: CANVAS_W,
      height: 360
    });
    composites.push({ input: Buffer.from(sv), top: 1100, left: 0 });
  }

  // 6) License footer (우하단 작은 인용)
  const licLines = [
    spec.featured_person ? '사진 인용 (Wikipedia · fair use)' : null,
    (spec.brand_logos?.length || 0) > 0 ? '로고: SimpleIcons (CC0)' : null
  ].filter(Boolean);
  if (licLines.length > 0) {
    const b64 = loadFontBase64('Bold');
    const footer = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="60"><defs><style>@font-face{font-family:'BFooter';src:url(data:font/otf;base64,${b64}) format('opentype');}</style></defs><text x="${CANVAS_W - 40}" y="40" text-anchor="end" fill="white" opacity="0.7" font-family="BFooter,sans-serif" font-size="22">${escapeXml(licLines.join(' · '))}</text></svg>`;
    composites.push({ input: Buffer.from(footer), top: CANVAS_H - 80, left: 0 });
  }

  await base.composite(composites).png({ quality: 92 }).toFile(outPath);
  return { path: outPath, layers: composites.length };
}
