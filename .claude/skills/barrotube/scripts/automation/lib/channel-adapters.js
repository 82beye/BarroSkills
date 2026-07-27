import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp',
  '.mp4', '.mov', '.webm',
  '.wav', '.mp3', '.m4a', '.aac',
  '.md', '.json', '.txt', '.srt', '.vtt',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac']);

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
};

const ACTIONS = {
  'barrotube-s12': [
    'script', 'factcheck', 'verify-prompts', 'tts', 'sync-durations', 'images', 'intro',
    'thumbnail', 'endcard', 'render', 'qa', 'metadata', 'approve',
    'publish', 'status',
  ],
  'media-render-r11': ['status', 'sync', 'autopilot'],
  'carousel-c4': ['sync', 'build', 'qa', 'meta', 'autopilot'],
};

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function canonicalDirectory(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function isContained(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function safeFileFromRoot(root, relativePath) {
  if (!root || typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath)) return null;
  const candidate = resolve(root, relativePath);
  if (!isContained(root, candidate)) return null;
  if (!ALLOWED_EXTENSIONS.has(extname(candidate).toLowerCase()) || !existsSync(candidate)) return null;

  try {
    // Asset files must be regular files at their lexical path. Rejecting file
    // symlinks keeps extension, backup-name, and platform checks bound to the
    // same on-disk object that will later be served.
    if (!lstatSync(candidate).isFile()) return null;
    const real = realpathSync(candidate);
    if (!isContained(root, real)
        || !ALLOWED_EXTENSIONS.has(extname(real).toLowerCase())
        || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

function safeChildDirectories(root) {
  if (!root) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const path = canonicalDirectory(join(root, entry.name));
        return path && isContained(root, path) ? { name: entry.name, path } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeRelative(path) {
  return path.split(sep).join('/');
}

function frontmatterValue(markdown, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) return null;
  return match[1]
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2') || null;
}

function markdownHeading(markdown) {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  return match ? match[1].replace(/^(?:Episode Brief|EP\s*\d+)\s*[—:\-·]\s*/i, '').trim() : null;
}

function humanizeDirectory(name) {
  return name
    .replace(/^ep\d+[_-]?/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase()) || name;
}

function channelIdOf(context) {
  return firstString(
    context?.id,
    context?.channel_id,
    context?.identity?.id,
    context?.manifest?.id,
    context?.manifest?.identity?.id,
  );
}

function projectRootOf(context) {
  return firstString(
    context?.project_root,
    context?.paths?.project_root,
    context?.paths?.projectRoot,
    context?.manifest?.project_root,
    context?.manifest?.paths?.project_root,
  );
}

function profilesOf(context) {
  const primary = firstString(
    context?.pipeline_profile,
    context?.pipeline?.profile,
    context?.manifest?.pipeline_profile,
    context?.manifest?.pipeline?.profile,
  );
  if (!primary) throw new Error('Channel context is missing pipeline.profile');

  const additional = [
    context?.additional_profiles,
    context?.pipeline?.additional_profiles,
    context?.manifest?.pipeline?.additional_profiles,
  ].find(Array.isArray) || [];

  return [...new Set([primary, ...additional.filter(value => typeof value === 'string')])];
}

function s12EpisodesRoot(context) {
  const explicit = firstString(
    context?.episodes_root,
    context?.paths?.episodes_root,
    context?.paths?.episodes,
    context?.manifest?.episodes_root,
    context?.manifest?.paths?.episodes_root,
  );
  const projectRoot = projectRootOf(context);
  const candidates = [
    explicit,
    projectRoot && basename(projectRoot) === 'episodes' ? projectRoot : null,
    projectRoot ? join(projectRoot, 'workspace', 'episodes') : null,
    projectRoot ? join(projectRoot, 'episodes') : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const root = canonicalDirectory(candidate);
    if (root) return root;
  }
  return null;
}

function seriesIndexPath(context, projectRoot) {
  return firstString(
    context?.series_index,
    context?.paths?.series_index,
    context?.manifest?.series_index,
    context?.manifest?.paths?.series_index,
  ) || (projectRoot ? join(projectRoot, 'series', 'index.json') : null);
}

function loadSeriesEntries(context, projectRoot) {
  const index = readJson(seriesIndexPath(context, projectRoot));
  if (Array.isArray(index?.series)) {
    return index.series.flatMap(series => {
      if (!series || !Array.isArray(series.episodes)) return [];
      return series.episodes.map(episode => ({
        ...episode,
        series_id: firstString(episode?.series_id, series.id),
      }));
    });
  }
  if (Array.isArray(index?.episodes)) {
    return index.episodes.map(episode => ({
      ...episode,
      series_id: firstString(episode?.series_id, index.id, index.series_id),
    }));
  }
  return [];
}

function seriesEntryFor(entries, projectRoot, episodeRoot, episodeNumber = null) {
  const rel = normalizeRelative(relative(projectRoot, episodeRoot));
  const folderMatch = entries.find(entry => {
    const folder = typeof entry?.folder === 'string' ? entry.folder.replace(/^\.\//, '').replace(/\\/g, '/') : null;
    return folder && (folder === rel || folder.endsWith(`/${rel}`));
  });
  if (folderMatch) return folderMatch;

  if (episodeNumber === null) return null;
  const numberMatches = entries.filter(entry => Number(entry?.episode_no) === Number(episodeNumber));
  return numberMatches.length === 1 ? numberMatches[0] : null;
}

function seriesEntryByKey(entries, seriesId, episodeNumber) {
  if (!seriesId || episodeNumber === null || episodeNumber === undefined) return null;
  const matches = entries.filter(entry => (
    entry?.series_id === seriesId
    && Number(entry?.episode_no) === Number(episodeNumber)
  ));
  return matches.length === 1 ? matches[0] : null;
}

function positiveEpisodeNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

function correlationFields(series, fallback = {}) {
  const episodeNo = positiveEpisodeNumber(
    series?.episode_no,
    series?.series_episode,
    fallback.episode_no,
  );
  return {
    series_id: firstString(series?.series_id, fallback.series_id),
    episode_no: episodeNo,
    plan_id: firstString(series?.id, series?.episode_id, fallback.plan_id),
    slug: firstString(series?.slug, fallback.slug),
  };
}

function directMatchingFiles(root, pattern) {
  try {
    return readdirSync(root)
      .filter(name => pattern.test(name))
      .sort()
      .map(name => ({ name, path: safeFileFromRoot(root, name) }))
      .filter(item => item.path);
  } catch {
    return [];
  }
}

function existingFile(root, relativePath) {
  return safeFileFromRoot(root, relativePath);
}

function countFiles(root, relativeDirectory, extensions) {
  const directory = canonicalDirectory(join(root, relativeDirectory));
  if (!directory || !isContained(root, directory)) return 0;
  try {
    return readdirSync(directory, { withFileTypes: true }).filter(entry => {
      if (!entry.isFile() && !entry.isSymbolicLink()) return false;
      if (!extensions.has(extname(entry.name).toLowerCase())) return false;
      return Boolean(safeFileFromRoot(root, join(relativeDirectory, entry.name)));
    }).length;
  } catch {
    return 0;
  }
}

function parseQaFile(root, relativePath) {
  const path = existingFile(root, relativePath);
  if (!path) return { exists: false, passed: null, status: 'missing', source: null };

  const source = normalizeRelative(relativePath);
  if (extname(path).toLowerCase() === '.json') {
    const json = readJson(path);
    const raw = json?.ok ?? json?.passed ?? json?.pass ?? json?.verdict;
    const passed = typeof raw === 'boolean'
      ? raw
      : typeof raw === 'string'
        ? /^(?:pass|passed|ok|success)$/i.test(raw)
        : null;
    return { exists: true, passed, status: passed === true ? 'pass' : passed === false ? 'fail' : 'unknown', source };
  }

  const markdown = readText(path);
  const verdict = markdown.match(/(?:Verdict[^\n]*\n[^\n]*|\*\*(?:PASS|FAIL)\*\*)/i)?.[0] || '';
  const passed = /\bPASS\b/i.test(verdict) ? true : /\bFAIL\b/i.test(verdict) ? false : null;
  return { exists: true, passed, status: passed === true ? 'pass' : passed === false ? 'fail' : 'unknown', source };
}

function parsePublishJson(json, source) {
  const youtube = json?.targets?.youtube || {};
  const videoId = firstString(
    youtube.videoId,
    youtube.video_id,
    json?.videoId,
    json?.video_id,
    json?.post_id,
    json?.media_id,
  );
  const url = firstString(
    youtube.url,
    json?.url,
    json?.permalink,
    videoId && (json?.schema?.includes('instagram') ? null : `https://youtu.be/${videoId}`),
  );
  const status = firstString(json?.status, youtube.status)
    || (json?.published === true ? 'published' : null);
  const published = json?.published === true
    || Boolean(videoId)
    || /^(?:published|uploaded|scheduled|success|completed)$/i.test(status || '');

  return {
    published,
    status,
    video_id: videoId,
    url,
    privacy: firstString(
      json?.privacyStatus,
      json?.privacy_status,
      json?.privacy,
      youtube.privacyStatus,
      youtube.privacy_status,
    ),
    published_at: firstString(
      json?.published_at,
      json?.publishedAt,
      youtube.published_at,
      youtube.publishedAt,
    ),
    source,
  };
}

function missingPublish() {
  return {
    published: false,
    status: null,
    video_id: null,
    url: null,
    privacy: null,
    published_at: null,
    source: null,
  };
}

function publishFromFiles(root, pattern = /^80_publish_result(?:\..+)?\.json$/) {
  for (const item of directMatchingFiles(root, pattern)) {
    const parsed = parsePublishJson(readJson(item.path), item.name);
    if (parsed.published) return parsed;
  }
  return missingPublish();
}

function publishFromS12Status(status) {
  const historyUrl = Array.isArray(status?.stage_history)
    ? status.stage_history.map(item => item?.youtube_url).filter(Boolean).pop()
    : null;
  const videoId = firstString(status?.publish?.video_id, status?.publish?.videoId, status?.video_id, status?.videoId);
  const url = firstString(status?.publish?.url, historyUrl, videoId ? `https://youtu.be/${videoId}` : null);
  if (!videoId && !url) return missingPublish();
  return {
    published: true,
    status: firstString(status?.publish?.status, 'published'),
    video_id: videoId,
    url,
    privacy: firstString(status?.publish?.privacy, status?.publish?.privacy_status),
    published_at: firstString(status?.publish?.published_at, status?.publish?.publish_at),
    source: '.episode_status.json',
  };
}

function maxQa(qas) {
  const existing = qas.filter(qa => qa.exists);
  if (!existing.length) return { exists: false, passed: null, status: 'missing', sources: [] };
  const passed = existing.some(qa => qa.passed === false)
    ? false
    : existing.every(qa => qa.passed === true) ? true : null;
  return {
    exists: true,
    passed,
    status: passed === true ? 'pass' : passed === false ? 'fail' : 'unknown',
    sources: existing.map(qa => qa.source),
  };
}

function highestStage(stages, order) {
  return stages.reduce((best, stage) => order.indexOf(stage) > order.indexOf(best) ? stage : best, null);
}

function lifecycleFromSStage(stage, publish) {
  if (publish?.published) return 'published';
  const numeric = Number(/^S(\d+)/.exec(stage || '')?.[1] || -1);
  if (numeric >= 9) return 'approval';
  if (numeric >= 8) return 'qa';
  if (numeric >= 7) return 'render';
  if (numeric >= 6) return 'assets';
  if (numeric >= 2) return 'script';
  return 'planned';
}

function lifecycleFromRStage(stage, publish, hasMeta) {
  if (publish?.published) return 'published';
  if (hasMeta || /^R(?:9|10|11)$/.test(stage || '')) return 'approval';
  if (/^R8$/.test(stage || '')) return 'qa';
  if (/^R(?:6|7)$/.test(stage || '')) return 'render';
  if (/^R(?:2|3|4|5)$/.test(stage || '')) return 'assets';
  if (/^R1$/.test(stage || '')) return 'script';
  return 'planned';
}

function lifecycleFromCStage(stage, publish, hasMeta) {
  if (publish?.published) return 'published';
  if (hasMeta || stage === 'C4') return 'approval';
  if (stage === 'C3') return 'qa';
  if (stage === 'C2') return 'assets';
  if (stage === 'C1') return 'script';
  return 'planned';
}

function scanS12Platform(episodeRoot, platformRoot, platformName, status) {
  const local = relativePath => existingFile(platformRoot, relativePath);
  const shared = relativePath => local(relativePath) || existingFile(episodeRoot, relativePath);
  const qaPath = local('60_qa_report.md')
    ? '60_qa_report.md'
    : directMatchingFiles(platformRoot, /^60_qa_report(?:\..+)?\.json$/)[0]?.name || null;
  const qa = qaPath ? parseQaFile(platformRoot, qaPath) : { exists: false, passed: null, status: 'missing', source: null };
  let publish = publishFromFiles(platformRoot);
  if (!publish.published) publish = publishFromS12Status(status);

  return {
    platform: platformName,
    script: Boolean(shared('30_script.md')),
    factcheck: Boolean(shared('35_factcheck.md')),
    images: countFiles(platformRoot, join('40_assets', 'images'), IMAGE_EXTENSIONS),
    videos: countFiles(platformRoot, join('40_assets', 'videos'), VIDEO_EXTENSIONS),
    audio: countFiles(platformRoot, join('40_assets', 'tts'), AUDIO_EXTENSIONS),
    intro: Boolean(local('45_intro.png')),
    thumbnail: Boolean(local('47_thumbnail.png') || local('47_thumbnail.jpg')),
    endcard: Boolean(local('48_endcard.png') || local('48_outro.png')),
    render: Boolean(local(join('55_render', 'video.mp4'))),
    qa,
    meta: Boolean(local('70_publish_meta.json')),
    approval: Boolean(local('75_board_approval.json')),
    publish,
  };
}

function s12ArtifactStage(episodeRoot, platforms, status) {
  const has = predicate => platforms.some(predicate);
  const stages = [];
  if (existingFile(episodeRoot, '00_brief.md')) stages.push('S0');
  if (existingFile(episodeRoot, '10_market_research.md')) stages.push('S2');
  if (existingFile(episodeRoot, '20_strategy.md')) stages.push('S3');
  if (has(item => item.script)) stages.push('S4');
  if (has(item => item.factcheck)) stages.push('S5');
  if (has(item => item.images || item.videos || item.audio || item.intro || item.thumbnail || item.endcard)) stages.push('S6');
  if (has(item => item.render)) stages.push('S7');
  if (has(item => item.qa.exists)) stages.push('S8');
  if (has(item => item.meta)) stages.push('S9');
  if (has(item => item.approval)) stages.push('S10');
  if (has(item => item.publish.published)) stages.push('S11');

  return highestStage(stages, ['S0', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11'])
    || firstString(status?.current_stage)
    || 'S0';
}

function discoverS12(context) {
  const episodesRoot = s12EpisodesRoot(context);
  if (!episodesRoot) return [];
  const channelId = channelIdOf(context);
  const projectRoot = canonicalDirectory(projectRootOf(context)) || projectRootOf(context);
  const seriesEntries = loadSeriesEntries(context, projectRoot);

  return safeChildDirectories(episodesRoot)
    .filter(item => /^EP-\d{4}-\d{4}$/.test(item.name))
    .map(({ name: id, path: episodeRoot }) => {
      const briefPath = existingFile(episodeRoot, '00_brief.md');
      const brief = readText(briefPath);
      const status = readJson(join(episodeRoot, '.episode_status.json'));
      const explicitChannel = firstString(frontmatterValue(brief, 'channel_id'), status?.channel_id);
      const legacyDefaultChannel = firstString(
        context?.pipeline?.legacy_default_channel,
        context?.legacy_default_channel,
      );
      if (!explicitChannel && legacyDefaultChannel !== channelId) return null;
      const declaredChannel = explicitChannel || legacyDefaultChannel;
      if (channelId && declaredChannel && declaredChannel !== channelId) return null;
      const declaredSeriesId = firstString(
        frontmatterValue(brief, 'series_id'),
        status?.series_id,
      );
      const declaredEpisodeNo = positiveEpisodeNumber(
        frontmatterValue(brief, 'series_episode'),
        frontmatterValue(brief, 'episode_no'),
        status?.series_episode,
        status?.episode_no,
      );
      const series = seriesEntryByKey(seriesEntries, declaredSeriesId, declaredEpisodeNo);
      const correlation = correlationFields(series, {
        series_id: declaredSeriesId,
        episode_no: declaredEpisodeNo,
        slug: frontmatterValue(brief, 'slug'),
      });

      const platformsDirectory = canonicalDirectory(join(episodeRoot, 'platforms'));
      const platformDirectories = platformsDirectory && isContained(episodeRoot, platformsDirectory)
        ? safeChildDirectories(platformsDirectory).filter(item => ['long', 'shorts'].includes(item.name))
        : [];
      const layout = platformDirectories.length ? 'v2' : 'v1';
      const platformRecords = platformDirectories.length
        ? platformDirectories.map(item => scanS12Platform(episodeRoot, item.path, item.name, status))
        : [scanS12Platform(episodeRoot, episodeRoot, '(v1-flat)', status)];
      const platforms = Object.fromEntries(platformRecords.map(item => [item.platform, item]));
      const nativeStage = s12ArtifactStage(episodeRoot, platformRecords, status);
      const publish = platformRecords.find(item => item.publish.published)?.publish || publishFromS12Status(status);
      const qa = maxQa(platformRecords.map(item => item.qa));
      const format = firstString(
        frontmatterValue(brief, 'format'),
        platformDirectories.length === 1 ? platformDirectories[0].name : null,
        platformDirectories.length > 1 ? 'multi' : null,
      );
      const title = firstString(
        frontmatterValue(brief, 'topic'),
        status?.topic,
        markdownHeading(brief),
        id,
      );

      const artifacts = {
        layout,
        platforms,
        script: platformRecords.some(item => item.script),
        factcheck: platformRecords.some(item => item.factcheck),
        images: platformRecords.reduce((sum, item) => sum + item.images, 0),
        videos: platformRecords.reduce((sum, item) => sum + item.videos, 0),
        audio: platformRecords.reduce((sum, item) => sum + item.audio, 0),
        render: platformRecords.some(item => item.render),
        meta: platformRecords.some(item => item.meta),
        approval: platformRecords.some(item => item.approval),
      };

      return {
        channel_id: declaredChannel || channelId,
        id,
        title,
        format,
        ...correlation,
        native_stage: nativeStage,
        lifecycle_stage: lifecycleFromSStage(nativeStage, publish),
        artifacts,
        qa,
        publish,
        supported_actions: [...ACTIONS['barrotube-s12']],
        source_profile: 'barrotube-s12',
        updated_at: firstString(status?.last_updated, status?.updated_at, status?.created_at),
        _root: episodeRoot,
        _platformRoots: Object.fromEntries(platformDirectories.map(item => [item.name, item.path])),
      };
    })
    .filter(Boolean);
}

function episodeNumberFromDirectory(name) {
  const match = /^ep0*(\d+)/i.exec(name);
  return match ? Number(match[1]) : null;
}

function derivedBtEpisode(name) {
  const number = episodeNumberFromDirectory(name);
  return number === null ? name : `BT-EP${String(number).padStart(2, '0')}`;
}

function titleFromScript(root) {
  return markdownHeading(readText(existingFile(root, 'script.md')));
}

function scanR11Root(context, projectRoot, seriesEntries, episodeRoot) {
  const jobPath = existingFile(episodeRoot, 'render-job.json');
  if (!jobPath) return null;
  const job = readJson(jobPath);
  if (!job || (job.schema && job.schema !== 'barrotube.render_job.v1')) return null;

  const episodeNumber = episodeNumberFromDirectory(basename(episodeRoot));
  const series = seriesEntryFor(seriesEntries, projectRoot, episodeRoot, episodeNumber);
  const metaFile = directMatchingFiles(episodeRoot, /^70_publish_meta(?:\..+)?\.json$/)[0] || null;
  const meta = metaFile ? readJson(metaFile.path) : null;
  const declaredChannel = firstString(job.channel_id, meta?.channel_id, channelIdOf(context));
  if (channelIdOf(context) && declaredChannel && declaredChannel !== channelIdOf(context)) return null;

  const publish = publishFromFiles(episodeRoot);
  const qaFile = directMatchingFiles(episodeRoot, /^60_qa_report\.media\.json$/)[0]
    || directMatchingFiles(episodeRoot, /^60_qa_report(?:\..+)?\.json$/)[0]
    || null;
  const qa = qaFile
    ? parseQaFile(episodeRoot, qaFile.name)
    : { exists: false, passed: null, status: 'missing', source: null };
  const images = countFiles(episodeRoot, 'Image', IMAGE_EXTENSIONS);
  const videos = countFiles(episodeRoot, 'video', VIDEO_EXTENSIONS);
  const audio = countFiles(episodeRoot, 'audio', AUDIO_EXTENSIONS);
  const ffmpegRender = Boolean(existingFile(episodeRoot, join('55_render', 'video.mp4')));
  const capcutRender = Boolean(existingFile(episodeRoot, join('56_capcut_export', 'video.mp4')));
  const distribution = canonicalDirectory(join(episodeRoot, 'distribution', 'reels'));
  const packaged = Boolean(distribution && isContained(episodeRoot, distribution)
    && countFiles(episodeRoot, join('distribution', 'reels'), VIDEO_EXTENSIONS));
  const timing = Boolean(existingFile(episodeRoot, join('90_timing', 'production-timing.md')));
  const script = Boolean(existingFile(episodeRoot, 'script.md'));

  let nativeStage = 'R0';
  if (script) nativeStage = 'R1';
  if (images) nativeStage = 'R2';
  if (directMatchingFiles(episodeRoot, /^60_qa_report\.images\.json$/).length) nativeStage = 'R3';
  if (videos) nativeStage = 'R4';
  if (directMatchingFiles(episodeRoot, /^60_qa_report\.videos\.json$/).length) nativeStage = 'R5';
  if (ffmpegRender) nativeStage = 'R6';
  if (capcutRender) nativeStage = 'R7';
  if (qa.exists) nativeStage = 'R8';
  if (packaged || metaFile) nativeStage = 'R9';
  if (publish.published) nativeStage = 'R10';
  if (timing) nativeStage = 'R11';

  const id = firstString(job.episode, series?.episode_id, series?.id, derivedBtEpisode(basename(episodeRoot)));
  const title = firstString(job.topic?.title, meta?.title, series?.title, titleFromScript(episodeRoot), humanizeDirectory(basename(episodeRoot)));
  const format = firstString(series?.format, meta?.format, 'reel').replace(/^reels$/i, 'reel');
  const correlation = correlationFields(series, { episode_no: episodeNumber });

  return {
    channel_id: declaredChannel,
    id,
    title,
    format,
    ...correlation,
    native_stage: nativeStage,
    lifecycle_stage: lifecycleFromRStage(nativeStage, publish, Boolean(metaFile)),
    artifacts: {
      layout: 'r11',
      script,
      images,
      videos,
      audio,
      render: ffmpegRender || capcutRender,
      render_kind: capcutRender ? 'capcut' : ffmpegRender ? 'ffmpeg' : null,
      meta: Boolean(metaFile),
      approval: Boolean(existingFile(episodeRoot, '75_board_approval.json')),
      packaged,
      timing,
    },
    qa: { ...qa, sources: qa.source ? [qa.source] : [] },
    publish,
    supported_actions: [...ACTIONS['media-render-r11']],
    source_profile: 'media-render-r11',
    updated_at: firstString(job.updated_at, job.created_at),
    _root: episodeRoot,
    _platformRoots: {},
  };
}

function discoverR11(context) {
  const projectRoot = canonicalDirectory(projectRootOf(context));
  if (!projectRoot) return [];
  const reelsRoot = canonicalDirectory(join(projectRoot, 'barrotube'));
  if (!reelsRoot || !isContained(projectRoot, reelsRoot)) return [];
  const seriesEntries = loadSeriesEntries(context, projectRoot);
  return safeChildDirectories(reelsRoot)
    .map(item => scanR11Root(context, projectRoot, seriesEntries, item.path))
    .filter(Boolean);
}

function scanC4Root(context, projectRoot, seriesEntries, episodeRoot) {
  const jobPath = existingFile(episodeRoot, 'carousel-job.json');
  if (!jobPath) return null;
  const job = readJson(jobPath);
  if (!job || (job.schema && job.schema !== 'barrotube.carousel_job.v1')) return null;

  const series = seriesEntryFor(seriesEntries, projectRoot, episodeRoot);
  const metaFile = directMatchingFiles(episodeRoot, /^70_publish_meta(?:\..+)?\.json$/)[0] || null;
  const meta = metaFile ? readJson(metaFile.path) : null;
  const declaredChannel = firstString(job.channel_id, meta?.channel_id, channelIdOf(context));
  if (channelIdOf(context) && declaredChannel && declaredChannel !== channelIdOf(context)) return null;

  const publish = publishFromFiles(episodeRoot);
  const qaFile = directMatchingFiles(episodeRoot, /^60_qa_report\.carousel\.json$/)[0]
    || directMatchingFiles(episodeRoot, /^60_qa_report(?:\..+)?\.json$/)[0]
    || null;
  const qa = qaFile
    ? parseQaFile(episodeRoot, qaFile.name)
    : { exists: false, passed: null, status: 'missing', source: null };
  const slides = countFiles(episodeRoot, 'slides', IMAGE_EXTENSIONS);
  const script = Boolean(existingFile(episodeRoot, 'script.md'));
  const correlation = correlationFields(series, {
    episode_no: episodeNumberFromDirectory(basename(episodeRoot)),
  });

  let nativeStage = 'C0';
  if (script) nativeStage = 'C1';
  if (slides) nativeStage = 'C2';
  if (qa.exists) nativeStage = 'C3';
  if (metaFile || publish.published) nativeStage = 'C4';

  return {
    channel_id: declaredChannel,
    id: firstString(job.episode, series?.episode_id, series?.id, basename(episodeRoot)),
    title: firstString(job.title, meta?.title, series?.title, titleFromScript(episodeRoot), humanizeDirectory(basename(episodeRoot))),
    format: 'carousel',
    ...correlation,
    native_stage: nativeStage,
    lifecycle_stage: lifecycleFromCStage(nativeStage, publish, Boolean(metaFile)),
    artifacts: {
      layout: 'c4',
      script,
      slides,
      images: slides,
      videos: 0,
      audio: 0,
      render: slides > 0,
      meta: Boolean(metaFile),
      approval: false,
    },
    qa: { ...qa, sources: qa.source ? [qa.source] : [] },
    publish,
    supported_actions: [...ACTIONS['carousel-c4']],
    source_profile: 'carousel-c4',
    updated_at: firstString(job.updated_at, job.created_at),
    _root: episodeRoot,
    _platformRoots: {},
  };
}

function discoverC4(context) {
  const projectRoot = canonicalDirectory(projectRootOf(context));
  if (!projectRoot) return [];
  const dailyRoot = canonicalDirectory(join(projectRoot, 'daily'));
  if (!dailyRoot || !isContained(projectRoot, dailyRoot)) return [];
  const seriesEntries = loadSeriesEntries(context, projectRoot);
  return safeChildDirectories(dailyRoot)
    .map(item => scanC4Root(context, projectRoot, seriesEntries, item.path))
    .filter(Boolean);
}

function discoverRecords(context) {
  const records = [];
  for (const profile of profilesOf(context)) {
    if (profile === 'barrotube-s12') records.push(...discoverS12(context));
    else if (profile === 'media-render-r11') records.push(...discoverR11(context));
    else if (profile === 'carousel-c4') records.push(...discoverC4(context));
    else throw new Error(`Unsupported channel pipeline profile: ${profile}`);
  }
  return records;
}

function publicEpisode(record) {
  const { _root, _platformRoots, ...episode } = record;
  return episode;
}

/**
 * Read all configured channel pipelines and normalize their on-disk state.
 * This function is deliberately read-only; milestone files outrank reported status.
 */
export function scanChannelEpisodes(context) {
  return discoverRecords(context)
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true })
      || a.source_profile.localeCompare(b.source_profile))
    .map(publicEpisode);
}

function selectRecord(context, episodeId, platform, sourceProfile) {
  const candidates = discoverRecords(context).filter(record => record.id === episodeId
    && (!sourceProfile || record.source_profile === sourceProfile));
  if (platform) {
    const platformRecord = candidates.find(record => record._platformRoots?.[platform]);
    if (platformRecord) return platformRecord;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** Return the trusted real episode directory used by an adapter action runner. */
export function resolveEpisodeRoot(context, episodeId, platform = null, sourceProfile = null) {
  if (typeof episodeId !== 'string' || !episodeId) return null;
  const record = selectRecord(context, episodeId, platform, sourceProfile);
  if (!record) return null;
  if (platform && record.source_profile === 'barrotube-s12') {
    return record._platformRoots?.[platform] || (platform === '(v1-flat)' ? record._root : null);
  }
  return record._root;
}

/**
 * Resolve an asset path returned by listChannelAssets. Absolute paths, traversal,
 * disallowed extensions and symlinks escaping the episode root are rejected.
 */
export function resolveSafeAssetPath(context, episodeId, relativePath, platform = null, sourceProfile = null) {
  const record = selectRecord(context, episodeId, platform, sourceProfile);
  if (!record) return null;
  const resolved = safeFileFromRoot(record._root, relativePath);
  if (!resolved) return null;

  if (platform && record.source_profile === 'barrotube-s12' && platform !== '(v1-flat)') {
    const lexical = normalizeRelative(relative(record._root, resolve(record._root, relativePath)));
    if (lexical.startsWith('platforms/')) {
      const expected = `platforms/${platform}/`;
      if (!lexical.startsWith(expected) && !isDistributionAsset(record, { rel: lexical })) return null;
    }
  }
  return resolved;
}

function walkAllowedFiles(root, current = root, depth = 0, results = []) {
  if (depth > 8) return results;
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (/\.bak\.|_(?:bak|backup)(?:[._-]|$)|^\.DS_Store$/i.test(entry.name)) continue;
    const absolute = join(current, entry.name);
    const rel = normalizeRelative(relative(root, absolute));
    if (entry.isDirectory()) {
      const real = canonicalDirectory(absolute);
      if (real && isContained(root, real)) walkAllowedFiles(root, real, depth + 1, results);
      continue;
    }
    if (!entry.isFile()) continue;
    const safe = safeFileFromRoot(root, rel);
    if (!safe) continue;
    results.push({
      rel,
      name: entry.name,
      size: statSync(safe).size,
      type: MIME_TYPES[extname(safe).toLowerCase()] || 'application/octet-stream',
    });
  }
  return results;
}

function isDistributionAsset(record, item) {
  const rel = item.rel.toLowerCase();
  if (/^(?:distribution\/|platforms\/(?:reels|tiktok|youtube)\/)/.test(rel)) return true;
  if (record.source_profile !== 'barrotube-s12' || record.artifacts?.layout !== 'v2') return false;
  return /^(?:40_assets|assets|55_render|56_capcut_export)(?:\/|$)/.test(rel)
    || /^(?:45_intro|47_thumbnail|48_(?:endcard|outro)|60_qa_report|70_publish_meta|75_board_approval|80_publish_result)(?:[._-]|$)/.test(rel);
}

function assetGroup(item, record) {
  const rel = item.rel.toLowerCase();
  const name = item.name.toLowerCase();
  const extension = extname(name);
  if (isDistributionAsset(record, item)) return 'distribution';
  if (VIDEO_EXTENSIONS.has(extension)
      && (/(?:^|\/)(?:55_render|56_capcut_export|distribution\/reels)\//.test(rel)
        || /(?:final|master|export)/.test(name))) return 'render';
  if (IMAGE_EXTENSIONS.has(extension)
      && /(?:intro|thumbnail|endcard|outro|contact[_-]?sheet)/.test(name)) return 'cards';
  if (IMAGE_EXTENSIONS.has(extension)) return 'images';
  if (VIDEO_EXTENSIONS.has(extension)) return 'videos';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (/publish_meta|caption|hashtag/.test(name)) return 'metadata';
  if (/qa_report|approval|publish_result|render-job|carousel-job|timing/.test(rel)) return 'reports';
  if (extension === '.md' || extension === '.srt' || extension === '.vtt') return 'script';
  return 'other';
}

/** List previewable assets without following a symlink outside the episode root. */
export function listChannelAssets(context, episodeId, platform = null, sourceProfile = null) {
  const record = selectRecord(context, episodeId, platform, sourceProfile);
  if (!record) return null;
  let files = walkAllowedFiles(record._root);

  if (platform && record.source_profile === 'barrotube-s12' && platform !== '(v1-flat)') {
    const prefix = `platforms/${platform}/`;
    files = files.filter(item => isDistributionAsset(record, item)
      || !item.rel.startsWith('platforms/')
      || item.rel.startsWith(prefix));
  }

  const groups = {
    script: [],
    images: [],
    videos: [],
    audio: [],
    cards: [],
    render: [],
    distribution: [],
    reports: [],
    metadata: [],
    other: [],
  };
  for (const item of files.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }))) {
    groups[assetGroup(item, record)].push(item);
  }

  return {
    episode_id: episodeId,
    platform: platform || null,
    source_profile: record.source_profile,
    root: record._root,
    groups,
  };
}

export { ALLOWED_EXTENSIONS };
