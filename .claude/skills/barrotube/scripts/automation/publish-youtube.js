#!/usr/bin/env node

/**
 * publish-youtube.js — YouTube Data API v3 업로드 클라이언트
 *
 * 표준 라이브러리만 사용 (node:fetch). Dependencies 없음.
 *
 * Usage:
 *   node publish-youtube.js \
 *     --video path/to/video.mp4 \
 *     --meta path/to/meta.json \
 *     [--thumbnail path/to/thumb.jpg] \
 *     [--dry-run]
 *
 * meta.json 스키마:
 * {
 *   "title": "...",                           // 100자 이내
 *   "description": "...",                     // 5000자 이내
 *   "tags": ["...", "..."],                   // 500자 이내 합산
 *   "categoryId": "25",                       // 기본: 25 (News & Politics), 22 (People & Blogs)
 *   "privacyStatus": "public|unlisted|private",
 *   "publishAt": "2026-04-20T07:00:00+09:00", // 선택: 예약 공개 시 privacy='private'+publishAt
 *   "madeForKids": false,
 *   "shortsTag": true                         // true면 description 끝에 #Shorts 자동 추가
 * }
 */

import { readFileSync, statSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { getSecret } from './config-loader.js';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/videos';
const THUMBNAIL_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';

/**
 * refresh_token으로 새 access_token 발급
 */
async function getAccessToken() {
  const clientId = getSecret('YOUTUBE_OAUTH_CLIENT_ID');
  const clientSecret = getSecret('YOUTUBE_OAUTH_CLIENT_SECRET');
  const refreshToken = getSecret('YOUTUBE_OAUTH_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing YOUTUBE_OAUTH_* env vars. Run /setup-youtube-oauth first.');
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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OAuth token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

/**
 * Resumable upload 세션 초기화
 */
async function initResumableUpload(accessToken, videoBody, fileSize) {
  const url = `${UPLOAD_ENDPOINT}?uploadType=resumable&part=snippet,status`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(fileSize),
      'X-Upload-Content-Type': 'video/*',
    },
    body: JSON.stringify(videoBody),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resumable init failed: ${res.status} ${err}`);
  }

  const uploadUrl = res.headers.get('location');
  if (!uploadUrl) throw new Error('No Location header returned from resumable init');
  return uploadUrl;
}

/**
 * 영상 파일을 Resumable URL에 PUT (단일 청크)
 */
async function uploadVideoChunk(uploadUrl, videoPath, fileSize) {
  const buffer = readFileSync(videoPath); // 100MB 이하라 메모리 로드 OK (Shorts 60s)
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/*',
      'Content-Length': String(fileSize),
    },
    body: buffer,
  });

  if (!res.ok && res.status !== 200 && res.status !== 201) {
    const err = await res.text();
    throw new Error(`Upload failed: ${res.status} ${err}`);
  }
  return res.json();
}

/**
 * 썸네일 설정
 */
async function setThumbnail(accessToken, videoId, thumbnailPath) {
  const buffer = readFileSync(thumbnailPath);
  const res = await fetch(`${THUMBNAIL_ENDPOINT}?videoId=${videoId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'image/jpeg',
    },
    body: buffer,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Thumbnail set failed: ${res.status} ${err}`);
  }
  return res.json();
}

/**
 * 메인: YouTube 업로드
 */
export async function publishYouTube({ videoPath, meta, thumbnailPath, dryRun = false }) {
  const fileSize = statSync(videoPath).size;

  // description에 #Shorts 자동 추가 (shortsTag: true)
  let description = meta.description || '';
  if (meta.shortsTag !== false && !description.includes('#Shorts')) {
    description = `${description}\n\n#Shorts`.trim();
  }

  const videoBody = {
    snippet: {
      title: (meta.title || '').slice(0, 100),
      description: description.slice(0, 5000),
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      categoryId: meta.categoryId || '25',
      defaultLanguage: meta.language || 'ko',
      defaultAudioLanguage: meta.language || 'ko',
    },
    status: {
      privacyStatus: meta.publishAt ? 'private' : (meta.privacyStatus || 'public'),
      selfDeclaredMadeForKids: meta.madeForKids === true,
      ...(meta.publishAt ? { publishAt: meta.publishAt } : {}),
    },
  };

  if (dryRun) {
    console.log('[DRY RUN] Would upload:', JSON.stringify(videoBody, null, 2));
    console.log(`[DRY RUN] File: ${videoPath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
    return { status: 'dry_run', videoBody };
  }

  console.log('🔑 Refreshing OAuth token...');
  const accessToken = await getAccessToken();

  console.log('📤 Initializing resumable upload...');
  const uploadUrl = await initResumableUpload(accessToken, videoBody, fileSize);

  console.log(`📤 Uploading video (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);
  const video = await uploadVideoChunk(uploadUrl, videoPath, fileSize);
  const videoId = video.id;
  console.log(`✅ Uploaded: video_id=${videoId}`);

  // 썸네일 (선택)
  if (thumbnailPath) {
    console.log('🖼 Setting thumbnail...');
    try {
      await setThumbnail(accessToken, videoId, thumbnailPath);
      console.log('✅ Thumbnail set');
    } catch (e) {
      console.warn(`⚠️  Thumbnail set failed (uploaded video still valid): ${e.message}`);
    }
  }

  const url = `https://youtu.be/${videoId}`;
  return {
    status: meta.publishAt ? 'scheduled' : 'uploaded',
    videoId,
    url,
    publishedAt: meta.publishAt || new Date().toISOString(),
    privacyStatus: videoBody.status.privacyStatus,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opts = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--')) {
      opts[a.replace(/^--/, '')] = args[++i];
    }
  }

  if (!opts.video || !opts.meta) {
    console.error('Usage: publish-youtube.js --video <path> --meta <path> [--thumbnail <path>] [--dry-run]');
    process.exit(1);
  }

  const meta = JSON.parse(readFileSync(resolve(opts.meta), 'utf-8'));
  try {
    const result = await publishYouTube({
      videoPath: resolve(opts.video),
      meta,
      thumbnailPath: opts.thumbnail ? resolve(opts.thumbnail) : null,
      dryRun: opts.dryRun,
    });
    console.log('\n📊 Result:');
    console.log(JSON.stringify(result, null, 2));

    if (!opts.dryRun && result.status !== 'dry-run') {
      const botToken = getSecret('TELEGRAM_BOT_TOKEN');
      const chatId = getSecret('TELEGRAM_CHAT_ID');
      if (botToken && chatId) {
        const sizeMb = (statSync(resolve(opts.video)).size / (1024 * 1024)).toFixed(2);
        const lines = [
          `🎬 <b>YouTube publish 완료</b>`,
          ``,
          `📌 <b>Title</b>: ${meta.title || '(no title)'}`,
          `🆔 <b>Video ID</b>: <code>${result.videoId}</code>`,
          `🔗 ${result.url}`,
          `🔒 <b>Privacy</b>: ${result.privacyStatus}`,
          `📦 <b>Size</b>: ${sizeMb} MB`,
          `📅 <b>Published</b>: ${result.publishedAt}`,
        ];
        try {
          const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: lines.join('\n').slice(0, 4000),
              parse_mode: 'HTML',
              disable_web_page_preview: false,
            }),
          });
          if (res.ok) console.log('📲 Telegram notified');
          else console.warn(`⚠️  Telegram notify failed: ${res.status}`);
        } catch (e) {
          console.warn(`⚠️  Telegram notify error: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.error(`\n❌ Publish failed: ${e.message}`);
    process.exit(1);
  }
}
