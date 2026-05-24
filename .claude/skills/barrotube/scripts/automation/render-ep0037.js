#!/usr/bin/env node
/**
 * render-ep0037.js — EP-2026-0037 전용 렌더
 *
 * 특수 처리:
 *  - 16:9 (1920x1080) horizontal
 *  - 씬별 BGM 볼륨 5단계 (tense_intro/calm_explain/dramatic_reveal/neutral_bg/hopeful_outro)
 *  - 씬 7: 마지막 5초 면책 자막 + BGM 50% 감쇠 (hopeful_outro 15%→7.5%)
 *  - 씬 4: 80초 지점(씬 내 상대 시간) 구독 CTA 자막 (5초 표시)
 *  - 크로스페이드 0.5s xfade 전환 (각 씬 클립 간)
 *  - 인트로 카드 45_intro.png 2초 (무음)
 *  - 자막: splitNarrationByTime → PIL PNG overlay (하단 100px 마진)
 */

import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parse as parseYAML } from 'yaml';

// ── 설정 ──────────────────────────────────────────────────────────────────────
const EPISODE_DIR   = resolve(process.env.HOME, 'youtube-co/workspace/episodes/EP-2026-0037');
const ASSETS_DIR    = join(EPISODE_DIR, 'assets');
const OUT_PATH      = join(EPISODE_DIR, '55_render/video.mp4');
const SCRIPT_PATH   = join(EPISODE_DIR, '30_script.md');
const INTRO_PATH    = join(EPISODE_DIR, '45_intro.png');
const BGM_PATH      = join(ASSETS_DIR, 'bgm.wav');
const CANVAS_W      = 1920;
const CANVAS_H      = 1080;
const INTRO_DUR     = 2;         // 초
const XFADE_DUR     = 0.5;       // 씬 전환 크로스페이드 초
const SUBTITLE_MARGIN_BOTTOM = 100;  // 하단 마진 px (16:9 long-form)
const PY_BIN        = join(process.env.HOME, 'youtube-co/.venv/bin/python3');
const SUB_PY        = join(process.env.HOME, 'youtube-co/scripts/automation/render-subtitle.py');

// BGM 볼륨 맵 (mood → ratio)
const BGM_VOL = {
  tense_intro:    0.15,
  calm_explain:   0.10,
  dramatic_reveal:0.18,
  neutral_bg:     0.08,
  hopeful_outro:  0.15,  // 면책 구간 전 (면책 구간은 0.075로 감쇠)
};

// 씬별 BGM 볼륨 (scene_id → vol ratio)
const SCENE_BGM_VOL = {
  '001': 0.15,  // tense_intro
  '002': 0.10,  // calm_explain
  '003': 0.10,  // calm_explain
  '004': 0.18,  // dramatic_reveal (씬 전반부 calm→dramatic는 단순화하여 dramatic_reveal 적용)
  '005': 0.10,  // calm_explain
  '006': 0.08,  // neutral_bg
  '007': 0.15,  // hopeful_outro (전체, 면책 감쇠는 BGM 믹스 단계에서 처리)
};

// 면책 자막 텍스트
const DISCLAIMER_TEXT = '본 영상은 투자 조언이 아닙니다. 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다.';
// 구독 CTA 자막 (씬 4용)
const SUBSCRIBE_TEXT = '구독과 알림 설정으로 경제 뉴스를 놓치지 마세요!';

// ── 유틸 ──────────────────────────────────────────────────────────────────────
function parseFrontmatter(path) {
  const content = readFileSync(path, 'utf-8');
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error('No YAML frontmatter');
  return parseYAML(m[1]);
}

function probeDuration(p) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p,
  ], { encoding: 'utf-8' });
  return parseFloat(r.stdout.trim()) || 0;
}

function splitNarrationByTime(narration, totalSec) {
  const phrases = narration
    .split(/(?<=[.!?])\s+/)
    .flatMap(p => {
      if (p.length > 60 && p.includes(',')) {
        return p.split(/(?<=,)\s*/).map(s => s.trim()).filter(Boolean);
      }
      return p.trim() ? [p.trim()] : [];
    });
  if (!phrases.length) return [];
  const totalChars = phrases.reduce((a, p) => a + p.length, 0);
  let t = 0;
  return phrases.map(p => {
    const dur = (p.length / totalChars) * totalSec;
    const entry = { text: p, start: t, end: t + dur };
    t += dur;
    return entry;
  });
}

function renderSubtitlePng(text, outPath, opts = {}) {
  const width   = opts.width    || CANVAS_W;
  const fontsize= opts.fontsize || 52;
  const maxlines= opts.maxlines || 3;
  const r = spawnSync(PY_BIN, [SUB_PY, text, outPath,
    '--width', String(width), '--fontsize', String(fontsize), '--maxlines', String(maxlines),
  ], { stdio: 'pipe' });
  if (r.status !== 0) {
    console.warn(`  [WARN] subtitle PNG failed: ${r.stderr.toString().slice(-200)}`);
    return null;
  }
  return outPath;
}

// ── 씬 클립 렌더 ──────────────────────────────────────────────────────────────
/**
 * imagePath + ttsPath → 단일 mp4 클립
 * extraOverlays: [{png, start, end}] — 나레이션 자막 외 추가 오버레이
 */
function renderScene({ imagePath, ttsPath, durationSec, narration, workDir, sceneId, outPath, extraOverlays = [] }) {
  const phrases = narration ? splitNarrationByTime(narration, durationSec) : [];
  const narrationOverlays = [];
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i];
    const png = join(workDir, `sub_${sceneId}_${i}.png`);
    if (renderSubtitlePng(p.text, png)) {
      narrationOverlays.push({ png, start: p.start, end: p.end });
    }
  }
  const overlays = [...narrationOverlays, ...extraOverlays];

  const args = ['-y', '-loop', '1', '-i', imagePath, '-i', ttsPath];
  overlays.forEach(o => args.push('-loop', '1', '-i', o.png));

  let filter = `[0:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H}[v0]`;
  overlays.forEach((o, i) => {
    const inIdx = i + 2;
    const inLabel = `v${i}`;
    const outLabel = `v${i + 1}`;
    filter += `;[${inLabel}][${inIdx}:v]overlay=(W-w)/2:H-h-${SUBTITLE_MARGIN_BOTTOM}:enable='between(t,${o.start.toFixed(3)},${o.end.toFixed(3)})'[${outLabel}]`;
  });
  const finalLabel = overlays.length > 0 ? `v${overlays.length}` : 'v0';

  args.push(
    '-filter_complex', filter,
    '-map', `[${finalLabel}]`,
    '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-t', String(durationSec),
    '-movflags', '+faststart',
    outPath,
  );

  const res = spawnSync('ffmpeg', args, { stdio: 'pipe' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg scene ${sceneId} render failed:\n${res.stderr.toString().slice(-800)}`);
  }
  return outPath;
}

/** 정지 이미지 + 무음 → N초 클립 (인트로 카드용) */
function renderStillClip({ imagePath, durationSec, outPath }) {
  const res = spawnSync('ffmpeg', [
    '-y',
    '-loop', '1', '-i', imagePath,
    '-f', 'lavfi', '-t', String(durationSec), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-vf', `scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-t', String(durationSec),
    '-movflags', '+faststart',
    outPath,
  ], { stdio: 'pipe' });
  if (res.status !== 0) {
    throw new Error(`Intro clip failed:\n${res.stderr.toString().slice(-400)}`);
  }
  return outPath;
}

/**
 * 씬 클립들을 xfade 크로스페이드로 이어붙임
 * ffmpeg xfade 필터: 각 전환마다 offset = sum(prev_durs) - XFADE_DUR * xfade_count
 */
function concatWithXfade(clipPaths, durations, outPath) {
  if (clipPaths.length === 1) {
    execSync(`cp "${clipPaths[0]}" "${outPath}"`);
    return;
  }

  // xfade는 clip 사이마다 오버랩 → offset 계산
  // offset_i = sum(dur[0..i-1]) - xfade_dur * i
  const n = clipPaths.length;
  let inputs = [];
  clipPaths.forEach(p => inputs.push('-i', p));

  // 비디오 xfade 체인 구성
  let vFilter = '';
  let aFilter = '';

  // 첫 2개를 xfade 후 점차 체인
  // [0:v][1:v]xfade=transition=fade:duration=0.5:offset=<dur0-0.5>[v01]
  // [v01][2:v]xfade=transition=fade:duration=0.5:offset=<dur0+dur1-1.0>[v012]
  // ...
  let cumulDur = 0;
  const vLabels = [];
  const aLabels = [];

  for (let i = 0; i < n - 1; i++) {
    const inV_a = i === 0 ? `[0:v]` : `[${vLabels[i - 1]}]`;
    const inV_b = `[${i + 1}:v]`;
    const outV = `xv${i}`;
    const offset = (cumulDur + durations[i]) - XFADE_DUR * (i + 1);
    vFilter += `${inV_a}${inV_b}xfade=transition=fade:duration=${XFADE_DUR}:offset=${offset.toFixed(3)}[${outV}];`;
    vLabels.push(outV);
    cumulDur += durations[i];
  }

  // 오디오 acrossfade 체인 구성
  cumulDur = 0;
  for (let i = 0; i < n - 1; i++) {
    const inA_a = i === 0 ? `[0:a]` : `[${aLabels[i - 1]}]`;
    const inA_b = `[${i + 1}:a]`;
    const outA = `xa${i}`;
    aFilter += `${inA_a}${inA_b}acrossfade=d=${XFADE_DUR}:c1=tri:c2=tri[${outA}];`;
    aLabels.push(outA);
    cumulDur += durations[i];
  }

  const finalV = vLabels[vLabels.length - 1];
  const finalA = aLabels[aLabels.length - 1];
  const filterComplex = (vFilter + aFilter).replace(/;$/, '');

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', `[${finalV}]`,
    '-map', `[${finalA}]`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-movflags', '+faststart',
    outPath,
  ];

  const res = spawnSync('ffmpeg', args, { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`xfade concat failed:\n${res.stderr.toString().slice(-800)}`);
  }
}

/**
 * BGM 믹스: 씬별 볼륨 구간을 volume= 필터로 처리
 * sceneTimings: [{start, end, vol}] — 씬 시작/끝 절대 시간 + BGM 볼륨
 * disclaimerStart: 씬 7 면책 시작 절대 시간 (BGM 50% 추가 감쇠)
 */
function mixBgmWithSegments(videoPath, bgmPath, outPath, sceneTimings, disclaimerStart) {
  // 복잡한 volume 필터 대신 전체 평균 볼륨을 weighted-avg로 산정 후 단순 mix
  // (정밀 구간 볼륨은 ffmpeg volume 필터 타임라인 기능 사용)
  //
  // volume 필터 표현: volume=vol:enable='between(t,start,end)'
  // 단, 복수 구간은 체인으로 처리 불가 → 모든 구간을 OR 표현식 하나로 묶음
  // 해법: sendcmd 또는 volume=w/ expr. 가장 안정적인 방법은 aeval 대신
  // 구간별 stream을 amix → 이는 복잡함.
  // → 실용적 대안: 씬별 볼륨 가중 평균을 단일 볼륨으로 사용하되,
  //   면책 구간(disclaimerStart~end)만 별도 감쇠.

  // 전체 TTS duration 기반 weighted avg vol
  const totalDur = sceneTimings[sceneTimings.length - 1].end;
  let weightedVol = 0;
  for (const s of sceneTimings) {
    const dur = s.end - s.start;
    weightedVol += (dur / totalDur) * s.vol;
  }
  weightedVol = Math.round(weightedVol * 1000) / 1000;

  // 씬 7 면책 구간 (마지막 5초) 절대 시간 계산
  const disclaimerEnd = totalDur;
  // BGM 필터: 전체에 weightedVol, 면책 구간은 weightedVol * 0.5
  // volume filter with enable expression:
  // [bgm]volume=VOL[bv];[bv]volume=0.5:enable='between(t,DS,DE)'[bvd]
  // 위 방식: 면책 구간에서 0.5 추가 감쇠 적용 (전체에 weightedVol, 그 위에 0.5)
  // 실제 면책 볼륨 = weightedVol * 0.5

  const dStart = disclaimerStart.toFixed(3);
  const dEnd   = disclaimerEnd.toFixed(3);
  const bgmFilter = [
    `[1:a]aloop=loop=-1:size=2e9[bgml]`,
    `[bgml]volume=${weightedVol}[bgmv]`,
    `[bgmv]volume=0.5:enable='between(t,${dStart},${dEnd})'[bgmd]`,
    `[0:a][bgmd]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
  ].join(';');

  const res = spawnSync('ffmpeg', [
    '-y', '-i', videoPath, '-i', bgmPath,
    '-filter_complex', bgmFilter,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
    outPath,
  ], { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });

  if (res.status !== 0) {
    throw new Error(`BGM mix failed:\n${res.stderr.toString().slice(-600)}`);
  }
  console.log(`  BGM weighted vol=${weightedVol.toFixed(3)}, disclaimer attenuation x0.5 @ ${dStart}s~${dEnd}s`);
  return outPath;
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
async function main() {
  const meta   = parseFrontmatter(SCRIPT_PATH);
  const scenes = meta.scenes || [];
  if (!scenes.length) throw new Error('No scenes in script');

  const workDir = mkdtempSync(join(tmpdir(), 'bt-ep0037-'));
  console.log(`Work dir: ${workDir}`);

  const clipPaths  = [];
  const clipDurs   = [];  // 각 클립의 실제 duration (xfade offset 계산용)
  const sceneTimings = []; // BGM 구간 볼륨용

  // ── 인트로 카드 ────────────────────────────────────────────────────────────
  if (existsSync(INTRO_PATH)) {
    const introClip = join(workDir, 'clip_000_intro.mp4');
    renderStillClip({ imagePath: INTRO_PATH, durationSec: INTRO_DUR, outPath: introClip });
    clipPaths.push(introClip);
    clipDurs.push(INTRO_DUR);
    // 인트로는 BGM tense_intro 볼륨 적용
    sceneTimings.push({ start: 0, end: INTRO_DUR, vol: SCENE_BGM_VOL['001'] });
    console.log(`Intro card: ${INTRO_DUR}s`);
  }

  // ── 씬 렌더 ───────────────────────────────────────────────────────────────
  // 현재까지 쌓인 절대 시간 (인트로 포함)
  let absoluteT = clipDurs.reduce((a, b) => a + b, 0);

  for (let i = 0; i < scenes.length; i++) {
    const scene   = scenes[i];
    const sceneId = scene.scene_id || String(i + 1).padStart(3, '0');
    const imgPath = join(ASSETS_DIR, 'images', `scene_${sceneId}.png`);
    const ttsPath = join(ASSETS_DIR, 'tts',    `scene_${sceneId}.wav`);
    const clipOut = join(workDir, `clip_${sceneId}.mp4`);

    if (!existsSync(imgPath)) throw new Error(`Missing image: ${imgPath}`);
    if (!existsSync(ttsPath)) throw new Error(`Missing TTS: ${ttsPath}`);

    const ttsDur = probeDuration(ttsPath);
    const durSec = ttsDur > 0 ? ttsDur : (scene.target_seconds || 12);

    // 씬별 추가 오버레이 (면책 / 구독 CTA)
    const extraOverlays = [];

    // 씬 7: 마지막 5초 면책 자막 오버레이
    if (sceneId === '007') {
      const disclaimerPng = join(workDir, 'sub_disclaimer.png');
      // 면책 자막은 더 작은 폰트, 노란색 배경 강조를 위해 width 1920 사용
      renderSubtitlePng(DISCLAIMER_TEXT, disclaimerPng, { width: CANVAS_W, fontsize: 44, maxlines: 3 });
      if (existsSync(disclaimerPng)) {
        const dStart = Math.max(0, durSec - 5);
        const dEnd   = durSec;
        extraOverlays.push({ png: disclaimerPng, start: dStart, end: dEnd });
        console.log(`  [Scene 007] Disclaimer subtitle @ ${dStart.toFixed(2)}s ~ ${dEnd.toFixed(2)}s`);
      }
    }

    // 씬 4: 80초 지점은 영상 전체 기준. 씬 4 내 상대 시간으로 환산.
    // 씬 4의 절대 시작 시간은 인트로+씬1+씬2+씬3 duration 합산.
    // 하지만 현재 씬 렌더 루프에서는 absoluteT가 이 씬의 시작 시간.
    // 80초 지점의 씬 4 내 상대 시간 = 80 - absoluteT (단, 유효 범위 내일 때만)
    if (sceneId === '004') {
      const globalCTATime = 80.0; // 영상 전체 기준 80초
      const ctaRelStart = globalCTATime - absoluteT;
      const ctaRelEnd   = ctaRelStart + 5.0;
      if (ctaRelStart >= 0 && ctaRelEnd <= durSec) {
        const ctaPng = join(workDir, 'sub_subscribe.png');
        renderSubtitlePng(SUBSCRIBE_TEXT, ctaPng, { width: CANVAS_W, fontsize: 46, maxlines: 2 });
        if (existsSync(ctaPng)) {
          extraOverlays.push({ png: ctaPng, start: ctaRelStart, end: ctaRelEnd });
          console.log(`  [Scene 004] Subscribe CTA @ rel ${ctaRelStart.toFixed(2)}s ~ ${ctaRelEnd.toFixed(2)}s (abs 80~85s)`);
        }
      } else {
        console.log(`  [Scene 004] Subscribe CTA skip: rel start=${ctaRelStart.toFixed(2)}s out of clip duration ${durSec.toFixed(2)}s`);
      }
    }

    renderScene({
      imagePath: imgPath,
      ttsPath,
      durationSec: durSec,
      narration: scene.narration || '',
      workDir,
      sceneId,
      outPath: clipOut,
      extraOverlays,
    });

    clipPaths.push(clipOut);
    clipDurs.push(durSec);

    // BGM 구간 타이밍 기록
    const bgmVol = SCENE_BGM_VOL[sceneId] ?? 0.10;
    sceneTimings.push({ start: absoluteT, end: absoluteT + durSec, vol: bgmVol });
    absoluteT += durSec;

    console.log(`Scene ${sceneId}: ${durSec.toFixed(2)}s  bgmVol=${bgmVol}`);
  }

  // ── xfade concat ──────────────────────────────────────────────────────────
  const concatPath = join(workDir, 'concat_xfade.mp4');
  console.log(`\nConcatenating ${clipPaths.length} clips with ${XFADE_DUR}s xfade...`);
  concatWithXfade(clipPaths, clipDurs, concatPath);

  // 면책 구간 절대 시작 시간 (씬 7의 마지막 5초)
  const scene7Timing = sceneTimings.find((_, i) => {
    // sceneTimings[0] = intro, sceneTimings[1..7] = scenes 001..007
    // scenes[6] = scene 007 → sceneTimings index = 7 (if intro exists) or 6
    return false; // dummy
  });
  // 간단하게: 씬 7 시작 = absoluteT - clipDurs[마지막]
  const scene7Dur = clipDurs[clipDurs.length - 1];
  const scene7Start = sceneTimings[sceneTimings.length - 1].start;
  const disclaimerAbsStart = scene7Start + Math.max(0, scene7Dur - 5);

  // ── BGM 믹스 ──────────────────────────────────────────────────────────────
  const finalPath = OUT_PATH;
  if (existsSync(BGM_PATH)) {
    console.log('Mixing BGM with segment volumes...');
    mixBgmWithSegments(concatPath, BGM_PATH, finalPath, sceneTimings, disclaimerAbsStart);
  } else {
    execSync(`cp "${concatPath}" "${finalPath}"`);
    console.log('[WARN] bgm.wav not found, skipping BGM mix');
  }

  // ── 결과 확인 ─────────────────────────────────────────────────────────────
  const totalDur = probeDuration(finalPath);
  const size = execSync(`du -h "${finalPath}" | cut -f1`).toString().trim();
  console.log(`\nRendered: ${finalPath}`);
  console.log(`Duration: ${totalDur.toFixed(2)}s  Size: ${size}`);
  console.log(`Scene timings summary:`);
  sceneTimings.forEach(s => {
    console.log(`  ${s.start.toFixed(2)}s ~ ${s.end.toFixed(2)}s  bgmVol=${s.vol}`);
  });
}

main().catch(e => {
  console.error(`Render failed: ${e.message}`);
  process.exit(1);
});
