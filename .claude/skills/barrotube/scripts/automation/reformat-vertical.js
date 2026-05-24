#!/usr/bin/env node

/**
 * reformat-vertical.js — 가로 영상(16:9) → 세로(9:16) letterbox 변환
 *
 * TikTok / Reels용. 원본 영상은 손대지 않고 1080×1920 letterbox 버전을 별도 파일로 생성.
 *
 * Layout: 1080×1920 캔버스
 *   ├─ 배경: 원본 영상을 9:16 캔버스에 가득 채우도록 scale+crop + 강한 blur (분위기 유지)
 *   └─ 전경: 원본을 1080×608 (비율 유지)로 scale 후 중앙(상단 656px)에 overlay
 *
 * Usage:
 *   # 단일 에피소드 — distribution/{tiktok,reels}/video_vertical.mp4 생성
 *   node reformat-vertical.js --episode workspace/episodes/EP-2026-0010
 *
 *   # 직접 입출력 지정
 *   node reformat-vertical.js --in path/in.mp4 --out path/out.mp4
 *
 *   # 5편 일괄
 *   node reformat-vertical.js --series sp500-basic
 */

import { existsSync, readFileSync, statSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYAML } from 'yaml';

function probeDims(p) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', p,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  const [w, h] = r.stdout.trim().split(',').map(Number);
  return { w, h };
}

function reformat(inPath, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const { w, h } = probeDims(inPath);
  if (h > w) {
    // 이미 세로면 그대로 복사
    copyFileSync(inPath, outPath);
    return { status: 'copied', reason: 'already_vertical' };
  }
  // filter graph:
  //   [0:v]split=2[bg][fg];
  //   [bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:1[bg2];
  //   [fg]scale=1080:-2[fg2];
  //   [bg2][fg2]overlay=(W-w)/2:(H-h)/2
  const filter = [
    '[0:v]split=2[bg][fg];',
    '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:1[bg2];',
    '[fg]scale=1080:-2[fg2];',
    '[bg2][fg2]overlay=(W-w)/2:(H-h)/2,format=yuv420p',
  ].join('');
  const args = [
    '-y', '-i', inPath,
    '-filter_complex', filter,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  ];
  const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed (status ${r.status})`);
  return { status: 'reformatted' };
}

function reformatEpisode(epDir) {
  const abs = resolve(epDir);
  // v2: long platform render → tiktok/reels platforms (sibling).
  // v1: episodeDir/55_render → episodeDir/distribution/{tiktok,reels}.
  const v2Src = join(abs, 'platforms', 'long', '55_render', 'video.mp4');
  const v1Src = join(abs, '55_render', 'video.mp4');
  const src = existsSync(v2Src) ? v2Src : v1Src;
  if (!existsSync(src)) throw new Error(`Missing render (tried v2: ${v2Src}, v1: ${v1Src})`);
  const isV2 = src === v2Src;

  const targets = isV2
    ? ['tiktok', 'reels'].map(p => join(abs, 'platforms', p, 'video_vertical.mp4'))
    : ['tiktok', 'reels'].map(p => join(abs, 'distribution', p, 'video_vertical.mp4'));

  const tmpRoot = isV2 ? join(abs, 'platforms') : join(abs, 'distribution');
  mkdirSync(tmpRoot, { recursive: true });
  const tmp = join(tmpRoot, '_vertical.mp4');
  console.log(`🎞  ${basename(abs)}: ${src} → 1080×1920 (${isV2 ? 'v2 platforms/' : 'v1 distribution/'})`);
  const r = reformat(src, tmp);
  for (const t of targets) {
    mkdirSync(dirname(t), { recursive: true });
    copyFileSync(tmp, t);
    console.log(`   ✅ ${t}`);
  }
  return r;
}

function main() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.replace(/^--/, '');
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }

  if (opts.in && opts.out) {
    console.log(`🎞  ${opts.in} → ${opts.out}`);
    const r = reformat(resolve(opts.in), resolve(opts.out));
    console.log(`✅ ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`);
    return;
  }

  if (opts.episode) {
    reformatEpisode(opts.episode);
    return;
  }

  if (opts.series) {
    const seriesPath = resolve('paperclip/config/series.json');
    if (!existsSync(seriesPath)) { console.error('❌ paperclip/config/series.json not found'); process.exit(1); }
    const cfg = JSON.parse(readFileSync(seriesPath, 'utf-8'));
    const s = (cfg.series || []).find(x => x.id === opts.series);
    if (!s) { console.error(`❌ series not found: ${opts.series}`); process.exit(1); }
    const vids = s.branding_outputs?.video_ids || [];
    if (!vids.length) { console.error(`❌ series ${opts.series} has no branding_outputs.video_ids`); process.exit(1); }
    console.log(`📦 Series ${opts.series}: ${vids.length} episodes`);
    let ok = 0, fail = 0;
    for (const v of vids) {
      try {
        reformatEpisode(`workspace/episodes/${v.episode_id}`);
        ok++;
      } catch (e) {
        console.log(`   ❌ ${v.episode_id}: ${e.message}`);
        fail++;
      }
    }
    console.log(`\n📊 ${ok} ok · ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  }

  console.error('Usage:');
  console.error('  reformat-vertical.js --episode <dir>');
  console.error('  reformat-vertical.js --series <id>');
  console.error('  reformat-vertical.js --in <path> --out <path>');
  process.exit(1);
}

main();
