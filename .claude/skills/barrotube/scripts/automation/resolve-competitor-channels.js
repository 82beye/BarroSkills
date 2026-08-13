#!/usr/bin/env node

/**
 * resolve-competitor-channels.js — 경쟁사 채널 해석기
 *
 * 입력 소스:
 *  1. config/competitor-channels.json                 — 채널 정본 (v3.0) 또는 추출 정책 (v2.0 레거시)
 *  2. config/competitor-channel-overrides.json        — 운영자 수동 매핑 (최우선)
 *  3. workspace/intel/competitors/channel-id-cache.json — name → UC ID 캐시
 *  4. workspace/intel/marketing/*.json                — v2.0 레거시 경로에서만 사용
 *
 * 흐름 (v3.0):
 *  1. 정책 로드 → policy.channels[] 를 정본으로 사용
 *  2. overrides → config.channelId → cache 순으로 UC ID 결정
 *  3. 마케팅 리포트를 읽지 않으므로 리포트 만료와 무관하게 항상 목록이 나온다
 *
 * 흐름 (v2.0 레거시):
 *  최근 N개 마케팅 리포트 → 마크다운에서 채널명 추출 → search.list 로 UC ID 해석
 *  ※ 리포트가 max_age_days 를 넘기면 목록이 빈 배열이 된다 (v3.0 도입 사유)
 *
 * Usage (라이브러리로 import):
 *   const { resolveCompetitorChannels } = await import('./resolve-competitor-channels.js');
 *   const channels = await resolveCompetitorChannels({ accessToken });
 *
 * Usage (CLI 검증):
 *   node resolve-competitor-channels.js --dry-run    # API 호출 없이 목록만
 *   node resolve-competitor-channels.js --resolve    # v2.0 레거시: search.list 로 UC ID 해석
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const POLICY = join(ROOT, 'config', 'competitor-channels.json');
const OVERRIDES = join(ROOT, 'config', 'competitor-channel-overrides.json');
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

/**
 * handle(@name) → UC ID. channels.list?forHandle 는 1 unit 이라
 * search.list(100 units) 대비 100배 싸고 동명 채널 오매칭도 없다.
 */
export async function resolveByHandle(handle, accessToken) {
  const url = new URL(`${YT_API}/channels`);
  url.searchParams.set('part', 'id,snippet');
  url.searchParams.set('forHandle', handle.startsWith('@') ? handle : `@${handle}`);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`YT channels.list(forHandle=${handle}) ${r.status}: ${await r.text()}`);
  const item = (await r.json()).items?.[0];
  return item ? { channelId: item.id, title: item.snippet?.title ?? null } : null;
}

/** channelId 가 비어 있는 채널만 handle 로 해석하고 캐시에 적재한다. 채널당 1 unit. */
async function resolveHandles(accessToken) {
  const policy = loadJSON(POLICY);
  if (!policy || policy.version !== '3.0') {
    throw new Error(`--resolve-handles requires policy v3.0: ${POLICY}`);
  }
  const cache = loadJSON(CACHE, { resolved: {} });
  if (!cache.resolved) cache.resolved = {};

  const pending = (policy.channels || []).filter((c) => c.active !== false && !c.channelId && c.handle);
  if (pending.length === 0) {
    console.log('✓ 모든 활성 채널에 channelId 가 있다 — 해석할 대상 없음 (0 units)');
    return;
  }

  console.log(`🔎 handle 해석 대상 ${pending.length}건 (예상 ${pending.length} units)\n`);
  const patch = [];
  for (const c of pending) {
    try {
      const hit = await resolveByHandle(c.handle, accessToken);
      if (!hit) {
        console.warn(`  ✗ ${c.name} ${c.handle} — forHandle 결과 없음`);
        continue;
      }
      cache.resolved[c.name] = {
        channelId: hit.channelId,
        handle: c.handle,
        api_title: hit.title,
        resolved_at: new Date().toISOString(),
      };
      patch.push({ id: c.id, name: c.name, channelId: hit.channelId, api_title: hit.title });
      console.log(`  ✓ ${c.name} ${c.handle} → ${hit.channelId}  (API 표기: ${hit.title})`);
    } catch (e) {
      console.error(`  ✗ ${c.name} ${c.handle} — ${e.message}`);
    }
  }

  saveJSON(CACHE, cache);
  console.log(`\n✓ 캐시 갱신: ${CACHE.replace(ROOT + '/', '')}`);

  if (patch.length > 0) {
    console.log('\n📋 config/competitor-channels.json 의 해당 항목에 붙여넣을 값:');
    for (const p of patch) console.log(`   "${p.id}" → "channelId": "${p.channelId}"`);
    console.log('\n   (캐시만으로도 동작하지만, config 에 넣어야 캐시 삭제에도 살아남는다)');
  }
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

/**
 * v3.0 정본 경로 — 정적 channels[] 를 그대로 쓴다. API 호출 없음.
 * UC ID 우선순위: overrides > config.channelId > cache
 */
function resolveFromStaticList(policy) {
  const overrides = loadJSON(OVERRIDES, { overrides: {} }).overrides || {};
  const cached = loadJSON(CACHE, { resolved: {} }).resolved || {};

  const channels = (policy.channels || [])
    .filter((c) => c.active !== false)
    .map((c) => {
      let channelId = null;
      let via = 'unresolved';
      if (overrides[c.name]) {
        channelId = overrides[c.name];
        via = 'manual_override';
      } else if (c.channelId) {
        channelId = c.channelId;
        via = 'config';
      } else if (cached[c.name]?.channelId) {
        channelId = cached[c.name].channelId;
        via = 'cache';
      }
      return {
        id: c.id,
        name: c.name,
        handle: c.handle || null,
        tier: c.tier || 'core',
        competes_with: c.competes_with || [],
        channelId,
        sources: ['config/competitor-channels.json'],
        extracted_via: 'static_config',
        resolved_via: via,
      };
    });

  const missing = channels.filter((c) => !c.channelId);
  return {
    policy,
    channels,
    reports: [],
    note: missing.length
      ? `${missing.length} channel(s) without UC ID: ${missing.map((c) => c.name).join(', ')} — handle 해석이 필요하다`
      : null,
  };
}

export async function resolveCompetitorChannels({ accessToken = null, allowResolve = true } = {}) {
  const policy = loadJSON(POLICY);
  if (!policy) {
    throw new Error(`Missing policy: ${POLICY}`);
  }

  // v3.0: 정적 목록이 정본. 마케팅 리포트 신선도와 무관하게 항상 목록이 나온다.
  if (policy.version === '3.0') {
    return resolveFromStaticList(policy);
  }

  if (policy.version !== '2.0') {
    throw new Error(`Unsupported policy version "${policy.version}" (expected 3.0 or 2.0): ${POLICY}`);
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
      'resolve-handles': { type: 'boolean', default: false },
    },
  });

  const needsToken = (values.resolve || values['resolve-handles']) && !values['dry-run'];
  let accessToken = null;
  if (needsToken) {
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

  if (values['resolve-handles']) {
    await resolveHandles(accessToken);
    return;
  }

  const result = await resolveCompetitorChannels({ accessToken, allowResolve: values.resolve });
  if (result.reports.length > 0) {
    console.log(`📰 Recent reports: ${result.reports.length}`);
    for (const r of result.reports) console.log(`   - ${r.replace(ROOT + '/', '')}`);
  } else {
    console.log(`📋 Source: config/competitor-channels.json (v${result.policy.version})`);
  }
  console.log(`\n🎯 Resolved channels: ${result.channels.length}`);
  for (const c of result.channels) {
    const id = c.channelId || '(unresolved)';
    const label = c.handle ? `${c.name} ${c.handle}` : c.name;
    console.log(`   - ${label.padEnd(32)} ${id.padEnd(26)} via=${c.resolved_via}`);
  }
  if (result.note) console.log(`\nℹ ${result.note}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✗ ${e.stack || e.message}`);
    process.exit(1);
  });
}
