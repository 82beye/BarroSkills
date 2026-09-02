#!/usr/bin/env node

/**
 * generate-motion-wan.js — Wan 2.2(HF Space)로 씬 모션을 굽고, **QA 통과할 때까지 재생성**한다.
 *
 * 이게 이 스크립트의 존재 이유다. Wan 은 모션 도중 마스코트 얼굴을 다시 그리다 뭉갠다
 * (2026-09-02 실측: 65프레임 중 f12 머리 왜곡 · f31 눈이 노치 파인 사각형). 프롬프트로는
 * 못 막는다 — 얼굴을 얼리라고 명시해도 무시하고 오히려 입이 흰 격자로 뭉개진 적도 있다.
 * 막을 수 없으면 **걸러내고 다시 굽는** 수밖에 없다. 그 루프가 여기다.
 *
 *   생성 → qa-motion-frames.js → PASS 면 채택 / FAIL 이면 시드 바꾸고 결함 힌트 덧대 재시도
 *
 * 시드를 바꾸는 게 핵심이다. 같은 시드로 프롬프트만 손보면 같은 붕괴가 재현된다.
 * 재시도를 다 쓰면 **가장 결함이 적은 시도**를 남기고 exit 1 — 조용히 나쁜 걸 채택하지 않는다.
 *
 * 검사 불가(exit 2: 얼굴 ROI 미검출·비전 판정기 부재)는 재시도하지 않는다. 같은 이유로
 * 계속 실패할 뿐이고, 쿼터만 태운다 — 즉시 멈추고 사람을 부른다.
 *
 * Usage:
 *   node generate-motion-wan.js --image scene_001.png --out scene_001.mp4
 *   node generate-motion-wan.js --image scene_001.png --out clip.mp4 --attempts 4 --duration 4
 *   node generate-motion-wan.js --episode <episode_dir> --platform shorts   # 전 씬 (S6c 정본 경로)
 *   node generate-motion-wan.js --episode <dir> --scene 003 --force         # 한 씬만 다시
 *   node generate-motion-wan.js --image s.png --out c.mp4 --post-720p       # 24fps·720p 후처리까지
 *
 * 종료코드: 0 = QA 통과본 채택 · 1 = 전 시도 실패(최선본 보존) · 2 = 검사 불가/입력 오류
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { generateClip, downloadClip, withRepairHint, DEFAULT_PROMPT } from './lib/wan-hf.js';
import { ENGINE_MANIFEST } from './generate-motion.js';

const ROOT = resolve(import.meta.dirname, '..');
const QA = join(ROOT, 'automation', 'qa-motion-frames.js');

/**
 * 에피소드 디렉토리 규약은 generate-motion.js·grok-motion.js 와 같다 —
 * <episode_dir>/platforms/<platform>/40_assets/{images,videos}/scene_NNN.*
 * 클립은 videos/ 다. render-direct.js 가 거기서만 찾는다.
 */
function assetDirs(episodeDir, platform = 'shorts') {
  // media-render 경로는 이미 platforms/<p> 까지 내려온 디렉토리를 넘긴다 — 둘 다 받는다.
  const base = existsSync(join(episodeDir, '40_assets'))
    ? join(episodeDir, '40_assets')
    : join(episodeDir, 'platforms', platform, '40_assets');
  return { images: join(base, 'images'), videos: join(base, 'videos') };
}

/** images/scene_NNN.png 를 정렬해 돌려준다. */
function listScenes(imagesDir) {
  if (!existsSync(imagesDir)) return [];
  return readdirSync(imagesDir)
    .map((f) => f.match(/^scene_(\d{3})\.png$/)?.[1])
    .filter(Boolean).sort();
}

/** 클립을 무엇으로 구웠는지 남긴다 — QA 보고서와 auto-pipeline 의 폴백 감지가 이걸 읽는다. */
function recordManifest(videosDir, sceneId, entry) {
  const path = join(videosDir, ENGINE_MANIFEST);
  let m = {};
  if (existsSync(path)) { try { m = JSON.parse(readFileSync(path, 'utf-8')); } catch { m = {}; } }
  m[sceneId] = entry;
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
}

/** QA 실행. { code, report } — code 0 pass · 1 fail · 2 검사 불가. */
function runQa(video, reference, sheet) {
  const args = [QA, '--video', video, '--reference', reference];
  if (sheet) args.push('--sheet', sheet);
  const r = spawnSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  const reportPath = `${video.replace(/\.mp4$/i, '')}.qa.json`;
  let report = null;
  if (existsSync(reportPath)) {
    try { report = JSON.parse(readFileSync(reportPath, 'utf-8')); } catch { /* 무시 */ }
  }
  return { code: r.status ?? 2, report };
}

/** 16fps 원본 → 24fps·720p. 무료 Space 는 480×832·16fps 만 주므로 필요하면 여기서 올린다. */
function post720p(input, output) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', input,
    '-vf', 'minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:vsbmc=1,scale=720:-2:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', output],
  { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`후처리 실패: ${r.stderr?.slice(0, 200)}`);
}

/**
 * 씬 하나를 QA 통과까지 굽는다.
 * 반환 { pass, defects, attemptsUsed, reason } — reason 이 'uninspectable' 이면 재시도 무의미.
 */
async function produceScene({ image, out, attempts, duration, steps, seed, basePrompt, skipQa, sheetDir }) {
  const buf = readFileSync(image);
  let hint = '';
  let best = null;
  let used = 0;

  for (let i = 1; i <= attempts; i++) {
    used = i;
    const s = seed + i * 7919;   // 시드를 확실히 벌린다 — 같은 시드면 같은 붕괴가 재현된다
    const prompt = withRepairHint(basePrompt, hint);
    console.log(`  ▶ 시도 ${i}/${attempts} — seed=${s}${hint ? ' (결함 힌트 반영)' : ''}`);

    let clip;
    try {
      const { url } = await generateClip({ imageBuffer: buf, prompt, seed: s, duration, steps });
      clip = await downloadClip(url);
    } catch (e) {
      console.error(`    ⚠️ 생성 실패: ${e.message}`);
      continue;
    }
    const candidate = `${out.replace(/\.mp4$/i, '')}.try${i}.mp4`;
    writeFileSync(candidate, clip);
    console.log(`    ✓ 생성 (${(clip.length / 1024 / 1024).toFixed(1)}MB)`);

    if (skipQa) { best = { path: candidate, defects: 0, pass: true }; break; }

    const sheet = sheetDir ? join(sheetDir, `${basename(candidate, '.mp4')}.defects.png`) : null;
    const { code, report } = runQa(candidate, image, sheet);
    if (code === 2) {
      console.error(`    ⛔ 검사 불가 (${report?.reason ?? 'unknown'}) — 재시도해도 같은 이유로 실패한다`);
      best = best ?? { path: candidate, defects: Infinity, pass: false, reason: 'uninspectable' };
      best.reason = 'uninspectable';
      break;
    }
    const defects = report?.defectCount ?? Infinity;
    if (!best || defects < best.defects) best = { path: candidate, defects, pass: code === 0, report };
    if (code === 0) { console.log(`    ✅ QA 통과 — 시도 ${i} 채택`); break; }

    hint = report?.repair_hint || hint;
    console.log(`    ↻ 결함 ${defects}개 — 시드를 바꿔 재시도`);
  }

  if (!best) return { pass: false, defects: Infinity, attemptsUsed: used, reason: 'generate_failed' };

  copyFileSync(best.path, out);
  // 채택본 외 후보는 지운다 — 실패본이 남아 있으면 다음 단계가 집어갈 수 있다.
  for (let i = 1; i <= attempts; i++) {
    const c = `${out.replace(/\.mp4$/i, '')}.try${i}.mp4`;
    if (existsSync(c) && resolve(c) !== resolve(best.path)) { try { unlinkSync(c); } catch { /* 무시 */ } }
  }
  return { pass: !!best.pass, defects: best.defects, attemptsUsed: used, reason: best.reason ?? null };
}

async function main() {
  const { values } = parseArgs({ options: {
    image: { type: 'string' },
    out: { type: 'string' },
    episode: { type: 'string' },
    platform: { type: 'string', default: 'shorts' },
    scene: { type: 'string' },
    attempts: { type: 'string', default: '3' },
    duration: { type: 'string', default: '4' },
    steps: { type: 'string', default: '6' },
    seed: { type: 'string', default: '1000' },
    prompt: { type: 'string' },
    force: { type: 'boolean', default: false },
    'post-720p': { type: 'boolean', default: false },
    'skip-qa': { type: 'boolean', default: false },
  } });

  const common = {
    attempts: Math.max(1, Number(values.attempts) || 3),
    duration: Number(values.duration) || 4,
    steps: Number(values.steps) || 6,
    seed: Number(values.seed) || 1000,
    basePrompt: values.prompt || DEFAULT_PROMPT,
    skipQa: values['skip-qa'],
  };

  // ── 단일 이미지 모드 (파일럿·수동 재생성) ──
  if (values.image && values.out) {
    if (!existsSync(values.image)) { console.error(`❌ 없는 이미지: ${values.image}`); process.exit(2); }
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    const r = await produceScene({ ...common, image: values.image, out: values.out, sheetDir: dirname(resolve(values.out)) });
    if (r.reason === 'generate_failed') { console.error('\n❌ 생성 자체가 실패했습니다 (쿼터 소진·Space 중단 가능)'); process.exit(2); }
    if (r.reason === 'uninspectable') process.exit(2);
    if (values['post-720p'] && existsSync(values.out)) {
      const up = values.out.replace(/\.mp4$/i, '.720p24.mp4');
      post720p(values.out, up);
      console.log(`  ✓ 후처리: ${up} (720p·24fps)`);
    }
    process.exit(r.pass ? 0 : 1);
  }

  // ── 에피소드 모드 (S6c 정본 경로) ──
  if (!values.episode) {
    console.error('Usage: generate-motion-wan.js (--episode <dir> [--platform shorts] [--scene 003] | --image <png> --out <mp4>)');
    process.exit(2);
  }
  const epDir = resolve(values.episode);
  const { images, videos } = assetDirs(epDir, values.platform);
  const all = listScenes(images);
  if (!all.length) { console.error(`❌ 씬 이미지가 없습니다: ${images}`); process.exit(2); }
  const targets = values.scene ? all.filter((id) => id === String(values.scene).padStart(3, '0')) : all;
  if (!targets.length) { console.error(`❌ 씬 ${values.scene} 이미지가 없습니다`); process.exit(2); }
  mkdirSync(videos, { recursive: true });

  console.log(`🎬 Wan 2.2 모션 — ${targets.length}씬 (${epDir})`);
  const results = [];
  for (const id of targets) {
    const image = join(images, `scene_${id}.png`);
    const out = join(videos, `scene_${id}.mp4`);
    if (existsSync(out) && !values.force) {
      console.log(`\n⏭  씬 ${id} — 이미 있음 (덮어쓰려면 --force)`);
      results.push({ id, pass: true, skipped: true });
      continue;
    }
    console.log(`\n── 씬 ${id} ──`);
    const r = await produceScene({ ...common, image, out, sheetDir: videos });
    results.push({ id, ...r });
    if (r.pass || existsSync(out)) {
      recordManifest(videos, id, {
        engine: 'wan2.2-hf',
        source_image: `images/scene_${id}.png`,
        duration_sec: common.duration,
        qa_pass: r.pass,
        qa_defects: Number.isFinite(r.defects) ? r.defects : null,
        attempts: r.attemptsUsed,
        rendered_at: new Date().toISOString(),
      });
    }
    if (r.reason === 'uninspectable') {
      console.error('⛔ 검사 불가 — 남은 씬을 굽지 않고 멈춥니다 (쿼터 낭비 방지)');
      break;
    }
  }

  const done = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length ? '❌' : '✅'} Wan 모션 ${done}/${targets.length} 통과`);
  for (const f of failed) console.error(`   씬 ${f.id}: 결함 ${Number.isFinite(f.defects) ? f.defects : '?'}개 (${f.reason ?? 'qa_fail'})`);
  if (failed.some((f) => f.reason === 'uninspectable' || f.reason === 'generate_failed')) process.exit(2);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(2); });
