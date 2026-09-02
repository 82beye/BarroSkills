/**
 * motion-retry.js — 모션 클립 "생성 → 프레임 QA → 실패 시 시드 바꿔 재생성" 루프.
 *
 * 엔진에 독립적이다. LTX·Wan 이 같은 게이트를 쓰게 하려고 뺐다 — 복사본이 둘이면
 * QA 게이트가 한쪽에서만 고쳐져 조용히 갈라진다.
 *
 * 시드를 바꾸는 게 핵심이다. 같은 시드로 프롬프트만 손보면 같은 붕괴가 재현된다.
 * 검사 불가(QA exit 2: 얼굴 ROI 미검출·비전 판정기 부재)는 재시도하지 않는다 —
 * 같은 이유로 계속 실패하며 GPU 쿼터만 태운다.
 *
 * 엔진 어댑터 규약:
 *   { name, generateClip({imageBuffer,prompt,seed,duration}), downloadClip(url),
 *     withRepairHint(prompt,hint), DEFAULT_PROMPT, clampDuration?(sec) }
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const QA_SCRIPT = join(resolve(import.meta.dirname, '..'), 'qa-motion-frames.js');

/** QA 실행. { code, report } — 0 pass · 1 fail · 2 검사 불가. */
export function runQa(video, reference, sheet) {
  const args = [QA_SCRIPT, '--video', video, '--reference', reference];
  if (sheet) args.push('--sheet', sheet);
  const r = spawnSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  const p = `${video.replace(/\.mp4$/i, '')}.qa.json`;
  let report = null;
  if (existsSync(p)) { try { report = JSON.parse(readFileSync(p, 'utf-8')); } catch { /* 무시 */ } }
  return { code: r.status ?? 2, report };
}

/**
 * 씬 하나를 QA 통과까지 굽는다.
 * 반환 { pass, defects, attemptsUsed, reason } — reason 이 'uninspectable' 이면 재시도 무의미.
 */
export async function produceScene({
  engine, image, out, attempts = 3, duration = 8, seed = 1000,
  basePrompt = null, skipQa = false, sheetDir = null, extra = {},
}) {
  const buf = readFileSync(image);
  const prompt0 = basePrompt || engine.DEFAULT_PROMPT;
  let hint = '';
  let best = null;
  let used = 0;

  for (let i = 1; i <= attempts; i++) {
    used = i;
    const s = seed + i * 7919;   // 시드를 확실히 벌린다
    const prompt = engine.withRepairHint(prompt0, hint);
    console.log(`  ▶ 시도 ${i}/${attempts} — ${engine.name} seed=${s}${hint ? ' (결함 힌트 반영)' : ''}`);

    let clip;
    try {
      const { url } = await engine.generateClip({ imageBuffer: buf, prompt, seed: s, duration, ...extra });
      clip = await engine.downloadClip(url);
    } catch (e) {
      console.error(`    ⚠️ 생성 실패: ${e.message}`);
      // 쿼터 소진은 재시도해도 같은 결과다 — 남은 시도를 태우지 않는다.
      if (/쿼터|quota/i.test(e.message)) {
        return { pass: false, defects: Infinity, attemptsUsed: used, reason: 'quota_exhausted' };
      }
      continue;
    }
    const candidate = `${out.replace(/\.mp4$/i, '')}.try${i}.mp4`;
    mkdirSync(dirname(resolve(candidate)), { recursive: true });
    writeFileSync(candidate, clip);
    console.log(`    ✓ 생성 (${(clip.length / 1024 / 1024).toFixed(1)}MB)`);

    if (skipQa) { best = { path: candidate, defects: 0, pass: true }; break; }

    const sheet = sheetDir ? join(sheetDir, `${basename(candidate, '.mp4')}.defects.png`) : null;
    const { code, report } = runQa(candidate, image, sheet);
    if (code === 2) {
      console.error(`    ⛔ 검사 불가 (${report?.reason ?? 'unknown'}) — 재시도해도 같은 이유로 실패한다`);
      best = best ?? { path: candidate, defects: Infinity, pass: false };
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

/**
 * 에피소드 디렉토리 규약 — generate-motion.js·grok-motion.js 와 같다.
 * <episode_dir>/platforms/<platform>/40_assets/{images,videos}/scene_NNN.*
 * media-render 경로는 이미 platforms/<p> 까지 내려온 디렉토리를 넘기므로 둘 다 받는다.
 */
export function assetDirs(episodeDir, platform = 'shorts') {
  const base = existsSync(join(episodeDir, '40_assets'))
    ? join(episodeDir, '40_assets')
    : join(episodeDir, 'platforms', platform, '40_assets');
  return { images: join(base, 'images'), videos: join(base, 'videos') };
}

/** images/scene_NNN.png 를 정렬해 돌려준다. */
export function listScenes(imagesDir) {
  if (!existsSync(imagesDir)) return [];
  return readdirSync(imagesDir)
    .map((f) => f.match(/^scene_(\d{3})\.png$/)?.[1])
    .filter(Boolean).sort();
}

/**
 * 씬의 TTS 길이(초). 클립 길이를 여기에 맞추면 렌더 리타임이 1.0 에 가까워진다 —
 * 씬 6.6~11.5초를 4초 클립으로 채우면 1.6~2.8배 슬로모션이 된다(2026-09-02 실측).
 * TTS 가 없으면 null — 호출부가 기본 길이를 쓴다.
 */
export function sceneDuration(episodeDir, platform, sceneId) {
  const base = existsSync(join(episodeDir, '40_assets'))
    ? join(episodeDir, '40_assets')
    : join(episodeDir, 'platforms', platform, '40_assets');
  for (const ext of ['wav', 'mp3']) {
    const p = join(base, 'tts', `scene_${sceneId}.${ext}`);
    if (!existsSync(p)) continue;
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], { encoding: 'utf8' });
    const d = Number(String(r.stdout).trim());
    if (Number.isFinite(d) && d > 0) return d;
  }
  return null;
}

/** 클립을 무엇으로 구웠는지 남긴다 — QA 보고서와 auto-pipeline 의 폴백 감지가 읽는다. */
export function recordManifest(videosDir, manifestName, sceneId, entry) {
  const path = join(videosDir, manifestName);
  let m = {};
  if (existsSync(path)) { try { m = JSON.parse(readFileSync(path, 'utf-8')); } catch { m = {}; } }
  m[sceneId] = entry;
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
}

/** 16fps 원본 → 24fps·720p 후처리 (Wan 전용. LTX 는 이미 24fps·1024폭이라 불필요). */
export function post720p(input, output) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', input,
    '-vf', 'minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:vsbmc=1,scale=720:-2:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', output],
  { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`후처리 실패: ${r.stderr?.slice(0, 200)}`);
}
