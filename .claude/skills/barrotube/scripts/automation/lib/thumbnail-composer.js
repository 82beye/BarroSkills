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

/**
 * YouTube Shorts 플레이어가 자기 UI 로 덮는 구역. 여기에 글자를 두면 읽히지 않는다.
 *
 * 2026-08-27 EP-2026-0118 실측(운영자 스크린샷): 인트로 타이틀이 상단 5.8% 에서 시작해
 * 상태바(시각·통신사·배터리)와 뒤로가기·검색·⋮ 아이콘이 첫 줄 위에 그대로 얹혔다.
 * EP-0117 도 8.6% 로 같은 문제였다. 반면 generate-cards.js(HyperFrames) 로 만든
 * EP-0114·0116 은 22~24% 에서 시작해 안전했다 — 즉 경로마다 값이 달라 생긴 회귀다.
 *
 * 하단·우측은 채널명·설명·좋아요/댓글/공유 버튼이 차지한다. 지금은 상단만 강제하지만
 * 값은 세 경로가 같이 본다.
 */
export const SHORTS_SAFE = {
  /** 상단 크롬(상태바 + 네비 아이콘). 이 아래에서 글자를 시작한다. */
  topPct: 0.14,
  /** 하단 오버레이(채널·제목·설명·공유 바). */
  bottomPct: 0.20,
  /** 우측 액션 버튼 열. */
  rightPct: 0.15,
};

/** 안전선 아래로 밀어 준다. 이미 아래면 그대로 둔다. */
export function safeTop(y, canvasH = CANVAS_H) {
  return Math.max(y, Math.round(canvasH * SHORTS_SAFE.topPct));
}

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

/**
 * 브랜드 로고 레이어. 캔버스 크기를 받는 이유는 인트로가 항상 1080x1920 이 아니기 때문이다 —
 * media-render 로 만든 아트워크나 long(16:9) 인트로 위에도 같은 코드로 얹는다.
 * 인자를 안 주면 기존 썸네일 동작 그대로다.
 */
export async function loadBrandLogoLayers(spec, { canvasW = CANVAS_W, canvasH = CANVAS_H } = {}) {
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
      'top-right': { top: 80, left: canvasW - W - 80 },
      'bottom-left': { top: canvasH - W - 200, left: 80 },
      'bottom-right': { top: canvasH - W - 200, left: canvasW - W - 80 }
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

/**
 * 헤드라인을 캔버스 폭 안에 맞춘다.
 *
 * 한글은 글자당 대략 1em 이므로 한 줄에 들어가는 글자 수 ≈ 사용폭 / fontSize.
 * 큰 크기부터 시도하고, 가장 작은 크기로도 안 되면 공백 기준으로 두 줄로 나눈다.
 */
export function fitHeadline(text, sizes = [130, 112, 96]) {
  const usable = CANVAS_W - 120;   // 좌우 60px 여백
  for (const fontSize of sizes) {
    if (text.length * fontSize <= usable) return { lines: [text], fontSize };
  }
  const fontSize = sizes[sizes.length - 1];
  const parts = text.split(' ').filter(Boolean);
  if (parts.length < 2) return { lines: [text], fontSize: Math.floor(usable / Math.max(1, text.length)) };
  // 두 줄의 길이가 비슷해지는 지점에서 자른다.
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < parts.length; i++) {
    const a = parts.slice(0, i).join(' ').length;
    const b = parts.slice(i).join(' ').length;
    if (Math.abs(a - b) < bestDiff) { bestDiff = Math.abs(a - b); best = i; }
  }
  const lines = [parts.slice(0, best).join(' '), parts.slice(best).join(' ')];
  const longest = Math.max(...lines.map(l => l.length));
  return { lines, fontSize: Math.min(fontSize, Math.floor(usable / Math.max(1, longest))) };
}

/**
 * 이미 완성된 이미지 위에 브랜드 CI 만 얹는다. 헤드라인·배지는 건드리지 않는다.
 *
 * media-render 경로(브라우저 ChatGPT)는 한글 타이틀까지 그려서 내려온다. 거기에 필요한 건
 * 로고 한 장뿐인데, composeThumbnail 을 쓰면 헤드라인이 두 번 얹힌다. 그래서 진입점을 나눈다.
 */
export async function overlayBrandLogos({ baseImagePath, logoSpecs, outPath }) {
  if (!existsSync(baseImagePath)) throw new Error(`base image not found: ${baseImagePath}`);
  // sharp 는 같은 파일을 읽으면서 쓰면 원본이 잘린다. 덮어쓰기는 호출자가 임시 파일로 처리한다.
  if (resolve(baseImagePath) === resolve(outPath)) {
    throw new Error(`overlayBrandLogos: baseImagePath 와 outPath 가 같다 (${outPath})`);
  }
  if (!Array.isArray(logoSpecs) || logoSpecs.length === 0) {
    return { outPath, layers: 0, skipped: true };
  }
  const meta = await sharp(baseImagePath).metadata();
  const canvasW = meta.width || CANVAS_W;
  const canvasH = meta.height || CANVAS_H;
  const layers = await loadBrandLogoLayers({ brand_logos: logoSpecs }, { canvasW, canvasH });
  if (!layers.length) return { outPath, layers: 0, skipped: true };
  await sharp(baseImagePath).composite(layers).png().toFile(outPath);
  return { outPath, layers: layers.length, skipped: false };
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
      // 2026-08-14: 여기엔 길이 분기가 없어 130px 고정이었다. 한글은 글자당 대략 1em 이라
      // 11자면 ~1430px — 1080px 캔버스 밖으로 잘려 나간다. EP-2026-0093 썸네일
      // "코스피를 올린 진짜 힘" 이 좌우로 잘린 채 나왔다. intro 쪽에만 있던 길이 대응을
      // 여기에도 둔다.
      ({ lines, fontSize } = fitHeadline(spec.headline_text));
    }
    const lineHeight = Math.floor(fontSize * 1.25);
    // 인트로는 **영상의 첫 화면**이라 Shorts UI 와 정면으로 겹친다. 80(4.2%) 은 상태바와
    // 뒤로가기·검색·⋮ 아이콘 아래로 들어가는 값이었다 (2026-08-27 EP-0118 실측).
    // 썸네일(240 = 12.5%)도 안전선(14%)보다 살짝 위라 같이 민다.
    const blockTop = safeTop(isIntro ? 80 : 240);
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
