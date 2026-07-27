#!/usr/bin/env node

/**
 * create-playlist.js — YouTube 재생목록 생성 + 에피소드 일괄 추가
 *
 * Usage:
 *   # series_id로 자동 묶기 (script frontmatter의 series_id 일치 + series_episode 순서)
 *   node create-playlist.js --series sp500-basic --episodes-dir workspace/episodes \
 *        --title "S&P500 입문 (5편)" --channel econ-daily --privacy unlisted
 *
 *   # videoId 직접 나열
 *   node create-playlist.js --videos vid1,vid2,vid3 --title "..." --channel econ-daily --privacy public
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYAML } from 'yaml';
import { createChannelRegistry } from './lib/channel-registry.js';
import { assertOAuthChannel, getAccessToken } from './publish-youtube.js';

const PLAYLISTS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/playlists';
const PLAYLIST_ITEMS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/playlistItems';

async function createPlaylist(accessToken, { title, description, privacyStatus }) {
  const url = `${PLAYLISTS_ENDPOINT}?part=snippet,status`;
  const body = {
    snippet: { title: title.slice(0, 150), description: description.slice(0, 5000), defaultLanguage: 'ko' },
    status: { privacyStatus },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Playlist create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function addToPlaylist(accessToken, playlistId, videoId, position) {
  const url = `${PLAYLIST_ITEMS_ENDPOINT}?part=snippet`;
  const body = {
    snippet: {
      playlistId,
      position,
      resourceId: { kind: 'youtube#video', videoId },
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PlaylistItem insert failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function parseFrontmatter(mdPath) {
  const c = readFileSync(mdPath, 'utf-8');
  const m = c.match(/^---\n([\s\S]*?)\n---/);
  return m ? parseYAML(m[1]) : null;
}

function collectSeriesEpisodes(episodesDir, seriesId, platform = 'long', channelId = null) {
  const base = resolve(episodesDir);
  const dirs = readdirSync(base).filter(d => d.startsWith('EP-') && statSync(join(base, d)).isDirectory());
  const items = [];
  for (const d of dirs) {
    // v2 우선: platforms/{platform}/ 안에 30_script.md + 80_publish_result.json
    const v2Script = join(base, d, 'platforms', platform, '30_script.md');
    const v2Result = join(base, d, 'platforms', platform, '80_publish_result.json');
    const v1Script = join(base, d, '30_script.md');
    const v1Result = join(base, d, '80_publish_result.json');
    let scriptPath, resultPath;
    if (existsSync(v2Script) && existsSync(v2Result)) {
      scriptPath = v2Script; resultPath = v2Result;
    } else if (existsSync(v1Script) && existsSync(v1Result)) {
      scriptPath = v1Script; resultPath = v1Result;
    } else continue;
    const fm = parseFrontmatter(scriptPath);
    if (!fm || fm.series_id !== seriesId) continue;
    const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
    if (channelId && result.channel_id !== channelId) {
      throw new Error(`Published episode ${d} belongs to ${result.channel_id || '(unknown)'}, not ${channelId}`);
    }
    const videoId = result?.targets?.youtube?.videoId;
    if (!videoId) continue;
    items.push({
      episodeId: fm.episode_id || d,
      seriesEpisode: fm.series_episode || 0,
      videoId,
    });
  }
  items.sort((a, b) => a.seriesEpisode - b.seriesEpisode);
  return items;
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

  if (!opts.title) { console.error('--title required'); process.exit(1); }
  if (!opts.channel) { console.error('--channel required'); process.exit(1); }

  const skillRoot = resolve(import.meta.dirname, '../..');
  const dataRoot = resolve(process.env.BARROTUBE_DATA || '/Users/beye/BarroTubeData');
  const factoryRoot = resolve(process.env.BARRO_AI_FACTORY || '/Users/beye/BarroAiFactory');
  const registry = createChannelRegistry({
    skillRoot,
    dataRoot,
    factoryRoot,
    allowedRoots: [dataRoot, factoryRoot, resolve(skillRoot, '../../..')],
  });
  const channel = await registry.getChannel(opts.channel);
  if (channel.status !== 'active' || channel.unresolvedConflicts.length) {
    throw new Error(`Channel ${opts.channel} is not active or has unresolved conflicts`);
  }
  const youtube = channel.manifest.platforms?.youtube;
  if (youtube?.enabled === false) throw new Error(`YouTube publishing is disabled for channel ${opts.channel}`);
  if (!youtube?.channel_id) throw new Error(`Channel ${opts.channel} is missing platforms.youtube.channel_id`);
  const refs = channel.manifest.credentials?.youtube || {};
  const credentialEnv = {
    clientIdEnv: refs.client_id_env,
    clientSecretEnv: refs.client_secret_env,
    refreshTokenEnv: refs.refresh_token_env,
  };
  const privacy = opts.privacy
    || channel.manifest.playlists?.default_privacy
    || youtube.playlist_privacy
    || youtube.default_privacy
    || 'private';
  if (!['private', 'unlisted', 'public'].includes(privacy)) throw new Error(`Invalid playlist privacy: ${privacy}`);
  const description = opts.description || [
    opts.title,
    channel.manifest.identity?.description || channel.manifest.identity?.display_name || opts.channel,
  ].filter(Boolean).join('\n\n');

  let videos = [];
  if (opts.videos) {
    videos = opts.videos.split(',').map((v, i) => ({ episodeId: `manual-${i+1}`, seriesEpisode: i+1, videoId: v.trim() }));
  } else if (opts.series) {
    const dir = opts['episodes-dir'] || channel.context.episodes_root;
    const platform = opts.platform || 'long';  // 시리즈는 long 기본, --platform shorts로 Shorts 시리즈도 등록 가능
    videos = collectSeriesEpisodes(dir, opts.series, platform, opts.channel);
    if (videos.length === 0) { console.error(`❌ No episodes found for series "${opts.series}" in ${dir}`); process.exit(1); }
  } else {
    console.error('Either --series <id> or --videos <id1,id2,...> required'); process.exit(1);
  }

  console.log(`📺 Creating playlist: "${opts.title}" (${privacy})`);
  console.log(`   Videos (${videos.length}):`);
  for (const v of videos) console.log(`     - [${v.seriesEpisode}] ${v.episodeId} → ${v.videoId}`);

  const accessToken = await getAccessToken(credentialEnv);
  await assertOAuthChannel(accessToken, youtube.channel_id);
  const playlist = await createPlaylist(accessToken, { title: opts.title, description, privacyStatus: privacy });
  const playlistId = playlist.id;
  const playlistUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
  console.log(`✅ Playlist created: ${playlistUrl}`);

  let pos = 0;
  for (const v of videos) {
    try {
      await addToPlaylist(accessToken, playlistId, v.videoId, pos);
      console.log(`  ✅ [${pos}] ${v.episodeId} (${v.videoId})`);
      pos++;
    } catch (e) {
      console.log(`  ❌ ${v.episodeId} (${v.videoId}): ${e.message.slice(0, 200)}`);
    }
  }

  if (opts.out) {
    writeFileSync(resolve(opts.out), JSON.stringify({ playlistId, playlistUrl, videos }, null, 2));
    console.log(`💾 Saved: ${opts.out}`);
  }

  console.log(`\n📊 Done. Playlist: ${playlistUrl}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
