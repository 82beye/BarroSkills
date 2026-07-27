#!/usr/bin/env node

/**
 * approve-episode.js — Board 승인 토큰 발행 (S10 게이트 해제)
 *
 * Usage:
 *   node approve-episode.js --episode EP-2026-0001 [--by "운영자이름"] [--note "..."]
 *   node approve-episode.js --episode EP-2026-0020 --platform shorts
 *
 * v1.1 (2026-04-25): v2 platforms/ 레이아웃 지원
 *   - paths.js의 resolvePaths(epDir, format) 헬퍼 사용
 *   - brief frontmatter의 format 또는 --platform 플래그로 long/shorts 분기
 *   - v1 평면 레이아웃은 paths.js 자동 fallback으로 그대로 작동
 *
 * 승인 후: run-episode.js를 재실행하면 S10 통과 → S11 자동 진행
 */

import { parseArgs } from 'node:util';
import { writeFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { parse as parseYAML } from 'yaml';
import { resolvePaths } from './paths.js';
import { createChannelRegistry } from './lib/channel-registry.js';
import {
  effectiveYoutubeUpload,
  parseQaReport,
  resolveThumbnailArtifact,
  sha256File,
} from './lib/publish-approval.js';

const WORKSPACE = resolve(import.meta.dirname, '../../workspace');
const SKILL_ROOT = resolve(import.meta.dirname, '../..');
const DATA_ROOT = resolve(process.env.BARROTUBE_DATA || '/Users/beye/BarroTubeData');
const FACTORY_ROOT = resolve(process.env.BARRO_AI_FACTORY || '/Users/beye/BarroAiFactory');

const { values } = parseArgs({
  options: {
    episode:  { type: 'string', short: 'e' },
    by:       { type: 'string', short: 'b' },
    note:     { type: 'string', short: 'n' },
    platform: { type: 'string', short: 'p' },  // 'long' | 'shorts' (선택, brief 우선)
    'episode-dir': { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
});

if (!values.episode) {
  console.error('Usage: node approve-episode.js --episode <EP-YYYY-NNNN> [--episode-dir <resolved-dir>] [--by <name>] [--note <text>] [--platform long|shorts] [--dry-run]');
  process.exit(1);
}

const episodeDir = values['episode-dir'] ? resolve(values['episode-dir']) : join(WORKSPACE, 'episodes', values.episode);
if (!existsSync(episodeDir)) {
  console.error(`❌ Episode not found: ${values.episode}`);
  process.exit(1);
}

// brief frontmatter에서 format 추출 → 어느 platforms/{long|shorts}/를 검사할지 결정
const briefPath = join(episodeDir, '00_brief.md');
let briefFmt = 'long-3min';
let channelId = null;
if (existsSync(briefPath)) {
  try {
    const briefRaw = readFileSync(briefPath, 'utf-8');
    const m = briefRaw.match(/^---\n([\s\S]*?)\n---/);
    if (m) {
      const fm = parseYAML(m[1]);
      if (fm?.format) briefFmt = fm.format;
      if (fm?.channel_id || fm?.channel) channelId = fm.channel_id || fm.channel;
    }
  } catch (e) {
    console.warn(`⚠️  brief frontmatter 파싱 실패: ${e.message}. format=long-3min 가정.`);
  }
}

// --platform 플래그가 있으면 우선 (운영자가 명시적 지정)
const format = values.platform === 'shorts' ? 'shorts'
             : values.platform === 'long' ? 'long-3min'
             : briefFmt;

const p = resolvePaths(episodeDir, format);

console.log(`📂 Episode: ${values.episode}`);
console.log(`   Format: ${format} → platform=${p.platform}, layout=${p.isV2 ? 'v2 (platforms/)' : 'v1 (legacy)'}`);
console.log(`   Base dir: ${p.base}`);

// 선결조건: QA 리포트 + 메타데이터 + 렌더 존재
const required = [
  { path: p.video, label: 'Rendered video',      rel: '55_render/video.mp4' },
  { path: p.qa,    label: 'QA report',            rel: '60_qa_report.md' },
  { path: p.meta,  label: 'Metadata',             rel: '70_publish_meta.json' },
];

const missing = required.filter(r => !existsSync(r.path));
if (missing.length > 0) {
  for (const r of missing) {
    console.error(`❌ Missing: ${r.label} (${r.rel})`);
    console.error(`   Expected at: ${r.path}`);
  }
  console.error(`\n   S10 승인은 S7~S9 완료 후에만 가능합니다.`);
  process.exit(1);
}

// 메타/QA 간단 미리보기
const meta = JSON.parse(readFileSync(p.meta, 'utf-8'));
const qa = readFileSync(p.qa, 'utf-8');
if (channelId && meta.channel_id && channelId !== meta.channel_id) {
  console.error(`❌ Channel mismatch: brief=${channelId}, metadata=${meta.channel_id}`);
  process.exit(2);
}
channelId = meta.channel_id || channelId || null;
if (!channelId) {
  console.error('❌ channel_id가 brief/metadata에 없어 채널 결속 승인을 만들 수 없습니다.');
  process.exit(2);
}
const registry = createChannelRegistry({
  skillRoot: SKILL_ROOT,
  dataRoot: DATA_ROOT,
  factoryRoot: FACTORY_ROOT,
  allowedRoots: [DATA_ROOT, FACTORY_ROOT, resolve(SKILL_ROOT, '../../..')],
});
let channelRecord;
try { channelRecord = await registry.getChannel(channelId); }
catch (error) {
  console.error(`❌ Channel registry lookup failed: ${error.message}`);
  process.exit(2);
}
if (channelRecord.status !== 'active' || channelRecord.unresolvedConflicts.length) {
  console.error(`❌ Channel ${channelId} must be active with no unresolved conflicts before approval.`);
  process.exit(2);
}
const youtube = channelRecord.manifest.platforms?.youtube;
if (youtube?.enabled === false || !youtube?.channel_id) {
  console.error(`❌ Channel ${channelId} has no enabled, verified YouTube destination.`);
  process.exit(2);
}
const youtubeDefaults = {
  privacyStatus: youtube.default_privacy || null,
  categoryId: youtube.category_id || null,
};
let effectiveUpload;
try { effectiveUpload = effectiveYoutubeUpload(meta, youtubeDefaults); }
catch (error) {
  console.error(`❌ Publish settings rejected: ${error.message}`);
  process.exit(2);
}
const videoSha256 = sha256File(p.video);
const metadataSha256 = sha256File(p.meta);
const qaSha256 = sha256File(p.qa);
let thumbnailPath = null;
try {
  thumbnailPath = resolveThumbnailArtifact({ metadata: meta, metaPath: p.meta, episodeRoot: episodeDir });
} catch (error) {
  console.error(`❌ Thumbnail rejected: ${error.message}`);
  process.exit(2);
}
const thumbnailSha256 = thumbnailPath ? sha256File(thumbnailPath) : null;

console.log(`\n📋 Episode: ${values.episode}`);
console.log(`   Title: ${meta.title || '(no title)'}`);
console.log(`   Tags: ${(meta.tags || []).join(', ')}`);
console.log(`   Privacy: ${effectiveUpload.privacyStatus}`);
console.log(`   Category: ${effectiveUpload.categoryId}`);
console.log(`   Publish At: ${effectiveUpload.publishAt || 'ASAP'}`);
console.log(`\n   QA Preview (first 10 lines):`);
console.log(qa.split('\n').slice(0, 10).map(l => `     ${l}`).join('\n'));

// QA Public Figure Policy BLOCK 게이트 (CEO 정책 v1.0 §6.3)
// 60_qa_report.md에 "Risk: HIGH" + Public Figure Policy BLOCK 마커가 있으면 승인 거부.
// 정책 §6.3 "BLOCK 시 동작": Producer 자율 승인 모드도 우회 불가.
// 우회는 brief frontmatter `policy_override` 토큰만 허용 (이 경우 generate-qa-report.js가
// BLOCK을 WARN으로 다운그레이드해 risk:HIGH가 더 이상 나오지 않음).
const qaResult = parseQaReport(qa);
const qaRiskLevel = qaResult.risk;
const qaVerdict = qaResult.verdict;
const hasPolicyBlock =
  /\| Public Figure Policy \| ❌ \|/.test(qa) ||
  /## Public Figure Policy Checks[\s\S]*?### BLOCK \(S10 차단\)/.test(qa);

if (hasPolicyBlock || !qaResult.passed || qaResult.video_sha256 !== videoSha256) {
  console.error(`\n❌ S10 Board 승인 거부 — 명시적인 QA PASS가 필요합니다 (Risk=${qaRiskLevel || 'unknown'}, verdict=${qaVerdict || 'unknown'}).`);
  if (qaResult.video_sha256 !== videoSha256) {
    console.error('   QA 리포트의 영상 해시가 현재 렌더와 다릅니다. QA를 다시 실행하세요.');
  }
  if (hasPolicyBlock) console.error(`   Public Figure 정책 BLOCK은 자율 승인 모드도 우회할 수 없습니다.`);
  console.error(`   다음 중 하나를 수행하세요:`);
  console.error(`     1) Writer · Image Generator 재집필·재생성으로 BLOCK 사유 제거 후 재검사`);
  console.error(`     2) brief frontmatter에 policy_override 토큰 추가 (운영자 명시 사인 + 사유 + 시각):`);
  console.error(`        policy_override:`);
  console.error(`          section: "<§N>"  # 예: "5.1" 또는 "*"`);
  console.error(`          reason: "<운영자 사유>"`);
  console.error(`          approved_by: "<board-handle>"`);
  console.error(`          approved_at: "<ISO8601>"`);
  console.error(`     그 후 generate-qa-report.js 재실행 → BLOCK이 WARN으로 다운그레이드 → 재승인 가능.`);
  console.error(`   참조: workspace/channels/${meta.channel_id || 'econ-daily'}/policies/public-figures-policy.md §6.3 / §6.5`);
  process.exit(2);
}

// 멱등성은 승인 대상 해시까지 같을 때만 성립한다. 구형 승인이나 교체된
// 영상/메타의 승인은 보관 후 새 토큰을 발급한다.
if (existsSync(p.approval)) {
  try {
    const existing = JSON.parse(readFileSync(p.approval, 'utf-8'));
    const sameArtifact = existing.video_sha256 === videoSha256
      && existing.metadata_sha256 === metadataSha256
      && existing.qa_sha256 === qaSha256
      && (existing.thumbnail_sha256 || null) === thumbnailSha256
      && existing.episode_id === values.episode
      && (!channelId || existing.channel_id === channelId)
      && existing.channel_revision === channelRecord.revision
      && existing.youtube_channel_id === youtube.channel_id
      && JSON.stringify(existing.effective_upload) === JSON.stringify(effectiveUpload)
      && existing.platform === p.platform
      && existing.layout === (p.isV2 ? 'v2' : 'v1');
    if (sameArtifact && existing.approved === true) {
      console.log(`\n✅ 동일 산출물에 대한 승인이 이미 존재합니다.`);
      console.log(`   Token: ${existing.token}`);
      console.log(`   Approved by: ${existing.approved_by}`);
      console.log(`   Approved at: ${existing.approved_at}`);
      process.exit(0);
    }
    const backup = `${p.approval}.stale.${Date.now()}`;
    if (!values['dry-run']) renameSync(p.approval, backup);
    console.warn(`\n⚠️  기존 승인은 산출물 해시와 일치하지 않아 폐기됩니다${values['dry-run'] ? '' : `: ${backup}`}.`);
  } catch (e) {
    console.warn(`⚠️  기존 75_board_approval.json 파싱 실패: ${e.message}. 새로 발급합니다.`);
  }
}

if (values['dry-run']) {
  console.log(`\n🟡 Dry-run 모드 — 토큰 발급 생략. 모든 산출물 검사 통과.`);
  console.log(`   (실제 승인 시 다음 위치에 75_board_approval.json 생성됨)`);
  console.log(`   Approval path: ${p.approval}`);
  process.exit(0);
}

// 토큰 발행
const approval = {
  approved: true,
  approved_by: values.by || userInfo().username,
  approved_at: new Date().toISOString(),
  note: values.note || '',
  token: `BT-APPROVAL-${Date.now().toString(36).toUpperCase()}`,
  channel_id: channelId,
  episode_id: values.episode,
  channel_revision: channelRecord.revision,
  youtube_channel_id: youtube.channel_id,
  effective_upload: effectiveUpload,
  video_sha256: videoSha256,
  metadata_sha256: metadataSha256,
  qa_sha256: qaSha256,
  thumbnail_sha256: thumbnailSha256,
  platform: p.platform,
  layout: p.isV2 ? 'v2' : 'v1',
};

const tmpApproval = `${p.approval}.tmp-${process.pid}`;
writeFileSync(tmpApproval, `${JSON.stringify(approval, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
renameSync(tmpApproval, p.approval);

console.log(`\n✅ Approval token issued: ${approval.token}`);
console.log(`   Approved by: ${approval.approved_by}`);
console.log(`   Written to: ${p.approval}`);
console.log(`\n다음 단계: node scripts/automation/run-episode.js --episode ${values.episode}`);
console.log(`          (자동 재개 → S11 Publish)`);
