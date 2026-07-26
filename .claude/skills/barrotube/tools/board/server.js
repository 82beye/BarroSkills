#!/usr/bin/env node

/**
 * BarroTube channel board.
 *
 * The board is the editable control plane for federated channel manifests. It
 * binds to loopback only, derives every executable/path server-side, and keeps
 * generated channel documents read-only.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  createReadStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  listChannelAssets,
  resolveEpisodeRoot,
  resolveSafeAssetPath,
  scanChannelEpisodes,
} from '../../scripts/automation/lib/channel-adapters.js';
import {
  mergeEpisodeSources,
  renderChannelDocument,
} from '../../scripts/automation/lib/channel-document.js';
import { createChannelRegistry } from '../../scripts/automation/lib/channel-registry.js';
import { assertPublishApproval } from '../../scripts/automation/lib/publish-approval.js';

const BOARD_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(BOARD_DIR, '../..');
const REPO_ROOT = resolve(SKILL_ROOT, '../../..');
const AUTOMATION_ROOT = join(SKILL_ROOT, 'scripts', 'automation');
const MEDIA_RENDER_ROOT = resolve(SKILL_ROOT, '../barrotube-media-render');
const MEDIA_RENDER_SCRIPTS = join(MEDIA_RENDER_ROOT, 'scripts');
const DEFAULT_DATA_ROOT = resolve(process.env.BARROTUBE_DATA || '/Users/beye/BarroTubeData');
const DEFAULT_FACTORY_ROOT = resolve(process.env.BARRO_AI_FACTORY || '/Users/beye/BarroAiFactory');
const DEFAULT_CHANNELS_ROOT = join(DEFAULT_DATA_ROOT, 'workspace', 'channels');
const BODY_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const ACTION_TIMEOUT_MS = 30 * 60 * 1000;
const PREVIEW_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
};
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ENV_REFERENCE = /^[A-Z][A-Z0-9_]*$/;
const PLATFORM_ID = /^(?:[a-z0-9][a-z0-9-]{0,31}|\(v1-flat\))$/;
const runningActions = new Map();

class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR', details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function registryOptions(overrides = {}) {
  const dataRoot = resolve(overrides.dataRoot || DEFAULT_DATA_ROOT);
  const factoryRoot = resolve(overrides.factoryRoot || DEFAULT_FACTORY_ROOT);
  return {
    skillRoot: SKILL_ROOT,
    dataRoot,
    factoryRoot,
    channelsRoot: resolve(overrides.channelsRoot || join(dataRoot, 'workspace', 'channels')),
    allowedRoots: [dataRoot, factoryRoot, REPO_ROOT],
    ...overrides,
  };
}

function json(res, status, value, headers = {}) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function html(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(value),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(value);
}

function parseJsonBody(req) {
  return new Promise((accept, reject) => {
    let bytes = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, '요청 본문이 너무 큽니다.', 'BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!chunks.length) return accept({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('JSON object required');
        }
        accept(parsed);
      } catch (error) {
        reject(new HttpError(400, `JSON 형식이 올바르지 않습니다: ${error.message}`, 'INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sameToken(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

function assertMutationAuthorized(req, token, port) {
  if (!sameToken(req.headers['x-barrotube-token'], token)) {
    throw new HttpError(403, '유효한 로컬 보드 토큰이 필요합니다.', 'INVALID_BOARD_TOKEN');
  }
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch {
    throw new HttpError(403, '허용되지 않은 Origin입니다.', 'INVALID_ORIGIN');
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  const expectedPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  if (!loopback || parsed.protocol !== 'http:' || expectedPort !== String(port)) {
    throw new HttpError(403, '허용되지 않은 Origin입니다.', 'INVALID_ORIGIN');
  }
}

function assertLoopbackHost(req) {
  const host = req.headers.host;
  if (!host) throw new HttpError(400, 'Host 헤더가 필요합니다.', 'INVALID_HOST');
  let parsed;
  try { parsed = new URL(`http://${host}`); } catch {
    throw new HttpError(403, '허용되지 않은 Host입니다.', 'INVALID_HOST');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new HttpError(403, 'loopback Host만 허용됩니다.', 'INVALID_HOST');
  }
}

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  return ({
    NOT_FOUND: 404,
    ALREADY_EXISTS: 409,
    REVISION_CONFLICT: 409,
    CHANNEL_BUSY: 409,
    REVISION_REQUIRED: 428,
    UNRESOLVED_CONFLICTS: 409,
    ARCHIVED_CHANNEL: 409,
    VALIDATION_ERROR: 422,
    SECRET_VALUE_FORBIDDEN: 422,
    UNSAFE_OBJECT_KEY: 422,
    PATH_OUTSIDE_ALLOWED_ROOT: 422,
    PUBLISH_APPROVAL_REJECTED: 428,
  })[error?.code] || 500;
}

function cleanError(error) {
  return {
    error: error?.message || String(error),
    code: error?.code || 'INTERNAL_ERROR',
    ...(error?.details ? { details: error.details } : {}),
  };
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function loadSeries(context) {
  const path = context?.series_index || context?.paths?.series_index;
  if (typeof path !== 'string') return [];
  const value = readJson(path, undefined);
  if (value === undefined) throw new HttpError(422, 'series_index를 읽거나 파싱할 수 없습니다.', 'INVALID_SERIES_INDEX');
  return value;
}

function firstText(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || null;
}

function positiveEpisodeNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

function configuredProfiles(context) {
  return [
    context?.pipeline_profile,
    context?.pipeline?.profile,
    ...(Array.isArray(context?.pipeline?.additional_profiles)
      ? context.pipeline.additional_profiles
      : []),
  ].filter((value, index, values) => typeof value === 'string' && values.indexOf(value) === index);
}

function plannedProfile(context, plan) {
  const profiles = configuredProfiles(context);
  const format = firstText(plan?.format, plan?.content_format, plan?.type)?.toLowerCase() || '';
  if (/car/.test(format)) return profiles.find(profile => profile === 'carousel-c4') || profiles[0] || 'planned';
  if (/reel/.test(format)) return profiles.find(profile => profile === 'media-render-r11') || profiles[0] || 'planned';
  if (/short|long|youtube/.test(format)) return profiles.find(profile => profile === 'barrotube-s12') || profiles[0] || 'planned';
  return profiles[0] || 'planned';
}

function plannedArtifacts(plan) {
  const stages = plan?.stages && typeof plan.stages === 'object' ? plan.stages : {};
  const counts = plan?.counts && typeof plan.counts === 'object' ? plan.counts : {};
  const countOrStage = (keys, stage) => {
    for (const key of keys) {
      const count = Number(counts[key]);
      if (Number.isFinite(count) && count >= 0) return count;
    }
    return Boolean(stages[stage]);
  };
  return {
    layout: 'planned',
    script: Boolean(stages.script),
    images: countOrStage(['images', 'slides', 'stills'], 'image'),
    videos: countOrStage(['videos', 'clips'], 'video'),
    audio: countOrStage(['audio'], 'audio'),
    render: Boolean(stages.render),
  };
}

function plannedLifecycle(plan, artifacts) {
  if (plan?.published === true) return 'published';
  if (plan?.qa_passed === true) return 'qa';
  if (artifacts.render) return 'render';
  if (Number(artifacts.images) > 0 || Number(artifacts.videos) > 0) return 'assets';
  if (artifacts.script) return 'script';
  return 'planned';
}

function planFields(plan) {
  if (!plan) return {};
  const qaChecks = Array.isArray(plan.qa_checks) ? plan.qa_checks.map(Boolean) : [];
  return {
    planned_title: firstText(plan.title, plan.topic, plan.name),
    planned_format: firstText(plan.format, plan.content_format, plan.type),
    planned_slug: firstText(plan.slug),
    weekday: firstText(plan.weekday, plan.day_of_week),
    arc_beat: firstText(plan.arc_beat, plan.narrative_beat, plan.beat, plan.summary),
    caption: firstText(plan.caption, plan.cap),
    folder: firstText(plan.folder),
    schedule_date: firstText(plan.schedule_date, plan.publish_date, plan.date),
    series_start_date: firstText(plan.series_start_date),
    planned_status: firstText(plan.status, plan.state),
    planned_stages: plan.stages && typeof plan.stages === 'object' ? plan.stages : {},
    planned_counts: plan.counts && typeof plan.counts === 'object' ? plan.counts : {},
    qa_checks: qaChecks,
    qa_checked_count: qaChecks.filter(Boolean).length,
    qa_check_count: qaChecks.length,
    human_qa_passed: plan.qa_passed === true,
    planned_qa_auto: plan.qa_auto === true ? true : plan.qa_auto === false ? false : null,
    planned_published: plan.published === true,
  };
}

function plannedEpisodeView(context, plan, index) {
  const episodeNo = positiveEpisodeNumber(plan?.episode_no, plan?.series_episode);
  const profile = plannedProfile(context, plan);
  const artifacts = plannedArtifacts(plan);
  const qaChecks = Array.isArray(plan?.qa_checks) ? plan.qa_checks.map(Boolean) : [];
  const id = firstText(plan?.id, plan?.episode_id, plan?.plan_id, plan?.key, plan?.slug)
    || `PLAN-${String(episodeNo || index + 1).padStart(3, '0')}`;
  const published = plan?.published === true;
  return {
    channel_id: context.channel_id || context.id || null,
    id,
    title: firstText(plan?.title, plan?.topic, plan?.name) || '제목 미정',
    format: firstText(plan?.format, plan?.content_format, plan?.type) || 'unspecified',
    series_id: firstText(plan?.series_id),
    episode_no: episodeNo,
    plan_id: firstText(plan?.plan_id, plan?.id, plan?.episode_id, plan?.slug),
    slug: firstText(plan?.slug),
    native_stage: 'PLAN',
    lifecycle_stage: plannedLifecycle(plan, artifacts),
    artifacts,
    qa: {
      exists: plan?.qa_auto !== null && plan?.qa_auto !== undefined || qaChecks.some(Boolean),
      passed: plan?.qa_passed === true,
      auto_passed: plan?.qa_auto === true ? true : plan?.qa_auto === false ? false : null,
      status: plan?.qa_passed === true ? 'pass' : plan?.qa_auto === false ? 'fail' : 'planned',
      source: 'series-index',
      sources: ['series-index'],
    },
    publish: {
      published,
      status: published ? 'published' : null,
      video_id: null,
      url: null,
      privacy: null,
      published_at: null,
      source: 'series-index',
    },
    supported_actions: [],
    source_profile: profile,
    updated_at: firstText(plan?.updated_at, plan?.series_generated_at),
    observed: false,
    assets_available: false,
    ...planFields(plan),
  };
}

function boardEpisodeViews(record, observed = scanChannelEpisodes(record.context)) {
  const series = loadSeries(record.context);
  const sources = mergeEpisodeSources(observed, series);
  const rows = sources.map(({ plan, observed: actual }, index) => {
    if (!actual) return plannedEpisodeView(record.context, plan || {}, index);
    return {
      ...actual,
      ...planFields(plan),
      observed: true,
      assets_available: true,
    };
  });
  return {
    rows,
    observedCount: observed.length,
    plannedCount: sources.filter(item => item.plan).length,
    unobservedCount: rows.filter(episode => episode.observed === false).length,
  };
}

function detailPayload(record) {
  return {
    channel: record.context,
    manifest: record.manifest,
    conflicts: record.conflicts || [],
    unresolved: record.unresolvedConflicts?.length || 0,
    unresolved_conflicts: record.unresolvedConflicts || [],
    provenance: record.provenance,
  };
}

function summarize(record) {
  if (record.error) return { id: record.id, error: record.error, unresolved: 0, episode_count: 0, published_count: 0 };
  let episodes = [];
  let boardEpisodeCount = 0;
  let plannedCount = 0;
  let unobservedCount = 0;
  let scanError = null;
  try {
    episodes = scanChannelEpisodes(record.context);
    const view = boardEpisodeViews(record, episodes);
    boardEpisodeCount = view.rows.length;
    plannedCount = view.plannedCount;
    unobservedCount = view.unobservedCount;
  }
  catch (error) { scanError = error.message; }
  return {
    id: record.id,
    revision: record.revision,
    status: record.status,
    identity: record.context.identity,
    pipeline_profile: record.context.pipeline_profile,
    formats: record.context.format_ids,
    unresolved: record.unresolvedConflicts?.length || 0,
    episode_count: episodes.length,
    board_episode_count: boardEpisodeCount,
    planned_count: plannedCount,
    unobserved_count: unobservedCount,
    published_count: episodes.filter((episode) => episode.publish?.published).length,
    ...(scanError ? { scan_error: scanError } : {}),
  };
}

function atomicWrite(path, content, { backup = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.from(content);
  if (existsSync(path)) {
    const current = readFileSync(path);
    if (current.equals(bytes)) return { changed: false, backup_path: null };
  }
  let backupPath = null;
  if (backup && existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${path}.bak.${stamp}`;
    copyFileSync(path, backupPath);
  }
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temp, bytes, { mode: 0o644 });
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* noop */ }
    throw error;
  }
  return { changed: true, backup_path: backupPath };
}

function renderRecordDocument(record, { offline, generatedAt = new Date().toISOString() }) {
  const episodes = scanChannelEpisodes(record.context);
  const series = loadSeries(record.context);
  const channel = {
    ...record.manifest,
    ...record.context,
    identity: { ...record.manifest.identity, ...record.context.identity },
    conflicts: record.conflicts,
    risks: record.conflicts,
  };
  return {
    html: renderChannelDocument({ channel, series, episodes, offline, generatedAt }),
    episodes,
    series,
  };
}

function documentGeneratedAt(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8').match(/"generated_at":"([^"]+)"/)?.[1] || null;
  } catch { return null; }
}

function publicAssets(value) {
  if (!value) return value;
  const { root: _root, ...safe } = value;
  return safe;
}

function assetRequest(record, url) {
  const episodeId = url.searchParams.get('episode_id') || '';
  const sourceProfile = url.searchParams.get('source_profile') || null;
  const platform = url.searchParams.get('platform') || null;
  const matches = scanChannelEpisodes(record.context).filter(episode => episode.id === episodeId
    && (!sourceProfile || episode.source_profile === sourceProfile));
  if (!matches.length) {
    throw new HttpError(404, '에피소드 자산을 찾지 못했습니다.', 'EPISODE_NOT_FOUND');
  }
  if (matches.length > 1) {
    throw new HttpError(409, '동일 ID 에피소드가 여러 파이프라인에 있습니다. source_profile을 지정하세요.', 'AMBIGUOUS_EPISODE', {
      source_profiles: matches.map(episode => episode.source_profile),
    });
  }

  const [episode] = matches;
  const choices = episode.source_profile === 'barrotube-s12'
    ? Object.keys(episode.artifacts?.platforms || {})
    : [];
  if (episode.source_profile === 'barrotube-s12' && choices.length && !platform) {
    throw new HttpError(400, '자산을 볼 플랫폼을 지정하세요.', 'ASSET_PLATFORM_REQUIRED', { choices });
  }
  if (platform) {
    if (!PLATFORM_ID.test(platform) || !choices.includes(platform)) {
      throw new HttpError(400, `에피소드에 없는 플랫폼입니다: ${platform}`, 'INVALID_PLATFORM', { choices });
    }
  }

  const assets = listChannelAssets(
    record.context,
    episodeId,
    platform,
    episode.source_profile,
  );
  if (!assets) throw new HttpError(404, '에피소드 자산을 찾지 못했습니다.', 'EPISODE_NOT_FOUND');
  return { assets, episodeId, platform, sourceProfile: episode.source_profile };
}

function listedAsset(assets, relativePath) {
  return Object.values(assets.groups || {})
    .flat()
    .find(item => item.rel === relativePath) || null;
}

function serveAsset(req, res, path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  } catch {
    throw new HttpError(409, '자산이 변경되었습니다. 목록을 새로고침하세요.', 'ASSET_CHANGED');
  }
  let fileOwned = true;
  const closeFile = () => {
    if (!fileOwned) return;
    fileOwned = false;
    try { closeSync(fd); } catch { /* already closed */ }
  };

  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new HttpError(400, '허용되지 않은 자산입니다.', 'INVALID_ASSET_PATH');
    let reboundPath;
    let reboundStats;
    try {
      reboundPath = realpathSync(path);
      reboundStats = statSync(reboundPath);
    } catch {
      throw new HttpError(409, '자산이 변경되었습니다. 목록을 새로고침하세요.', 'ASSET_CHANGED');
    }
    if (reboundPath !== path || reboundStats.dev !== stats.dev || reboundStats.ino !== stats.ino) {
      throw new HttpError(409, '자산이 변경되었습니다. 목록을 새로고침하세요.', 'ASSET_CHANGED');
    }
    const size = stats.size;
    const type = PREVIEW_MIME[extname(path).toLowerCase()] || 'application/octet-stream';
    const commonHeaders = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    const finish = (status, headers, streamOptions = null) => {
      res.writeHead(status, { ...commonHeaders, ...headers });
      if (req.method === 'HEAD') {
        closeFile();
        return res.end();
      }
      const stream = createReadStream(path, {
        ...(streamOptions || {}),
        fd,
        autoClose: true,
      });
      fileOwned = false;
      const abort = () => {
        if (!stream.destroyed) stream.destroy();
      };
      const cleanup = () => {
        req.off('aborted', abort);
        res.off('close', abort);
      };
      req.once('aborted', abort);
      res.once('close', abort);
      stream.once('close', cleanup);
      stream.once('error', error => {
        if (!res.destroyed) res.destroy(error);
      });
      stream.pipe(res);
      return res;
    };
    const rejectRange = () => {
      closeFile();
      res.writeHead(416, { ...commonHeaders, 'Content-Range': `bytes */${size}` });
      res.end();
      return res;
    };

    const range = req.headers.range;
    if (!range) {
      return finish(200, { 'Content-Length': size });
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]) || size === 0) return rejectRange();

    let start;
    let end;
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return rejectRange();
      start = Math.max(size - suffixLength, 0);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || start > end || start >= size) return rejectRange();
    end = Math.min(end, size - 1);
    return finish(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    }, { start, end });
  } catch (error) {
    closeFile();
    throw error;
  }
}

function validatedPlatform(episode, requested) {
  const choices = Object.keys(episode?.artifacts?.platforms || {});
  const value = requested || choices[0] || '(v1-flat)';
  if (!PLATFORM_ID.test(value) || (choices.length && !choices.includes(value))) {
    throw new HttpError(400, `에피소드에 없는 플랫폼입니다: ${value}`, 'INVALID_PLATFORM', { choices });
  }
  return value;
}

function s12Paths(context, episode, requestedPlatform) {
  const episodeRoot = resolveEpisodeRoot(context, episode.id, null, episode.source_profile);
  if (!episodeRoot) throw new HttpError(404, '에피소드 폴더를 찾지 못했습니다.', 'EPISODE_NOT_FOUND');
  const platform = validatedPlatform(episode, requestedPlatform);
  const platformRoot = platform === '(v1-flat)'
    ? episodeRoot
    : resolveEpisodeRoot(context, episode.id, platform, episode.source_profile);
  if (!platformRoot) throw new HttpError(404, '플랫폼 폴더를 찾지 못했습니다.', 'PLATFORM_NOT_FOUND');
  const platformArgs = platform === '(v1-flat)' ? [] : ['--platform', platform];
  return {
    episodeRoot,
    platformRoot,
    platform,
    platformArgs,
    script: join(platformRoot, '30_script.md'),
    tts: join(platformRoot, '40_assets', 'tts'),
    images: join(platformRoot, '40_assets', 'images'),
    video: join(platformRoot, '55_render', 'video.mp4'),
    qa: join(platformRoot, '60_qa_report.md'),
    meta: join(platformRoot, '70_publish_meta.json'),
    approval: join(platformRoot, '75_board_approval.json'),
    publishResult: join(platformRoot, '80_publish_result.json'),
    thumbnail: existsSync(join(platformRoot, '47_thumbnail.png'))
      ? join(platformRoot, '47_thumbnail.png')
      : join(platformRoot, '47_thumbnail.jpg'),
  };
}

function nodeSpec(script, args, cwd = SKILL_ROOT) {
  return { executable: process.execPath, args: [join(AUTOMATION_ROOT, script), ...args], cwd };
}

function pythonSpec(script, args) {
  return { executable: 'python3', args: [join(MEDIA_RENDER_SCRIPTS, script), ...args], cwd: MEDIA_RENDER_ROOT };
}

function envReferenceArgs(credentials = {}) {
  const youtube = credentials.youtube || {};
  const mapping = [
    ['client_id_env', '--client-id-env'],
    ['client_secret_env', '--client-secret-env'],
    ['refresh_token_env', '--refresh-token-env'],
  ];
  const args = [];
  for (const [key, flag] of mapping) {
    const value = youtube[key];
    if (!ENV_REFERENCE.test(value || '')) {
      throw new HttpError(422, `credentials.youtube.${key} 환경변수 참조가 필요합니다.`, 'CREDENTIAL_REFERENCE_MISSING');
    }
    args.push(flag, value);
  }
  return args;
}

function buildS12Action(record, episode, action, body) {
  const paths = s12Paths(record.context, episode, body.platform);
  const maybeForce = [];
  switch (action) {
    case 'status': return { immediate: episode };
    case 'script': return nodeSpec('generate-script.js', ['--episode', paths.episodeRoot, ...paths.platformArgs, ...maybeForce]);
    case 'factcheck': return nodeSpec('run-factcheck.js', ['--episode', paths.episodeRoot, ...paths.platformArgs, ...maybeForce]);
    case 'tts': return nodeSpec('generate-tts.js', ['--script', paths.script, '--out-dir', paths.tts, ...maybeForce]);
    case 'sync-durations': return nodeSpec('sync-durations.js', ['--script', paths.script, '--tts-dir', paths.tts]);
    case 'images': return nodeSpec('generate-image.js', ['--script', paths.script, '--out-dir', paths.images, ...maybeForce]);
    case 'intro': return nodeSpec('generate-intro.js', ['--episode', paths.episodeRoot, ...paths.platformArgs, ...maybeForce]);
    case 'thumbnail': return nodeSpec('generate-thumbnail.js', ['--episode', paths.episodeRoot, ...paths.platformArgs, ...maybeForce]);
    case 'endcard': return nodeSpec('generate-endcard.js', ['--episode', paths.episodeRoot, ...paths.platformArgs, ...maybeForce]);
    case 'render': return nodeSpec('render-direct.js', ['--episode', paths.episodeRoot, '--out', paths.video, ...paths.platformArgs]);
    case 'qa': return nodeSpec('generate-qa-report.js', ['--episode', paths.episodeRoot, ...paths.platformArgs]);
    case 'metadata': return nodeSpec('generate-metadata.js', ['--episode', paths.episodeRoot, ...paths.platformArgs]);
    case 'approve': {
      const operator = typeof body.operator === 'string' ? body.operator.trim().slice(0, 80) : 'BarroTube Board';
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : 'local board approval';
      return nodeSpec('approve-episode.js', ['--episode', episode.id, '--episode-dir', paths.episodeRoot, '--by', operator || 'BarroTube Board', '--note', note, ...paths.platformArgs]);
    }
    case 'publish': {
      if (body.confirm !== 'PUBLISH') {
        throw new HttpError(428, '발행에는 confirm="PUBLISH"가 필요합니다.', 'PUBLISH_CONFIRMATION_REQUIRED');
      }
      if (record.manifest.platforms?.youtube?.enabled === false) {
        throw new HttpError(409, '이 채널은 YouTube 발행이 비활성화되어 있습니다.', 'YOUTUBE_DISABLED');
      }
      const youtube = record.manifest.platforms?.youtube;
      if (!youtube?.channel_id) {
        throw new HttpError(422, '검증된 YouTube channel_id가 필요합니다.', 'YOUTUBE_CHANNEL_MISSING');
      }
      const platformQa = episode.artifacts?.platforms?.[paths.platform]?.qa || episode.qa;
      if (platformQa?.passed !== true) {
        throw new HttpError(428, 'QA PASS가 확인되지 않아 발행할 수 없습니다.', 'QA_PASS_REQUIRED');
      }
      assertPublishApproval({
        approvalPath: paths.approval,
        videoPath: paths.video,
        metaPath: paths.meta,
        qaPath: paths.qa,
        channelId: record.id,
        episodeId: episode.id,
        platform: paths.platform === '(v1-flat)' ? (/short/i.test(episode.format || '') ? 'shorts' : 'long') : paths.platform,
        layout: paths.platform === '(v1-flat)' ? 'v1' : 'v2',
        episodeRoot: paths.episodeRoot,
        channelRevision: record.revision,
        youtubeChannelId: youtube.channel_id,
        youtubeDefaults: {
          privacyStatus: youtube.default_privacy || null,
          categoryId: youtube.category_id || null,
        },
      });
      const publishPlatform = paths.platform === '(v1-flat)'
        ? (/short/i.test(episode.format || '') ? 'shorts' : 'long')
        : paths.platform;
      const args = [
        '--video', paths.video,
        '--meta', paths.meta,
        '--qa', paths.qa,
        '--approval', paths.approval,
        '--channel', record.id,
        '--episode-id', episode.id,
        '--platform', publishPlatform,
        '--layout', paths.platform === '(v1-flat)' ? 'v1' : 'v2',
        '--episode-root', paths.episodeRoot,
        '--out', paths.publishResult,
        ...envReferenceArgs(record.manifest.credentials),
      ];
      return nodeSpec('publish-youtube.js', args);
    }
    default: throw new HttpError(400, `지원하지 않는 S12 액션입니다: ${action}`, 'UNSUPPORTED_ACTION');
  }
}

function buildR11Action(record, episode, action, body) {
  const root = resolveEpisodeRoot(record.context, episode.id, null, episode.source_profile);
  if (!root) throw new HttpError(404, '에피소드 폴더를 찾지 못했습니다.', 'EPISODE_NOT_FOUND');
  if (action === 'status') return pythonSpec('render_reel_job.py', ['status', root, '--json']);
  if (action === 'sync') return pythonSpec('render_reel_job.py', ['sync', root]);
  if (action === 'autopilot') {
    return pythonSpec('reel_autopilot.py', [
      root, '--episode', episode.id, '--json',
      ...(body.allow_render === true ? ['--allow-render'] : []),
    ]);
  }
  throw new HttpError(400, `지원하지 않는 R11 액션입니다: ${action}`, 'UNSUPPORTED_ACTION');
}

function buildC4Action(record, episode, action) {
  const root = resolveEpisodeRoot(record.context, episode.id, null, episode.source_profile);
  if (!root) throw new HttpError(404, '에피소드 폴더를 찾지 못했습니다.', 'EPISODE_NOT_FOUND');
  if (!['sync', 'build', 'qa', 'meta', 'autopilot'].includes(action)) {
    throw new HttpError(400, `지원하지 않는 C4 액션입니다: ${action}`, 'UNSUPPORTED_ACTION');
  }
  return pythonSpec('carousel_job.py', [action, root, '--json']);
}

function actionPreview(spec) {
  return {
    executable: basename(spec.executable),
    script: basename(spec.args[0]),
    args: spec.args.slice(1).map((arg) => {
      if (typeof arg === 'string' && arg.startsWith('/')) return `<resolved:${basename(arg)}>`;
      return arg;
    }),
  };
}

function terminateChild(child, shared) {
  if (shared.killed) return;
  shared.killed = true;
  const signal = (name) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  shared.killTimer = setTimeout(() => signal('SIGKILL'), shared.killDelayMs);
  shared.killTimer.unref?.();
}

function appendBounded(state, shared, chunk, child) {
  const buffer = Buffer.from(chunk);
  const remaining = shared.outputLimit - shared.bytes;
  if (remaining > 0) state.parts.push(buffer.subarray(0, remaining));
  shared.bytes += buffer.length;
  if (shared.bytes > shared.outputLimit) terminateChild(child, shared);
}

export function executeActionSpec(spec, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, BARROTUBE_CHANNEL_ACTION: '1' },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = { parts: [] };
    const stderr = { parts: [] };
    const shared = {
      bytes: 0,
      killed: false,
      killTimer: null,
      timedOut: false,
      outputLimit: options.outputLimit ?? OUTPUT_LIMIT,
      killDelayMs: options.killDelayMs ?? 2_000,
    };
    const timeout = setTimeout(() => {
      shared.timedOut = true;
      terminateChild(child, shared);
    }, options.timeoutMs ?? ACTION_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.on('data', (chunk) => appendBounded(stdout, shared, chunk, child));
    child.stderr.on('data', (chunk) => appendBounded(stderr, shared, chunk, child));
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (shared.killTimer) clearTimeout(shared.killTimer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      // Keep the SIGKILL fallback alive after the wrapper exits: descendants
      // may share its process group while ignoring SIGTERM.
      if (shared.killTimer && !shared.killed) clearTimeout(shared.killTimer);
      accept({
        code,
        signal,
        stdout: Buffer.concat(stdout.parts).toString('utf8'),
        stderr: Buffer.concat(stderr.parts).toString('utf8'),
        truncated: shared.bytes > shared.outputLimit,
        timed_out: shared.timedOut,
      });
    });
  });
}

function auditAction(event) {
  try {
    const dir = join(SKILL_ROOT, 'logs', 'audit');
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(dir, `${day}.channel-board.jsonl`), `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, 'utf8');
  } catch { /* Audit failure must not reveal credentials or mutate the action. */ }
}

async function runAction(record, action, body, executeAction = executeActionSpec) {
  const episodes = scanChannelEpisodes(record.context);
  const matches = episodes.filter((item) => item.id === body.episode_id);
  let episode;
  if (body.source_profile) {
    episode = matches.find((item) => item.source_profile === body.source_profile);
  } else if (matches.length === 1) {
    [episode] = matches;
  } else if (matches.length > 1) {
    throw new HttpError(409, '동일 ID 에피소드가 여러 파이프라인에 있습니다. source_profile을 지정하세요.', 'AMBIGUOUS_EPISODE', {
      source_profiles: matches.map(item => item.source_profile),
    });
  }
  if (!episode) throw new HttpError(404, `에피소드를 찾지 못했습니다: ${body.episode_id || ''}`, 'EPISODE_NOT_FOUND');
  if (!episode.supported_actions?.includes(action)) {
    throw new HttpError(400, `이 파이프라인에서 지원하지 않는 액션입니다: ${action}`, 'UNSUPPORTED_ACTION');
  }
  if (action !== 'status') {
    if (record.status !== 'active') {
      throw new HttpError(409, '활성화된 채널에서만 제작 액션을 실행할 수 있습니다.', 'CHANNEL_NOT_ACTIVE');
    }
    if (record.unresolvedConflicts?.length) {
      throw new HttpError(409, '미해결 충돌을 먼저 검토해야 합니다.', 'UNRESOLVED_CONFLICTS');
    }
  }

  const spec = episode.source_profile === 'barrotube-s12'
    ? buildS12Action(record, episode, action, body)
    : episode.source_profile === 'media-render-r11'
      ? buildR11Action(record, episode, action, body)
      : buildC4Action(record, episode, action, body);
  if (spec.immediate) return { ok: true, dry_run: false, result: spec.immediate };
  if (body.dry_run === true) return { ok: true, dry_run: true, command: actionPreview(spec) };

  const lockKey = `${record.id}:${episode.source_profile}:${episode.id}`;
  if (runningActions.has(lockKey)) {
    throw new HttpError(409, '이 에피소드에서 다른 액션이 실행 중입니다.', 'EPISODE_BUSY', runningActions.get(lockKey));
  }
  const lock = { action, started_at: new Date().toISOString() };
  runningActions.set(lockKey, lock);
  auditAction({ event: 'action_start', channel_id: record.id, episode_id: episode.id, profile: episode.source_profile, action });
  try {
    const result = await executeAction(spec);
    auditAction({ event: 'action_end', channel_id: record.id, episode_id: episode.id, profile: episode.source_profile, action, code: result.code, signal: result.signal });
    return { ok: result.code === 0, dry_run: false, action, ...result };
  } finally {
    runningActions.delete(lockKey);
  }
}

function boardHtml(token) {
  const source = readFileSync(join(BOARD_DIR, 'index.html'), 'utf8');
  const meta = `<meta name="barrotube-board-token" content="${token}">`;
  return /<meta\s+name="barrotube-board-token"[^>]*>/.test(source)
    ? source.replace(/<meta name="barrotube-board-token"[^>]*>/, meta)
    : source.replace('</head>', `${meta}</head>`);
}

function decodeSegments(pathname) {
  try { return pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new HttpError(400, 'URL 인코딩이 올바르지 않습니다.', 'INVALID_URL'); }
}

export function createBoardServer(options = {}) {
  const port = Number(options.port ?? 8933);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${options.port}`);
  const token = options.token || randomBytes(32).toString('base64url');
  const registry = options.registry || createChannelRegistry(registryOptions(options.registryOptions));
  const executeAction = typeof options.executeAction === 'function' ? options.executeAction : executeActionSpec;

  const server = createServer(async (req, res) => {
    try {
      assertLoopbackHost(req);
      const address = server.address();
      const activePort = address && typeof address === 'object' ? address.port : port;
      const url = new URL(req.url || '/', `http://127.0.0.1:${activePort}`);
      const segments = decodeSegments(url.pathname);
      if (MUTATING_METHODS.has(req.method || 'GET')) assertMutationAuthorized(req, token, activePort);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return html(res, 200, boardHtml(token));
      }

      if (req.method === 'GET' && segments.length === 2 && segments[0] === 'channels') {
        const record = await registry.getChannel(segments[1]);
        return html(res, 200, renderRecordDocument(record, { offline: false }).html);
      }

      if (segments[0] !== 'api') throw new HttpError(404, 'not found', 'NOT_FOUND');

      if (req.method === 'GET' && segments.length === 2 && segments[1] === 'channels') {
        const records = await registry.listChannels();
        return json(res, 200, {
          channels_root: registry.channelsRoot,
          channels: records.map(summarize),
        });
      }

      if (req.method === 'POST' && segments.length === 2 && segments[1] === 'channels') {
        const body = await parseJsonBody(req);
        const created = await registry.createChannel(body.manifest || body);
        return json(res, 201, detailPayload(created));
      }

      if (segments.length >= 3 && segments[1] === 'channels') {
        const id = segments[2];
        if (req.method === 'GET' && segments.length === 3) {
          return json(res, 200, detailPayload(await registry.getChannel(id)));
        }
        if (req.method === 'PUT' && segments.length === 3) {
          const body = await parseJsonBody(req);
          const expectedRevision = Number(body.expected_revision || req.headers['if-match']);
          const updated = await registry.updateChannel(id, body.manifest || body.patch || body, { expectedRevision });
          return json(res, 200, detailPayload(updated));
        }
        if (req.method === 'POST' && segments.length === 4 && segments[3] === 'activate') {
          const body = await parseJsonBody(req);
          const expectedRevision = Number(body.expected_revision || req.headers['if-match']);
          const activated = await registry.activateChannel(id, { expectedRevision });
          return json(res, 200, detailPayload(activated));
        }
        if (req.method === 'GET' && segments.length === 4 && segments[3] === 'episodes') {
          const record = await registry.getChannel(id);
          const observed = scanChannelEpisodes(record.context);
          const view = boardEpisodeViews(record, observed);
          return json(res, 200, {
            channel_id: id,
            observed_count: view.observedCount,
            planned_count: view.plannedCount,
            unobserved_count: view.unobservedCount,
            episodes: observed,
            board_episodes: view.rows,
          });
        }
        if (req.method === 'GET' && segments.length === 4 && segments[3] === 'assets') {
          const record = await registry.getChannel(id);
          const { assets } = assetRequest(record, url);
          return json(res, 200, publicAssets(assets));
        }
        if ((req.method === 'GET' || req.method === 'HEAD') && segments.length === 5
            && segments[3] === 'asset' && segments[4] === 'file') {
          const record = await registry.getChannel(id);
          const request = assetRequest(record, url);
          const relativePath = url.searchParams.get('path') || '';
          if (!listedAsset(request.assets, relativePath)) {
            throw new HttpError(400, '목록에 없는 자산 경로입니다.', 'INVALID_ASSET_PATH');
          }
          const path = resolveSafeAssetPath(
            record.context,
            request.episodeId,
            relativePath,
            request.platform,
            request.sourceProfile,
          );
          if (!path) throw new HttpError(400, '허용되지 않은 자산 경로입니다.', 'INVALID_ASSET_PATH');
          return serveAsset(req, res, path);
        }
        if (req.method === 'POST' && segments.length === 5 && segments[3] === 'documents' && segments[4] === 'render') {
          await parseJsonBody(req);
          const record = await registry.getChannel(id);
          const outputPath = record.context.document_output_path;
          if (!outputPath || typeof outputPath !== 'string' || outputPath.includes('${')
              || record.context.document_output_safe !== true || extname(outputPath).toLowerCase() !== '.html') {
            throw new HttpError(422, 'document.output_path가 안전하게 해석되지 않았습니다.', 'DOCUMENT_PATH_UNRESOLVED');
          }
          const previousGeneratedAt = documentGeneratedAt(outputPath);
          let rendered = renderRecordDocument(record, {
            offline: true,
            generatedAt: previousGeneratedAt || new Date().toISOString(),
          });
          if (previousGeneratedAt && !readFileSync(outputPath).equals(Buffer.from(rendered.html))) {
            rendered = renderRecordDocument(record, { offline: true, generatedAt: new Date().toISOString() });
          }
          const write = atomicWrite(outputPath, rendered.html, { backup: true });
          return json(res, 200, { ok: true, output_path: outputPath, ...write, episode_count: rendered.episodes.length });
        }
        if (req.method === 'POST' && segments.length === 5 && segments[3] === 'actions') {
          const body = await parseJsonBody(req);
          const record = await registry.getChannel(id);
          return json(res, 200, await runAction(record, segments[4], body, executeAction));
        }
      }

      if (url.pathname === '/api/run') {
        throw new HttpError(410, '임의 인자 실행 API는 제거되었습니다. 채널별 actions API를 사용하세요.', 'RAW_RUN_REMOVED');
      }
      throw new HttpError(404, 'not found', 'NOT_FOUND');
    } catch (error) {
      if (!res.headersSent) json(res, errorStatus(error), cleanError(error));
      else res.destroy();
    }
  });

  return { server, token, registry, port };
}

function listenOnce(server, port, host) {
  return new Promise((accept, reject) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      accept(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function listenBoardServer(app, options = {}) {
  const host = options.host || '127.0.0.1';
  const autoPort = options.autoPort ?? true;
  const maxAttempts = Number(options.maxAttempts ?? 20);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`Invalid maxAttempts: ${options.maxAttempts}`);
  }

  const attemptedPorts = [];
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = app.port + attempt;
    if (candidate > 65535) break;
    attemptedPorts.push(candidate);
    try {
      const address = await listenOnce(app.server, candidate, host);
      return {
        host,
        port: address && typeof address === 'object' ? address.port : candidate,
        requested_port: app.port,
        fallback_used: candidate !== app.port,
        attempted_ports: attemptedPorts,
      };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' || !autoPort) {
        error.port = candidate;
        error.attemptedPorts = attemptedPorts;
        throw error;
      }
    }
  }

  const error = new Error(`사용 가능한 보드 포트를 찾지 못했습니다: ${attemptedPorts.join(', ')}`);
  error.code = 'EADDRINUSE';
  error.port = attemptedPorts.at(-1) ?? app.port;
  error.attemptedPorts = attemptedPorts;
  throw error;
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      open: { type: 'boolean', default: false },
    },
  });
  const configuredPort = values.port ?? process.env.BARROTUBE_BOARD_PORT;
  const requestedPort = Number(configuredPort ?? 8933);
  const app = createBoardServer({ port: requestedPort });
  const binding = await listenBoardServer(app, { autoPort: configuredPort === undefined });
  const url = `http://127.0.0.1:${binding.port}`;
  if (binding.fallback_used) {
    console.warn(`포트 ${binding.requested_port} 사용 중 → ${binding.port} 자동 선택`);
  }
  console.log(`BarroTube 채널 보드: ${url}`);
  console.log(`채널 레지스트리: ${app.registry.channelsRoot}`);
  console.log('loopback 전용 · 세션 토큰 · 서버측 액션 허용목록 적용');
  if (values.open) {
    const child = spawn('open', [url], { stdio: 'ignore', detached: true });
    child.unref();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main().catch((error) => {
  if (error?.code === 'EADDRINUSE') {
    const nextPort = Math.min(Number(error.port || 8933) + 1, 65535);
    console.error(`board: 포트 ${error.port || 8933}이 이미 사용 중입니다.`);
    console.error(`다른 포트로 실행: npm run board -- --port ${nextPort} --open`);
  } else {
    console.error(`board: ${error.message}`);
  }
  process.exitCode = 1;
});
