#!/usr/bin/env node

/**
 * fetch-competitor-stats.js — 경쟁 채널 정량 트래커 (v2.0, 2026-05-01)
 *
 * 채널 목록은 정적 config가 아닌 Marketing Analyst 리포트에서 동적 추출됨:
 *   resolve-competitor-channels.js
 *     ← workspace/intel/marketing/*.json (PaperClip Marketing Analyst 산출물)
 *     ← paperclip/config/competitor-channels.json (추출 정책 v2.0)
 *     ← paperclip/config/competitor-channel-overrides.json (운영자 수동 매핑)
 *     ← workspace/intel/competitors/channel-id-cache.json (자동 캐시)
 *
 * 동작:
 *   1. 마케팅 리포트에서 채널명 추출
 *   2. overrides → cache → YouTube search.list 순으로 UC ID 해석
 *   3. channels.list (구독자/총조회수) + search.list+videos.list (최근 N일 영상) fetch
 *   4. workspace/intel/competitors/YYYY-MM-DD.json에 산출
 *
 * 인증: publish-youtube.js의 OAuth refresh_token 재사용
 *
 * Usage:
 *   node fetch-competitor-stats.js                # 정상 실행 (UC 미해석 시 search.list 자동 호출)
 *   node fetch-competitor-stats.js --dry-run      # API 호출 없이 추출 결과만 출력
 *   node fetch-competitor-stats.js --skip-resolve # cache+overrides만 사용, search.list 호출 금지
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getSecret } from './config-loader.js';
import { resolveCompetitorChannels } from './resolve-competitor-channels.js';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT_DIR = join(ROOT, 'workspace', 'intel', 'competitors');
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YT_API = 'https://www.googleapis.com/youtube/v3';

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

async function ytGet(path, params, accessToken) {
  const url = new URL(`${YT_API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`YT ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchChannelStats(channelId, accessToken) {
  const data = await ytGet('channels', {
    part: 'snippet,statistics,brandingSettings',
    id: channelId,
  }, accessToken);
  const item = data.items?.[0];
  if (!item) return null;
  return {
    channelId: item.id,
    title: item.snippet?.title,
    customUrl: item.snippet?.customUrl,
    publishedAt: item.snippet?.publishedAt,
    statistics: item.statistics,
    branding_keywords: item.brandingSettings?.channel?.keywords,
  };
}

async function fetchRecentVideos(channelId, accessToken, windowDays = 7, maxResults = 10) {
  const sinceISO = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();
  const search = await ytGet('search', {
    part: 'id,snippet',
    channelId,
    order: 'date',
    type: 'video',
    publishedAfter: sinceISO,
    maxResults: String(maxResults),
  }, accessToken);
  const videoIds = (search.items || []).map((it) => it.id?.videoId).filter(Boolean);
  if (videoIds.length === 0) return [];
  const details = await ytGet('videos', {
    part: 'snippet,statistics,contentDetails',
    id: videoIds.join(','),
  }, accessToken);
  return (details.items || []).map((v) => ({
    videoId: v.id,
    title: v.snippet?.title,
    publishedAt: v.snippet?.publishedAt,
    duration: v.contentDetails?.duration,
    isShorts: /PT\d{0,2}([0-5]?\dS)?$/.test(v.contentDetails?.duration || ''),
    statistics: v.statistics,
    tags: v.snippet?.tags,
  }));
}

async function main() {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      'window-days': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'skip-resolve': { type: 'boolean', default: false },
    },
  });

  // 1. dry-run은 OAuth 없이 추출 결과만 보여줌
  if (values['dry-run']) {
    const r = await resolveCompetitorChannels({ accessToken: null, allowResolve: false });
    console.log(`📰 Recent marketing reports: ${r.reports.length}`);
    for (const p of r.reports) console.log(`   - ${p.replace(ROOT + '/', '')}`);
    console.log(`\n🎯 Channels (dry-run, UC unresolved unless cached):`);
    for (const c of r.channels) {
      console.log(`   - ${c.name.padEnd(20)} ${(c.channelId || '(unresolved)').padEnd(28)} via=${c.resolved_via}`);
    }
    if (r.note) console.log(`\nℹ ${r.note}`);
    console.log('\n✓ dry-run mode — no YouTube API calls made');
    return;
  }

  // 2. 정상 모드: OAuth 발급 → 채널 해석 → fetch
  const accessToken = await getAccessToken();
  const allowResolve = !values['skip-resolve'];
  const resolved = await resolveCompetitorChannels({ accessToken, allowResolve });

  const eligible = resolved.channels.filter((c) => c.channelId);
  console.log(`📊 fetch-competitor-stats: ${eligible.length}/${resolved.channels.length} channels with UC ID (from ${resolved.reports.length} marketing reports)`);
  if (eligible.length === 0) {
    console.warn('⚠ No channels with resolved UC ID. Possible causes:');
    console.warn('  - 0 recent marketing reports');
    console.warn('  - YouTube search.list returned no match for extracted names');
    console.warn('  - --skip-resolve set + empty cache');
    if (resolved.note) console.warn(`  - ${resolved.note}`);
    process.exit(0);
  }

  const policy = resolved.policy;
  const date = values.date || new Date().toISOString().slice(0, 10);
  const windowDays = parseInt(values['window-days'] || policy.tracking?.recent_videos_window_days || '7', 10);
  const maxVids = policy.tracking?.recent_videos_per_channel || 10;

  const result = {
    fetched_at: new Date().toISOString(),
    window_days: windowDays,
    sourced_reports: resolved.reports.map((p) => p.replace(ROOT + '/', '')),
    channel_count: eligible.length,
    unresolved_count: resolved.channels.length - eligible.length,
    unresolved: resolved.channels.filter((c) => !c.channelId).map((c) => ({ name: c.name, resolved_via: c.resolved_via, sources: c.sources })),
    channels: [],
  };

  for (const ch of eligible) {
    try {
      const stats = await fetchChannelStats(ch.channelId, accessToken);
      if (!stats) {
        console.warn(`  ⚠ ${ch.name} (${ch.channelId}) not found via channels.list`);
        continue;
      }
      const videos = await fetchRecentVideos(ch.channelId, accessToken, windowDays, maxVids);
      result.channels.push({
        resolved: ch,
        stats,
        recent_videos: videos,
      });
      console.log(`  ✓ ${stats.title} — subs=${stats.statistics?.subscriberCount}, ${videos.length} new in ${windowDays}d`);
    } catch (e) {
      console.error(`  ✗ ${ch.name} (${ch.channelId}) fetch error: ${e.message}`);
      result.channels.push({ resolved: ch, error: e.message });
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n✓ Saved: ${outPath}`);
  console.log(`  Quota used (approx): channels.list ${eligible.length} + search.list ${eligible.length}*100 + videos.list ${eligible.length} ≈ ${eligible.length * 102} units`);
  if (result.unresolved_count > 0) {
    console.log(`  ⚠ ${result.unresolved_count} unresolved name(s). Add manual entry in paperclip/config/competitor-channel-overrides.json if needed.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✗ ${e.stack || e.message}`);
    process.exit(1);
  });
}
