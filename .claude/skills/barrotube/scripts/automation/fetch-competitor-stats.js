#!/usr/bin/env node

/**
 * fetch-competitor-stats.js — 경쟁 채널 정량 트래커 (schema v2)
 *
 * 채널 목록 정본: config/competitor-channels.json (v3.0) 의 정적 channels[]
 *
 * 수집 경로 — search.list(100 units) 를 쓰지 않는다:
 *   channels.list(snippet,statistics,contentDetails,brandingSettings)  1 unit → uploads 재생목록 ID
 *   playlistItems.list(contentDetails, playlistId=UU…, maxResults=50)  1 unit → 최근 영상 ID
 *   videos.list(snippet,statistics,contentDetails, id=최대 50개)        1 unit → 길이·조회수·태그
 *   ────────────────────────────────────────────────────────────────
 *   채널당 3 units (구 방식 102 units 대비 34배 절감)
 *
 * 산출:
 *   workspace/intel/competitors/YYYY-MM-DD.json          — 당일 스냅샷
 *   workspace/intel/competitors/videos/<channelId>.json  — 영구 인덱스 + stats_history
 *   workspace/intel/competitors/quota-YYYY-MM-DD.json    — 쿼터 원장
 *
 * 실패 정책: 어떤 오류에서도 exit 0. 인텔 수집이 EP 생산을 막지 않는다.
 *   quota  → 남은 채널 중단, degraded:'quota' 로 부분 저장
 *   auth   → degraded:'auth' 로 기록 (OAuth 갱신 필요)
 *   기타   → 해당 채널만 error 기록 후 다음 채널 계속
 *
 * 인증: publish-youtube.js의 OAuth refresh_token 재사용
 *
 * Usage:
 *   node fetch-competitor-stats.js                    # 정상 실행
 *   node fetch-competitor-stats.js --dry-run          # API 0콜, 대상·쿼터 예상치만
 *   node fetch-competitor-stats.js --date 2026-08-13  # 산출 파일명 지정
 *   node fetch-competitor-stats.js --window-days 7    # recent_videos 윈도
 *   node fetch-competitor-stats.js --deep             # 주 1회: uploads 4페이지까지 (9 units/채널)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getSecret } from './config-loader.js';
import { resolveCompetitorChannels } from './resolve-competitor-channels.js';
import {
  parseDuration, lengthBucket, isShorts,
  planQuota, quotaPreflight, classifyApiError, uploadsPlaylistId,
  selectVideoIdsToFetch, appendStatsHistory, subscriberDelta,
} from './lib/competitor-analytics.js';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT_DIR = join(ROOT, 'workspace', 'intel', 'competitors');
const INDEX_DIR = join(OUT_DIR, 'videos');
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YT_API = 'https://www.googleapis.com/youtube/v3';

class YtError extends Error {
  constructor(status, body, path) {
    super(`YT ${path} ${status}: ${String(body).slice(0, 200)}`);
    this.status = status;
    this.kind = classifyApiError(status, body);
  }
}

function loadJSON(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

function saveJSON(path, data) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

async function getAccessToken() {
  const clientId = getSecret('YOUTUBE_OAUTH_CLIENT_ID');
  const clientSecret = getSecret('YOUTUBE_OAUTH_CLIENT_SECRET');
  const refreshToken = getSecret('YOUTUBE_OAUTH_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing YOUTUBE_OAUTH_* env vars. Run /setup-youtube-oauth first.');
  }
  const r = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`OAuth token refresh failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

/** 쿼터 원장. 모든 API 호출이 이 함수를 거친다. */
function makeLedger(date, cap) {
  const path = join(OUT_DIR, `quota-${date}.json`);
  const prior = loadJSON(path, { date, units_used: 0, cap, calls: [] });
  return {
    path,
    date,
    cap,
    get used() { return prior.units_used; },
    record(api, units, channel, now) {
      prior.units_used += units;
      prior.calls.push({ at: now.toISOString(), api, units, channel });
    },
    save() { prior.cap = cap; saveJSON(path, prior); },
  };
}

async function ytGet(path, params, accessToken, ledger, channelId, now) {
  const url = new URL(`${YT_API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  ledger.record(path, 1, channelId, now);
  if (!r.ok) throw new YtError(r.status, await r.text(), path);
  return r.json();
}

/**
 * 채널 1개 수집. 3 units.
 * 인덱스를 갱신하고 window 이내 영상을 recent_videos 로 돌려준다.
 */
async function collectChannel(ch, accessToken, opts, ledger, now) {
  const { windowDays, tracking } = opts;

  const chanData = await ytGet('channels', {
    part: 'snippet,statistics,contentDetails,brandingSettings',
    id: ch.channelId,
  }, accessToken, ledger, ch.channelId, now);

  const item = chanData.items?.[0];
  if (!item) return { missing: true };

  const stats = {
    channelId: item.id,
    title: item.snippet?.title,
    customUrl: item.snippet?.customUrl,
    publishedAt: item.snippet?.publishedAt,
    statistics: item.statistics,
    branding_keywords: item.brandingSettings?.channel?.keywords,
  };

  const uploads = item.contentDetails?.relatedPlaylists?.uploads || uploadsPlaylistId(ch.channelId);
  if (!uploads) return { stats, recent_videos: [], note: 'uploads playlist unavailable' };

  // 기본은 1페이지(50개). --deep 이면 nextPageToken 을 따라 pages 회 페이징한다.
  // 90일 baseline 은 업로드가 잦은 채널(삼프로·심플관심종목)에서 50개로 안 채워진다.
  const pages = opts.deep ? (tracking.deep_scan_pages ?? 4) : 1;
  const candidates = [];
  let pageToken;
  for (let i = 0; i < pages; i++) {
    const params = {
      part: 'contentDetails',
      playlistId: uploads,
      maxResults: String(tracking.uploads_page_size ?? 50),
    };
    if (pageToken) params.pageToken = pageToken;

    const page = await ytGet('playlistItems', params, accessToken, ledger, ch.channelId, now);
    for (const it of page.items || []) {
      if (it.contentDetails?.videoId) {
        candidates.push({
          videoId: it.contentDetails.videoId,
          publishedAt: it.contentDetails.videoPublishedAt,
        });
      }
    }
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }

  const indexPath = join(INDEX_DIR, `${ch.channelId}.json`);
  const index = loadJSON(indexPath, { channelId: ch.channelId, uploads_playlist_id: uploads, videos: {} });
  if (!index.videos) index.videos = {};

  const toFetch = selectVideoIdsToFetch(candidates, index, {
    refreshWindowDays: tracking.refresh_window_days ?? 14,
    limit: pages * 50,
    now,
  });

  // videos.list 는 한 호출에 50개까지다. deep scan 은 그보다 많이 모으므로 청크로 나눈다.
  for (let i = 0; i < toFetch.length; i += 50) {
    const batch = toFetch.slice(i, i + 50);
    const details = await ytGet('videos', {
      part: 'snippet,statistics,contentDetails',
      id: batch.join(','),
    }, accessToken, ledger, ch.channelId, now);

    for (const v of details.items || []) {
      const sec = parseDuration(v.contentDetails?.duration);
      const prev = index.videos[v.id];
      index.videos[v.id] = {
        title: v.snippet?.title,
        publishedAt: v.snippet?.publishedAt,
        duration: v.contentDetails?.duration,
        duration_s: sec,
        length_bucket: lengthBucket(sec),
        isShorts: isShorts(sec),
        tags: v.snippet?.tags,
        thumbnail: v.snippet?.thumbnails?.high?.url ?? v.snippet?.thumbnails?.default?.url,
        first_seen: prev?.first_seen ?? now.toISOString(),
        stats_history: appendStatsHistory(prev?.stats_history, {
          at: now.toISOString(),
          views: Number(v.statistics?.viewCount ?? 0),
          likes: Number(v.statistics?.likeCount ?? 0),
          comments: Number(v.statistics?.commentCount ?? 0),
        }, tracking.stats_history_max ?? 30),
      };
    }
  }

  index.uploads_playlist_id = uploads;
  index.updated_at = now.toISOString();
  saveJSON(indexPath, index);

  // window 이내 영상을 인덱스에서 뽑는다 — 이번에 안 받은 영상도 마지막 스냅샷으로 포함된다
  const cutoff = now.getTime() - windowDays * 86400_000;
  const recent = Object.entries(index.videos)
    .filter(([, v]) => {
      const t = Date.parse(v.publishedAt ?? '');
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(b[1].publishedAt) - Date.parse(a[1].publishedAt))
    .slice(0, tracking.recent_videos_per_channel ?? 50)
    .map(([videoId, v]) => {
      const last = v.stats_history?.[v.stats_history.length - 1];
      return {
        videoId,
        title: v.title,
        publishedAt: v.publishedAt,
        duration: v.duration,
        duration_s: v.duration_s,
        length_bucket: v.length_bucket,
        isShorts: v.isShorts,
        statistics: {
          viewCount: String(last?.views ?? 0),
          likeCount: String(last?.likes ?? 0),
          commentCount: String(last?.comments ?? 0),
        },
        stats_at: last?.at ?? null,
        tags: v.tags,
        thumbnail: v.thumbnail,
      };
    });

  return { stats, recent_videos: recent, fetched_now: toFetch.length };
}

/** 7일 전(없으면 5~10일 전 가장 가까운) 스냅샷에서 구독자 수를 찾는다. */
function priorSubscribers(date, channelId) {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(base)) return null;
  for (const back of [7, 6, 8, 5, 9, 10]) {
    const d = new Date(base - back * 86400_000).toISOString().slice(0, 10);
    const snap = loadJSON(join(OUT_DIR, `${d}.json`));
    const hit = snap?.channels?.find((c) => c.resolved?.channelId === channelId);
    const subs = hit?.stats?.statistics?.subscriberCount;
    if (subs !== undefined) return Number(subs);
  }
  return null;
}

async function main() {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      'window-days': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      deep: { type: 'boolean', default: false },
    },
  });

  const now = new Date();
  const date = values.date || now.toISOString().slice(0, 10);
  const resolved = await resolveCompetitorChannels({ accessToken: null, allowResolve: false });
  const policy = resolved.policy;
  const tracking = policy.tracking ?? {};
  const cap = policy.quota?.daily_cap_units ?? 2000;
  const windowDays = parseInt(values['window-days'] || tracking.recent_videos_window_days || '7', 10);
  const eligible = resolved.channels.filter((c) => c.channelId);

  if (values['dry-run']) {
    console.log(`📋 Source: config/competitor-channels.json (v${policy.version})\n`);
    console.log('🎯 Channels:');
    for (const c of resolved.channels) {
      const label = c.handle ? `${c.name} ${c.handle}` : c.name;
      console.log(`   - ${label.padEnd(32)} ${(c.channelId || '(unresolved)').padEnd(26)} via=${c.resolved_via}`);
    }
    const planned = planQuota(eligible.length, { deep: values.deep, pages: tracking.deep_scan_pages ?? 4 });
    const ledger = makeLedger(date, cap);
    const per = values.deep ? (tracking.deep_scan_pages ?? 4) * 2 + 1 : 3;
    console.log(`\n📐 Quota: ${eligible.length} × ${per} = ${planned} units${values.deep ? ' (deep scan)' : ''} (today used ${ledger.used}/${cap})`);
    if (resolved.note) console.log(`\nℹ ${resolved.note}`);
    console.log('\n✓ dry-run mode — no YouTube API calls made');
    return;
  }

  console.log(`📊 fetch-competitor-stats: ${eligible.length}/${resolved.channels.length} channels (config v${policy.version})`);
  if (eligible.length === 0) {
    console.warn('⚠ UC ID 가 있는 채널이 없다.');
    console.warn('  - config/competitor-channels.json 의 channels[] 확인');
    console.warn('  - handle 만 있다면: resolve-competitor-channels.js --resolve-handles');
    if (resolved.note) console.warn(`  - ${resolved.note}`);
    return;
  }

  const ledger = makeLedger(date, cap);
  const planned = planQuota(eligible.length, { deep: values.deep, pages: tracking.deep_scan_pages ?? 4 });
  const pre = quotaPreflight({ used: ledger.used, planned, cap });
  if (!pre.allowed) {
    console.warn(`⚠ ${pre.reason} — 오늘 수집을 건너뛴다`);
    return;
  }

  // 토큰을 루프 밖에서 한 번만 확보한다.
  // 채널 루프 안에서 발급하면 OAuth 만료 시 채널 수만큼 무의미한 재시도가 일어나고,
  // 그 실패들이 채널별 error 로 기록돼 degraded='auth' 라는 진짜 원인을 가린다.
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    console.error(`✗ OAuth 실패 — 수집을 시작하지 않는다: ${e.message.split('\n')[0]}`);
    console.error('  갱신: node scripts/automation/setup-youtube-oauth.js');
    console.error('  (기존 스냅샷은 그대로 보존된다)');
    return;
  }

  const result = {
    schema_version: 2,
    fetched_at: now.toISOString(),
    window_days: windowDays,
    channel_count: 0,
    unresolved_count: resolved.channels.length - eligible.length,
    unresolved: resolved.channels.filter((c) => !c.channelId).map((c) => ({
      name: c.name, handle: c.handle, resolved_via: c.resolved_via,
    })),
    degraded: null,
    deep_scan: values.deep,
    quota: { planned_units: planned, used_units: 0, cap },
    channels: [],
  };

  const before = ledger.used;

  for (const ch of eligible) {
    try {
      const got = await collectChannel(ch, accessToken, { windowDays, tracking, deep: values.deep }, ledger, now);
      if (got.missing) {
        console.warn(`  ⚠ ${ch.name} (${ch.channelId}) — channels.list 결과 없음`);
        result.channels.push({ resolved: ch, error: 'channel not found' });
        continue;
      }
      const prevSubs = priorSubscribers(date, ch.channelId);
      got.stats.subscriber_delta_7d = subscriberDelta(got.stats.statistics?.subscriberCount, prevSubs);

      result.channels.push({ resolved: ch, stats: got.stats, recent_videos: got.recent_videos });
      const delta = got.stats.subscriber_delta_7d;
      const deltaStr = delta === null ? '' : ` (Δ7d ${delta >= 0 ? '+' : ''}${delta.toLocaleString()})`;
      console.log(`  ✓ ${got.stats.title} — subs=${got.stats.statistics?.subscriberCount}${deltaStr}, ${got.recent_videos.length} in ${windowDays}d, ${got.fetched_now} fetched`);
    } catch (e) {
      if (e instanceof YtError && (e.kind === 'quota' || e.kind === 'auth')) {
        result.degraded = e.kind;
        console.error(`  ✗ ${e.kind === 'quota' ? '쿼터 소진' : 'OAuth 만료'} — 남은 채널 중단: ${e.message}`);
        break;
      }
      console.error(`  ✗ ${ch.name} (${ch.channelId}): ${e.message}`);
      result.channels.push({ resolved: ch, error: e.message });
    }
  }

  result.channel_count = result.channels.filter((c) => c.stats).length;
  result.quota.used_units = ledger.used - before;
  ledger.save();

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${date}.json`);

  // 전 채널 실패 시 기존 스냅샷을 덮지 않는다.
  // fail-soft 는 "실패해도 파이프라인이 계속된다"는 뜻이지
  // "실패가 이미 확보한 데이터를 파괴해도 된다"는 뜻이 아니다.
  if (result.channel_count === 0 && existsSync(outPath)) {
    console.warn(`\n⚠ 수집 0건 — 기존 스냅샷을 보존한다: ${outPath.replace(ROOT + '/', '')}`);
    if (result.degraded) console.warn(`  degraded=${result.degraded}`);
    return;
  }

  saveJSON(outPath, result);

  console.log(`\n✓ Saved: ${outPath.replace(ROOT + '/', '')}`);
  console.log(`  Quota: ${result.quota.used_units} units used (today total ${ledger.used}/${cap})`);
  if (result.degraded) console.log(`  ⚠ degraded=${result.degraded} — 부분 저장됨`);
  if (result.unresolved_count > 0) {
    console.log(`  ⚠ ${result.unresolved_count}건 미해석. --resolve-handles 로 확보하거나 config 에 channelId 를 직접 넣어라.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // 인텔 실패가 파이프라인을 막지 않는다 — 로그만 남기고 정상 종료
    console.error(`✗ ${e.message}`);
    process.exitCode = 0;
  });
}
