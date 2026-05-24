#!/usr/bin/env node

/**
 * create-playlist.js — YouTube 재생목록 생성 + 에피소드 일괄 추가
 *
 * Usage:
 *   # series_id로 자동 묶기 (script frontmatter의 series_id 일치 + series_episode 순서)
 *   node create-playlist.js --series sp500-basic --episodes-dir workspace/episodes \
 *        --title "S&P500 입문 (5편)" --privacy unlisted
 *
 *   # videoId 직접 나열
 *   node create-playlist.js --videos vid1,vid2,vid3 --title "..." --privacy public
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYAML } from 'yaml';
import { getSecret } from './config-loader.js';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PLAYLISTS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/playlists';
const PLAYLIST_ITEMS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/playlistItems';

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

function collectSeriesEpisodes(episodesDir, seriesId, platform = 'long') {
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
  const privacy = opts.privacy || 'unlisted';
  const description = opts.description ||
`S&P500 입문 시리즈 — 워런 버핏이 추천한 단 하나의 펀드를 5편으로 정리합니다.

1편 WHAT  : S&P500이 뭐길래 워런 버핏이 90%를 추천했나
2편 WHY   : 100년 데이터로 본 진짜 수익률 (10% 법칙)
3편 HOW   : SPY·IVV·VOO·SPLG — 한국인은 뭘 사야 하나 (수수료 0.03%)
4편 RISK  : 환헷지 vs 비헷지 — 1500원 환율 시대의 정답
5편 WHEN  : 적립식 vs 일시불 — 30년 시뮬레이션의 충격 결과

📚 Barro 경제수업 · 3분이면 충분한 경제`;

  let videos = [];
  if (opts.videos) {
    videos = opts.videos.split(',').map((v, i) => ({ episodeId: `manual-${i+1}`, seriesEpisode: i+1, videoId: v.trim() }));
  } else if (opts.series) {
    const dir = opts['episodes-dir'] || 'workspace/episodes';
    const platform = opts.platform || 'long';  // 시리즈는 long 기본, --platform shorts로 Shorts 시리즈도 등록 가능
    videos = collectSeriesEpisodes(dir, opts.series, platform);
    if (videos.length === 0) { console.error(`❌ No episodes found for series "${opts.series}" in ${dir}`); process.exit(1); }
  } else {
    console.error('Either --series <id> or --videos <id1,id2,...> required'); process.exit(1);
  }

  console.log(`📺 Creating playlist: "${opts.title}" (${privacy})`);
  console.log(`   Videos (${videos.length}):`);
  for (const v of videos) console.log(`     - [${v.seriesEpisode}] ${v.episodeId} → ${v.videoId}`);

  const accessToken = await getAccessToken();
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
