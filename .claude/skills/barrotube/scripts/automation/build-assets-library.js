#!/usr/bin/env node

/**
 * BarroTube Asset Library Builder
 * - Public figures: Wikipedia REST API + 라이선스 검증 (공개도메인·CC만)
 * - Brand logos: SimpleIcons CDN (CC0)
 *
 * Usage:
 *   node scripts/automation/build-assets-library.js              # 전체 빌드
 *   node scripts/automation/build-assets-library.js --public-figures
 *   node scripts/automation/build-assets-library.js --brand-logos
 *   node scripts/automation/build-assets-library.js --force      # 기존 파일 덮어쓰기
 *   node scripts/automation/build-assets-library.js --dry-run
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const MANIFEST_PATH = join(ROOT, 'workspace', 'assets', 'manifest.json');
const FIGURES_DIR = join(ROOT, 'workspace', 'assets', 'public-figures');
const LOGOS_DIR = join(ROOT, 'workspace', 'assets', 'brand-logos');

const UA = 'BarroTube/1.0 (asset-library-builder; beye@youtube-co)';

const ACCEPTABLE_LICENSES = [
  'public domain', 'cc0', 'cc by', 'cc-by', 'cc by-sa', 'cc-by-sa',
  'creative commons attribution', 'creative commons zero'
];

function isAcceptableLicense(licenseStr) {
  if (!licenseStr) return false;
  const lc = String(licenseStr).toLowerCase().replace(/<[^>]+>/g, '');
  return ACCEPTABLE_LICENSES.some(l => lc.includes(l));
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchWithRetry(url, init, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    if (res.status === 429 || res.status === 503) {
      if (attempt < retries) {
        const wait = 2000 * (attempt + 1);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
    }
    throw new Error(`HTTP ${res.status}: ${url}`);
  }
}

async function fetchJson(url) {
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  return res.json();
}

async function fetchWikipediaSummary(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  return fetchJson(url);
}

async function fetchImageInfo(filename) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent('File:' + filename)}&prop=imageinfo&iiprop=url|extmetadata&format=json&formatversion=2`;
  const data = await fetchJson(url);
  const page = data?.query?.pages?.[0];
  return page?.imageinfo?.[0] || null;
}

async function downloadBinary(url, outPath) {
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': UA } });
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outPath, buf);
  return buf.length;
}

async function downloadText(url, outPath) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const txt = await res.text();
  writeFileSync(outPath, txt);
  return Buffer.byteLength(txt);
}

function extractFilename(imgUrl) {
  const m = imgUrl.match(/\/([^/]+\.(?:jpe?g|png|gif|svg))(?:\?|$)/i);
  if (!m) return null;
  return decodeURIComponent(m[1]).replace(/^\d+px-/, '');
}

async function processFigure(fig, opts) {
  const outPath = join(FIGURES_DIR, `${fig.id}.jpg`);
  if (existsSync(outPath) && !opts.force) {
    return { ...fig, status: 'skipped_exists', image_path: `public-figures/${fig.id}.jpg` };
  }

  try {
    const summary = await fetchWikipediaSummary(fig.wikipedia_title);
    const imgUrl = summary?.originalimage?.source || summary?.thumbnail?.source;
    if (!imgUrl) {
      return { ...fig, status: 'no_image_in_wikipedia', image_path: null };
    }

    const filename = extractFilename(imgUrl);
    let licenseShort = '';
    let artist = '';
    let credit = '';
    if (filename) {
      try {
        const info = await fetchImageInfo(filename);
        licenseShort = info?.extmetadata?.LicenseShortName?.value || info?.extmetadata?.License?.value || '';
        artist = info?.extmetadata?.Artist?.value || '';
        credit = info?.extmetadata?.Credit?.value || '';
      } catch (e) {
        // license check 실패 — 거부 처리
      }
    }

    if (!isAcceptableLicense(licenseShort)) {
      return {
        ...fig,
        status: 'license_rejected',
        license: stripHtml(licenseShort) || 'unknown',
        image_path: null,
        note: 'Wikipedia 사진이 공개도메인·CC 라이선스가 아니거나 정보 부족. 수동 보강 필요.'
      };
    }

    const dlUrl = summary.thumbnail?.source || imgUrl;
    const bytes = await downloadBinary(dlUrl, outPath);

    const { error: _stale, note: _staleNote, ...rest } = fig;
    return {
      ...rest,
      status: 'downloaded',
      image_path: `public-figures/${fig.id}.jpg`,
      image_size: bytes,
      source: summary.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(fig.wikipedia_title)}`,
      source_url: dlUrl,
      license: stripHtml(licenseShort),
      license_note: `사진: Wikipedia (${stripHtml(licenseShort)})${artist ? ' — ' + stripHtml(artist) : ''}`,
      downloaded_at: new Date().toISOString()
    };
  } catch (e) {
    return { ...fig, status: 'error', error: e.message, image_path: null };
  }
}

async function processLogo(logo, opts) {
  const outPath = join(LOGOS_DIR, `${logo.id}.svg`);
  if (existsSync(outPath) && !opts.force) {
    return { ...logo, status: 'skipped_exists', logo_path: `brand-logos/${logo.id}.svg` };
  }

  try {
    const url = `https://cdn.simpleicons.org/${logo.simpleicons_slug}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      return {
        ...logo,
        status: res.status === 404 ? 'not_found_in_simpleicons' : 'error',
        error: `HTTP ${res.status}`,
        source: 'manual_needed',
        logo_path: null,
        note: 'SimpleIcons에 없음. 공식 Brand Center에서 수동 다운로드 필요.'
      };
    }
    const svg = await res.text();
    writeFileSync(outPath, svg);
    const { error: _stale, note: _staleNote, ...rest } = logo;
    return {
      ...rest,
      status: 'downloaded',
      logo_path: `brand-logos/${logo.id}.svg`,
      logo_size: Buffer.byteLength(svg),
      source: 'SimpleIcons CDN',
      source_url: url,
      license: 'CC0',
      license_note: '로고: SimpleIcons (CC0)',
      downloaded_at: new Date().toISOString()
    };
  } catch (e) {
    return { ...logo, status: 'error', error: e.message, logo_path: null };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opts = {
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
    figuresOnly: args.includes('--public-figures'),
    logosOnly: args.includes('--brand-logos'),
    retryFailed: args.includes('--retry-failed')
  };

  if (!existsSync(MANIFEST_PATH)) {
    console.error(`❌ manifest.json 없음: ${MANIFEST_PATH}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));

  const doFigures = !opts.logosOnly;
  const doLogos = !opts.figuresOnly;

  if (doFigures) {
    console.log(`\n📸 Public Figures (${manifest.public_figures.length}):`);
    for (let i = 0; i < manifest.public_figures.length; i++) {
      const fig = manifest.public_figures[i];
      const isFailed = ['error', 'license_rejected', 'no_image_in_wikipedia'].includes(fig.status);
      if (opts.retryFailed && !isFailed && fig.status === 'downloaded') {
        continue;
      }
      process.stdout.write(`  [${(i+1).toString().padStart(2)}/${manifest.public_figures.length}] ${fig.id.padEnd(16)} (${fig.name_ko})... `);
      if (opts.dryRun) { console.log('(dry-run)'); continue; }
      const result = await processFigure(fig, opts);
      manifest.public_figures[i] = result;
      console.log(`${result.status}${result.image_size ? ` (${(result.image_size/1024).toFixed(1)}KB)` : ''}${result.license ? ` [${result.license}]` : ''}`);
      // Wikipedia API rate limit 회피 (500ms + retry backoff in fetchWithRetry)
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (doLogos) {
    console.log(`\n🏢 Brand Logos (${manifest.brand_logos.length}):`);
    for (let i = 0; i < manifest.brand_logos.length; i++) {
      const lg = manifest.brand_logos[i];
      const isFailed = ['error', 'not_found_in_simpleicons'].includes(lg.status);
      if (opts.retryFailed && !isFailed && lg.status === 'downloaded') {
        continue;
      }
      process.stdout.write(`  [${(i+1).toString().padStart(2)}/${manifest.brand_logos.length}] ${lg.id.padEnd(12)} (${lg.name_ko})... `);
      if (opts.dryRun) { console.log('(dry-run)'); continue; }
      const result = await processLogo(lg, opts);
      manifest.brand_logos[i] = result;
      console.log(`${result.status}${result.logo_size ? ` (${(result.logo_size/1024).toFixed(1)}KB)` : ''}`);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (!opts.dryRun) {
    manifest.updated_at = new Date().toISOString();
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\n✅ Manifest 갱신: ${MANIFEST_PATH}`);
  }

  // Summary
  const counts = (arr) => arr.reduce((acc, x) => { const k = x.status || 'pending'; acc[k] = (acc[k]||0)+1; return acc; }, {});
  console.log(`\n📊 Summary:`);
  console.log(`  Public Figures:`, counts(manifest.public_figures));
  console.log(`  Brand Logos:`, counts(manifest.brand_logos));
}

main().catch(e => { console.error('❌', e); process.exit(1); });
