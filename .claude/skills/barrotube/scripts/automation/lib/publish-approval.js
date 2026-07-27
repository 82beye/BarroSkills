import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';

const THUMBNAIL_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

export function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

export function effectiveYoutubeUpload(metadata = {}, defaults = {}) {
  const platform = metadata.platforms?.youtube || {};
  const publishAt = platform.publishAt || metadata.publishAt || null;
  const privacyStatus = publishAt
    ? 'private'
    : (platform.privacyStatus || metadata.privacyStatus || defaults.privacyStatus || 'private');
  const categoryId = platform.categoryId || metadata.categoryId || defaults.categoryId || null;
  if (!['private', 'unlisted', 'public'].includes(privacyStatus)) {
    throw new Error(`Invalid YouTube privacyStatus: ${privacyStatus}`);
  }
  if (!categoryId || !/^\d+$/.test(String(categoryId))) {
    throw new Error('YouTube categoryId is required in approved metadata or channel manifest');
  }
  return { privacyStatus, categoryId: String(categoryId), publishAt };
}

function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve the optional thumbnail named by approved metadata without allowing it
 * to escape the episode directory. When metadata does not name one, use the
 * same deterministic auto-detection order as the runner.
 */
export function resolveThumbnailArtifact({ metadata, metaPath, episodeRoot = null }) {
  const platformRoot = dirname(resolve(metaPath));
  const allowedRoot = resolve(episodeRoot || platformRoot);
  const realAllowedRoot = realpathSync(allowedRoot);
  const candidates = [];
  if (metadata?.thumbnail !== undefined && metadata?.thumbnail !== null && metadata.thumbnail !== '') {
    if (typeof metadata.thumbnail !== 'string' || metadata.thumbnail.includes('\0')) {
      throw new Error('metadata.thumbnail must be a safe relative path');
    }
    if (isAbsolute(metadata.thumbnail)) {
      throw new Error('metadata.thumbnail must be relative to the episode bundle');
    }
    candidates.push(resolve(platformRoot, metadata.thumbnail));
    if (allowedRoot !== platformRoot) candidates.push(resolve(allowedRoot, metadata.thumbnail));
  } else {
    candidates.push(resolve(platformRoot, '47_thumbnail.png'));
    candidates.push(resolve(platformRoot, '47_thumbnail.jpg'));
    if (allowedRoot !== platformRoot) {
      candidates.push(resolve(allowedRoot, '47_thumbnail.png'));
      candidates.push(resolve(allowedRoot, '47_thumbnail.jpg'));
    }
  }

  for (const candidate of [...new Set(candidates)]) {
    if (!isInside(allowedRoot, candidate)) {
      if (metadata?.thumbnail) throw new Error('metadata.thumbnail escapes the episode directory');
      continue;
    }
    if (!THUMBNAIL_EXTENSIONS.has(extname(candidate).toLowerCase())) {
      if (metadata?.thumbnail) throw new Error('metadata.thumbnail must be a PNG or JPEG image');
      continue;
    }
    if (existsSync(candidate)) {
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new Error('metadata.thumbnail must not be a symbolic link');
      }
      const realCandidate = realpathSync(candidate);
      if (!isInside(realAllowedRoot, realCandidate)) {
        throw new Error('metadata.thumbnail resolves outside the episode directory');
      }
      if (!statSync(realCandidate).isFile()) throw new Error('metadata.thumbnail must be a regular file');
      return realCandidate;
    }
  }
  if (metadata?.thumbnail) throw new Error(`metadata.thumbnail does not exist inside the episode directory`);
  return null;
}

export function parseQaReport(content) {
  const source = String(content || '');
  const verdictHeadings = [...source.matchAll(/^##\s+(?:[^\n]*\s)?Verdict\s*$/gim)];
  const verdictMatches = [...source.matchAll(
    /^##\s+(?:[^\n]*\s)?Verdict\s*$\s*\n+\*\*(PASS|FAIL)\*\*(?:\s*\(risk:\s*(LOW|MEDIUM|HIGH)\))?\s*$/gim,
  )];
  const riskLines = [...source.matchAll(/^\*\*Risk\*\*:\s*([^\n]+)\s*$/gim)];
  const riskMatch = riskLines.length === 1
    ? /^`?(LOW|MEDIUM|HIGH)`?$/i.exec(riskLines[0][1].trim())
    : null;
  const videoLines = [...source.matchAll(/^\*\*Video SHA-256\*\*:\s*([^\n]+)\s*$/gim)];
  const videoMatch = videoLines.length === 1
    ? /^`([a-f0-9]{64})`$/i.exec(videoLines[0][1].trim())
    : null;
  const inlineRisk = verdictMatches.length === 1 ? verdictMatches[0][2]?.toUpperCase() || null : null;
  const canonical = verdictHeadings.length === 1
    && verdictMatches.length === 1
    && Boolean(riskMatch)
    && (!inlineRisk || inlineRisk === riskMatch[1].toUpperCase());
  const verdict = canonical ? verdictMatches[0][1].toUpperCase() : null;
  const risk = canonical ? riskMatch[1].toUpperCase() : null;
  const videoSha256 = videoMatch?.[1]?.toLowerCase() || null;
  return {
    verdict,
    risk,
    video_sha256: videoSha256,
    passed: canonical && verdict === 'PASS' && (risk === 'LOW' || risk === 'MEDIUM'),
  };
}

export function verifyPublishApproval({
  approvalPath,
  videoPath,
  metaPath,
  qaPath,
  channelId,
  episodeId,
  platform = null,
  layout = null,
  episodeRoot = null,
  channelRevision = null,
  youtubeChannelId = null,
  youtubeDefaults = {},
}) {
  if (!channelId) return { ok: false, reason: 'expected channel_id is required' };
  if (!episodeId) return { ok: false, reason: 'expected episode_id is required' };
  if (!Number.isInteger(channelRevision)) return { ok: false, reason: 'expected channel revision is required' };
  if (!youtubeChannelId) return { ok: false, reason: 'expected YouTube channel ID is required' };
  if (!approvalPath || !existsSync(approvalPath)) return { ok: false, reason: 'approval file missing' };
  if (!videoPath || !existsSync(videoPath)) return { ok: false, reason: 'video file missing' };
  if (!metaPath || !existsSync(metaPath)) return { ok: false, reason: 'metadata file missing' };
  if (!qaPath || !existsSync(qaPath)) return { ok: false, reason: 'QA report missing' };

  let approval;
  try { approval = JSON.parse(readFileSync(approvalPath, 'utf8')); }
  catch (error) { return { ok: false, reason: `invalid approval JSON: ${error.message}` }; }

  if (approval.approved !== true) return { ok: false, reason: 'approval is not approved' };
  if (!approval.video_sha256 || !approval.metadata_sha256 || !approval.qa_sha256) {
    return { ok: false, reason: 'legacy approval is not hash-bound; approve again' };
  }
  const artifacts = {
    video: readFileSync(videoPath),
    metadata: readFileSync(metaPath),
    qa: readFileSync(qaPath),
    thumbnail: null,
  };
  let metadata;
  try { metadata = JSON.parse(artifacts.metadata.toString('utf8')); }
  catch (error) { return { ok: false, reason: `invalid metadata JSON: ${error.message}` }; }

  let thumbnailPath = null;
  try {
    thumbnailPath = resolveThumbnailArtifact({ metadata, metaPath, episodeRoot });
    if (thumbnailPath) artifacts.thumbnail = readFileSync(thumbnailPath);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const videoSha256 = sha256Buffer(artifacts.video);
  if (approval.video_sha256 !== videoSha256) return { ok: false, reason: 'video hash changed after approval' };
  if (approval.metadata_sha256 !== sha256Buffer(artifacts.metadata)) return { ok: false, reason: 'metadata hash changed after approval' };
  if (approval.qa_sha256 !== sha256Buffer(artifacts.qa)) return { ok: false, reason: 'QA report changed after approval' };
  if (artifacts.thumbnail) {
    if (!approval.thumbnail_sha256) return { ok: false, reason: 'thumbnail is not hash-bound; approve again' };
    if (approval.thumbnail_sha256 !== sha256Buffer(artifacts.thumbnail)) {
      return { ok: false, reason: 'thumbnail hash changed after approval' };
    }
  } else if (approval.thumbnail_sha256) {
    return { ok: false, reason: 'approved thumbnail is missing' };
  }
  const qa = parseQaReport(artifacts.qa.toString('utf8'));
  if (!qa.passed) return { ok: false, reason: `QA verdict is not publishable (${qa.verdict || 'missing'}/${qa.risk || 'unknown'})` };
  if (!qa.video_sha256) return { ok: false, reason: 'QA report is not bound to a video hash; rerun QA' };
  if (qa.video_sha256 !== videoSha256) return { ok: false, reason: 'QA report was generated for a different video' };
  if (approval.channel_id !== channelId) return { ok: false, reason: 'approval channel does not match expected channel' };
  if (approval.episode_id !== episodeId) return { ok: false, reason: 'approval episode does not match expected episode' };
  if (approval.channel_revision !== channelRevision) return { ok: false, reason: 'channel manifest changed after approval' };
  if (approval.youtube_channel_id !== youtubeChannelId) return { ok: false, reason: 'approval YouTube destination does not match expected channel' };
  if (platform && approval.platform !== platform) return { ok: false, reason: 'approval platform does not match expected platform' };
  if (layout && approval.layout !== layout) return { ok: false, reason: 'approval layout does not match expected layout' };
  let effectiveUpload;
  try { effectiveUpload = effectiveYoutubeUpload(metadata, youtubeDefaults); }
  catch (error) { return { ok: false, reason: error.message }; }
  if (!approval.effective_upload
      || approval.effective_upload.privacyStatus !== effectiveUpload.privacyStatus
      || String(approval.effective_upload.categoryId || '') !== effectiveUpload.categoryId
      || (approval.effective_upload.publishAt || null) !== effectiveUpload.publishAt) {
    return { ok: false, reason: 'effective YouTube publish settings changed after approval' };
  }
  return { ok: true, approval, qa, metadata, thumbnailPath, effectiveUpload, artifacts };
}

export function assertPublishApproval(options) {
  const result = verifyPublishApproval(options);
  if (!result.ok) {
    const error = new Error(`Publish approval rejected: ${result.reason}`);
    error.code = 'PUBLISH_APPROVAL_REJECTED';
    throw error;
  }
  return result;
}
