import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseQaReport,
  sha256File,
  verifyPublishApproval,
} from '../scripts/automation/lib/publish-approval.js';

const EXPECTED = {
  channelId: 'demo',
  episodeId: 'EP-2026-0001',
  platform: 'long',
  layout: 'v2',
  channelRevision: 7,
  youtubeChannelId: 'UC_DEMO',
  youtubeDefaults: { privacyStatus: 'private', categoryId: '22' },
};

function fixture({ thumbnail = false } = {}) {
  const episodeRoot = mkdtempSync(join(tmpdir(), 'bt-approval-'));
  const base = join(episodeRoot, 'platforms', 'long');
  mkdirSync(join(base, '55_render'), { recursive: true });
  const video = join(base, '55_render', 'video.mp4');
  const meta = join(base, '70_publish_meta.json');
  const qa = join(base, '60_qa_report.md');
  const approval = join(base, '75_board_approval.json');
  const thumbnailPath = thumbnail ? join(base, '47_thumbnail.png') : null;
  writeFileSync(video, 'video');
  if (thumbnailPath) writeFileSync(thumbnailPath, 'thumbnail');
  writeFileSync(meta, JSON.stringify({
    channel_id: 'demo',
    title: 'Approved title',
    categoryId: '22',
    ...(thumbnail ? { thumbnail: '47_thumbnail.png' } : {}),
  }));
  writeFileSync(qa, [
    '# QA Report',
    `**Video SHA-256**: \`${sha256File(video)}\``,
    '**Risk**: `LOW`',
    '',
    '## Verdict',
    '**PASS** (risk: LOW)',
    '',
  ].join('\n'));
  const approvalValue = {
    approved: true,
    channel_id: 'demo',
    episode_id: 'EP-2026-0001',
    channel_revision: 7,
    youtube_channel_id: 'UC_DEMO',
    effective_upload: { privacyStatus: 'private', categoryId: '22', publishAt: null },
    platform: 'long',
    layout: 'v2',
    video_sha256: sha256File(video),
    metadata_sha256: sha256File(meta),
    qa_sha256: sha256File(qa),
    thumbnail_sha256: thumbnailPath ? sha256File(thumbnailPath) : null,
  };
  writeFileSync(approval, JSON.stringify(approvalValue));
  return { episodeRoot, base, video, meta, qa, approval, approvalValue, thumbnailPath };
}

function verify(item, overrides = {}) {
  return verifyPublishApproval({
    approvalPath: item.approval,
    videoPath: item.video,
    metaPath: item.meta,
    qaPath: item.qa,
    episodeRoot: item.episodeRoot,
    ...EXPECTED,
    ...overrides,
  });
}

test('hash-bound approval returns the exact immutable artifact bytes', () => {
  const item = fixture({ thumbnail: true });
  const result = verify(item);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.metadata.title, 'Approved title');
  assert.equal(result.artifacts.video.toString(), 'video');
  assert.equal(result.artifacts.thumbnail.toString(), 'thumbnail');
});

test('legacy, changed, or cross-context approvals are rejected', () => {
  const item = fixture();
  writeFileSync(item.approval, JSON.stringify({ approved: true }));
  assert.match(verify(item).reason, /legacy/);

  writeFileSync(item.approval, JSON.stringify(item.approvalValue));
  writeFileSync(item.video, 'replacement');
  assert.match(verify(item).reason, /video hash/);

  const fresh = fixture();
  assert.match(verify(fresh, { episodeId: 'EP-OTHER' }).reason, /episode/);
  assert.match(verify(fresh, { platform: 'shorts' }).reason, /platform/);
  assert.match(verify(fresh, { layout: 'v1' }).reason, /layout/);
  assert.match(verify(fresh, { channelRevision: 8 }).reason, /manifest changed/);
  assert.match(
    verify(fresh, { youtubeDefaults: { privacyStatus: 'public', categoryId: '22' } }).reason,
    /publish settings changed/,
  );
});

test('QA parser rejects missing, unknown, duplicate, and contradictory final fields', () => {
  const hash = 'a'.repeat(64);
  const report = (risk, verdict = '**PASS** (risk: LOW)') => [
    `**Video SHA-256**: \`${hash}\``,
    ...(risk === null ? [] : [`**Risk**: \`${risk}\``]),
    '## Verdict',
    verdict,
  ].join('\n');
  assert.equal(parseQaReport(report('LOW')).passed, true);
  assert.equal(parseQaReport(report(null)).passed, false);
  assert.equal(parseQaReport(report('UNKNOWN')).passed, false);
  assert.equal(parseQaReport(`${report('LOW')}\n## Verdict\n**FAIL** (risk: HIGH)`).passed, false);
  assert.equal(parseQaReport(`${report('LOW')}\n**Risk**: \`HIGH\``).passed, false);
  assert.equal(parseQaReport(report('LOW', '**PASS** (risk: HIGH)')).passed, false);
});

test('thumbnail is hash-bound and symlinks escaping the episode are rejected', () => {
  const item = fixture({ thumbnail: true });
  writeFileSync(item.thumbnailPath, 'replacement thumbnail');
  assert.match(verify(item).reason, /thumbnail hash/);

  const linked = fixture();
  const outside = join(tmpdir(), `bt-outside-${process.pid}-${Date.now()}.png`);
  writeFileSync(outside, 'outside');
  const thumbnail = join(linked.base, '47_thumbnail.png');
  symlinkSync(outside, thumbnail);
  const metadata = { channel_id: 'demo', categoryId: '22', thumbnail: '47_thumbnail.png' };
  writeFileSync(linked.meta, JSON.stringify(metadata));
  linked.approvalValue.metadata_sha256 = sha256File(linked.meta);
  linked.approvalValue.thumbnail_sha256 = sha256File(outside);
  writeFileSync(linked.approval, JSON.stringify(linked.approvalValue));
  assert.match(verify(linked).reason, /symbolic link/);
});
