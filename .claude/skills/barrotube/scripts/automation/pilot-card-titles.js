#!/usr/bin/env node
/**
 * pilot-card-titles.js — 인트로 카드 타이틀 후보를 여러 장 뽑아 고르게 한다 (파일럿).
 *
 * 카드 글자를 이미지 모델이 그리면 오타가 나고(메타→머타) 뜻이 어긋난다(상승 회차에
 * 빨간 폭락 차트). 배경만 모델이 그리고 글자는 HyperFrames 가 얹으면 둘 다 사라진다.
 *
 * 후보를 한 컴포지션에 1초씩 이어 붙여 한 번의 렌더로 전부 뽑는다 — 브라우저를 N 번
 * 띄우지 않으려는 것이다.
 *
 * Usage:
 *   node scripts/automation/pilot-card-titles.js --episode <dir> [--platform shorts]
 *     [--titles titles.json] [--bg 40_assets/images/scene_001.png] [--out-dir <dir>]
 *     [--tone alert|accent]
 *
 * titles.json 형식: [{ "title": "사상 최고치인데|AMD는 왜 **8% 빠졌나**", "sub": "실적은 다 이겼는데" }, …]
 *   `|` 는 줄바꿈, `**…**` 는 강조색.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildCardComposition, loadCardConfig } from './lib/card-composition.js';
import { resolveGsap, resolveHyperframes, resolveScript } from './generate-motion.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, '..', '..');
const FONT = join(SKILL_DIR, 'assets', 'fonts', 'NotoSansKR-Black.otf');

function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string' },
      platform: { type: 'string' },
      titles: { type: 'string' },
      bg: { type: 'string' },
      'out-dir': { type: 'string' },
      tone: { type: 'string' },
      /** intro | outro — config/cards.json 의 해당 항목을 기본값으로 쓴다. */
      kind: { type: 'string' },
      /** 폰트 비교 모드. 같은 문안을 폰트만 바꿔 뽑는다. */
      fonts: { type: 'string' },
    },
  });
  if (!values.episode || !values.titles) {
    console.error('Usage: pilot-card-titles.js --episode <dir> --titles <titles.json> [--fonts <fonts.json>] [--bg <png>] [--out-dir <dir>] [--tone alert|accent]');
    process.exit(2);
  }

  const hfBin = resolveHyperframes();
  const gsapPath = resolveGsap();
  if (!hfBin || !gsapPath) throw new Error('hyperframes/gsap 없음 — generate-motion.js --doctor');
  if (!existsSync(FONT)) throw new Error(`폰트 없음: ${FONT}`);

  const epDir = resolve(values.episode);
  const baseDir = dirname(resolveScript(epDir, values.platform || null));
  const bgPath = resolve(values.bg
    ? (values.bg.startsWith('/') ? values.bg : join(baseDir, values.bg))
    : join(baseDir, '40_assets', 'images', 'scene_001.png'));
  if (!existsSync(bgPath)) throw new Error(`배경 그림 없음: ${bgPath}`);

  const variants = JSON.parse(readFileSync(resolve(values.titles), 'utf-8'));
  if (!Array.isArray(variants) || !variants.length) throw new Error('titles.json 이 비었다');

  const outDir = resolve(values['out-dir'] || join(baseDir, '55_render', 'title-candidates'));
  mkdirSync(outDir, { recursive: true });

  // 폰트 비교 모드는 폰트마다 별도 렌더다. 한 컴포지션에 CJK 폰트 10종을 넣으면
  // HyperFrames 가 전부 임베드해 수백 MB 가 된다(실측: Apple SD Gothic Neo 한 종 52MB).
  // --fonts 를 안 주면 config/cards.json 의 확정 타이포를 쓴다.
  const cardCfg = loadCardConfig(values.kind || 'intro');
  const fonts = values.fonts
    ? JSON.parse(readFileSync(resolve(values.fonts), 'utf-8'))
    : [{ label: cardCfg.fontFamily || 'NotoSansKR Black',
         family: cardCfg.fontFamily || null,
         bundled: !cardCfg.fontFamily,
         treatment: cardCfg.treatment || {} }];

  const shot = (label, fontFamily, bundled, prefix, treatment = {}) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'bt-card-'));
    try {
      mkdirSync(join(projectDir, 'assets'), { recursive: true });
      copyFileSync(gsapPath, join(projectDir, 'assets', 'gsap.min.js'));
      copyFileSync(bgPath, join(projectDir, 'assets', 'bg.png'));
      if (bundled) copyFileSync(FONT, join(projectDir, 'assets', 'kr.otf'));
      writeFileSync(join(projectDir, 'hyperframes.json'), JSON.stringify({ paths: { assets: 'assets' } }, null, 2));
      writeFileSync(join(projectDir, 'index.html'), buildCardComposition({
        variants, imageRel: 'assets/bg.png',
        fontRel: bundled ? 'assets/kr.otf' : null,
        fontFamily: bundled ? null : fontFamily,
        gsapRel: 'assets/gsap.min.js', tone: values.tone || cardCfg.tone || 'alert',
        treatment,
        cta: cardCfg.cta || null,
        ctaLead: cardCfg.ctaLead || '',
        disclaimer: cardCfg.disclaimer || '',
      }));

      // 후보 i 는 [i, i+1) 구간에 있다 — 가운데를 뜬다.
      const at = variants.map((_, i) => (i + 0.5).toFixed(1)).join(',');
      const res = spawnSync(process.execPath, [hfBin, 'snapshot', projectDir, '--at', at], {
        encoding: 'utf-8',
        env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' },
        timeout: 20 * 60 * 1000,
      });
      if (res.status !== 0) {
        throw new Error(`snapshot 실패 (exit ${res.status}): ${`${res.stderr || ''}${res.stdout || ''}`.trim().slice(-400)}`);
      }
      const snapDir = join(projectDir, 'snapshots');
      const frames = readdirSync(snapDir).filter(f => /^frame-\d+-at-/.test(f)).sort();
      let n = 0;
      for (const f of frames) {
        // 컴포지션 끝에 자동으로 붙는 end-of-timeline 프레임은 후보가 아니다.
        if (n >= variants.length) break;
        const name = variants.length === 1 ? `${prefix}.png` : `${prefix}-${String(n + 1).padStart(2, '0')}.png`;
        copyFileSync(join(snapDir, f), join(outDir, name));
        n++;
      }
      return n;
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  };

  console.log(`🎴 문안 ${variants.length}종 × 폰트 ${fonts.length}종 — 배경 ${bgPath.split('/').pop()}`);
  let total = 0;
  fonts.forEach((f, i) => {
    const prefix = values.fonts ? `font-${String(i + 1).padStart(2, '0')}` : 'title';
    const n = shot(f.label, f.family, !!f.bundled, prefix, f.treatment || {});
    total += n;
    console.log(`  ${String(i + 1).padStart(2, ' ')}. ${f.label}${f.family ? ` (${f.family})` : ''} → ${n}장`);
  });
  console.log(`\n✅ ${total}장 → ${outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
}
