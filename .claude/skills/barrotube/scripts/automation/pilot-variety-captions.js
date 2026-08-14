#!/usr/bin/env node
/**
 * pilot-variety-captions.js — 예능형 자막 파일럿 (HyperFrames).
 *
 * 기존 자막은 파이썬이 구운 정지 PNG 라 "색이 바뀐다" 외의 연출이 불가능하다.
 * 이 스크립트는 자막만 **알파 WebM** 으로 따로 뽑아(HyperFrames) 기존 모션 클립 위에
 * ffmpeg 로 얹는다. 배경 렌더는 건드리지 않으므로 기존 파이프라인과 나란히 비교할 수 있다.
 *
 * 파일럿이다 — produce-episode 경로에 연결돼 있지 않다. 결과가 좋으면
 * render-direct.js 의 자막 층을 이걸로 교체하면 된다.
 *
 * Usage:
 *   node scripts/automation/pilot-variety-captions.js --episode <dir> [--platform shorts]
 *     [--scenes 001,002] [--out <mp4>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from 'yaml';

import { buildCaptionComposition, CANVAS } from './lib/caption-composition.js';
import { resolveGsap, resolveHyperframes, resolveAssetsDir, resolveScript } from './generate-motion.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, '..', '..');
const FONT = join(SKILL_DIR, 'assets', 'fonts', 'NotoSansKR-Black.otf');

function probeDuration(p) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], { encoding: 'utf-8' });
  return r.status === 0 ? (parseFloat(r.stdout.trim()) || 0) : 0;
}

function parseFrontmatter(mdPath) {
  const m = readFileSync(mdPath, 'utf-8').match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error(`No YAML frontmatter in ${mdPath}`);
  return parseYAML(m[1]);
}

/** 자막 트랙만 알파 WebM 으로 렌더한다. */
function renderCaptionTrack({ hfBin, gsapPath, text, durationSec, emphasis, outPath }) {
  const projectDir = mkdtempSync(join(tmpdir(), 'bt-cap-'));
  try {
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    copyFileSync(FONT, join(projectDir, 'assets', 'kr.otf'));
    copyFileSync(gsapPath, join(projectDir, 'assets', 'gsap.min.js'));
    writeFileSync(join(projectDir, 'hyperframes.json'), JSON.stringify({
      paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
    }, null, 2));
    writeFileSync(join(projectDir, 'index.html'), buildCaptionComposition({
      text, durationSec, emphasis,
      fontRel: 'assets/kr.otf',
      gsapRel: 'assets/gsap.min.js',
    }));

    const rendered = join(projectDir, 'cap.webm');
    // WebM/MOV 만 알파를 보존한다. --low-memory-mode 는 필수 (references/MOTION.md).
    // --resolution 은 알파 출력과 함께 쓸 수 없다 ("outputResolution cannot be combined with
    // alpha output") — 컴포지션이 이미 1080x1920 이라 그대로 뜨면 된다.
    const res = spawnSync(process.execPath, [hfBin, 'render', projectDir, '-o', rendered,
      '--format', 'webm', '--quality', 'standard',
      '--low-memory-mode', '--quiet'], {
      encoding: 'utf-8',
      env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' },
      timeout: 10 * 60 * 1000,
    });
    if (res.status !== 0 || !existsSync(rendered)) {
      throw new Error(`caption render 실패 (exit ${res.status}): ${`${res.stderr || ''}${res.stdout || ''}`.trim().slice(-500)}`);
    }
    copyFileSync(rendered, outPath);
    return outPath;
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

/** 모션 클립 + 자막 트랙 + TTS 를 한 씬 클립으로 합친다. */
function composeScene({ videoPath, captionPath, ttsPath, durationSec, outPath }) {
  const args = ['-y', '-i', videoPath, '-c:v', 'libvpx-vp9', '-i', captionPath, '-i', ttsPath,
    '-filter_complex',
    `[0:v]scale=${CANVAS.w}:${CANVAS.h}:force_original_aspect_ratio=increase,crop=${CANVAS.w}:${CANVAS.h},fps=30[bg];`
    + `[1:v]fps=30[cap];[bg][cap]overlay=0:0:format=auto[v];`
    + `[2:a]apad=pad_dur=${durationSec},atrim=duration=${durationSec},asetpts=PTS-STARTPTS,aresample=44100[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1',
    '-t', String(durationSec), outPath];
  const r = spawnSync('ffmpeg', args.filter(a => a !== '-c:v' || true), { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`ffmpeg compose 실패: ${r.stderr.toString().slice(-500)}`);
  return outPath;
}

function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string' },
      platform: { type: 'string' },
      scenes: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!values.episode) {
    console.error('Usage: pilot-variety-captions.js --episode <dir> [--platform shorts] [--scenes 001,002] [--out sample.mp4]');
    process.exit(2);
  }

  const hfBin = resolveHyperframes();
  const gsapPath = resolveGsap();
  if (!hfBin || !gsapPath) throw new Error('hyperframes/gsap 없음 — generate-motion.js --doctor 로 점검하세요');
  if (!existsSync(FONT)) throw new Error(`폰트 없음: ${FONT} (build-fonts.js 실행)`);

  const scriptPath = resolveScript(resolve(values.episode), values.platform || null);
  const baseDir = dirname(scriptPath);
  const assetsDir = resolveAssetsDir(baseDir);
  const meta = parseFrontmatter(scriptPath);
  const want = values.scenes ? values.scenes.split(',').map(s => s.trim()) : null;
  const scenes = (meta.scenes || []).filter(s => !want || want.includes(String(s.scene_id)));
  if (!scenes.length) throw new Error('대상 씬이 없다');

  const workDir = mkdtempSync(join(tmpdir(), 'bt-pilot-'));
  const clips = [];
  console.log(`🎬 예능 자막 파일럿 — ${scenes.length}개 씬`);

  try {
    for (const scene of scenes) {
      const id = scene.scene_id;
      const videoPath = join(assetsDir, 'videos', `scene_${id}.mp4`);
      const imagePath = join(assetsDir, 'images', `scene_${id}.png`);
      const ttsPath = join(assetsDir, 'tts', `scene_${id}.wav`);
      if (!existsSync(ttsPath)) throw new Error(`TTS 없음: ${ttsPath}`);
      const bg = existsSync(videoPath) ? videoPath : imagePath;
      if (!existsSync(bg)) throw new Error(`배경 없음: ${videoPath}`);

      const durationSec = Math.max(probeDuration(ttsPath), Number(scene.target_seconds) || 0) || 10;
      const text = scene.subtitle_text || scene.narration || '';
      const t0 = Date.now();

      const capPath = join(workDir, `cap_${id}.webm`);
      renderCaptionTrack({ hfBin, gsapPath, text, durationSec, emphasis: scene.emphasis_tokens || [], outPath: capPath });

      const clipPath = join(workDir, `clip_${id}.mov`);
      composeScene({ videoPath: bg, captionPath: capPath, ttsPath, durationSec, outPath: clipPath });
      clips.push(clipPath);
      console.log(`  ✅ Scene ${id} (${durationSec.toFixed(1)}s, ${((Date.now() - t0) / 1000).toFixed(0)}s)  "${text.slice(0, 30)}…"`);
    }

    const listPath = join(workDir, 'list.txt');
    writeFileSync(listPath, clips.map(p => `file '${p}'`).join('\n'));
    const outPath = resolve(values.out || join(baseDir, '55_render', 'pilot_variety_captions.mp4'));
    mkdirSync(dirname(outPath), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '1',
      outPath]);
    console.log(`\n✅ 샘플: ${outPath}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
}
