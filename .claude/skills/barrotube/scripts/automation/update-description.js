#!/usr/bin/env node

/**
 * update-description.js — YouTube 영상 설명(description) 업데이트
 *
 * videos.update (part=snippet)를 사용하여 title, description, tags 등을 업데이트.
 * 다른 snippet 필드는 유지하고 description만 교체.
 *
 * Usage:
 *   # 단일 videoId로 직접 업데이트
 *   node update-description.js --video-id dTiR2hgTXXA --find "2025년 1분기" --replace "2026년 1분기"
 *
 *   # 여러 videoId 일괄 처리
 *   node update-description.js --videos dTiR2hgTXXA,9V_WflzrCB4 --find "2025년 1분기" --replace "2026년 1분기"
 */

import { getSecret } from './config-loader.js';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';

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

async function fetchVideoSnippet(accessToken, videoId) {
  const url = `${VIDEOS_ENDPOINT}?part=snippet&id=${videoId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`videos.list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.items?.[0] || null;
}

async function updateDescription(accessToken, videoId, findText, replaceText) {
  // 현재 snippet 정보를 조회
  const video = await fetchVideoSnippet(accessToken, videoId);
  if (!video) throw new Error(`videoId ${videoId}: not found or no access`);

  const snippet = video.snippet;
  const oldDescription = snippet.description || '';
  const newDescription = oldDescription.replace(new RegExp(findText, 'g'), replaceText);

  if (oldDescription === newDescription) {
    console.log(`⏭  ${videoId}: no changes needed (find text not found)`);
    return { videoId, changed: false, oldDescription, newDescription };
  }

  // videos.update 호출 (part=snippet)
  const url = `${VIDEOS_ENDPOINT}?part=snippet`;
  const body = {
    id: videoId,
    snippet: {
      title: snippet.title,
      description: newDescription,
      tags: snippet.tags || [],
      categoryId: snippet.categoryId,
      defaultLanguage: snippet.defaultLanguage,
      localized: snippet.localized,
    },
  };

  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`videos.update failed: ${res.status} ${errText.slice(0, 200)}`);
  }

  const result = await res.json();
  console.log(`✅ ${videoId}: description updated`);
  return { videoId, changed: true, oldDescription, newDescription };
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
    else {
      opts[key] = next;
      i++;
    }
  }

  const find = opts.find || opts.f;
  const replace = opts.replace || opts.r;

  if (!find || !replace) {
    console.error('❌ --find and --replace are required');
    console.error('');
    console.error('Usage:');
    console.error('  node update-description.js --video-id <ID> --find <text> --replace <text>');
    console.error('  node update-description.js --videos <ID1>,<ID2> --find <text> --replace <text>');
    process.exit(1);
  }

  const accessToken = await getAccessToken();

  let videoIds = [];
  if (opts['video-id']) {
    videoIds = [opts['video-id']];
  } else if (opts.videos) {
    videoIds = opts.videos.split(',').map(v => v.trim());
  } else {
    console.error('❌ --video-id or --videos is required');
    process.exit(1);
  }

  console.log(`🔄 Updating description for ${videoIds.length} video(s)`);
  console.log(`   Find: "${find}"`);
  console.log(`   Replace: "${replace}"`);
  console.log('');

  let ok = 0,
    skip = 0,
    fail = 0;
  const results = [];

  for (const vid of videoIds) {
    try {
      const result = await updateDescription(accessToken, vid, find, replace);
      results.push(result);
      if (result.changed) ok++;
      else skip++;
    } catch (e) {
      console.log(`  ❌ ${vid}: ${e.message.slice(0, 150)}`);
      fail++;
    }
  }

  console.log('');
  console.log(`📊 ${ok} updated · ${skip} skipped · ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
