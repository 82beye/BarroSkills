#!/usr/bin/env node

/**
 * resolve-competitor-channels.js — 경쟁사 채널 동적 해석기
 *
 * 입력 소스 (정적 channels[] 목록 없음):
 *  1. paperclip/config/competitor-channels.json   — 추출 정책 (v2.0)
 *  2. workspace/intel/marketing/*.json            — Marketing Analyst 리포트 (가장 최근 N개)
 *  3. paperclip/config/competitor-channel-overrides.json — 운영자 수동 매핑
 *  4. workspace/intel/competitors/channel-id-cache.json  — name → UC ID 캐시
 *
 * 흐름:
 *  1. 정책 로드
 *  2. 가장 최근 N개 마케팅 리포트 → 마크다운 body에서 채널명 추출 (h3/h2/table_row 정규식)
 *  3. 추출된 이름 → overrides → cache → YouTube search.list 순으로 UC ID 해석
 *  4. cache 갱신 후 결과 반환 [{name, channelId, source_issue, resolved_via}]
 *
 * Usage (라이브러리로 import):
 *   const { resolveCompetitorChannels } = await import('./resolve-competitor-channels.js');
 *   const channels = await resolveCompetitorChannels({ accessToken });
 *
 * Usage (CLI 검증):
 *   node resolve-competitor-channels.js --dry-run    # API 호출 없이 추출 결과만
 *   node resolve-competitor-channels.js --resolve    # YouTube API로 UC ID까지 해석 (cache miss 시)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const POLICY = join(ROOT, 'paperclip', 'config', 'competitor-channels.json');
const OVERRIDES = join(ROOT, 'paperclip', 'config', 'competitor-channel-overrides.json');
const CACHE = join(ROOT, 'workspace', 'intel', 'competitors', 'channel-id-cache.json');
const YT_API = 'https://www.googleapis.com/youtube/v3';

function loadJSON(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

function saveJSON(path, data) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function listRecentReports(dir, maxReports, maxAgeDays) {
  if (!existsSync(dir)) return [];
  const ageCutoff = Date.now() - maxAgeDays * 86400 * 1000;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .filter((x) => x.m >= ageCutoff)
    .sort((a, b) => b.m - a.m)
    .slice(0, maxReports)
    .map((x) => join(dir, x.f));
}

function extractChannelNames(body, policy) {
  const names = new Map(); // name → first match line
  const patterns = policy.extraction.channel_name_patterns || [];
  const exclude = new Set(policy.extraction.exclude_names || []);
  const minLen = policy.extraction.min_name_length || 2;
  const maxLen = policy.extraction.max_name_length || 30;
  for (const pat of patterns) {
    const re = new RegExp(pat.regex, 'gm');
    let m;
    while ((m = re.exec(body)) !== null) {
      const name = (m[1] || '').trim().replace(/\s+/g, ' ');
      if (!name) continue;
      if (exclude.has(name)) continue;
      if (name.length < minLen || name.length > maxLen) continue;
      if (/^[\-:|]+$/.test(name)) continue;
      if (!names.has(name)) names.set(name, pat.type);
    }
  }
  return [...names.entries()].map(([name, via]) => ({ name, extracted_via: via }));
}

async function ytSearchChannel(name, accessToken, policy) {
  const url = new URL(`${YT_API}/search`);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('q', name);
  url.searchParams.set('type', 'channel');
  url.searchParams.set('maxResults', String(policy.channel_id_resolution.search_max_results || 3));
  if (policy.channel_id_resolution.search_region_code) {
    url.searchParams.set('regionCode', policy.channel_id_resolution.search_region_code);
  }
  if (policy.channel_id_resolution.search_relevance_language) {
    url.searchParams.set('relevanceLanguage', policy.channel_id_resolution.search_relevance_language);
  }
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`YT search ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const items = data.items || [];
  if (items.length === 0) return null;
  // 가장 정확한 매칭: title이 정확히 같으면 우선, 없으면 첫 결과
  const exact = items.find((it) => it.snippet?.title?.trim() === name);
  return (exact || items[0]).snippet?.channelId || items[0].id?.channelId || null;
}

export async function resolveCompetitorChannels({ accessToken = null, allowResolve = true } = {}) {
  const policy = loadJSON(POLICY);
  if (!policy || policy.version !== '2.0') {
    throw new Error(`Invalid or missing policy (expected v2.0): ${POLICY}`);
  }

  const sourceDir = join(ROOT, policy.extraction.source_dir);
  const reports = listRecentReports(sourceDir, policy.extraction.max_reports, policy.extraction.max_age_days);
  if (reports.length === 0) {
    return { policy, channels: [], reports: [], note: `No marketing reports found in ${sourceDir} within ${policy.extraction.max_age_days} days` };
  }

  // 채널 이름 추출 (출처 issue 기록)
  const nameMap = new Map(); // name → { name, sources: [issueId,...], extracted_via }
  for (const path of reports) {
    const data = loadJSON(path);
    const body = data?.report?.body || '';
    const issueId = data?.issue?.identifier || resolve(path);
    for (const { name, extracted_via } of extractChannelNames(body, policy)) {
      const cur = nameMap.get(name);
      if (cur) cur.sources.push(issueId);
      else nameMap.set(name, { name, sources: [issueId], extracted_via });
    }
  }

  // UC ID 해석: overrides → cache → search
  const overrides = loadJSON(OVERRIDES, { overrides: {} }).overrides || {};
  const cache = loadJSON(CACHE, { resolved: {} });
  if (!cache.resolved) cache.resolved = {};

  const channels = [];
  for (const entry of nameMap.values()) {
    const { name, sources, extracted_via } = entry;
    let channelId = null;
    let via = null;

    if (overrides[name]) {
      channelId = overrides[name];
      via = 'manual_override';
    } else if (cache.resolved[name]) {
      channelId = cache.resolved[name].channelId;
      via = 'cache';
    } else if (allowResolve && accessToken && policy.channel_id_resolution.youtube_search_when_miss) {
      try {
        channelId = await ytSearchChannel(name, accessToken, policy);
        via = channelId ? 'youtube_search' : null;
        if (channelId) {
          cache.resolved[name] = { channelId, resolved_at: new Date().toISOString() };
        }
      } catch (e) {
        via = `error:${e.message.slice(0, 80)}`;
      }
    } else {
      via = 'unresolved';
    }

    channels.push({
      name,
      channelId,
      sources,
      extracted_via,
      resolved_via: via,
    });
  }

  saveJSON(CACHE, cache);
  return { policy, channels, reports };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      resolve: { type: 'boolean', default: false },
    },
  });

  let accessToken = null;
  if (values.resolve && !values['dry-run']) {
    // OAuth는 publish-youtube.js와 동일 방식 — getSecret 동적 import (CLI 모드만)
    const { getSecret } = await import('./config-loader.js');
    const clientId = getSecret('YOUTUBE_OAUTH_CLIENT_ID');
    const clientSecret = getSecret('YOUTUBE_OAUTH_CLIENT_SECRET');
    const refreshToken = getSecret('YOUTUBE_OAUTH_REFRESH_TOKEN');
    if (!clientId || !clientSecret || !refreshToken) {
      console.error('✗ Missing YOUTUBE_OAUTH_* secrets. Either set them or run with --dry-run.');
      process.exit(2);
    }
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    if (!r.ok) { console.error(`✗ OAuth ${r.status}: ${await r.text()}`); process.exit(1); }
    accessToken = (await r.json()).access_token;
  }

  const result = await resolveCompetitorChannels({ accessToken, allowResolve: values.resolve });
  console.log(`📰 Recent reports: ${result.reports.length}`);
  for (const r of result.reports) console.log(`   - ${r.replace(ROOT + '/', '')}`);
  console.log(`\n🎯 Resolved channels: ${result.channels.length}`);
  for (const c of result.channels) {
    const id = c.channelId || '(unresolved)';
    console.log(`   - ${c.name.padEnd(20)} ${id.padEnd(28)} via=${c.resolved_via}  src=${c.sources.join(',')}`);
  }
  if (result.note) console.log(`\nℹ ${result.note}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✗ ${e.stack || e.message}`);
    process.exit(1);
  });
}
