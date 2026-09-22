#!/usr/bin/env node

/**
 * sync-youtube-state.js — 유튜브 실제 공개 상태를 캐시에 적는다 (2026-09-23)
 *
 * 왜 필요했나: 보드와 파이프라인이 "발행됨"을 **로컬 기록**으로 판정한다.
 * channel-adapters.js 의 parsePublishJson 은 `published = ... || Boolean(videoId)` 라서
 * 영상 ID 만 있으면 발행으로 센다. 그런데 슬롯 시각을 넘겨 예약이 걸리지 않으면 유튜브는
 * private 로 남긴다 — 업로드는 됐고 ID 도 있지만 아무도 못 본다.
 *
 * 2026-09-23 실측: 보드는 107편을 공개로 셌는데 유튜브 실제 공개는 65편이었다.
 * 24편이 비공개로 묻혀 있었고 그중 14편은 QA PASS 였다. 만들어 올려놓고 아무도
 * 모르게 사라진 영상이 14편이라는 뜻이다.
 *
 * videos.list 는 호출당 1유닛(일일 10,000)이고 50건씩 묶이므로 사실상 무과금이다.
 * 읽기 전용이라 영상 상태를 바꾸지 않는다.
 *
 * Usage:
 *   node scripts/automation/sync-youtube-state.js
 *   node scripts/automation/sync-youtube-state.js --quiet   # 크론용
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSecret } from './config-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const EPISODES = join(ROOT, 'workspace', 'episodes');
export const STATE_PATH = join(ROOT, 'workspace', 'youtube-state.json');

/** 에피소드 산출물에서 videoId 를 전부 긁는다. v1·v2 레이아웃을 모두 본다. */
export function collectVideoIds(episodesRoot = EPISODES) {
  const ids = new Map(); // videoId → episodeId
  if (!existsSync(episodesRoot)) return ids;

  for (const ep of readdirSync(episodesRoot).filter((d) => /^EP-/.test(d))) {
    const bases = [join(episodesRoot, ep)];
    const plat = join(episodesRoot, ep, 'platforms');
    if (existsSync(plat)) for (const p of readdirSync(plat)) bases.push(join(plat, p));

    for (const base of bases) {
      const f = join(base, '80_publish_result.json');
      if (!existsSync(f)) continue;
      try {
        const d = JSON.parse(readFileSync(f, 'utf8'));
        const id = d?.targets?.youtube?.videoId || d?.video_id;
        if (id) ids.set(id, ep);
      } catch { /* 손상된 파일 하나가 동기화 전체를 막지 않는다 */ }
    }
  }
  return ids;
}

async function accessToken() {
  const body = new URLSearchParams({
    client_id: getSecret('YOUTUBE_OAUTH_CLIENT_ID'),
    client_secret: getSecret('YOUTUBE_OAUTH_CLIENT_SECRET'),
    refresh_token: getSecret('YOUTUBE_OAUTH_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });
  const t = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!t.access_token) throw new Error(`OAuth 갱신 실패: ${t.error || 'unknown'} ${t.error_description || ''}`);
  return t.access_token;
}

export async function fetchLiveState(ids, token) {
  const out = {};
  const list = [...ids];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const r = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=status,statistics&id=${chunk.join(',')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const d = await r.json();
    if (d.error) throw new Error(`YouTube API: ${d.error.message}`);
    for (const v of d.items || []) {
      out[v.id] = {
        privacy: v.status.privacyStatus,
        publishAt: v.status.publishAt || null,
        uploadStatus: v.status.uploadStatus || null,
        views: Number(v.statistics?.viewCount ?? 0),
        likes: Number(v.statistics?.likeCount ?? 0),
      };
    }
    // 응답에 없는 ID 는 삭제됐거나 이 계정으로 못 본다. 빠뜨리면 보드가 그 편을
    // 계속 "정상"으로 보여 주므로 명시적으로 표시한다.
    for (const id of chunk) if (!out[id]) out[id] = { privacy: 'gone', publishAt: null, views: 0 };
  }
  return out;
}

async function main() {
  const { values } = parseArgs({ options: { quiet: { type: 'boolean' } } });
  const log = (...a) => { if (!values.quiet) console.log(...a); };

  const ids = collectVideoIds();
  if (ids.size === 0) { log('조회할 영상이 없습니다.'); return; }

  const videos = await fetchLiveState(ids.keys(), await accessToken());
  const byPrivacy = {};
  for (const v of Object.values(videos)) byPrivacy[v.privacy] = (byPrivacy[v.privacy] || 0) + 1;

  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({
    version: 1,
    checked_at: new Date().toISOString(),
    counts: byPrivacy,
    videos,
  }, null, 2)}\n`);

  log(`📺 유튜브 실제 상태 ${Object.keys(videos).length}건 — ${JSON.stringify(byPrivacy)}`);
  const buried = Object.entries(videos).filter(([, v]) => v.privacy === 'private').map(([id]) => ids.get(id));
  if (buried.length) log(`   비공개로 묻힌 편 ${buried.length}: ${buried.slice(0, 8).join(', ')}${buried.length > 8 ? ' …' : ''}`);
  log(`   → ${STATE_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
