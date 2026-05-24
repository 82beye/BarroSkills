#!/usr/bin/env node

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

async function verifyVideo(accessToken, videoId) {
  const url = `${VIDEOS_ENDPOINT}?part=snippet&id=${videoId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`videos.list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.items?.[0] || null;
}

async function main() {
  const videoId = process.argv[2] || 'dTiR2hgTXXA';
  const accessToken = await getAccessToken();
  const video = await verifyVideo(accessToken, videoId);

  if (!video) {
    console.log(`❌ Video not found: ${videoId}`);
    process.exit(1);
  }

  const description = video.snippet.description;
  const title = video.snippet.title;

  console.log(`\n📺 Video: ${videoId}`);
  console.log(`   Title: ${title}`);
  console.log('');
  console.log('=== Description ===');
  console.log(description);
  console.log('');
  console.log('=== Verification ===');
  console.log(`✓ Contains "2026년 1분기": ${description.includes('2026년 1분기') ? 'YES' : 'NO'}`);
  console.log(`✓ Contains "2025년 1분기": ${description.includes('2025년 1분기') ? 'YES (ERROR)' : 'NO (GOOD)'}`);
  console.log('');
}

main().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
