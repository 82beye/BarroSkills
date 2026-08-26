#!/usr/bin/env node

/**
 * set-video-privacy.js — 이미 올라간 영상의 공개 상태만 바꾼다.
 *
 * 왜 필요한가. 슬롯 시각(us-close 08:00 · kr-close 18:00)을 넘겨 파이프라인이 끝나면
 * generate-metadata 의 resolvePublishAt 이 null 을 돌린다 — YouTube 가 과거 publishAt 을
 * 거부하기 때문이다. 그러면 영상은 **private 로 올라가고 그대로 묻힌다.**
 * 2026-08-26 EP-2026-0116·EP-2026-0117 이 연속으로 그렇게 됐다.
 *
 * 그 상태를 되돌리는 데 재업로드는 필요 없다. videos.update 로 status 만 고치면 된다.
 * 승인 토큰을 다시 발급할 필요도 없다 — 영상·메타데이터는 이미 승인된 그대로다.
 *
 * status 파트는 **전체 교체**라 빠뜨린 필드가 기본값으로 되돌아간다. 그래서 현재 값을
 * 먼저 읽어 보존하고 privacyStatus 만 바꾼다 (madeForKids 가 리셋되면 아동용 표시가
 * 뒤집힌다).
 *
 * Usage:
 *   node set-video-privacy.js --video <id> --privacy public
 *   node set-video-privacy.js --episode EP-2026-0117 --privacy public   # 결과 파일에서 id 조회
 *   node set-video-privacy.js --video <id> --privacy public --dry-run
 *
 * 종료코드: 0 = 변경했거나 이미 그 상태 · 1 = 실패 · 2 = 입력 오류
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { getSecret } from './config-loader.js';

const ROOT = resolve(import.meta.dirname, '../..');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3/videos';
const ALLOWED = ['public', 'unlisted', 'private'];

async function accessToken() {
  const body = new URLSearchParams({
    client_id: getSecret('YOUTUBE_OAUTH_CLIENT_ID'),
    client_secret: getSecret('YOUTUBE_OAUTH_CLIENT_SECRET'),
    refresh_token: getSecret('YOUTUBE_OAUTH_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });
  const t = await (await fetch(TOKEN_URL, { method: 'POST', body })).json();
  if (!t.access_token) throw new Error(`OAuth 갱신 실패: ${t.error || 'unknown'} ${t.error_description || ''}`);
  return t.access_token;
}

/** 에피소드 결과 파일에서 videoId 를 찾는다. v2(platforms/) 우선. */
function videoIdFromEpisode(episodeId) {
  const base = join(ROOT, 'workspace', 'episodes', episodeId);
  const candidates = [
    join(base, 'platforms', 'shorts', '80_publish_result.json'),
    join(base, 'platforms', 'long', '80_publish_result.json'),
    join(base, '80_publish_result.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      const id = d?.targets?.youtube?.videoId || d?.video_id;
      if (id) return id;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

async function main() {
  const { values } = parseArgs({ options: {
    video: { type: 'string' },
    episode: { type: 'string' },
    privacy: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  } });

  const privacy = (values.privacy || '').toLowerCase();
  if (!ALLOWED.includes(privacy)) {
    console.error(`Usage: set-video-privacy.js (--video <id> | --episode <EP-YYYY-NNNN>) --privacy ${ALLOWED.join('|')} [--dry-run]`);
    process.exit(2);
  }

  const videoId = values.video || (values.episode ? videoIdFromEpisode(values.episode) : null);
  if (!videoId) {
    console.error(`❌ videoId 를 찾지 못했습니다${values.episode ? ` (${values.episode} 의 80_publish_result.json)` : ''}`);
    process.exit(2);
  }

  const token = await accessToken();
  const cur = await (await fetch(`${API}?part=status,snippet&id=${encodeURIComponent(videoId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  const item = cur.items?.[0];
  if (!item) { console.error(`❌ 영상을 찾지 못했습니다: ${videoId}`); process.exit(1); }

  console.log(`🎬 ${item.snippet.title}`);
  console.log(`   현재: ${item.status.privacyStatus} → 목표: ${privacy}`);
  if (item.status.privacyStatus === privacy) { console.log('   이미 그 상태입니다 — 변경 없음'); process.exit(0); }
  if (values['dry-run']) { console.log('   [DRY RUN] 변경하지 않았습니다'); process.exit(0); }

  // status 는 전체 교체다. 빠뜨린 필드는 기본값으로 되돌아가므로 현재 값을 보존한다.
  const st = item.status;
  const res = await fetch(`${API}?part=status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: videoId,
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: st.madeForKids === true,
        license: st.license,
        embeddable: st.embeddable,
        publicStatsViewable: st.publicStatsViewable,
      },
    }),
  });
  const j = await res.json();
  if (!res.ok) { console.error(`❌ 변경 실패 ${res.status}: ${JSON.stringify(j).slice(0, 300)}`); process.exit(1); }

  console.log(`✅ ${j.status.privacyStatus} — https://youtu.be/${videoId}`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
