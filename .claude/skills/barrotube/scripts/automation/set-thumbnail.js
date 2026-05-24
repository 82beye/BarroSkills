#!/usr/bin/env node

/**
 * set-thumbnail.js — YouTube 기존 영상에 썸네일만 교체
 *
 * 영상 재업로드 없이 thumbnails.set API만 호출.
 * 채널 인증(전화번호) 이후 대기 중이던 47_thumbnail.png들을
 * 일괄 적용할 때 사용.
 *
 * Usage:
 *   # 단일 에피소드
 *   node set-thumbnail.js --episode workspace/episodes/EP-2026-0010
 *
 *   # 시리즈 5편 일괄 (80_publish_result.json의 videoId 자동 읽음)
 *   node set-thumbnail.js --all workspace/episodes/
 *
 *   # 특정 videoId + thumbnail 경로 직접 지정
 *   node set-thumbnail.js --video-id X_4CRKaHJnE --thumbnail path/to/thumb.png
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getSecret } from './config-loader.js';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const THUMBNAIL_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';

async function getAccessToken() {
  const clientId = getSecret('YOUTUBE_OAUTH_CLIENT_ID');
  const clientSecret = getSecret('YOUTUBE_OAUTH_CLIENT_SECRET');
  const refreshToken = getSecret('YOUTUBE_OAUTH_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing YOUTUBE_OAUTH_* env vars');
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`OAuth refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function setThumbnail(accessToken, videoId, thumbnailPath) {
  const buffer = readFileSync(thumbnailPath);
  const mime = thumbnailPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const res = await fetch(`${THUMBNAIL_ENDPOINT}?videoId=${videoId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': mime,
    },
    body: buffer,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Thumbnail set failed: ${res.status} ${err.slice(0, 300)}`);
  }
  return res.json();
}

function resolveEpisode(epDir) {
  const abs = resolve(epDir);
  // v2 (platforms/long, platforms/shorts) 우선 → v1 fallback.
  const resultCandidates = [
    join(abs, 'platforms', 'long', '80_publish_result.json'),
    join(abs, 'platforms', 'shorts', '80_publish_result.json'),
    join(abs, '80_publish_result.json'),
  ];
  const resultPath = resultCandidates.find(p => existsSync(p));
  if (!resultPath) return { ok: false, reason: 'no 80_publish_result.json' };
  const platformDir = resultPath.replace(/\/80_publish_result\.json$/, '');
  // 썸네일은 같은 platformDir에 있으면 우선, 아니면 episodeDir 직접.
  const thumbCandidates = [
    join(platformDir, '47_thumbnail.png'),
    join(abs, '47_thumbnail.png'),
  ];
  const thumbPath = thumbCandidates.find(p => existsSync(p));
  if (!thumbPath) return { ok: false, reason: 'no 47_thumbnail.png' };
  const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
  const videoId = result?.targets?.youtube?.videoId;
  if (!videoId) return { ok: false, reason: 'no videoId in publish result' };
  return { ok: true, videoId, thumbPath, episodeId: result.episode_id };
}

async function main() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.replace(/^--/, '');
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i++;
    }
  }

  const accessToken = await getAccessToken();

  // Mode 1: single episode
  if (opts.episode) {
    const r = resolveEpisode(opts.episode);
    if (!r.ok) { console.error(`❌ ${r.reason}`); process.exit(1); }
    console.log(`🖼  ${r.episodeId} → ${r.videoId}`);
    try {
      await setThumbnail(accessToken, r.videoId, r.thumbPath);
      console.log(`✅ Thumbnail set for ${r.videoId}`);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
    return;
  }

  // Mode 2: direct videoId + thumbnail
  if (opts['video-id'] && opts.thumbnail) {
    const thumbPath = resolve(opts.thumbnail);
    if (!existsSync(thumbPath)) { console.error(`❌ Not found: ${thumbPath}`); process.exit(1); }
    console.log(`🖼  ${opts['video-id']} ← ${thumbPath}`);
    await setThumbnail(accessToken, opts['video-id'], thumbPath);
    console.log(`✅ Thumbnail set`);
    return;
  }

  // Mode 3: batch over a directory of episodes
  if (opts.all) {
    const base = resolve(opts.all);
    if (!existsSync(base) || !statSync(base).isDirectory()) {
      console.error(`❌ Not a directory: ${base}`); process.exit(1);
    }
    const entries = readdirSync(base).filter(d => d.startsWith('EP-') && statSync(join(base, d)).isDirectory());
    entries.sort();
    console.log(`📦 Found ${entries.length} episodes under ${base}`);
    let ok = 0, skip = 0, fail = 0;
    for (const ep of entries) {
      const r = resolveEpisode(join(base, ep));
      if (!r.ok) {
        console.log(`  ⏭  ${ep}: ${r.reason}`);
        skip++; continue;
      }
      try {
        await setThumbnail(accessToken, r.videoId, r.thumbPath);
        console.log(`  ✅ ${ep} (${r.videoId})`);
        ok++;
      } catch (e) {
        console.log(`  ❌ ${ep} (${r.videoId}): ${e.message.slice(0, 120)}`);
        fail++;
      }
    }
    console.log(`\n📊 Done: ${ok} ok · ${skip} skipped · ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  }

  console.error('Usage:');
  console.error('  set-thumbnail.js --episode <dir>');
  console.error('  set-thumbnail.js --all <episodes-dir>');
  console.error('  set-thumbnail.js --video-id <ID> --thumbnail <path>');
  process.exit(1);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
