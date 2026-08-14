#!/usr/bin/env node

/**
 * render-direct.js — ffmpeg 직접 렌더 (권장, CapCut 우회)
 *
 * 장점:
 *  - AppleScript/접근성 권한 불필요
 *  - 완전 자동화 (헤드리스)
 *  - 재현성 100%
 *  - CapCut은 인간 QA/편집 용도로만 사용
 *
 * 입력: 에피소드 디렉토리 (scenes + tts + bgm + script)
 * 출력: mp4 (1080x1920 9:16, H.264, 30fps, AAC)
 *
 * Usage:
 *   node render-direct.js --episode <episode_dir> --out <output.mp4>
 *
 * 에피소드 구조 기대:
 *   <episode_dir>/30_script.md              (YAML frontmatter 파싱)
 *   <episode_dir>/assets/images/scene_NNN.png
 *   <episode_dir>/assets/videos/scene_NNN.mp4  (필수 — --allow-stills일 때만 생략 가능)
 *   <episode_dir>/assets/tts/scene_NNN.wav
 *   <episode_dir>/assets/bgm.wav            (선택)
 */

import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parse as parseYAML } from 'yaml';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, '..', '..');

// 이모지·픽토그램(🚨📚✅ 등) 제거 — 자막 burn-in 표시 오류 방지 (2026-06-07)
// generate-tts.js stripEmoji 와 동일 규칙.
function stripEmoji(s) {
  return (s || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseFrontmatter(mdPath) {
  const content = readFileSync(mdPath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`No YAML frontmatter in ${mdPath}`);
  return parseYAML(match[1]);
}

function hasFfmpeg() {
  const r = spawnSync('which', ['ffmpeg']);
  return r.status === 0;
}

function probeDuration(mediaPath) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mediaPath], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) return 0;
  return parseFloat(r.stdout.trim()) || 0;
}

function probeHasAudio(mediaPath) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', mediaPath], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

// 모션 클립(media-render Grok) 자체 음성을 나레이션 밑에 앰비언트로 깔 때의 볼륨.
// 기존 BGM 믹스 단계는 그대로 유지 — 이 층은 씬 클립 렌더 시 TTS와 함께 amix된다.
// BT_CLIP_AMBIENT_VOLUME 로 조절, BT_NO_CLIP_AMBIENT=1 로 비활성 (2026-07-04 추가).
const CLIP_AMBIENT_VOLUME = parseFloat(process.env.BT_CLIP_AMBIENT_VOLUME || '0.25');
const CLIP_AMBIENT_DISABLED = /^(1|true|yes)$/i.test(process.env.BT_NO_CLIP_AMBIENT || '');

/**
 * Scene 단위로 이미지+TTS를 lossless-audio MOV 클립으로 렌더
 */
/**
 * 나레이션을 문장 단위로 분할 (., ?, !, 및 긴 쉼표 기준)
 * 각 phrase에 시간 배분 (char 비율)
 */
function splitNarrationByTime(narration, totalSec) {
  const phrases = stripEmoji(narration)
    .split(/(?<=[.!?])\s+/)
    .flatMap(p => {
      // 한 문장도 60자 넘으면 쉼표 기준 재분할
      if (p.length > 60 && p.includes(',')) {
        return p.split(/(?<=,)\s*/).map(s => s.trim()).filter(Boolean);
      }
      return p.trim() ? [p.trim()] : [];
    });

  if (phrases.length === 0) return [];
  const totalChars = phrases.reduce((a, p) => a + p.length, 0);
  let t = 0;
  return phrases.map(p => {
    const dur = (p.length / totalChars) * totalSec;
    const entry = { text: p, start: t, end: t + dur };
    t += dur;
    return entry;
  });
}

function renderSubtitlePng(text, outPath) {
  const pyBin = join(process.env.HOME, 'youtube-co/.venv/bin/python3');
  const script = join(process.env.HOME, 'youtube-co/scripts/automation/render-subtitle.py');
  if (!existsSync(pyBin) || !existsSync(script)) return null;
  const r = spawnSync(pyBin, [script, text, outPath], { stdio: 'pipe' });
  if (r.status !== 0) return null;
  return outPath;
}

// ── Karaoke 자막 (옵션, 채널별) ──────────────────────────────────────────
// config/subtitles.json 으로 켠다. mode=karaoke 면 문구를 단어 단위로 쪼개 TTS 시간에
// 맞춰 앞에서부터 강조색으로 칠하는 PNG를 여러 장 그려 오버레이한다 (이 ffmpeg 빌드는
// libass/drawtext 가 없어 텍스트는 전부 PNG). 해석 우선순위: env > channel > default.
// 채널로 고정하지 않고, config 에 채널을 추가하면 그 채널도 켜진다.
const KARAOKE_PY = existsSync(join(process.env.HOME, 'youtube-co/.venv/bin/python3'))
  ? join(process.env.HOME, 'youtube-co/.venv/bin/python3') : 'python3';
const KARAOKE_SCRIPT = join(SCRIPT_DIR, 'render-karaoke-png.py');

function resolveSubtitleStyle(channelId) {
  const DEFAULT = {
    mode: 'static', base_color: '#FFFFFF', highlight_color: '#FF9A1F',
    outline_color: '#081320', font_size: 60,
  };
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(SKILL_DIR, 'config', 'subtitles.json'), 'utf-8')); } catch { /* 없으면 static */ }
  const chan = (cfg.channels && channelId && cfg.channels[channelId]) || {};
  const style = { ...DEFAULT, ...(cfg.default || {}), ...chan };
  if (process.env.BT_SUBTITLE_MODE) style.mode = process.env.BT_SUBTITLE_MODE; // 테스트 override
  return style;
}

function renderKaraokePng(text, highlight, style, outPath, width) {
  const r = spawnSync(KARAOKE_PY, [KARAOKE_SCRIPT, text, outPath,
    '--highlight', String(highlight), '--width', String(width),
    '--fontsize', String(style.font_size || 60),
    '--base', style.base_color || '#FFFFFF',
    '--hl', style.highlight_color || '#FF9A1F',
    '--outline', style.outline_color || '#081320'], { stdio: 'pipe' });
  if (r.status !== 0) return null;
  return outPath;
}

// Ken Burns Zoom 설정 (2026-05-16, B2)
// 정적 PNG가 음성 길이만큼 정지하던 단조로움 → 5% 천천히 줌인
const KEN_BURNS_ENABLED = process.env.BT_DISABLE_KEN_BURNS !== '1';
const KEN_BURNS_ZOOM_MAX = 1.05;
const KEN_BURNS_FPS = 30;

function renderScene({ imagePath, videoPath = null, ttsPath, durationSec, narration, workDir, sceneId, outPath, canvasW = 1080, canvasH = 1920, subtitle = null }) {
  // 나레이션을 시간 기반 phrase로 분할 → 자막 PNG 여러 개 생성 → 시간 오버레이
  // mode=none 이면 자막을 굽지 않는다. 자막 층을 다른 방식(HyperFrames 알파 트랙 등)으로
  // 얹어 비교할 때 필요하다 — 안 그러면 두 겹이 된다.
  const noSubtitle = subtitle && subtitle.mode === 'none';
  const phrases = (narration && !noSubtitle) ? splitNarrationByTime(narration, durationSec) : [];
  const overlays = [];
  const karaoke = subtitle && subtitle.mode === 'karaoke';
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i];
    if (karaoke) {
      // 문구를 단어(공백 분리)로 쪼개 각 단어의 시간창을 잡고, 앞에서부터 k+1개 단어를
      // 강조색으로 칠한 PNG를 그 창에 오버레이 → TTS 싱크로 글자색이 순차로 바뀐다.
      // ponytail: 단어 시간은 글자수 비례 추정(기존 문구 자막과 동일 정밀도). 정확 싱크는
      // ElevenLabs with-timestamps 사이드카가 생기면 이 분배만 교체하면 된다.
      const words = p.text.split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      const chars = words.map(w => w.length);
      const totalC = chars.reduce((a, b) => a + b, 0) || 1;
      const span = p.end - p.start;
      let t = p.start;
      for (let k = 0; k < words.length; k++) {
        const wStart = t;
        const wEnd = (k === words.length - 1) ? p.end : t + (chars[k] / totalC) * span;
        t = wEnd;
        const png = join(workDir, `ka_${sceneId}_${i}_${k}.png`);
        if (renderKaraokePng(p.text, k + 1, subtitle, png, canvasW)) {
          overlays.push({ png, start: wStart, end: wEnd });
        }
      }
    } else {
      const png = join(workDir, `sub_${sceneId}_${i}.png`);
      if (renderSubtitlePng(p.text, png)) {
        overlays.push({ png, start: p.start, end: p.end });
      }
    }
  }

  // Grok 클립은 보통 10초 고정이다. 3배 이내면 한 번만 재생해 씬 길이에 맞추고,
  // 그보다 큰 차이거나 BT_CLIP_FIT_MODE=loop일 때만 반복한다.
  const clipFitMode = (process.env.BT_CLIP_FIT_MODE || 'speed').toLowerCase();
  const clipDuration = videoPath ? probeDuration(videoPath) : 0;
  const maxSpeedFactor = Number(process.env.BT_CLIP_MAX_SPEED_FACTOR) || 3;
  const retimeFactor = clipDuration > 0.1 ? durationSec / clipDuration : 0;
  const retimeClip = !!videoPath
    && clipFitMode === 'speed'
    && retimeFactor >= 1 / maxSpeedFactor
    && retimeFactor <= maxSpeedFactor;
  const args = videoPath
    ? (retimeClip
        ? ['-y', '-i', videoPath, '-i', ttsPath]
        : ['-y', '-stream_loop', '-1', '-i', videoPath, '-i', ttsPath])
    : ['-y', '-loop', '1', '-i', imagePath, '-i', ttsPath];
  overlays.forEach(o => args.push('-loop', '1', '-i', o.png));

  // Subtitle bottom margin — Shorts needs 480px for YouTube UI; Long-form only 100px
  // (heuristic: vertical canvas => Shorts, horizontal => Long-form)
  const isVertical = canvasH > canvasW;
  const subtitleBottomMargin = isVertical ? 480 : 100;

  let filter;
  if (videoPath) {
    // 모션 클립: 이미 움직임이 있으므로 Ken Burns 없이 캔버스 normalize만
    const setpts = retimeClip ? `${retimeFactor.toFixed(6)}*(PTS-STARTPTS)` : 'PTS-STARTPTS';
    filter = `[0:v]scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH},setpts=${setpts},fps=30[v0]`;
  } else if (KEN_BURNS_ENABLED) {
    // Ken Burns: 입력 110%로 scale 후 zoompan으로 1.0→1.05 점진 줌인 (씬 길이 전체)
    const scaledW = Math.floor(canvasW * 1.10);
    const scaledH = Math.floor(canvasH * 1.10);
    const totalFrames = Math.max(2, Math.round(durationSec * KEN_BURNS_FPS));
    const zoomDelta = (KEN_BURNS_ZOOM_MAX - 1.0).toFixed(4);
    filter = `[0:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,crop=${scaledW}:${scaledH},zoompan=z='min(1+${zoomDelta}*on/${totalFrames}\\,${KEN_BURNS_ZOOM_MAX})':d=${totalFrames}:s=${canvasW}x${canvasH}:fps=${KEN_BURNS_FPS}[v0]`;
  } else {
    filter = `[0:v]scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH}[v0]`;
  }
  overlays.forEach((o, i) => {
    const inIdx = i + 2; // 0=img, 1=audio, 2+=subs
    const inLabel = `v${i}`;
    const outLabel = `v${i + 1}`;
    filter += `;[${inLabel}][${inIdx}:v]overlay=(W-w)/2:H-h-${subtitleBottomMargin}:enable='between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})'[${outLabel}]`;
  });
  const finalLabel = overlays.length > 0 ? `v${overlays.length}` : 'v0';

  // 모션 클립 자체 음성(앰비언트)을 나레이션 밑에 낮은 볼륨으로 amix.
  // 클립에 오디오가 없거나 still 렌더면 기존과 동일하게 TTS만 (1:a).
  filter += `;[1:a]apad=pad_dur=${durationSec},atrim=duration=${durationSec},asetpts=PTS-STARTPTS,aresample=44100[voice]`;
  const withAmbient = !!videoPath && !retimeClip && !CLIP_AMBIENT_DISABLED && probeHasAudio(videoPath);
  let audioMap = '[voice]';
  if (withAmbient) {
    filter += `;[0:a]atrim=0:${durationSec},asetpts=PTS-STARTPTS,volume=${CLIP_AMBIENT_VOLUME},`
      + `afade=t=out:st=${Math.max(0, durationSec - 0.4).toFixed(3)}:d=0.4[amb]`
      + `;[voice][amb]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;
    audioMap = '[aout]';
  }

  args.push(
    '-filter_complex', filter,
    '-map', `[${finalLabel}]`,
    '-map', audioMap,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1',
    '-t', String(durationSec),
    outPath,
  );

  const res = spawnSync('ffmpeg', args, { stdio: 'pipe' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg scene render failed: ${res.stderr.toString().slice(-500)}`);
  }
  return outPath;
}

/**
 * 정지 이미지 + 무음 오디오로 N초짜리 클립 생성 (인트로 카드용)
 */
function renderStillClip({ imagePath, durationSec, canvasW, canvasH, outPath }) {
  const args = [
    '-y',
    '-loop', '1', '-i', imagePath,
    '-f', 'lavfi', '-t', String(durationSec), '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
    '-vf', `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1',
    '-t', String(durationSec),
    outPath,
  ];
  const res = spawnSync('ffmpeg', args, { stdio: 'pipe' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg intro clip render failed: ${res.stderr.toString().slice(-500)}`);
  }
  return outPath;
}

/**
 * 마지막 씬 클립의 끝 프레임을 freeze로 N초 연장 + 오디오 페이드아웃.
 * Outro 패딩으로 abrupt cut 방지 (Scene 005 TTS 끝과 영상 끝이 동시일 때
 * 운영자가 "잘리는 느낌"을 보고함 — 2026-05-14 EP-2026-0050).
 *
 * lastClipPath의 비디오는 stop_mode=clone(마지막 프레임 freeze)로 stop_duration 만큼 연장.
 * 오디오는 apad로 무음 추가 + afade로 부드러운 페이드아웃.
 */
function renderOutroPad({ lastClipPath, durationSec, fadeDurationSec, outPath }) {
  const baseDur = probeDuration(lastClipPath);
  if (baseDur <= 0) {
    throw new Error(`renderOutroPad: cannot probe duration of ${lastClipPath}`);
  }
  const fadeStart = Math.max(0, baseDur - 0.2);   // 마지막 0.2s 전부터 페이드 시작
  const fadeDur = Math.max(0.5, fadeDurationSec); // 최소 0.5s
  const totalDur = baseDur + durationSec;
  const args = [
    '-y',
    '-i', lastClipPath,
    '-vf', `tpad=stop_mode=clone:stop_duration=${durationSec},fps=30`,
    '-af', `apad=pad_dur=${durationSec},afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeDur.toFixed(3)}`,
    '-t', totalDur.toFixed(3),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1',
    outPath,
  ];
  const res = spawnSync('ffmpeg', args, { stdio: 'pipe' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg outro pad failed: ${res.stderr.toString().slice(-500)}`);
  }
  return outPath;
}

/**
 * Outro slot clip — 마지막 씬 이미지 freeze + outro TTS + fadeout.
 * 2026-05-15 추가: Writer가 별도 outro TTS slot (scene_006_outro.wav 등)을 만든 경우
 * 본 영상 마지막에 prepend되는 CTA 클립.
 *
 * - 비디오: imagePath를 durationSec 동안 freeze (canvas에 맞춰 scale+crop)
 * - 오디오: ttsPath + apad to durationSec + 끝 0.3s fadeout
 */
function renderOutroSlotClip({ imagePath, ttsPath, durationSec, canvasW, canvasH, outPath }) {
  const fadeStart = Math.max(0, durationSec - 0.3);
  const args = [
    '-y',
    '-loop', '1', '-i', imagePath,
    '-i', ttsPath,
    '-filter_complex',
    `[0:v]scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH},setsar=1,format=yuv420p[v];` +
    `[1:a]apad=pad_dur=${durationSec},atrim=duration=${durationSec.toFixed(3)},afade=t=in:st=0:d=0.1,afade=t=out:st=${fadeStart.toFixed(3)}:d=0.3,aresample=44100[a]`,
    '-map', '[v]', '-map', '[a]',
    '-t', durationSec.toFixed(3),
    '-r', '30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
    '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1',
    outPath,
  ];
  const res = spawnSync('ffmpeg', args, { stdio: 'pipe' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg outro slot clip failed: ${res.stderr.toString().slice(-500)}`);
  }
  return outPath;
}

/**
 * 모든 씬 클립 concat
 */
function concatScenes(clipPaths, outPath) {
  const workDir = mkdtempSync(join(tmpdir(), 'bt-concat-'));
  const listFile = join(workDir, 'list.txt');
  writeFileSync(listFile, clipPaths.map(p => `file '${p}'`).join('\n'));

  const res = spawnSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', outPath,
  ], { stdio: 'pipe' });

  if (res.status !== 0) {
    throw new Error(`ffmpeg concat failed: ${res.stderr.toString().slice(-500)}`);
  }
  return outPath;
}

/**
 * BGM 믹스 — voice ducking 적용 (2026-05-16, 잔잔 갱신)
 *
 * 운영자 피드백(EP-0050 v2-demo, 5/16): 컨텐츠 구간 BGM이 너무 커서 나레이션 집중을 방해.
 * 조치:
 *   - baseline 0.30 → 0.12 (~-18dB)로 낮춤 — 무음 구간도 잔잔
 *   - sidechain threshold 0.05 → 0.03, ratio 10 → 14 (음성 구간 더 강한 감쇠)
 *   - 결과: 무음 ~-18dB, 음성 ~-30dB (나레이션 우선)
 *
 * BT_BGM_VOLUME=0.20 env var로 baseline override 가능.
 */
function mixBgm(videoPath, bgmPath, outPath, bgmVolume = null) {
  const baselineVolume = bgmVolume ?? (Number(process.env.BT_BGM_VOLUME) || 0.12);
  const filter = [
    // 1) BGM 볼륨 + 무한 루프 (영상 길이만큼 자동 채워짐)
    `[1:a]volume=${baselineVolume},aloop=loop=-1:size=2e9[bgm_loop]`,
    // 2) Voice를 sidechain으로 사용해 BGM 자동 감쇠
    //    threshold 0.03 (낮은 임계), ratio 14 (강한 압축), attack 20ms, release 400ms
    //    voice 구간에서 BGM 추가 약 -12dB 감쇠. 무음 구간엔 baseline 유지.
    `[bgm_loop][0:a]sidechaincompress=threshold=0.03:ratio=14:attack=20:release=400:makeup=1:mix=1[bgm_ducked]`,
    // 3) Voice + ducked BGM 합성. normalize=0으로 voice 레벨 보존
    `[0:a][bgm_ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,aformat=sample_rates=44100:channel_layouts=mono,alimiter=limit=0.841395:level=false[aout]`,
  ].join(';');

  const res = spawnSync('ffmpeg', [
    '-y', '-i', videoPath, '-i', bgmPath,
    '-filter_complex', filter,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '1',
    '-shortest',
    '-movflags', '+faststart',
    outPath,
  ], { stdio: 'pipe' });

  if (res.status !== 0) {
    throw new Error(`ffmpeg bgm mix failed: ${res.stderr.toString().slice(-500)}`);
  }
  return outPath;
}

function encodeFinal(videoPath, outPath) {
  const res = spawnSync('ffmpeg', [
    '-y', '-i', videoPath,
    '-map', '0:v', '-map', '0:a',
    '-af', 'alimiter=limit=0.841395:level=false',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '1',
    '-movflags', '+faststart',
    outPath,
  ], { stdio: 'pipe' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg final encode failed: ${res.stderr.toString().slice(-500)}`);
  }
  return outPath;
}

/**
 * 페르소나·format 기반 BGM 카테고리 자동 선택 (2026-05-16)
 * 우선순위:
 *   1) episode `assets/bgm.wav` (EP별 운영자 커스텀) — 최우선, 호환
 *   2) global `assets/bgm/{analysis,alert,recap,intro}.mp3` (페르소나·brief 기반)
 *   3) null (BGM 없음)
 */
function resolveBgmPath(epAssetsDir, scriptFm) {
  // 1) EP별 커스텀
  const epBgmWav = join(epAssetsDir, 'bgm.wav');
  if (existsSync(epBgmWav)) return { path: epBgmWav, source: 'episode-custom' };
  const epBgmMp3 = join(epAssetsDir, 'bgm.mp3');
  if (existsSync(epBgmMp3)) return { path: epBgmMp3, source: 'episode-custom' };

  // 2) 페르소나 → 카테고리
  const persona = scriptFm?.persona || 'barro-teacher';
  let category;
  if (persona === 'barro-alert') category = 'alert';
  else if (persona === 'barro-recap') category = 'recap';
  else category = 'analysis';

  const globalBgm = join(SKILL_DIR, 'assets', 'bgm', `${category}.mp3`);
  if (existsSync(globalBgm)) return { path: globalBgm, source: `global-${category}` };

  return null;
}

export function renderDirect({ episodeDir, outPath, canvas, platform: platformHint, allowStills = false }) {
  // v2 (platforms/{long|shorts}/) 우선 → v1 legacy (episodeDir 직접) fallback.
  // platformHint가 있으면 해당 플랫폼만 시도, 없으면 long → shorts → legacy 순으로 탐색.
  const candidates = platformHint
    ? [join(episodeDir, 'platforms', platformHint, '30_script.md')]
    : [
        join(episodeDir, 'platforms', 'long', '30_script.md'),
        join(episodeDir, 'platforms', 'shorts', '30_script.md'),
        join(episodeDir, '30_script.md'),
      ];
  const scriptPath = candidates.find(p => existsSync(p));
  if (!scriptPath) throw new Error(`Missing 30_script.md (tried: ${candidates.join(', ')})`);
  const baseDir = dirname(scriptPath);  // platforms/{long|shorts}/ or episodeDir 자체
  const usingV2 = baseDir !== episodeDir;

  const meta = parseFrontmatter(scriptPath);
  const scenes = meta.scenes || [];
  if (!scenes.length) throw new Error('No scenes in script');

  // Assets directory: 40_assets (v1.1+ 표준) — v1과 v2 모두 base 안에
  let assetsDir = join(baseDir, '40_assets');
  if (!existsSync(assetsDir)) assetsDir = join(baseDir, 'assets');
  if (!existsSync(assetsDir)) throw new Error(`Missing assets dir under ${baseDir}`);

  const missingMotion = scenes
    .map((scene, i) => scene.scene_id || String(i + 1).padStart(3, '0'))
    .filter(sceneId => !existsSync(join(assetsDir, 'videos', `scene_${sceneId}.mp4`)));
  if (missingMotion.length && !allowStills) {
    const error = new Error([
      `Grok 모션 클립 누락 (${missingMotion.length}/${scenes.length} 씬): ${missingMotion.join(', ')}`,
      `barrotube-media-render로 ${join(assetsDir, 'videos')}/scene_NNN.mp4 를 먼저 만드세요.`,
      '(비권장) 정지 이미지 렌더는 --allow-stills 로 허용할 수 있습니다.',
    ].join('\n'));
    error.code = 3;
    error.exitCode = 3;
    throw error;
  }

  if (!hasFfmpeg()) {
    throw new Error('ffmpeg not found. Install: brew install ffmpeg');
  }

  // Canvas: explicit arg > format-based default
  const format = meta.format || 'shorts';
  const defaultCanvas = format === 'long-3min' ? 'horizontal' : 'vertical';
  const chosenCanvas = canvas || defaultCanvas;
  const canvasDim = chosenCanvas === 'vertical' ? [1080, 1920] : [1920, 1080];

  console.log(`📐 Format: ${format} → canvas=${chosenCanvas} (${canvasDim.join('x')}), layout=${usingV2 ? 'v2' : 'v1'}, base=${baseDir.replace(episodeDir + '/', '') || '.'}`);
  const workDir = mkdtempSync(join(tmpdir(), 'bt-render-'));
  const clipPaths = [];

  // Optional: prepend a silent intro card. 45_intro.png 우선, 없으면 47_thumbnail.png.
  // Shorts는 YouTube에서 커스텀 썸네일을 지정할 수 없으므로, 썸네일을 영상 앞에 몇 초
  // 노출해 같은 역할(첫 인상·후킹)을 하게 한다. 길이는 BT_INTRO_SEC로 조절 (기본 2초).
  const introCandidates = [
    join(baseDir, '45_intro.png'),
    join(baseDir, '47_thumbnail.png'),
  ];
  const introPath = introCandidates.find(p => existsSync(p));
  const INTRO_DURATION_SEC = Number(process.env.BT_INTRO_SEC) || 2;
  if (introPath) {
    const introClipPath = join(workDir, 'clip_000_intro.mov');
    renderStillClip({
      imagePath: introPath,
      durationSec: INTRO_DURATION_SEC,
      canvasW: canvasDim[0],
      canvasH: canvasDim[1],
      outPath: introClipPath,
    });
    clipPaths.push(introClipPath);
    console.log(`🎬 Intro card prepended (${INTRO_DURATION_SEC}s silent, from ${introPath.split('/').pop()})`);
  }

  // 자막 모드 해석 (채널별 옵션). config/subtitles.json 없거나 채널 미등록이면 static(무변화).
  const subtitleStyle = resolveSubtitleStyle(meta.channel_id);
  if (subtitleStyle.mode === 'karaoke') {
    console.log(`💬 Subtitle: karaoke (channel=${meta.channel_id || '?'}, base=${subtitleStyle.base_color} → hl=${subtitleStyle.highlight_color})`);
  }

  console.log(`🎬 Rendering ${scenes.length} scenes at ${canvasDim.join('x')}...`);

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const sceneId = scene.scene_id || String(i + 1).padStart(3, '0');
    const imagePath = join(assetsDir, 'images', `scene_${sceneId}.png`);
    const videoPath = join(assetsDir, 'videos', `scene_${sceneId}.mp4`);
    const hasMotion = existsSync(videoPath);
    const ttsPath = join(assetsDir, 'tts', `scene_${sceneId}.wav`);
    const clipPath = join(workDir, `clip_${sceneId}.mov`);

    if (!hasMotion && !existsSync(imagePath)) throw new Error(`Missing image: ${imagePath} (and no motion clip ${videoPath})`);
    if (!existsSync(ttsPath)) throw new Error(`Missing tts: ${ttsPath}`);

    const ttsDur = probeDuration(ttsPath);
    const targetDur = Number(scene.target_seconds) || 0;
    const durationSec = Math.max(ttsDur, targetDur) || 12;
    const targetNote = scene.target_seconds ? ` (script target ${scene.target_seconds}s)` : '';

    renderScene({
      imagePath,
      videoPath: hasMotion ? videoPath : null,
      ttsPath,
      durationSec,
      // TTS는 narration(한글 수사), 화면 자막은 subtitle_text(숫자 표기)를 사용한다.
      narration: scene.subtitle_text || scene.narration || '',
      workDir,
      sceneId,
      outPath: clipPath,
      canvasW: canvasDim[0],
      canvasH: canvasDim[1],
      subtitle: subtitleStyle,
    });

    clipPaths.push(clipPath);
    console.log(`  ✅ Scene ${sceneId} (${durationSec.toFixed(2)}s, TTS ${ttsDur.toFixed(2)}s${targetNote}${hasMotion ? ', motion clip' : ''})`);
  }

  // Outro pad: 마지막 씬 끝에 freeze + audio fadeout (abrupt cut 방지)
  // 2026-05-14 EP-2026-0050 운영자 "마지막이 잘리는 느낌" 보고 후 추가.
  // TTS 실제 길이 기반으로 clip을 잘라내므로 outro 여백이 0초가 되어 발생한 문제.
  //
  // 2026-05-15 개선: 별도 outro TTS slot (scene_006_outro.wav 등) 존재 시
  // 별도 outro 클립을 마지막에 concat. 이 경우 freeze는 0.3s로 단축(전환 부드럽게)
  // outro slot 없으면 기존 1.0s freeze + 0.8s fade 동작 유지.
  const outroTtsCandidates = [
    join(assetsDir, 'tts', 'scene_006_outro.wav'),
    join(assetsDir, 'tts', 'outro.wav'),
  ];
  const outroTtsPath = outroTtsCandidates.find(p => existsSync(p));
  const hasOutroSlot = !!outroTtsPath;

  const OUTRO_PAD_SEC = hasOutroSlot ? 0.3 : 1.0;
  const OUTRO_FADE_SEC = hasOutroSlot ? 0.2 : 0.8;
  if (clipPaths.length > 0 && OUTRO_PAD_SEC > 0) {
    const lastIdx = clipPaths.length - 1;
    const lastClipPath = clipPaths[lastIdx];
    const paddedPath = join(workDir, 'clip_outro_padded.mov');
    renderOutroPad({
      lastClipPath,
      durationSec: OUTRO_PAD_SEC,
      fadeDurationSec: OUTRO_FADE_SEC,
      outPath: paddedPath,
    });
    clipPaths[lastIdx] = paddedPath;
    console.log(`🎬 Outro pad appended (+${OUTRO_PAD_SEC}s freeze, ${OUTRO_FADE_SEC}s audio fade${hasOutroSlot ? ' — short variant (outro slot detected)' : ''})`);
  }

  // 별도 outro 클립 prepend (outro TTS slot 사용 시)
  // 마지막 씬 이미지를 freeze로 사용해 outro TTS 길이만큼 추가 클립 생성 후 concat.
  if (hasOutroSlot) {
    const lastScene = scenes[scenes.length - 1];
    const lastSceneId = lastScene.scene_id || String(scenes.length).padStart(3, '0');
    const outroImagePath = join(assetsDir, 'images', `scene_${lastSceneId}.png`);
    const outroClipPath = join(workDir, 'clip_zzz_outro.mov');
    const outroTtsDur = probeDuration(outroTtsPath);
    // outro 클립은 TTS + 0.3s tail silence + 0.3s fade
    const outroClipDur = Math.min(6.0, outroTtsDur + 0.3); // 6s 상한 (shorts 60s 보호)
    renderOutroSlotClip({
      imagePath: outroImagePath,
      ttsPath: outroTtsPath,
      durationSec: outroClipDur,
      canvasW: canvasDim[0],
      canvasH: canvasDim[1],
      outPath: outroClipPath,
    });
    clipPaths.push(outroClipPath);
    console.log(`🎬 Outro slot clip appended (${outroClipDur.toFixed(2)}s, TTS=${outroTtsDur.toFixed(2)}s) from ${outroTtsPath.split('/').slice(-1)[0]}`);
  }

  // Outro/Endcard: 브라우저 생성 48_outro.png를 우선하고, 없으면 로컬 48_endcard.png를 사용한다.
  // 자산이 없으면 무동작(기존 에피소드 안전).
  // BGM은 concat 후 전체에 믹스되므로 엔드카드 구간에도 음악이 자연스럽게 이어진다.
  const endcardPath = [
    join(baseDir, '48_outro.png'),
    join(baseDir, '48_endcard.png'),
  ].find(p => existsSync(p));
  if (existsSync(endcardPath)) {
    // BT_ENDCARD_SEC로 조절 가능 (Shorts 60초 정합 등 미세 조정용).
    const endcardDurationSec = Number(process.env.BT_ENDCARD_SEC)
      || (chosenCanvas === 'vertical' ? 2.5 : 3.5);
    const endcardClipPath = join(workDir, 'clip_zzzz_endcard.mov');
    renderStillClip({
      imagePath: endcardPath,
      durationSec: endcardDurationSec,
      canvasW: canvasDim[0],
      canvasH: canvasDim[1],
      outPath: endcardClipPath,
    });
    clipPaths.push(endcardClipPath);
    console.log(`🎬 Outro/Endcard appended (+${endcardDurationSec}s, from ${endcardPath.split('/').pop()})`);
  }

  // Concat
  const concatPath = join(workDir, 'concat.mov');
  console.log('🔗 Concatenating scenes...');
  concatScenes(clipPaths, concatPath);

  // BGM mix (optional, 2026-05-16: 자동 카테고리 선택 + voice ducking)
  const bgmResolved = resolveBgmPath(assetsDir, meta);
  if (bgmResolved) {
    console.log(`🎵 Mixing BGM (${bgmResolved.source}, voice-ducked)...`);
    mixBgm(concatPath, bgmResolved.path, outPath);
  } else {
    encodeFinal(concatPath, outPath);
  }

  const stats = execSync(`du -h "${outPath}" | cut -f1`).toString().trim();
  console.log(`\n✅ Rendered: ${outPath} (${stats})`);
  return outPath;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opts = {};
  // Robust flag parser: only treat tokens starting with `--` as flag names.
  // Previous pair-based parser would silently mis-pair if any flag value
  // was missing, producing nonsense file names like `  .mp4` for `--out`.
  // 2026-05-14 EP-2026-0050: video.mp4 was written as ` .mp4` (leading spaces).
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!tok.startsWith('--')) continue;
    const name = tok.replace(/^--/, '');
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[name] = true;
    } else {
      opts[name] = next;
      i++;
    }
  }

  if (!opts.episode || !opts.out) {
    console.error('Usage: render-direct.js --episode <dir> --out <path.mp4> [--canvas vertical|horizontal] [--allow-stills]');
    console.error('  (canvas auto-inferred from script frontmatter.format if omitted)');
    console.error('  --allow-stills: 모션 클립 없이 정지 이미지 렌더 허용 (비권장)');
    process.exit(1);
  }

  // Guard: --out must end in .mp4 and have a non-whitespace basename.
  // (2026-05-14 EP-2026-0050: render produced ` .mp4` because of broken pair parser.)
  const outResolved = resolve(opts.out);
  const outBase = outResolved.split('/').pop() || '';
  if (!outBase.endsWith('.mp4') || outBase.replace(/\.mp4$/, '').trim() === '') {
    console.error(`❌ Invalid --out filename: "${outBase}" (resolved="${outResolved}"). Must be non-empty *.mp4.`);
    process.exit(1);
  }

  try {
    renderDirect({
      episodeDir: resolve(opts.episode),
      outPath: resolve(opts.out),
      canvas: opts.canvas,
      platform: opts.platform,
      allowStills: Boolean(opts['allow-stills']),
    });
  } catch (e) {
    console.error(`❌ Render failed: ${e.message}`);
    process.exit(e.exitCode || 1);
  }
}
