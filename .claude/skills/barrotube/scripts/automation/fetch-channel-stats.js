#!/usr/bin/env node

/**
 * fetch-channel-stats.js — 자체 채널(바로경제) 정량 트래커
 *
 * 경쟁사만 관측하고 정작 우리 채널 성과는 어디에도 안 쌓이던 결손을 메운다
 * (2026-08-31 감사에서 확인 — 성장 루프의 [측정] 단계).
 *
 * 수집 경로 (fetch-competitor-stats.js 와 같은 절약 패턴, 채널당 3 units):
 *   channels.list(mine=true, snippet,statistics,contentDetails)   1 unit
 *   playlistItems.list(contentDetails, uploads, maxResults=50)    1 unit  (--deep 은 2페이지)
 *   videos.list(snippet,statistics,contentDetails, ≤50개)          1 unit
 *
 * 산출:
 *   workspace/growth/channel/history.jsonl   채널 구독·조회 시계열 (fetch 마다 1행 append)
 *   workspace/growth/channel/videos.json     영상 인덱스 + stats_history (경쟁 인덱스와 동일 스키마)
 *
 * Analytics API 프로브: yt-analytics.readonly 스코프가 있으면 일별 상세(노출 CTR·시청지속)를
 * analytics-YYYY-MM-DD.json 으로 저장한다. 현재 토큰은 youtube+upload 뿐이라 403 이 정상이며
 * 조용히 건너뛴다. 스코프 추가는 운영자 재동의가 필요한 사안 — 자동화가 임의로 넓히지 않는다
 * (renew-youtube-oauth.js 의 SCOPE 를 여기서든 어디서든 몰래 바꾸지 말 것).
 *
 * 실패 정책: 어떤 오류에서도 exit 0. 관측이 EP 생산·다른 성장 단계를 막지 않는다.
 *
 * Usage:
 *   node fetch-channel-stats.js            # 정상 실행
 *   node fetch-channel-stats.js --deep     # uploads 2페이지 (백필·주 1회 권장)
 *   node fetch-channel-stats.js --dry-run  # API 0콜
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getSecret } from './config-loader.js';
import { parseDuration, lengthBucket, isShorts, appendStatsHistory } from './lib/competitor-analytics.js';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT_DIR = join(ROOT, 'workspace', 'growth', 'channel');
const INDEX_PATH = join(OUT_DIR, 'videos.json');
const HISTORY_PATH = join(OUT_DIR, 'history.jsonl');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YT_API = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports';

function loadJSON(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

async function accessToken() {
  const body = new URLSearchParams({
    client_id: getSecret('YOUTUBE_OAUTH_CLIENT_ID'),
    client_secret: getSecret('YOUTUBE_OAUTH_CLIENT_SECRET'),
    refresh_token: getSecret('YOUTUBE_OAUTH_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });
  const t = await (await fetch(TOKEN_URL, { method: 'POST', body })).json();
  if (!t.access_token) throw new Error(`OAuth 갱신 실패: ${t.error || 'unknown'}`);
  return t.access_token;
}

async function yt(token, path, params) {
  const url = `${YT_API}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`YT ${path} ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** Analytics API 프로브. 스코프 없으면(401/403) null — 정상 강등. */
async function tryAnalytics(token, channelId, date) {
  const end = date;
  const start = new Date(Date.parse(date) - 6 * 86400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    ids: `channel==${channelId}`, startDate: start, endDate: end,
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost',
    dimensions: 'day',
  });
  const res = await fetch(`${ANALYTICS_API}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) return null;
  return res.json();
}

async function main() {
  const { values } = parseArgs({ options: {
    deep: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  } });

  const growthCfg = loadJSON(join(ROOT, 'config', 'growth.json'), {});
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  if (values['dry-run']) {
    console.log(`📐 dry-run — channels.list 1 + playlistItems ${values.deep ? 2 : 1} + videos.list 1 units. API 0콜.`);
    return;
  }

  const token = await accessToken();

  // 1) 채널 통계
  const ch = await yt(token, 'channels', { part: 'snippet,statistics,contentDetails', mine: 'true' });
  const c = ch.items?.[0];
  if (!c) throw new Error('mine=true 채널 없음');
  const channelId = c.id;
  const stats = c.statistics ?? {};
  const uploads = c.contentDetails?.relatedPlaylists?.uploads
    || growthCfg.uploads_playlist_id;

  mkdirSync(OUT_DIR, { recursive: true });
  // `|| null` 은 정당한 0(구독 0)을 지우고, API 누락은 명시적 null 로 남겨야
  // netDelta 가 '관측 없음'으로 올바르게 건너뛴다.
  const numOrNull = (x) => (x == null || x === '' ? null : (Number.isFinite(Number(x)) ? Number(x) : null));
  appendFileSync(HISTORY_PATH, JSON.stringify({
    at: now.toISOString(),
    subs: numOrNull(stats.subscriberCount),
    views: numOrNull(stats.viewCount),
    videoCount: numOrNull(stats.videoCount),
  }) + '\n');

  // 2) 업로드 목록 (첫 실행 또는 --deep 이면 2페이지 = 최대 100편 백필)
  const index = loadJSON(INDEX_PATH, { channelId, uploads_playlist_id: uploads, videos: {} });
  const firstRun = !Object.keys(index.videos).length;
  const pages = (values.deep || firstRun) ? 2 : 1;
  const seenIds = new Set();
  const ids = [];
  let pageToken;
  for (let p = 0; p < pages; p++) {
    const pl = await yt(token, 'playlistItems', {
      part: 'contentDetails', playlistId: uploads, maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of pl.items ?? []) {
      const vid = it.contentDetails?.videoId;
      if (vid && !seenIds.has(vid)) { seenIds.add(vid); ids.push(vid); }
    }
    pageToken = pl.nextPageToken;
    if (!pageToken) break;
  }

  // 3) 상세 (50개 단위 — 페이지당 1 unit)
  let fetched = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const vs = await yt(token, 'videos', {
      part: 'snippet,statistics,contentDetails,status', id: ids.slice(i, i + 50).join(','),
    });
    for (const v of vs.items ?? []) {
      const durS = parseDuration(v.contentDetails?.duration);
      const prev = index.videos[v.id] ?? {};
      index.videos[v.id] = {
        title: v.snippet?.title ?? prev.title ?? '',
        publishedAt: v.snippet?.publishedAt ?? prev.publishedAt ?? null,
        duration: v.contentDetails?.duration ?? prev.duration ?? null,
        duration_s: durS ?? prev.duration_s ?? null,
        length_bucket: lengthBucket(durS),
        isShorts: isShorts(durS),
        tags: v.snippet?.tags ?? prev.tags ?? [],
        privacy: v.status?.privacyStatus ?? prev.privacy ?? null,
        stats_history: appendStatsHistory(prev.stats_history, {
          at: now.toISOString(),
          views: Number(v.statistics?.viewCount) || 0,
          likes: Number(v.statistics?.likeCount) || 0,
          comments: Number(v.statistics?.commentCount) || 0,
        }),
      };
      fetched++;
    }
  }
  index.channelId = channelId;
  index.uploads_playlist_id = uploads;
  index.updated_at = now.toISOString();
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));

  // 4) Analytics 프로브 (스코프 없으면 조용히 건너뜀)
  const an = await tryAnalytics(token, channelId, dateStr);
  if (an) {
    writeFileSync(join(OUT_DIR, `analytics-${dateStr}.json`), JSON.stringify(an, null, 2));
  }

  console.log(`📊 fetch-channel-stats: ${c.snippet?.title} — subs=${stats.subscriberCount} views=${stats.viewCount} videos=${stats.videoCount}`);
  console.log(`   인덱스 ${Object.keys(index.videos).length}편 (이번 회차 ${fetched}편 갱신${firstRun ? ' · 첫 실행 백필' : ''})`);
  console.log(`   Analytics API: ${an ? '✓ 수집' : '스코프 없음 — 건너뜀 (yt-analytics.readonly 재동의 시 자동 활성)'}`);
}

main().catch((e) => {
  // 관측 실패가 뒤 단계·EP 생산을 막지 않는다 — 항상 exit 0.
  console.error(`⚠️ fetch-channel-stats 실패 (exit 0 유지): ${e.message}`);
  process.exit(0);
});
