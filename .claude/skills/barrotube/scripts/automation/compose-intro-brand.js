#!/usr/bin/env node

/**
 * compose-intro-brand.js — 완성된 인트로 아트워크 위에 회사 CI(로고)를 얹는다 (S6d 마무리).
 *
 * 왜 따로 있나. 인트로 아트워크를 만드는 표면은 셋이다 — 브라우저 ChatGPT(media-render),
 * codex/OpenAI/Gemini API(generate-intro.js), 씬 스틸 재사용(generate-cards.js). 앞의 둘은
 * 그림만 만들고 나오므로 CI 를 붙일 자리가 없다. 그리고 로고는 **모델에게 그리게 하지 않는다**:
 * 카드 한글이 "메타→머타" 로 깨졌던 것과 같은 실패가 로고에서는 더 크게 난다. 라이선스 SVG
 * (workspace/assets/brand-logos, SimpleIcons CC0)를 생성 후에 얹는 것이 정본이다.
 *
 * 어떤 회사를 붙일지는 손으로 고르지 않는다. 에피소드 타이틀에서 기업명을 찾아
 * config/brand-entities.json 으로 해석한다 (lib/brand-entities.js).
 *
 * Usage:
 *   node scripts/automation/compose-intro-brand.js --episode <dir> [--platform shorts]
 *   node scripts/automation/compose-intro-brand.js --episode <dir> --base 45_intro.base.png --out 45_intro.png
 *
 * 기본 입력: 45_intro.base.png 가 있으면 그것, 없으면 45_intro.png (제자리 갱신).
 * 기본 출력: 45_intro.png
 * 기본 위치: bottom-right (타이틀이 위쪽에 이미 그려져 있다고 본다)
 *
 * 헤드라인·배지까지 로컬에서 얹어야 하는 경우라면 이 스크립트가 아니라 generate-intro.js 다 —
 * 아트워크를 45_intro.base.png 로 저장해 두면 그쪽이 v2spec 그대로 전체를 합성한다.
 */

import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { parseFrontmatter } from './generate-image-gemini.js';
import { resolveBrandsForTitle } from './lib/brand-entities.js';
import { overlayBrandLogos } from './lib/thumbnail-composer.js';

/** v2 (platforms/) 우선 → v1 (legacy) fallback. generate-intro.js 와 같은 규칙. */
function locateBase(epDir, platformHint) {
  const candidates = platformHint
    ? [join(epDir, 'platforms', platformHint, '30_script.md')]
    : [
        join(epDir, 'platforms', 'long', '30_script.md'),
        join(epDir, 'platforms', 'shorts', '30_script.md'),
        join(epDir, '30_script.md'),
      ];
  for (const c of candidates) if (existsSync(c)) return { scriptPath: c, baseDir: dirname(c) };
  return { scriptPath: null, baseDir: null };
}

function underBase(baseDir, p) {
  return isAbsolute(p) ? p : join(baseDir, p);
}

async function main() {
  const { values: opts } = parseArgs({
    options: {
      episode: { type: 'string' },
      platform: { type: 'string' },
      base: { type: 'string' },
      out: { type: 'string' },
      position: { type: 'string' },
    },
  });

  if (!opts.episode) {
    console.error('Usage: compose-intro-brand.js --episode <dir> [--platform shorts] [--base <png>] [--out <png>] [--position top-right|bottom-right|top-left|bottom-left]');
    process.exit(2);
  }

  const epDir = resolve(opts.episode);
  const { scriptPath, baseDir } = locateBase(epDir, opts.platform);
  if (!scriptPath) {
    console.error(`❌ 30_script.md 없음: ${epDir} (platforms/long, platforms/shorts, legacy root 확인)`);
    process.exit(1);
  }

  const fm = parseFrontmatter(scriptPath) || {};
  const channel = fm.channel_id;

  let briefFM = {};
  const briefPath = join(epDir, '00_brief.md');
  if (existsSync(briefPath)) {
    try { briefFM = parseFrontmatter(briefPath) || {}; } catch { briefFM = {}; }
  }

  const briefThumb = (briefFM.thumbnail && typeof briefFM.thumbnail === 'object') ? briefFM.thumbnail : {};
  const title = [briefThumb.intro_headline_text, briefFM.topic].filter(Boolean).join(' \n ');
  if (!title) {
    console.error('❌ 타이틀을 못 찾았다 — 00_brief.md 의 topic 또는 thumbnail.intro_headline_text 가 필요하다.');
    process.exit(1);
  }

  // 기본은 아래 모서리다. media-render 로 만든 인트로는 타이틀을 화면 위쪽에 크게 그려서
  // 내려오므로 우상단에 얹으면 글자를 덮는다. 위가 비어 있는 아트워크면 --position top-right.
  const logoPosition = opts.position || 'bottom-right';
  const brands = resolveBrandsForTitle(channel, briefFM, title, { logoPosition });
  if (!brands.brands.length) {
    console.log(`⏭  타이틀에 등록된 기업명이 없다 — CI 합성할 게 없다.`);
    console.log(`   타이틀: "${title.replace(/\n/g, ' ')}"`);
    console.log(`   기업을 늘리려면 config/brand-entities.json 에 항목을 추가한다.`);
    process.exit(0);
  }

  console.log(`🏢 브랜드 감지: ${brands.brands.map(b => b.company.name_ko).join(', ')}`);
  for (const n of brands.notes) console.log(`   ↳ ${n}`);

  if (!brands.logoSpecs.length) {
    console.log(`⏭  붙일 로고 자산이 없다 — 이미지는 그대로 둔다.`);
    process.exit(0);
  }

  const outPath = underBase(baseDir, opts.out || '45_intro.png');
  const defaultBase = existsSync(join(baseDir, '45_intro.base.png'))
    ? join(baseDir, '45_intro.base.png')
    : outPath;
  const basePath = opts.base ? underBase(baseDir, opts.base) : defaultBase;

  if (!existsSync(basePath)) {
    console.error(`❌ 아트워크가 없다: ${basePath}`);
    console.error(`   브라우저(ChatGPT)로 만든 인트로를 45_intro.base.png 또는 45_intro.png 로 먼저 저장하라.`);
    process.exit(1);
  }

  // 제자리 갱신이면 임시 파일을 거친다 — sharp 는 읽는 파일에 그대로 쓰면 원본을 잘라먹는다.
  const inPlace = resolve(basePath) === resolve(outPath);
  const writeTo = inPlace ? `${outPath}.brand.tmp.png` : outPath;

  try {
    const r = await overlayBrandLogos({ baseImagePath: basePath, logoSpecs: brands.logoSpecs, outPath: writeTo });
    if (r.skipped) {
      if (inPlace && existsSync(writeTo)) unlinkSync(writeTo);
      console.log(`⏭  로고 파일을 못 찾아 합성을 건너뛴다 (build-assets-library.js --brand-logos 로 받는다).`);
      process.exit(0);
    }
    if (inPlace) renameSync(writeTo, outPath);
    console.log(`✅ CI ${r.layers}개 합성: ${outPath}`);
    console.log(`   로고: ${brands.logoSpecs.map(l => l.id).join(', ')} (SimpleIcons CC0)`);
  } catch (e) {
    if (inPlace && existsSync(writeTo)) unlinkSync(writeTo);
    console.error(`❌ CI 합성 실패: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
