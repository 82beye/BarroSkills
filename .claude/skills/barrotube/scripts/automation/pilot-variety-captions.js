#!/usr/bin/env node
/**
 * pilot-variety-captions.js — 레퍼런스형 자막 파일럿 (HyperFrames).
 *
 * 기존 자막은 파이썬이 구운 정지 PNG 라 "색이 바뀐다" 외의 연출이 불가능하다.
 * 이 스크립트는 두 단계로 만든다.
 *
 *   1) render-direct.js 를 **자막 없이**(BT_SUBTITLE_MODE=none) 돌려 완성본을 만든다.
 *      인트로 카드·아웃트로 패드·엔드카드·BGM 더킹이 전부 들어간 실제 발행 화면이다.
 *   2) 그 영상을 HyperFrames 컴포지션의 **배경 <video>** 로 깔고 그 위에 자막을 그려
 *      한 번에 MP4 로 뽑는다. 원본 오디오도 그대로 실린다.
 *
 * 씬 클립에만 얹으면 인트로·아웃트로·BGM 이 빠진 반쪽짜리가 나온다 — 그래서 완성본 위에
 * 올린다. 초기에는 자막만 알파 WebM 으로 뽑아 ffmpeg 로 덮었는데, VP9 알파 인코딩이
 * 이 파이프라인에서 제일 느린 구간이라 배경 <video> 방식으로 합쳤다.
 *
 * 파일럿이다 — produce-episode 경로에 연결돼 있지 않다.
 *
 * Usage:
 *   node scripts/automation/pilot-variety-captions.js --episode <dir> [--platform shorts]
 *     [--out <mp4>] [--keep-base]
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from 'yaml';

import { buildCaptionComposition } from './lib/caption-composition.js';
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

/**
 * 완성본 영상을 배경으로 깔고 그 위에 자막을 그려 한 번에 MP4 로 뽑는다.
 *
 * 처음에는 자막만 알파 WebM 으로 뽑아 ffmpeg 로 덮었는데, VP9 알파 인코딩이 이 파이프라인에서
 * 제일 느린 구간이었다. HyperFrames 는 <video> 를 클립으로 받으므로 한 번에 끝난다.
 * 원본 오디오도 그대로 실린다(실측: hasAudio=true, 출력에 AAC).
 */
function renderWithCaptions({ hfBin, gsapPath, basePath, segments, totalSec, outPath }) {
  const projectDir = mkdtempSync(join(tmpdir(), 'bt-cap-'));
  try {
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    copyFileSync(FONT, join(projectDir, 'assets', 'kr.otf'));
    copyFileSync(gsapPath, join(projectDir, 'assets', 'gsap.min.js'));
    copyFileSync(basePath, join(projectDir, 'assets', 'base.mp4'));
    writeFileSync(join(projectDir, 'hyperframes.json'), JSON.stringify({
      paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
    }, null, 2));
    writeFileSync(join(projectDir, 'index.html'), buildCaptionComposition({
      segments, totalSec,
      videoRel: 'assets/base.mp4',
      fontRel: 'assets/kr.otf',
      gsapRel: 'assets/gsap.min.js',
    }));

    const rendered = join(projectDir, 'out.mp4');
    // --low-memory-mode 는 필수 (references/MOTION.md).
    const res = spawnSync(process.execPath, [hfBin, 'render', projectDir, '-o', rendered,
      '--resolution', 'portrait', '--quality', 'standard', '--low-memory-mode', '--quiet'], {
      encoding: 'utf-8',
      env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' },
      timeout: 60 * 60 * 1000,
    });
    if (res.status !== 0 || !existsSync(rendered)) {
      throw new Error(`caption render 실패 (exit ${res.status}): ${`${res.stderr || ''}${res.stdout || ''}`.trim().slice(-500)}`);
    }
    mkdirSync(dirname(outPath), { recursive: true });
    copyFileSync(rendered, outPath);
    return outPath;
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string' },
      platform: { type: 'string' },
      out: { type: 'string' },
      'keep-base': { type: 'boolean', default: false },
    },
  });
  if (!values.episode) {
    console.error('Usage: pilot-variety-captions.js --episode <dir> [--platform shorts] [--out sample.mp4]');
    process.exit(2);
  }

  const hfBin = resolveHyperframes();
  const gsapPath = resolveGsap();
  if (!hfBin || !gsapPath) throw new Error('hyperframes/gsap 없음 — generate-motion.js --doctor 로 점검하세요');
  if (!existsSync(FONT)) throw new Error(`폰트 없음: ${FONT} (build-fonts.js 실행)`);

  const epDir = resolve(values.episode);
  const scriptPath = resolveScript(epDir, values.platform || null);
  const baseDir = dirname(scriptPath);
  const assetsDir = resolveAssetsDir(baseDir);
  const meta = parseFrontmatter(scriptPath);
  const scenes = meta.scenes || [];
  if (!scenes.length) throw new Error('대본에 씬이 없다');

  const workDir = mkdtempSync(join(tmpdir(), 'bt-pilot-'));
  try {
    // 1) 자막 없이 완성본을 만든다 — 인트로·아웃트로·엔드카드·BGM 이 다 들어간다.
    const basePath = join(workDir, 'base.mp4');
    console.log('🎬 1/2 자막 없는 완성본 렌더 (인트로·아웃트로·BGM 포함)');
    const r = spawnSync(process.execPath, [join(SCRIPT_DIR, 'render-direct.js'),
      '--episode', epDir, '--out', basePath], {
      encoding: 'utf-8',
      env: { ...process.env, BT_SUBTITLE_MODE: 'none' },
      timeout: 30 * 60 * 1000,
    });
    if (r.status !== 0 || !existsSync(basePath)) {
      throw new Error(`base 렌더 실패: ${`${r.stderr || ''}${r.stdout || ''}`.trim().slice(-500)}`);
    }
    const totalSec = probeDuration(basePath);

    // 2) 그 타임라인에 맞춰 자막 구간을 잡는다.
    //    render-direct 는 [인트로][씬…][아웃트로 패드][엔드카드] 순으로 이어 붙인다.
    const introSec = Number(process.env.BT_INTRO_SEC) || 2;
    const hasIntro = ['45_intro.png', '47_thumbnail.png'].some(f => existsSync(join(baseDir, f)));
    let cursor = hasIntro ? introSec : 0;
    const segments = scenes.map((scene, i) => {
      const id = scene.scene_id || String(i + 1).padStart(3, '0');
      const ttsPath = join(assetsDir, 'tts', `scene_${id}.wav`);
      const duration = Math.max(probeDuration(ttsPath), Number(scene.target_seconds) || 0) || 10;
      const seg = {
        text: scene.subtitle_text || scene.narration || '',
        emphasis: scene.emphasis_tokens || [],
        start: cursor,
        duration,
      };
      cursor += duration;
      return seg;
    });
    // 3) 그 영상을 HyperFrames 배경으로 깔고 자막을 그려 한 번에 뽑는다.
    console.log(`🎬 2/2 배경 영상 + 자막 렌더 — ${segments.length}구간 / 전체 ${totalSec.toFixed(1)}s`
      + `${hasIntro ? ` (인트로 ${introSec}s 뒤부터)` : ''}`);
    const outPath = resolve(values.out || join(baseDir, '55_render', 'pilot_captions.mp4'));
    renderWithCaptions({ hfBin, gsapPath, basePath, segments, totalSec, outPath });

    if (values['keep-base']) {
      const keep = outPath.replace(/\.mp4$/, '.nosub.mp4');
      copyFileSync(basePath, keep);
      console.log(`   비교용 자막 없는 원본: ${keep}`);
    }
    console.log(`\n✅ 샘플: ${outPath} (${totalSec.toFixed(1)}s)`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
}
