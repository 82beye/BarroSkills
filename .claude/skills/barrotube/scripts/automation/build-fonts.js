#!/usr/bin/env node
/**
 * Build/sync Korean fonts to assets/fonts/.
 * Idempotent — skips files that already exist with reasonable size.
 *
 * Usage: node scripts/automation/build-fonts.js [--force]
 */
import { writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const FONT_DIR = join(ROOT, 'assets', 'fonts');

const FONTS = [
  { weight: 'Black', url: 'https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/SubsetOTF/KR/NotoSansKR-Black.otf' },
  { weight: 'Bold',  url: 'https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/SubsetOTF/KR/NotoSansKR-Bold.otf' }
];

const force = process.argv.includes('--force');
if (!existsSync(FONT_DIR)) mkdirSync(FONT_DIR, { recursive: true });

for (const f of FONTS) {
  const out = join(FONT_DIR, `NotoSansKR-${f.weight}.otf`);
  if (existsSync(out) && statSync(out).size > 100_000 && !force) {
    console.log(`✓ ${f.weight} 이미 존재 (${(statSync(out).size / 1024 / 1024).toFixed(1)}MB) — skip`);
    continue;
  }
  process.stdout.write(`다운로드 NotoSansKR-${f.weight}... `);
  const res = await fetch(f.url, { headers: { 'User-Agent': 'BarroTube/1.0 (build-fonts)' } });
  if (!res.ok) {
    console.error(`❌ HTTP ${res.status}: ${f.url}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(out, buf);
  console.log(`${(buf.length / 1024 / 1024).toFixed(1)}MB`);
}
console.log(`\n✅ 폰트 준비 완료: ${FONT_DIR}`);
