#!/usr/bin/env node

/**
 * upload-direct.js — 승인 게이트 없이 YouTube Data API로 직접 업로드한다.
 *
 * publish-youtube.js 는 approve-episode.js 가 발급한 승인 토큰을 요구하고, 그 승인은
 * QA PASS 를 전제로 한다. 그 게이트는 "스틸 섞인 숏폼을 자동 발행하지 않는다"는 채널
 * 정책을 강제하기 위한 것이므로 평소에는 publish-youtube.js 를 써야 한다.
 * 이 스크립트는 **운영자가 특정 영상의 게시를 명시적으로 지시했을 때만** 쓴다.
 *
 * Usage:
 *   node upload-direct.js --video <mp4> --meta <70_publish_meta.json> --channel econ-daily \
 *     [--thumbnail <png>] [--playlist <PL...>] [--privacy public|unlisted|private] [--publish-at <ISO>]
 */

import { readFileSync, statSync } from 'node:fs';
import { createChannelRegistry } from './lib/channel-registry.js';
import { assertOAuthChannel, getAccessToken } from './publish-youtube.js';

const a = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (!k.startsWith('--')) continue;
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith('--')) a[k.slice(2)] = true; else { a[k.slice(2)] = n; i++; }
}
if (!a.video || !a.meta || !a.channel) {
  console.error('Usage: upload-direct.js --video <mp4> --meta <json> --channel <id> [--thumbnail <png>] [--playlist <PL...>] [--privacy public] [--publish-at <ISO>]');
  process.exit(1);
}

const meta = JSON.parse(readFileSync(a.meta, 'utf-8'));
const registry = createChannelRegistry({});
const channel = await registry.getChannel(a.channel);
const youtube = channel.manifest.platforms?.youtube;
if (!youtube?.channel_id) throw new Error(`Channel ${a.channel} is missing platforms.youtube.channel_id`);

const refs = channel.manifest.credentials?.youtube || {};
const credentialEnv = {
  clientIdEnv: refs.client_id_env,
  clientSecretEnv: refs.client_secret_env,
  refreshTokenEnv: refs.refresh_token_env,
};

console.log('🔑 Refreshing OAuth token...');
const token = await getAccessToken(credentialEnv);
console.log('🔐 Verifying channel identity...');
await assertOAuthChannel(token, youtube.channel_id);

const privacy = (a.privacy && a.privacy !== true) ? a.privacy : (meta.privacyStatus || 'private');
const publishAt = (a['publish-at'] && a['publish-at'] !== true) ? a['publish-at'] : meta.publishAt;

const body = {
  snippet: {
    title: meta.title,
    description: meta.description,
    tags: meta.tags || [],
    categoryId: String(meta.categoryId || '25'),
    defaultLanguage: meta.language || 'ko',
    defaultAudioLanguage: meta.language || 'ko',
  },
  status: {
    privacyStatus: publishAt ? 'private' : privacy,
    selfDeclaredMadeForKids: !!meta.madeForKids,
    ...(publishAt ? { publishAt } : {}),
  },
};

const size = statSync(a.video).size;
console.log(`📤 Initializing resumable upload (${(size / 1024 / 1024).toFixed(2)} MB)...`);
const init = await fetch(
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify(body),
  },
);
if (!init.ok) throw new Error(`init failed: ${init.status} ${(await init.text()).slice(0, 400)}`);
const location = init.headers.get('location');
if (!location) throw new Error('no resumable upload URL returned');

console.log('📤 Uploading video...');
const put = await fetch(location, {
  method: 'PUT',
  headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) },
  body: readFileSync(a.video),
});
if (!put.ok) throw new Error(`upload failed: ${put.status} ${(await put.text()).slice(0, 400)}`);
const video = await put.json();
console.log(`✅ Uploaded: video_id=${video.id}`);

if (a.thumbnail && a.thumbnail !== true) {
  console.log('🖼  Setting thumbnail...');
  const th = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${video.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
    body: readFileSync(a.thumbnail),
  });
  console.log(th.ok ? '✅ Thumbnail set' : `⚠️  thumbnail failed: ${th.status}`);
}

const playlistId = (a.playlist && a.playlist !== true) ? a.playlist : meta.playlistId;
if (playlistId) {
  console.log('📺 Adding to playlist...');
  const pl = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId: video.id } } }),
  });
  console.log(pl.ok ? '✅ Added to playlist' : `⚠️  playlist failed: ${pl.status}`);
}

console.log(JSON.stringify({
  status: publishAt ? 'scheduled' : 'published',
  videoId: video.id,
  url: `https://youtu.be/${video.id}`,
  privacyStatus: body.status.privacyStatus,
  publishAt: publishAt || null,
}, null, 2));
