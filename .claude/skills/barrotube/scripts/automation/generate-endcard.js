#!/usr/bin/env node
/**
 * generate-endcard.js — 아웃트로 엔드카드 카드 생성 (S6f)
 *
 * 채널 마스코트 base 이미지 위에 "구독 / 좋아요 / 알림" CTA + 채널명을 SVG 오버레이로 합성한다.
 * 한글 폰트는 thumbnail-composer.js 와 동일하게 NotoSansKR otf base64 @font-face 임베드.
 * API 비용 0 (sharp 로컬 합성). 결과: <baseDir>/48_endcard.png
 *
 * render-direct.js 가 48_endcard.png 존재 시 영상 끝에 정지 클립으로 붙인다(자산 게이트).
 *
 * Usage:
 *   node generate-endcard.js --episode workspace/episodes/EP-YYYY-NNNN [--platform long|shorts]
 *     [--channel-name "BarroTube"] [--tagline "3분이면 충분한 경제"] [--base <png>] [--out <png>] [--force]
 */
import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');        // barrotube/
const FONT_DIR = join(ROOT, 'assets', 'fonts');

const _fontCache = {};
function fontB64(weight) {
  if (_fontCache[weight]) return _fontCache[weight];
  const p = join(FONT_DIR, `NotoSansKR-${weight}.otf`);
  if (!existsSync(p)) throw new Error(`Font missing: ${p}`);
  _fontCache[weight] = readFileSync(p).toString('base64');
  return _fontCache[weight];
}

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Material 아이콘 path (24x24 viewBox)
const ICON = {
  thumbUp: 'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-1.91l-.01-.01L23 10z',
  bell: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
};

function iconG(path, cx, cy, sizePx, fill) {
  const s = sizePx / 24;
  const tx = cx - sizePx / 2;
  const ty = cy - sizePx / 2;
  return `<g transform="translate(${tx},${ty}) scale(${s})"><path d="${path}" fill="${fill}"/></g>`;
}

function buildOverlaySvg({ W, H, channelName, tagline, isLong }) {
  const blackB64 = fontB64('Black');
  const boldB64 = fontB64('Bold');
  const ff = 'BarroSansKR';
  const cx = W / 2;

  const titleSize = isLong ? 96 : 110;
  const taglineSize = isLong ? 46 : 56;
  const titleY = isLong ? 175 : 360;
  const taglineY = titleY + Math.round(titleSize * 0.78);

  const rowCy = isLong ? 880 : 1520;
  const labelY = rowCy + (isLong ? 132 : 150);
  const iconSize = isLong ? 96 : 120;
  const labelSize = isLong ? 44 : 52;

  const btnW = isLong ? 320 : 420;
  const btnH = isLong ? 132 : 160;
  const btnX = cx - btnW / 2;
  const btnY = rowCy - btnH / 2;
  const btnTextSize = isLong ? 66 : 80;
  const btnTextY = rowCy + btnTextSize / 3;

  const sideOffset = isLong ? 470 : 360;
  const leftCx = cx - sideOffset;
  const rightCx = cx + sideOffset;

  const panelTop = isLong ? 690 : 1300;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style>
      @font-face { font-family:'${ff}-Black'; src:url(data:font/otf;base64,${blackB64}) format('opentype'); }
      @font-face { font-family:'${ff}-Bold'; src:url(data:font/otf;base64,${boldB64}) format('opentype'); }
    </style>
    <linearGradient id="botgrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#070C18" stop-opacity="0"/>
      <stop offset="0.45" stop-color="#070C18" stop-opacity="0.78"/>
      <stop offset="1" stop-color="#070C18" stop-opacity="0.96"/>
    </linearGradient>
    <linearGradient id="topgrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#070C18" stop-opacity="0.88"/>
      <stop offset="1" stop-color="#070C18" stop-opacity="0"/>
    </linearGradient>
    <filter id="ds" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>

  <rect x="0" y="0" width="${W}" height="${Math.round(H * 0.30)}" fill="url(#topgrad)"/>
  <rect x="0" y="${panelTop}" width="${W}" height="${H - panelTop}" fill="url(#botgrad)"/>

  <text x="${cx}" y="${titleY}" text-anchor="middle" font-family="'${ff}-Black',sans-serif" font-size="${titleSize}" fill="#FFFFFF" stroke="#070C18" stroke-width="${Math.round(titleSize * 0.06)}" stroke-linejoin="round" paint-order="stroke fill" filter="url(#ds)">${esc(channelName)}</text>
  <text x="${cx}" y="${taglineY}" text-anchor="middle" font-family="'${ff}-Bold',sans-serif" font-size="${taglineSize}" fill="#F4A261" filter="url(#ds)">${esc(tagline)}</text>

  ${iconG(ICON.thumbUp, leftCx, rowCy, iconSize, '#FFFFFF')}
  <text x="${leftCx}" y="${labelY}" text-anchor="middle" font-family="'${ff}-Bold',sans-serif" font-size="${labelSize}" fill="#FFFFFF" filter="url(#ds)">좋아요</text>

  <rect x="${btnX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="${Math.round(btnH / 2)}" ry="${Math.round(btnH / 2)}" fill="#FF0000" filter="url(#ds)"/>
  <text x="${cx}" y="${btnTextY}" text-anchor="middle" font-family="'${ff}-Black',sans-serif" font-size="${btnTextSize}" fill="#FFFFFF">구독</text>

  ${iconG(ICON.bell, rightCx, rowCy, iconSize, '#FFFFFF')}
  <text x="${rightCx}" y="${labelY}" text-anchor="middle" font-family="'${ff}-Bold',sans-serif" font-size="${labelSize}" fill="#FFFFFF" filter="url(#ds)">알림</text>
</svg>`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string', short: 'e' },
      platform: { type: 'string', default: 'long' },
      'channel-name': { type: 'string', default: 'BarroTube' },
      tagline: { type: 'string', default: '3분이면 충분한 경제' },
      base: { type: 'string' },
      out: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });

  if (!values.episode) {
    console.error('Usage: generate-endcard.js --episode <epdir> [--platform long|shorts] [--channel-name ..] [--tagline ..] [--base <png>] [--force]');
    process.exit(1);
  }

  const epAbs = isAbsolute(values.episode) ? values.episode : resolve(process.cwd(), values.episode);
  const platform = values.platform === 'shorts' ? 'shorts' : 'long';
  const isLong = platform === 'long';
  const baseDir = join(epAbs, 'platforms', platform);
  if (!existsSync(baseDir)) { console.error(`❌ Missing platform dir: ${baseDir}`); process.exit(1); }

  const outPath = values.out
    ? (isAbsolute(values.out) ? values.out : resolve(process.cwd(), values.out))
    : join(baseDir, '48_endcard.png');

  if (existsSync(outPath) && !values.force) {
    console.log(`⏭  Endcard exists (skip, --force로 재생성): ${outPath}`);
    return;
  }

  const [W, H] = isLong ? [1920, 1080] : [1080, 1920];

  const baseCandidates = [
    values.base && (isAbsolute(values.base) ? values.base : resolve(process.cwd(), values.base)),
    join(baseDir, '45_intro.base.png'),
    join(baseDir, '45_intro.png'),
  ].filter(Boolean);
  const basePng = baseCandidates.find(p => existsSync(p));

  let baseForComposite;
  if (basePng) {
    console.log(`   Base mascot: ${basePng}`);
    const baseBuf = await sharp(basePng).resize(W, H, { fit: 'cover', position: 'center' }).toBuffer();
    const darken = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#070C18" opacity="0.32"/></svg>`);
    baseForComposite = await sharp(baseBuf).composite([{ input: darken }]).png().toBuffer();
  } else {
    console.log('   Base mascot 없음 → 솔리드 네이비 배경');
    baseForComposite = await sharp({ create: { width: W, height: H, channels: 3, background: '#0F1830' } }).png().toBuffer();
  }

  const overlay = Buffer.from(buildOverlaySvg({ W, H, channelName: values['channel-name'], tagline: values.tagline, isLong }));
  await sharp(baseForComposite).composite([{ input: overlay }]).png().toFile(outPath);

  console.log(`✅ Endcard saved: ${outPath} (${W}x${H}, platform=${platform})`);
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1); });
