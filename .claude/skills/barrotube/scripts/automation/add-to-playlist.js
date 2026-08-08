#!/usr/bin/env node

/**
 * add-to-playlist.js — 이미 존재하는 재생목록에 영상 하나를 추가한다.
 *
 * create-playlist.js 는 재생목록을 "생성"하는 스크립트라 기존 목록에 끼워넣을 수 없다.
 * publish-youtube.js 는 playlistId 를 아예 다루지 않는다. 그 사이의 빈칸을 메운다.
 *
 * Usage:
 *   node add-to-playlist.js --playlist PL... --video VIDEOID --channel econ-daily
 *   node add-to-playlist.js --playlist PL... --video VIDEOID --channel econ-daily --record <playlist.json> --episode EP-2026-0086 --topic "..."
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createChannelRegistry } from './lib/channel-registry.js';
import { assertOAuthChannel, getAccessToken } from './publish-youtube.js';

const a = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (!k.startsWith('--')) continue;
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith('--')) a[k.slice(2)] = true; else { a[k.slice(2)] = n; i++; }
}

if (!a.playlist || !a.video || !a.channel) {
  console.error('Usage: add-to-playlist.js --playlist <PL...> --video <videoId> --channel <id> [--record <json>] [--episode <EP-ID>] [--topic <text>]');
  process.exit(1);
}

const registry = createChannelRegistry({});
const channel = await registry.getChannel(a.channel);
const youtube = channel.manifest.platforms?.youtube;
if (!youtube?.channel_id) throw new Error(`Channel ${a.channel} is missing platforms.youtube.channel_id`);

const refs = channel.manifest.credentials?.youtube || {};
const accessToken = await getAccessToken({
  clientIdEnv: refs.client_id_env,
  clientSecretEnv: refs.client_secret_env,
  refreshTokenEnv: refs.refresh_token_env,
});
await assertOAuthChannel(accessToken, youtube.channel_id);

const res = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    snippet: { playlistId: a.playlist, resourceId: { kind: 'youtube#video', videoId: a.video } },
  }),
});
if (!res.ok) throw new Error(`playlistItems.insert failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
const item = await res.json();
console.log(`✅ Added ${a.video} → ${a.playlist} (position ${item.snippet?.position})`);

// 로컬 playlist 기록 파일도 함께 갱신해 두면 다음 EP 가 순서를 이어받는다.
if (a.record && a.record !== true && existsSync(a.record)) {
  const j = JSON.parse(readFileSync(a.record, 'utf-8'));
  j.videos = j.videos || [];
  if (!j.videos.some(v => v.video_id === a.video)) {
    j.videos.push({
      episode_id: a.episode && a.episode !== true ? a.episode : null,
      video_id: a.video,
      video_url: `https://youtu.be/${a.video}`,
      topic: a.topic && a.topic !== true ? a.topic : null,
      position: item.snippet?.position ?? j.videos.length,
      added_at: item.snippet?.publishedAt || null,
      video_privacy: 'scheduled',
    });
    j.video_count = j.videos.length;
    writeFileSync(a.record, JSON.stringify(j, null, 2) + '\n');
    console.log(`   record updated: ${a.record} (${j.video_count} videos)`);
  }
}
