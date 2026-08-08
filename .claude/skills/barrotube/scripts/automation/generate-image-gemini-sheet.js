#!/usr/bin/env node

/**
 * generate-image-gemini-sheet.js — Gemini 이미지 생성 + 캐릭터 시트를 "이미지"로 첨부
 *
 * 왜 별도인가: generate-image-gemini.js 는 character-dna.md 의 DNA 텍스트만 붙인다.
 * 실측(EP-2026-0086) 결과 텍스트 DNA만으로는 컷마다 마스코트가 통째로 빠지거나
 * (scene_001) 몸 색이 회색으로 바뀌는(scene_002) 드리프트가 났다.
 * ChatGPT 브라우저 경로가 안정적인 이유는 "시트를 첨부"하기 때문이므로 같은 방식을 쓴다.
 *
 * Usage:
 *   GOOGLE_AI_API_KEY=... node generate-image-gemini-sheet.js \
 *     --script <30_script.md> --out-dir <40_assets/images> [--sheet <png>] [--force] [--only 001,005]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYAML } from 'yaml';
import { getSecret } from './config-loader.js';

const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';
const DEFAULT_SHEET = '/Users/beye/BarroTubeData/workspace/docs/바로경제_캐릭터시트.png';

// ChatGPT 경로에서 검증된 헤더. 캐릭터는 시트가 정의하고, 프롬프트는 씬만 기술한다.
const HEADER =
  'Use the attached character sheet as the exact reference for the mascot — identical body, ' +
  'face, eyes, cheeks, colors and proportions. Create a single vertical 9:16 image with Masi ' +
  "as the dominant central actor. Show Masi's readable face and full-body action in the centre, " +
  'with comfortable headroom and footroom. SCENE: ';

const a = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (!k.startsWith('--')) continue;
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith('--')) a[k.slice(2)] = true;
  else { a[k.slice(2)] = n; i++; }
}

if (!a.script || !a['out-dir']) {
  console.error('Usage: generate-image-gemini-sheet.js --script <30_script.md> --out-dir <dir> [--sheet <png>] [--force] [--only 001,005]');
  process.exit(1);
}

const apiKey = getSecret('GOOGLE_AI_API_KEY');
if (!apiKey) { console.error('GOOGLE_AI_API_KEY not set'); process.exit(1); }

const sheetPath = a.sheet || DEFAULT_SHEET;
if (!existsSync(sheetPath)) { console.error(`sheet not found: ${sheetPath}`); process.exit(1); }
const sheetB64 = readFileSync(sheetPath).toString('base64');

const raw = readFileSync(a.script, 'utf-8');
const meta = parseYAML(raw.match(/^---\n([\s\S]*?)\n---/)[1]);
const only = a.only && a.only !== true ? String(a.only).split(',').map(s => s.trim()) : null;

console.log(`🧬 Sheet: ${sheetPath.split('/').pop()} (attached as image)`);
console.log(`🎨 ${meta.scenes.length} scenes, model=${MODEL}`);

let ok = 0, failed = [];
for (const s of meta.scenes) {
  const id = s.scene_id;
  if (only && !only.includes(id)) continue;
  const out = join(a['out-dir'], `scene_${id}.png`);
  if (existsSync(out) && !a.force) { console.log(`⏭  ${id} exists`); ok++; continue; }

  // palette 토큰은 텍스트 파이프라인용이라 제거한다. 배경색은 image_prompt 의 BACKGROUND 절이 정한다.
  const prompt = HEADER + String(s.image_prompt).replace(/\[palette:[a-z0-9_-]+\]\s*/i, '');
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'image/png', data: sheetB64 } },
      { text: prompt },
    ] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16', imageSize: '2K' } },
  };

  let done = false;
  for (let t = 1; t <= 3 && !done; t++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
      const d = await res.json();
      const part = (d.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
      if (!part) throw new Error('no image part in response');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from((part.inlineData || part.inline_data).data, 'base64'));
      console.log(`✅ ${id}`);
      done = true; ok++;
    } catch (e) {
      console.log(`⚠️  ${id} attempt ${t}: ${e.message}`);
      if (t < 3) await new Promise(r => setTimeout(r, 4000));
    }
  }
  if (!done) failed.push(id);
  await new Promise(r => setTimeout(r, 1500));
}

console.log(`\n${ok} ok, ${failed.length} failed${failed.length ? ': ' + failed.join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
