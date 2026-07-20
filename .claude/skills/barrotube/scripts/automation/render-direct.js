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
 *   <episode_dir>/assets/videos/scene_NNN.mp4  (선택 — media-render Grok 모션 클립,
 *                                               있으면 정지 이미지 대신 사용)
 *   <episode_dir>/assets/tts/scene_NNN.wav
 *   <episode_dir>/assets/bgm.wav            (선택)
 */

import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parse as parseYAML } from 'yaml';

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
 * Scene 단위로 이미지+TTS를 mp4 클립으로 렌더
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

// Ken Burns Zoom 설정 (2026-05-16, B2)
// 정적 PNG가 음성 길이만큼 정지하던 단조로움 → 5% 천천히 줌인
const KEN_BURNS_ENABLED = process.env.BT_DISABLE_KEN_BURNS !== '1';
const KEN_BURNS_ZOOM_MAX = 1.05;
const KEN_BURNS_FPS = 30;

function renderScene({ imagePath, videoPath = null, ttsPath, durationSec, narration, workDir, sceneId, outPath, canvasW = 1080, canvasH = 1920 }) {
  // 나레이션을 시간 기반 phrase로 분할 → 자막 PNG 여러 개 생성 → 시간 오버레이
  const phrases = narration ? splitNarrationByTime(narration, durationSec) : [];
  const overlays = [];
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i];
    const png = join(workDir, `sub_${sceneId}_${i}.png`);
    if (renderSubtitlePng(p.text, png)) {
      overlays.push({ png, start: p.start, end: p.end });
    }
  }

  // 입력 0 = 씬 소스. 모션 클립(Grok)은 보통 10초 고정이라 TTS 길이와 다르다.
  // 예전: -stream_loop -1 로 클립을 반복 재생해 프레임을 채움 → 같은 영상이 반복되어 보임.
  // 개선: setpts 리타임으로 클립을 "한 번만" 재생하되 재생속도를 조절해 씬(TTS) 길이에 정확히
  //   맞춘다 — 씬보다 짧으면 늘려서(slow) 채우고, 길면 압축(fast). 반복 없이 프레임을 채운다.
  //   극단 배율(기본 >3x 또는 <1/3x)은 부자연스러워 루프로 폴백. BT_CLIP_FIT_MODE=loop 로 예전
  //   반복 동작 복구, BT_CLIP_MAX_SPEED_FACTOR 로 폴백 임계 조정.
  const CLIP_FIT_MODE = (process.env.BT_CLIP_FIT_MODE || 'speed').toLowerCase();
  const clipDur = videoPath ? probeDuration(videoPath) : 0;
  const MAX_SPEED_FACTOR = Number(process.env.BT_CLIP_MAX_SPEED_FACTOR) || 3.0;
  let speedFactor = 1;       // 비디오 PTS 배율 (>1 느리게 늘림, <1 빠르게 압축)
  let retimeClip = false;
  if (videoPath && CLIP_FIT_MODE === 'speed' && clipDur > 0.1) {
    speedFactor = durationSec / clipDur;
    retimeClip = speedFactor <= MAX_SPEED_FACTOR && speedFactor >= 1 / MAX_SPEED_FACTOR;
  }

  const args = videoPath
    ? (retimeClip
        ? ['-y', '-i', videoPath, '-i', ttsPath]                         // 단일 재생 + setpts 리타임
        : ['-y', '-stream_loop', '-1', '-i', videoPath, '-i', ttsPath])  // 폴백: 반복 재생
    : ['-y', '-loop', '1', '-i', imagePath, '-i', ttsPath];
  overlays.forEach(o => args.push('-loop', '1', '-i', o.png));

  // Subtitle bottom margin — Shorts needs 480px for YouTube UI; Long-form only 100px
  // (heuristic: vertical canvas => Shorts, horizontal => Long-form)
  const isVertical = canvasH > canvasW;
  const subtitleBottomMargin = isVertical ? 480 : 100;

  let filter;
  if (videoPath) {
    // 모션 클립: 이미 움직임이 있으므로 Ken Burns 없이 캔버스 normalize만.
    if (retimeClip) {
      // setpts로 재생속도를 조절 → 클립 한 번 재생이 durationSec를 채움(반복 없음). 이후 fps=30 정규화.
      filter = `[0:v]scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH},setpts=${speedFactor.toFixed(6)}*(PTS-STARTPTS),fps=30[v0]`;
    } else {
      // 폴백(루프 재생): 기존 동작 유지
      filter = `[0:v]scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH},fps=30,setpts=PTS-STARTPTS[v0]`;
    }
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
  // retimeClip이면 비디오를 늘리/줄여 재생하므로 클립 앰비언트는 desync 방지를 위해 생략
  // (0.25 저볼륨이라 나레이션+BGM 밑에서 체감 영향 미미).
  const withAmbient = !!videoPath && !retimeClip && !CLIP_AMBIENT_DISABLED && probeHasAudio(videoPath);
  let audioMap = '1:a';
  if (withAmbient) {
    filter += `;[0:a]atrim=0:${durationSec},asetpts=PTS-STARTPTS,volume=${CLIP_AMBIENT_VOLUME},`
      + `afade=t=out:st=${Math.max(0, durationSec - 0.4).toFixed(3)}:d=0.4[amb]`
      + `;[1:a][amb]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;
    audioMap = '[aout]';
  }

  args.push(
    '-filter_complex', filter,
    '-map', `[${finalLabel}]`,
    '-map', audioMap,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-t', String(durationSec),
    '-movflags', '+faststart',
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
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-t', String(durationSec),
    '-movflags', '+faststart',
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
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-movflags', '+faststart',
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
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '1',
    '-movflags', '+faststart',
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
    `[0:a][bgm_ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
  ].join(';');

  const res = spawnSync('ffmpeg', [
    '-y', '-i', videoPath, '-i', bgmPath,
    '-filter_complex', filter,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    '-shortest',
    outPath,
  ], { stdio: 'pipe' });

  if (res.status !== 0) {
    throw new Error(`ffmpeg bgm mix failed: ${res.stderr.toString().slice(-500)}`);
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

  const globalBgm = resolve('assets/bgm', `${category}.mp3`);
  if (existsSync(globalBgm)) return { path: globalBgm, source: `global-${category}` };

  return null;
}

export function renderDirect({ episodeDir, outPath, canvas, platform: platformHint }) {
  if (!hasFfmpeg()) {
    throw new Error('ffmpeg not found. Install: brew install ffmpeg');
  }

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
    const introClipPath = join(workDir, 'clip_000_intro.mp4');
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

  console.log(`🎬 Rendering ${scenes.length} scenes at ${canvasDim.join('x')}...`);

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const sceneId = scene.scene_id || String(i + 1).padStart(3, '0');
    const imagePath = join(assetsDir, 'images', `scene_${sceneId}.png`);
    // 2026-07-02: media-render(Grok image→video) 모션 클립이 있으면 정지 이미지 대신
    // 사용 (기본). 없으면 기존 still 기반 렌더 (레거시). 산출물 경로는 동일.
    const videoPath = join(assetsDir, 'videos', `scene_${sceneId}.mp4`);
    const hasMotion = existsSync(videoPath);
    const ttsPath = join(assetsDir, 'tts', `scene_${sceneId}.wav`);
    const clipPath = join(workDir, `clip_${sceneId}.mp4`);

    if (!hasMotion && !existsSync(imagePath)) throw new Error(`Missing image: ${imagePath} (and no motion clip ${videoPath})`);
    if (!existsSync(ttsPath)) throw new Error(`Missing tts: ${ttsPath}`);

    // Use ACTUAL TTS duration for clip length + subtitle timing
    // (was: scene.target_seconds — produced up to 46s of silence across 7 scenes)
    const ttsDur = probeDuration(ttsPath);
    const durationSec = ttsDur > 0 ? ttsDur : (scene.target_seconds || 12);
    const targetNote = scene.target_seconds ? ` (script target ${scene.target_seconds}s)` : '';

    renderScene({
      imagePath,
      videoPath: hasMotion ? videoPath : null,
      ttsPath,
      durationSec,
      narration: scene.narration || '',
      workDir,
      sceneId,
      outPath: clipPath,
      canvasW: canvasDim[0],
      canvasH: canvasDim[1],
    });

    clipPaths.push(clipPath);
    console.log(`  ✅ Scene ${sceneId} (${durationSec.toFixed(2)}s TTS${targetNote}${hasMotion ? ', motion clip' : ''})`);
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
    const paddedPath = join(workDir, `clip_outro_padded.mp4`);
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
    const outroClipPath = join(workDir, 'clip_zzz_outro.mp4');
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

  // Endcard (구독/좋아요 CTA): 48_endcard.png 존재 시 영상 끝에 정지 클립으로 추가 (자산 게이트).
  // 2026-06-27 추가: 채널 심볼 + 구독/좋아요 엔드카드. 자산 없으면 무동작(기존 에피소드 안전).
  // BGM은 concat 후 전체에 믹스되므로 엔드카드 구간에도 음악이 자연스럽게 이어진다.
  const endcardPath = join(baseDir, '48_endcard.png');
  if (existsSync(endcardPath)) {
    // BT_ENDCARD_SEC로 조절 가능 (Shorts 60초 정합 등 미세 조정용).
    const endcardDurationSec = Number(process.env.BT_ENDCARD_SEC)
      || (chosenCanvas === 'vertical' ? 2.5 : 3.5);
    const endcardClipPath = join(workDir, 'clip_zzzz_endcard.mp4');
    renderStillClip({
      imagePath: endcardPath,
      durationSec: endcardDurationSec,
      canvasW: canvasDim[0],
      canvasH: canvasDim[1],
      outPath: endcardClipPath,
    });
    clipPaths.push(endcardClipPath);
    console.log(`🎬 Endcard appended (+${endcardDurationSec}s, from 48_endcard.png)`);
  }

  // Concat
  const concatPath = join(workDir, 'concat.mp4');
  console.log('🔗 Concatenating scenes...');
  concatScenes(clipPaths, concatPath);

  // BGM mix (optional, 2026-05-16: 자동 카테고리 선택 + voice ducking)
  const bgmResolved = resolveBgmPath(assetsDir, meta);
  if (bgmResolved) {
    console.log(`🎵 Mixing BGM (${bgmResolved.source}, voice-ducked)...`);
    mixBgm(concatPath, bgmResolved.path, outPath);
  } else {
    execSync(`cp "${concatPath}" "${outPath}"`);
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
    console.error('Usage: render-direct.js --episode <dir> --out <path.mp4> [--canvas vertical|horizontal]');
    console.error('  (canvas auto-inferred from script frontmatter.format if omitted)');
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
    });
  } catch (e) {
    console.error(`❌ Render failed: ${e.message}`);
    process.exit(1);
  }
}
