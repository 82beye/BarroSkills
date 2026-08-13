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

import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { getSecret } from './config-loader.js';
import { assertPublishApproval, effectiveYoutubeUpload } from './lib/publish-approval.js';
import { createChannelRegistry } from './lib/channel-registry.js';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/videos';
const THUMBNAIL_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';
const ENV_REFERENCE = /^[A-Z][A-Z0-9_]*$/;

function credentialKey(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing channel credential environment reference: ${label}`);
  }
  if (!ENV_REFERENCE.test(value)) throw new Error(`Invalid credential environment reference: ${value}`);
  return value;
}

/**
 * refresh_token으로 새 access_token 발급
 */
export async function getAccessToken(credentialEnv = {}) {
  const clientIdKey = credentialKey(credentialEnv.clientIdEnv, 'client_id_env');
  const clientSecretKey = credentialKey(credentialEnv.clientSecretEnv, 'client_secret_env');
  const refreshTokenKey = credentialKey(credentialEnv.refreshTokenEnv, 'refresh_token_env');
  const clientId = getSecret(clientIdKey);
  const clientSecret = getSecret(clientSecretKey);
  const refreshToken = getSecret(refreshTokenKey);

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`Missing YouTube OAuth credential reference(s): ${clientIdKey}, ${clientSecretKey}, ${refreshTokenKey}`);
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

export async function assertOAuthChannel(accessToken, expectedChannelId) {
  if (!expectedChannelId) throw new Error('Expected YouTube channel_id is required for a real upload');
  const url = 'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=50';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`YouTube channel identity check failed: ${res.status} ${await res.text()}`);
  const ids = (await res.json()).items?.map(item => item.id).filter(Boolean) || [];
  if (!ids.includes(expectedChannelId)) {
    throw new Error(`OAuth account channel mismatch: expected ${expectedChannelId}, got ${ids.join(', ') || '(none)'}`);
  }
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
async function uploadVideoChunk(uploadUrl, buffer, onUploadAttempt) {
  onUploadAttempt?.();
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/*',
      'Content-Length': String(buffer.length),
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
async function setThumbnail(accessToken, videoId, buffer, contentType = 'image/jpeg') {
  const res = await fetch(`${THUMBNAIL_ENDPOINT}?videoId=${videoId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType,
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
export async function publishYouTube({
  videoPath,
  meta,
  thumbnailPath,
  videoBuffer = null,
  thumbnailBuffer = null,
  dryRun = false,
  credentialEnv = {},
  expectedChannelId = null,
  channelDefaults = {},
  onUploadAttempt = null,
}) {
  // Copy every upload input before the first await. Approval callers pass the
  // exact verified buffers, so later filesystem changes cannot alter bytes sent.
  const approvedVideo = Buffer.from(videoBuffer || readFileSync(videoPath));
  const approvedThumbnail = thumbnailBuffer ? Buffer.from(thumbnailBuffer) : null;
  const clonedMeta = JSON.parse(JSON.stringify(meta || {}));
  const safeMeta = { ...clonedMeta, ...(clonedMeta.platforms?.youtube || {}) };
  const fileSize = approvedVideo.length;

  // description에 #Shorts 자동 추가 (shortsTag: true)
  let description = safeMeta.description || '';
  if (safeMeta.shortsTag !== false && !description.includes('#Shorts')) {
    description = `${description}\n\n#Shorts`.trim();
  }

  const effectiveUpload = effectiveYoutubeUpload(safeMeta, channelDefaults);
  const { categoryId, privacyStatus } = effectiveUpload;

  const videoBody = {
    snippet: {
      title: (safeMeta.title || '').slice(0, 100),
      description: description.slice(0, 5000),
      tags: Array.isArray(safeMeta.tags) ? safeMeta.tags : [],
      categoryId: String(categoryId),
      defaultLanguage: safeMeta.language || 'ko',
      defaultAudioLanguage: safeMeta.language || 'ko',
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: safeMeta.madeForKids === true,
      ...(safeMeta.publishAt ? { publishAt: safeMeta.publishAt } : {}),
    },
  };

  if (dryRun) {
    console.log('[DRY RUN] Would upload:', JSON.stringify(videoBody, null, 2));
    console.log(`[DRY RUN] File: ${videoPath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
    return { status: 'dry_run', videoBody };
  }

  console.log('🔑 Refreshing OAuth token...');
  const accessToken = await getAccessToken(credentialEnv);
  console.log('🔐 Verifying OAuth channel identity...');
  await assertOAuthChannel(accessToken, expectedChannelId);

  console.log('📤 Initializing resumable upload...');
  const uploadUrl = await initResumableUpload(accessToken, videoBody, fileSize);

  console.log(`📤 Uploading video (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);
  const video = await uploadVideoChunk(uploadUrl, approvedVideo, onUploadAttempt);
  const videoId = video.id;
  console.log(`✅ Uploaded: video_id=${videoId}`);

  // 썸네일 (선택)
  if (approvedThumbnail) {
    console.log('🖼 Setting thumbnail...');
    try {
      const contentType = extname(thumbnailPath || '').toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
      await setThumbnail(accessToken, videoId, approvedThumbnail, contentType);
      console.log('✅ Thumbnail set');
    } catch (e) {
      console.warn(`⚠️  Thumbnail set failed (uploaded video still valid): ${e.message}`);
    }
  }

  const url = `https://youtu.be/${videoId}`;
  return {
    status: safeMeta.publishAt ? 'scheduled' : 'uploaded',
    videoId,
    url,
    publishedAt: safeMeta.publishAt || new Date().toISOString(),
    privacyStatus: videoBody.status.privacyStatus,
  };
}

function existingPublishVideoId(path) {
  if (!existsSync(path)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Existing publish result is unreadable; refusing retry: ${error.message}`); }
  const videoId = parsed?.targets?.youtube?.videoId || parsed?.videoId || parsed?.video_id;
  if (!videoId) throw new Error('Publish result already exists without a video ID; reconcile it manually before retrying');
  return videoId;
}

export function reservePublishResult(path, { allowExisting = false } = {}) {
  const resolvedPath = resolve(path);
  const existingVideoId = existingPublishVideoId(resolvedPath);
  if (existingVideoId && !allowExisting) throw new Error(`Episode is already published as ${existingVideoId}`);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const lockPath = `${resolvedPath}.lock`;
  let fd;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
    closeSync(fd);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if (error.code === 'EEXIST') {
      throw new Error(`Publish is already reserved or requires manual reconciliation: ${lockPath}`);
    }
    throw error;
  }
  return { path: resolvedPath, lockPath };
}

export function persistPublishResult(reservation, value, { replace = false } = {}) {
  const path = reservation.path;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (replace) renameSync(tmp, path);
    else linkSync(tmp, path);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Publish result appeared concurrently; refusing to overwrite ${path}`);
    throw error;
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export function releasePublishResultReservation(reservation, { uploaded = false, persisted = false } = {}) {
  if (!reservation) return;
  // Keep a reconciliation marker when YouTube accepted bytes but the durable
  // result could not be written. Retrying blindly could create a duplicate.
  if ((!uploaded || persisted) && existsSync(reservation.lockPath)) unlinkSync(reservation.lockPath);
}

function parseCliArgs(args) {
  const opts = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--')) opts[arg.replace(/^--/, '')] = args[++i];
  }
  return opts;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseCliArgs(process.argv.slice(2));

  if (!opts.video || !opts.meta) {
    console.error('Usage: publish-youtube.js --video <path> --meta <path> --approval <approval.json> --qa <qa.md> --channel <id> --episode-id <id> --platform <long|shorts> --layout <v1|v2> --episode-root <dir> --out <result.json> [--thumbnail <path>] [--dry-run]');
    process.exit(1);
  }

  const videoPath = resolve(opts.video);
  const metaPath = resolve(opts.meta);
  let meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  let verified = null;
  let resultLock = null;
  let uploadAttempted = false;
  let resultPersisted = false;
  try {
    const requestedCredentialEnv = {
      clientIdEnv: opts['client-id-env'],
      clientSecretEnv: opts['client-secret-env'],
      refreshTokenEnv: opts['refresh-token-env'],
    };
    let credentialEnv = requestedCredentialEnv;
    let expectedChannelId = null;
    let channelDefaults = {};
    if (!opts.dryRun) {
      for (const required of ['approval', 'qa', 'channel', 'episode-id', 'platform', 'layout', 'episode-root', 'out']) {
        if (!opts[required]) throw new Error(`--${required} is required for a real upload`);
      }
      if (!['long', 'shorts'].includes(opts.platform)) throw new Error('--platform must be long or shorts');
      if (!['v1', 'v2'].includes(opts.layout)) throw new Error('--layout must be v1 or v2');
      const skillRoot = resolve(import.meta.dirname, '../..');
      const dataRoot = resolve(process.env.BARROTUBE_DATA || join(homedir(), 'BarroTubeData'));
      const factoryRoot = resolve(process.env.BARRO_AI_FACTORY || join(homedir(), 'BarroAiFactory'));
      const registry = createChannelRegistry({
        skillRoot,
        dataRoot,
        factoryRoot,
        allowedRoots: [dataRoot, factoryRoot, resolve(skillRoot, '../../..')],
      });
      const channel = await registry.getChannel(opts.channel);
      if (channel.status !== 'active' || channel.unresolvedConflicts.length) {
        throw new Error(`Channel ${opts.channel} is not active or has unresolved conflicts`);
      }
      const youtube = channel.manifest.platforms?.youtube;
      if (youtube?.enabled === false) throw new Error(`YouTube publishing is disabled for channel ${opts.channel}`);
      if (!youtube?.channel_id) throw new Error(`Channel ${opts.channel} is missing platforms.youtube.channel_id`);
      expectedChannelId = youtube.channel_id;
      channelDefaults = {
        privacyStatus: youtube.default_privacy || null,
        categoryId: youtube.category_id || null,
      };
      const refs = channel.manifest.credentials?.youtube || {};
      for (const [requested, configured, label] of [
        [requestedCredentialEnv.clientIdEnv, refs.client_id_env, 'client_id_env'],
        [requestedCredentialEnv.clientSecretEnv, refs.client_secret_env, 'client_secret_env'],
        [requestedCredentialEnv.refreshTokenEnv, refs.refresh_token_env, 'refresh_token_env'],
      ]) {
        if (!configured) throw new Error(`Channel ${opts.channel} is missing credentials.youtube.${label}`);
        if (requested && requested !== configured) throw new Error(`CLI credential reference does not match channel manifest: ${label}`);
      }
      credentialEnv = {
        clientIdEnv: refs.client_id_env,
        clientSecretEnv: refs.client_secret_env,
        refreshTokenEnv: refs.refresh_token_env,
      };
      verified = assertPublishApproval({
        approvalPath: resolve(opts.approval),
        videoPath,
        metaPath,
        qaPath: resolve(opts.qa),
        channelId: opts.channel,
        episodeId: opts['episode-id'],
        platform: opts.platform,
        layout: opts.layout,
        episodeRoot: resolve(opts['episode-root']),
        channelRevision: channel.revision,
        youtubeChannelId: youtube.channel_id,
        youtubeDefaults: channelDefaults,
      });
      meta = verified.metadata;
      if (meta.channel_id !== opts.channel) {
        throw new Error(`Approved metadata channel_id ${meta.channel_id || '(missing)'} does not match --channel ${opts.channel}`);
      }
      if (opts.thumbnail && resolve(opts.thumbnail) !== verified.thumbnailPath) {
        throw new Error('--thumbnail does not match the thumbnail selected from approved metadata');
      }
      resultLock = reservePublishResult(resolve(opts.out));
    }
    const result = await publishYouTube({
      videoPath,
      meta,
      thumbnailPath: verified?.thumbnailPath || (opts.thumbnail ? resolve(opts.thumbnail) : null),
      videoBuffer: verified?.artifacts.video || null,
      thumbnailBuffer: verified?.artifacts.thumbnail || null,
      dryRun: opts.dryRun,
      credentialEnv,
      expectedChannelId,
      channelDefaults,
      onUploadAttempt: () => { uploadAttempted = true; },
    });
    uploadAttempted ||= Boolean(!opts.dryRun && result.videoId);
    console.log('\n📊 Result:');
    console.log(JSON.stringify(result, null, 2));

    if (!opts.dryRun) {
      const resultEnvelope = {
        episode_id: opts['episode-id'],
        channel_id: opts.channel,
        published_at: new Date().toISOString(),
        targets: { youtube: result },
      };
      persistPublishResult(resultLock, resultEnvelope);
      resultPersisted = true;

      const botToken = getSecret('TELEGRAM_BOT_TOKEN');
      const chatId = getSecret('TELEGRAM_CHAT_ID');
      if (botToken && chatId) {
        const sizeMb = ((verified?.artifacts.video.length || statSync(videoPath).size) / (1024 * 1024)).toFixed(2);
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
    process.exitCode = 1;
  } finally {
    // A successful upload whose result could not be persisted keeps the lock as
    // a fail-closed reconciliation marker. All other exits release it.
    releasePublishResultReservation(resultLock, { uploaded: uploadAttempted, persisted: resultPersisted });
  }
}
