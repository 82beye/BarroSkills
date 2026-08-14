#!/usr/bin/env node
/**
 * generate-motion.js — 승인된 씬 스틸을 로컬에서 모션 클립으로 만든다 (S6c 모션 단계).
 *
 * 지금까지 `40_assets/videos/scene_NNN.mp4` 는 브라우저(Grok Imagine)로만 만들 수 있었다.
 * render-direct.js 는 이 파일이 없으면 exit 3 으로 멈춘다. 그래서 무인 파이프라인이
 * 로그인·유료 모달·일일 쿼터에 묶여 있었고, Grok 은 스틸을 다시 상상해 캐릭터가 바뀌는
 * 문제까지 있었다(barrotube-media-render/SKILL.md 의 today.myo ep04 실측: 6개 중 4개).
 *
 * 이 스크립트는 HeyGen 의 HyperFrames(HTML→MP4, Apache-2.0)로 **승인된 그 PNG 자체**를
 * 헤드리스 크롬에서 움직여 같은 경로에 클립을 만든다. 브라우저·쿼터·비용이 없고,
 * 길이를 TTS 에 정확히 맞추므로 render-direct 의 리타임 속도 워프도 사라진다.
 *
 * 화질/움직임의 양 자체는 기존 ffmpeg Ken Burns 와 비슷하다(실측 프레임 차이 0.021 vs
 * 0.022). 이 단계가 버는 것은 "브라우저 없이, 캐릭터 드리프트 없이, 정확한 길이로"다.
 *
 * Usage:
 *   node scripts/automation/generate-motion.js --episode <episode_dir> [--platform shorts|long]
 *   node scripts/automation/generate-motion.js --episode <dir> --scene 003 --force
 *   node scripts/automation/generate-motion.js --doctor
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from 'yaml';

import { buildSceneComposition, CANVAS } from './lib/motion-composition.js';
import { verifyMotionClip } from './lib/motion-verify.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, '..', '..');

/** 클립을 무엇으로 만들었는지 남긴다. QA 가 이걸 읽어 보고서에 적는다. */
export const ENGINE_MANIFEST = '_engines.json';

/** HyperFrames 는 헤드리스 크롬으로 프레임을 뜬다. 없으면 렌더 자체가 안 된다. */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/**
 * hyperframes 실행 파일을 찾는다.
 *
 * npx 로 그때그때 받아오지 않는다 — 버전이 바뀌면 같은 입력에 다른 영상이 나오고,
 * 오프라인 cron 에서 조용히 실패한다. 스킬의 node_modules 에 고정 설치한 것을 쓴다.
 */
export function resolveHyperframes() {
  if (process.env.BT_HYPERFRAMES_BIN && existsSync(process.env.BT_HYPERFRAMES_BIN)) {
    return process.env.BT_HYPERFRAMES_BIN;
  }
  const local = join(SKILL_DIR, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
  return existsSync(local) ? local : null;
}

export function resolveGsap() {
  const local = join(SKILL_DIR, 'node_modules', 'gsap', 'dist', 'gsap.min.js');
  return existsSync(local) ? local : null;
}

function probeDuration(mediaPath) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', mediaPath], { encoding: 'utf-8' });
  if (r.status !== 0) return 0;
  return parseFloat(r.stdout.trim()) || 0;
}

function parseFrontmatter(mdPath) {
  const content = readFileSync(mdPath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`No YAML frontmatter in ${mdPath}`);
  return parseYAML(match[1]);
}

/** render-direct.js 와 같은 순서로 30_script.md 를 찾는다. */
export function resolveScript(episodeDir, platformHint) {
  const candidates = platformHint
    ? [join(episodeDir, 'platforms', platformHint, '30_script.md')]
    : [
        join(episodeDir, 'platforms', 'long', '30_script.md'),
        join(episodeDir, 'platforms', 'shorts', '30_script.md'),
        join(episodeDir, '30_script.md'),
      ];
  const scriptPath = candidates.find(p => existsSync(p));
  if (!scriptPath) throw new Error(`Missing 30_script.md (tried: ${candidates.join(', ')})`);
  return scriptPath;
}

export function resolveAssetsDir(baseDir) {
  for (const name of ['40_assets', 'assets']) {
    const p = join(baseDir, name);
    if (existsSync(p)) return p;
  }
  throw new Error(`Missing assets dir under ${baseDir}`);
}

/**
 * 한 씬을 렌더한다. 실패하면 throw — 조용히 넘어가면 정지 클립이 게시까지 간다.
 */
export function renderSceneClip({ hfBin, gsapPath, imagePath, durationSec, index, outPath, quiet = true }) {
  const projectDir = mkdtempSync(join(tmpdir(), 'bt-hf-'));
  try {
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    copyFileSync(imagePath, join(projectDir, 'assets', 'scene.png'));
    copyFileSync(gsapPath, join(projectDir, 'assets', 'gsap.min.js'));
    writeFileSync(join(projectDir, 'hyperframes.json'), JSON.stringify({
      paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
      media: { autoProxy: true },
    }, null, 2));
    writeFileSync(join(projectDir, 'index.html'), buildSceneComposition({
      imageRel: 'assets/scene.png',
      gsapRel: 'assets/gsap.min.js',
      durationSec,
      index,
    }));

    const rendered = join(projectDir, 'out.mp4');
    // --low-memory-mode: 워커를 1개로 고정하고 screenshot 캡처를 쓴다.
    // 기본값(beginFrame, 워커 auto=6)은 이 맥에서 180프레임 중 0장을 뜨고
    // "Attempted to use detached Frame" 로 전부 실패했다 (2026-08-14 실측).
    const args = ['render', projectDir, '-o', rendered,
      '--resolution', 'portrait', '--quality', 'standard', '--low-memory-mode'];
    if (quiet) args.push('--quiet');

    const res = spawnSync(process.execPath, [hfBin, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' },
      timeout: Number(process.env.BT_MOTION_TIMEOUT_MS) || 10 * 60 * 1000,
    });
    if (res.status !== 0 || !existsSync(rendered)) {
      const tail = `${res.stderr || ''}${res.stdout || ''}`.trim().slice(-600);
      throw new Error(`hyperframes render 실패 (exit ${res.status}): ${tail}`);
    }

    mkdirSync(dirname(outPath), { recursive: true });
    copyFileSync(rendered, outPath);
    return outPath;
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function readManifest(videosDir) {
  const p = join(videosDir, ENGINE_MANIFEST);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return {}; }
}

function writeManifest(videosDir, manifest) {
  mkdirSync(videosDir, { recursive: true });
  writeFileSync(join(videosDir, ENGINE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

function doctor() {
  const rows = [];
  const hf = resolveHyperframes();
  rows.push(['hyperframes', hf || '없음 — npm install --prefix .claude/skills/barrotube hyperframes']);
  rows.push(['gsap', resolveGsap() || '없음 — npm install --prefix .claude/skills/barrotube gsap']);
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' });
  rows.push(['ffmpeg', ff.status === 0 ? ff.stdout.split('\n')[0] : '없음']);
  // hyperframes doctor 는 프로젝트 디렉토리 밖에서 아무것도 출력하지 않는다 — 크롬은 직접 본다.
  const chrome = CHROME_CANDIDATES.find(existsSync);
  rows.push(['chrome', chrome || '없음 — HyperFrames 는 헤드리스 크롬으로 프레임을 뜬다']);
  for (const [k, v] of rows) console.log(`  ${k.padEnd(12)} ${v}`);
  const ok = !!hf && !!resolveGsap() && ff.status === 0 && !!chrome;
  console.log(ok ? '\n✅ 모션 엔진 준비됨' : '\n❌ 준비 안 됨 — 위 항목을 채우세요');
  return ok ? 0 : 1;
}

export function generateMotion({ episodeDir, platform = null, onlyScene = null, force = false }) {
  const hfBin = resolveHyperframes();
  const gsapPath = resolveGsap();
  if (!hfBin) throw new Error('hyperframes 가 없다. npm install --prefix .claude/skills/barrotube hyperframes');
  if (!gsapPath) throw new Error('gsap 이 없다. npm install --prefix .claude/skills/barrotube gsap');

  const scriptPath = resolveScript(resolve(episodeDir), platform);
  const baseDir = dirname(scriptPath);
  const assetsDir = resolveAssetsDir(baseDir);
  const videosDir = join(assetsDir, 'videos');
  const meta = parseFrontmatter(scriptPath);
  const scenes = meta.scenes || [];
  if (!scenes.length) throw new Error('No scenes in script');

  const manifest = readManifest(videosDir);
  const results = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const sceneId = scene.scene_id || String(i + 1).padStart(3, '0');
    if (onlyScene && sceneId !== onlyScene) continue;

    const imagePath = join(assetsDir, 'images', `scene_${sceneId}.png`);
    const ttsPath = join(assetsDir, 'tts', `scene_${sceneId}.wav`);
    const outPath = join(videosDir, `scene_${sceneId}.mp4`);

    if (!existsSync(imagePath)) throw new Error(`Missing image: ${imagePath}`);
    if (!existsSync(ttsPath)) throw new Error(`Missing tts: ${ttsPath}`);

    // render-direct.js 와 같은 공식이어야 클립이 씬 길이에 정확히 맞는다.
    const ttsDur = probeDuration(ttsPath);
    const durationSec = Math.max(ttsDur, Number(scene.target_seconds) || 0) || 12;

    if (existsSync(outPath) && !force) {
      // 다른 엔진(Grok)이 만든 클립을 우리 규격으로 재단하지 않는다. Grok 은 720x1264 ·
      // 10.04s 고정이라 이 검사의 1080x1920 · TTS 길이 조건을 원천적으로 못 맞춘다.
      // 그걸 "실패"로 보고 덮어쓰면 사람이 브라우저로 어렵게 받아온 클립이 사라진다.
      const madeHere = manifest[sceneId]?.engine === 'hyperframes';
      const check = madeHere
        ? verifyMotionClip({ videoPath: outPath, expectDurationSec: durationSec })
        : verifyMotionClip({ videoPath: outPath, expectDurationSec: null, expectW: null, expectH: null });
      if (check.ok) {
        console.log(`  ⏭  Scene ${sceneId} 이미 있음 (${check.duration.toFixed(2)}s, ${manifest[sceneId]?.engine || '엔진 미상'}) — skip`);
        results.push({ sceneId, skipped: true, ...check });
        continue;
      }
      if (!madeHere) {
        throw new Error(`Scene ${sceneId} 의 기존 클립(${manifest[sceneId]?.engine || '엔진 미상'})이 검사에 걸렸다: `
          + `${check.reasons.join('; ')}. 덮어쓰려면 --force 를 명시하세요.`);
      }
      console.log(`  ♻️  Scene ${sceneId} 기존 클립이 검사 실패 (${check.reasons.join('; ')}) — 다시 만든다`);
    }

    const t0 = Date.now();
    renderSceneClip({ hfBin, gsapPath, imagePath, durationSec, index: i, outPath });
    const check = verifyMotionClip({ videoPath: outPath, expectDurationSec: durationSec });
    if (!check.ok) {
      throw new Error(`Scene ${sceneId} 클립이 검사를 통과하지 못했다: ${check.reasons.join('; ')}`);
    }

    manifest[sceneId] = {
      engine: 'hyperframes',
      source_image: `images/scene_${sceneId}.png`,
      duration_sec: Number(check.duration.toFixed(3)),
      motion_diff: Number(check.motion.toFixed(4)),
      rendered_at: new Date().toISOString(),
    };
    writeManifest(videosDir, manifest);

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ✅ Scene ${sceneId} → ${check.duration.toFixed(2)}s, ${check.width}x${check.height}, motion ${check.motion.toFixed(4)} (${secs}s)`);
    results.push({ sceneId, skipped: false, ...check });
  }

  return { scriptPath, videosDir, results, manifest };
}

function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string' },
      platform: { type: 'string' },
      scene: { type: 'string' },
      force: { type: 'boolean', default: false },
      doctor: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.doctor) {
    process.exit(doctor());
  }
  if (!values.episode) {
    console.error('Usage: generate-motion.js --episode <episode_dir> [--platform shorts|long] [--scene NNN] [--force]');
    console.error('       generate-motion.js --doctor');
    process.exit(2);
  }

  console.log(`🎥 HyperFrames 모션 클립 (${CANVAS.w}x${CANVAS.h} @${CANVAS.fps}fps)`);
  const { videosDir, results } = generateMotion({
    episodeDir: values.episode,
    platform: values.platform || null,
    onlyScene: values.scene || null,
    force: values.force,
  });
  const made = results.filter(r => !r.skipped).length;
  console.log(`\n✅ ${results.length}개 씬 확인 (신규 ${made}개) → ${videosDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}
