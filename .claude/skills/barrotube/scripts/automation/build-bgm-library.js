#!/usr/bin/env node
/**
 * Build BGM library from Internet Archive (CC0/CC-BY tracks).
 * Searches mediatype:audio with CC licenses for 4 categories and downloads top match.
 *
 * Usage:
 *   node scripts/automation/build-bgm-library.js
 *   node scripts/automation/build-bgm-library.js --category analysis --force
 *   node scripts/automation/build-bgm-library.js --dry-run
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const BGM_DIR = join(ROOT, 'assets', 'bgm');
const MANIFEST_PATH = join(BGM_DIR, 'manifest.json');

const UA = 'BarroTube/1.0 (bgm-library-builder)';

// 카테고리별 검색어 — archive.org에서 CC 라이선스 + 영상 BGM 적합한 키워드
const CATEGORIES = {
  analysis:  { query: 'ambient calm instrumental',     desc: '분석·해설 BGM (차분, barro-teacher 기본)' },
  alert:     { query: 'dramatic instrumental',          desc: '속보·경고 BGM (긴장감, barro-alert 기본)' },
  recap:     { query: 'uplifting instrumental',         desc: '회고·정리 BGM (시리즈 마지막 EP)' },
  intro:     { query: 'electronic intro',                desc: '인트로 카드 BGM (2~5s 효과음)' },
  bullish:   { query: 'happy upbeat instrumental',      desc: '상승·호재 BGM (긍정 영상)' },
  bearish:   { query: 'sad somber instrumental',        desc: '하락·위기 BGM (부정 영상)' },
  mystery:   { query: 'suspense piano instrumental',    desc: '분석·음모·숨은 이야기 BGM' },
  broadcast: { query: 'broadcast intro theme instrumental short', desc: '뉴스 권위 톤 BGM (시사 정통)' }
};

async function searchArchive(query) {
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`mediatype:audio AND licenseurl:*creativecommons* AND ${query}`)}&fl[]=identifier&fl[]=title&fl[]=licenseurl&fl[]=runtime&fl[]=item_size&sort[]=downloads%20desc&output=json&rows=10`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const data = await res.json();
  return data?.response?.docs || [];
}

async function pickMp3FromItem(identifier) {
  const url = `https://archive.org/metadata/${encodeURIComponent(identifier)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`metadata HTTP ${res.status}`);
  const meta = await res.json();
  const files = meta?.files || [];
  // VBR MP3 or MP3 우선, 길이 30s~3min
  const mp3 = files.find(f => /\.mp3$/i.test(f.name) && (!f.length || (parseFloat(f.length) >= 20 && parseFloat(f.length) <= 240)));
  if (!mp3) return null;
  return {
    download_url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(mp3.name)}`,
    filename: mp3.name,
    length: mp3.length,
    license: meta?.metadata?.licenseurl || 'unknown',
    title: meta?.metadata?.title || identifier,
    creator: meta?.metadata?.creator || 'unknown'
  };
}

async function fetchOneCategory(catKey, opts) {
  const def = CATEGORIES[catKey];
  const outPath = join(BGM_DIR, `${catKey}.mp3`);
  if (existsSync(outPath) && !opts.force) {
    return { category: catKey, status: 'skipped_exists', file: `bgm/${catKey}.mp3` };
  }

  try {
    const docs = await searchArchive(def.query);
    if (docs.length === 0) return { category: catKey, status: 'no_search_results', query: def.query };
    // 상위 5개에서 mp3 가능한 첫 항목 채택
    for (const doc of docs.slice(0, 5)) {
      const pick = await pickMp3FromItem(doc.identifier);
      if (!pick) continue;
      const res = await fetch(pick.download_url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50_000) continue; // 너무 작으면 placeholder/silence
      writeFileSync(outPath, buf);
      return {
        category: catKey,
        status: 'downloaded',
        file: `bgm/${catKey}.mp3`,
        size_bytes: buf.length,
        archive_identifier: doc.identifier,
        title: pick.title,
        creator: pick.creator,
        license: pick.license,
        source_url: pick.download_url,
        length_seconds: pick.length ? Number(pick.length) : null,
        downloaded_at: new Date().toISOString(),
        license_note: `BGM: archive.org "${pick.title}" by ${pick.creator} (${pick.license})`
      };
    }
    return { category: catKey, status: 'no_mp3_in_top_results', query: def.query };
  } catch (e) {
    return { category: catKey, status: 'error', error: e.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opts = {
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run')
  };
  const catFilter = args.includes('--category') ? args[args.indexOf('--category') + 1] : null;

  if (!existsSync(BGM_DIR)) mkdirSync(BGM_DIR, { recursive: true });
  const manifest = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) : { version: 1, tracks: {} };

  console.log(`\n🎵 BGM Library Builder — archive.org CC tracks\n`);

  const targets = catFilter ? [catFilter] : Object.keys(CATEGORIES);
  for (const cat of targets) {
    if (!CATEGORIES[cat]) { console.warn(`unknown category: ${cat}`); continue; }
    process.stdout.write(`  [${cat.padEnd(8)}] ${CATEGORIES[cat].desc}... `);
    if (opts.dryRun) { console.log('(dry-run)'); continue; }
    const result = await fetchOneCategory(cat, opts);
    manifest.tracks[cat] = result;
    console.log(`${result.status}${result.size_bytes ? ` (${(result.size_bytes/1024).toFixed(1)}KB)` : ''}${result.creator ? ` "${result.title.slice(0,40)}" — ${result.creator.slice(0,30)}` : ''}`);
    await new Promise(r => setTimeout(r, 300));
  }

  if (!opts.dryRun) {
    manifest.updated_at = new Date().toISOString();
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\n✅ Manifest: ${MANIFEST_PATH}`);
  }

  // Summary
  const counts = Object.values(manifest.tracks).reduce((acc, t) => { acc[t.status || 'pending'] = (acc[t.status || 'pending'] || 0) + 1; return acc; }, {});
  console.log(`\n📊 Summary:`, counts);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
