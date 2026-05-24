#!/usr/bin/env node

/**
 * update-privacy.js — YouTube 영상 privacyStatus 일괄 변경
 *
 * 80_publish_result.json의 videoId를 읽어 videos.update 호출.
 * 영상 재업로드 없이 private/unlisted/public 토글.
 *
 * Usage:
 *   # 단일 에피소드
 *   node update-privacy.js --episode workspace/episodes/EP-2026-0010 --status public
 *
 *   # 시리즈 일괄 (videoId 있는 모든 EP-* 디렉토리)
 *   node update-privacy.js --all workspace/episodes/ --status public
 *
 *   # 직접 videoId
 *   node update-privacy.js --video-id jCwpGlzVICg --status public
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getSecret } from './config-loader.js';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';

const ALLOWED = new Set(['private', 'unlisted', 'public']);

async function getAccessToken() {
  const clientId = getSecret('YOUTUBE_OAUTH_CLIENT_ID');
  const clientSecret = getSecret('YOUTUBE_OAUTH_CLIENT_SECRET');
  const refreshToken = getSecret('YOUTUBE_OAUTH_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Missing YOUTUBE_OAUTH_* env vars');
  const body = new URLSearchParams({
    client_id: clientId, client_secret: clientSecret,
    refresh_token: refreshToken, grant_type: 'refresh_token',
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`OAuth refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function fetchVideo(accessToken, videoId) {
  const url = `${VIDEOS_ENDPOINT}?part=status&id=${videoId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`videos.list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.items?.[0] || null;
}

async function updatePrivacy(accessToken, videoId, status) {
  // 현재 status 객체를 받아서 privacyStatus만 교체 (다른 필드 유지)
  const cur = await fetchVideo(accessToken, videoId);
  if (!cur) throw new Error(`videoId ${videoId}: not found or no access`);
  const newStatus = { ...cur.status, privacyStatus: status };
  delete newStatus.publishAt; // public 즉시 전환 시 publishAt 충돌 방지

  const url = `${VIDEOS_ENDPOINT}?part=status`;
  const body = { id: videoId, status: newStatus };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`videos.update failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function videoIdFromEpisode(epDir) {
  const candidates = [
    join(epDir, 'platforms', 'long', '80_publish_result.json'),
    join(epDir, 'platforms', 'shorts', '80_publish_result.json'),
    join(epDir, '80_publish_result.json'),
  ];
  const p = candidates.find(c => existsSync(c));
  if (!p) return null;
  try {
    const r = JSON.parse(readFileSync(p, 'utf-8'));
    return r?.targets?.youtube?.videoId || null;
  } catch { return null; }
}

async function main() {
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

  const status = opts.status;
  if (!status || !ALLOWED.has(status)) {
    console.error('--status must be one of: private | unlisted | public');
    process.exit(1);
  }

  const accessToken = await getAccessToken();

  if (opts['video-id']) {
    console.log(`🔄 ${opts['video-id']} → ${status}`);
    await updatePrivacy(accessToken, opts['video-id'], status);
    console.log('✅ Updated');
    return;
  }

  if (opts.episode) {
    const vid = videoIdFromEpisode(resolve(opts.episode));
    if (!vid) { console.error('❌ no videoId in 80_publish_result.json'); process.exit(1); }
    console.log(`🔄 ${vid} → ${status}`);
    await updatePrivacy(accessToken, vid, status);
    console.log('✅ Updated');
    return;
  }

  if (opts.all) {
    const base = resolve(opts.all);
    const dirs = readdirSync(base).filter(d => d.startsWith('EP-') && statSync(join(base, d)).isDirectory()).sort();
    let ok = 0, skip = 0, fail = 0;
    for (const d of dirs) {
      const vid = videoIdFromEpisode(join(base, d));
      if (!vid) { console.log(`  ⏭  ${d}: no videoId`); skip++; continue; }
      try {
        await updatePrivacy(accessToken, vid, status);
        console.log(`  ✅ ${d} (${vid}) → ${status}`);
        ok++;
      } catch (e) {
        console.log(`  ❌ ${d} (${vid}): ${e.message.slice(0, 150)}`);
        fail++;
      }
    }
    console.log(`\n📊 ${ok} ok · ${skip} skipped · ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  }

  console.error('Usage:');
  console.error('  update-privacy.js --episode <dir> --status public');
  console.error('  update-privacy.js --all <episodes-dir> --status public');
  console.error('  update-privacy.js --video-id <ID> --status public');
  process.exit(1);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
