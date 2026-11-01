#!/usr/bin/env node

/**
 * benchmark-playlist.js — 벤치마크 재생목록의 영상 전부를 정량 수집한다.
 *
 * fetch-competitor-stats.js 는 채널의 **최근** 업로드만 본다. 특정 포맷(예: 오선의
 * 「증시 요약」)을 통째로 벤치마크하려면 그 재생목록 전체가 필요하다 — yt-dlp 의
 * flat-playlist 는 2026-10-01 실측 100편에서 끊겼다(실제 191·246편).
 *
 *   playlistItems.list(contentDetails, maxResults=50)  1 unit/페이지
 *   videos.list(snippet,statistics,contentDetails)     1 unit/50편
 *   channels.list(snippet,statistics)                  1 unit
 *
 * 산출 (workspace/intel/benchmarks/<slug>/):
 *   videos.json      — 영상별 제목·게시일·길이·조회·좋아요·댓글·태그·설명
 *   channel.json     — 채널 통계 (구독자·총 조회·영상 수)
 *
 * 자막은 --transcripts 로 yt-dlp 가 받는다 (API 0 unit) → transcripts/<id>.txt
 *
 * Usage:
 *   node benchmark-playlist.js --slug futuresnow-summary \
 *     --playlist PL-kIFxHMwyFAqrAm34SbOfDgThMbH6lCL --playlist PL-kIFxHMwyFBvNENT360qo0LOOP_q8yYe
 *   node benchmark-playlist.js --slug futuresnow-summary --transcripts   # 받은 목록의 자막만
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { getSecret } from './config-loader.js';

const ROOT = resolve(import.meta.dirname, '../..');
const YT_API = 'https://www.googleapis.com/youtube/v3';

async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: getSecret('YOUTUBE_OAUTH_CLIENT_ID'),
      client_secret: getSecret('YOUTUBE_OAUTH_CLIENT_SECRET'),
      refresh_token: getSecret('YOUTUBE_OAUTH_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`OAuth token refresh failed: ${r.status}`);
  return (await r.json()).access_token;
}

let units = 0;
async function ytGet(path, params, token) {
  const url = new URL(`${YT_API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  units += 1;
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** ISO 8601 duration (PT3M32S) → 초 */
export function isoSeconds(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => Number(x || 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

/** WebVTT 자동자막 → 평문. 자동자막은 줄이 겹쳐 반복되므로 연속 중복을 지운다. */
export function vttToText(vtt) {
  const out = [];
  for (const raw of vtt.split('\n')) {
    const line = raw.replace(/<[^>]+>/g, '').trim();
    if (!line || line === 'WEBVTT' || /^(Kind|Language):/.test(line) || line.includes('-->')) continue;
    if (/^\d+$/.test(line) || line === out[out.length - 1]) continue;
    out.push(line);
  }
  return out.join('\n');
}

async function collect(slug, playlists, outDir) {
  const token = await getAccessToken();
  const items = [];
  for (const pl of playlists) {
    let pageToken = '';
    do {
      const d = await ytGet('playlistItems', {
        part: 'contentDetails', playlistId: pl, maxResults: '50', ...(pageToken ? { pageToken } : {}),
      }, token);
      for (const it of d.items || []) items.push({ id: it.contentDetails.videoId, playlist: pl });
      pageToken = d.nextPageToken || '';
    } while (pageToken);
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  const videos = [];
  const ids = [...byId.keys()];
  let channelId = null;
  for (let i = 0; i < ids.length; i += 50) {
    const d = await ytGet('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') }, token);
    for (const v of d.items || []) {
      channelId ||= v.snippet.channelId;
      videos.push({
        id: v.id,
        playlist: byId.get(v.id)?.playlist,
        title: v.snippet.title,
        published_at: v.snippet.publishedAt,
        duration_s: isoSeconds(v.contentDetails.duration),
        views: Number(v.statistics.viewCount || 0),
        likes: v.statistics.likeCount != null ? Number(v.statistics.likeCount) : null,
        comments: v.statistics.commentCount != null ? Number(v.statistics.commentCount) : null,
        tags: v.snippet.tags || [],
        description: v.snippet.description || '',
        thumbnail: v.snippet.thumbnails?.maxres?.url || v.snippet.thumbnails?.high?.url || null,
      });
    }
  }
  videos.sort((a, b) => a.published_at.localeCompare(b.published_at));

  let channel = null;
  if (channelId) {
    const c = (await ytGet('channels', { part: 'snippet,statistics', id: channelId }, token)).items?.[0];
    if (c) channel = { id: c.id, title: c.snippet.title, ...c.statistics };
  }

  mkdirSync(outDir, { recursive: true });
  const fetchedAt = new Date().toISOString();
  writeFileSync(join(outDir, 'videos.json'), JSON.stringify({ slug, playlists, fetched_at: fetchedAt, count: videos.length, videos }, null, 2));
  writeFileSync(join(outDir, 'channel.json'), JSON.stringify({ fetched_at: fetchedAt, ...channel }, null, 2));
  console.log(`✅ ${videos.length}편 (재생목록 항목 ${items.length}) · 채널 ${channel?.title} 구독 ${channel?.subscriberCount} · ${units} units`);
  console.log(`   ${outDir}`);
}

function transcripts(outDir) {
  const { videos } = JSON.parse(readFileSync(join(outDir, 'videos.json'), 'utf-8'));
  const dir = join(outDir, 'transcripts');
  mkdirSync(dir, { recursive: true });
  const todo = videos.map((v) => v.id).filter((id) => !existsSync(join(dir, `${id}.txt`)));
  console.log(`📝 자막 ${todo.length}편 (이미 ${videos.length - todo.length}편)`);
  if (!todo.length) return;
  const list = join(dir, '_todo.txt');
  writeFileSync(list, todo.map((id) => `https://www.youtube.com/watch?v=${id}`).join('\n'));
  // 수백 편을 연달아 받으면 429 가 난다 — 요청 사이를 띄운다.
  spawnSync('yt-dlp', ['--no-update', '--skip-download', '--write-auto-subs', '--write-subs',
    '--sub-langs', 'ko', '--sub-format', 'vtt', '--sleep-requests', '1', '--sleep-subtitles', '2',
    '--ignore-errors', '-o', join(dir, '%(id)s.%(ext)s'), '-a', list], { stdio: 'inherit' });
  unlinkSync(list);
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.vtt'))) {
    const id = f.split('.')[0];
    writeFileSync(join(dir, `${id}.txt`), vttToText(readFileSync(join(dir, f), 'utf-8')));
    unlinkSync(join(dir, f));
    n += 1;
  }
  console.log(`✅ 자막 ${n}편 저장 → ${dir}`);
}

async function main() {
  const { values } = parseArgs({ options: {
    slug: { type: 'string' },
    playlist: { type: 'string', multiple: true },
    transcripts: { type: 'boolean', default: false },
  } });
  if (!values.slug) { console.error('Usage: benchmark-playlist.js --slug <name> [--playlist <id> ...] [--transcripts]'); process.exit(1); }
  const outDir = join(ROOT, 'workspace', 'intel', 'benchmarks', values.slug);
  if (values.playlist?.length) await collect(values.slug, values.playlist, outDir);
  if (values.transcripts) transcripts(outDir);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
