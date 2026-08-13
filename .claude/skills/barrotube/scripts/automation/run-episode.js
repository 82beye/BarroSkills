#!/usr/bin/env node

/**
 * BarroTube — 에피소드 워크플로우 실행 스크립트
 * 체크포인트 기반 재시작(FR-S-003) 지원
 *
 * Usage: node run-episode.js --episode <EP-YYYY-NNNN> [--from <stage>] [--dry-run]
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, statSync, copyFileSync, mkdtempSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { renderDirect } from './render-direct.js';
import { buildDistributionPackage } from './build-distribution.js';
import {
  persistPublishResult,
  publishYouTube,
  releasePublishResultReservation,
  reservePublishResult,
} from './publish-youtube.js';
import { notify } from './notify.js';
import { updateIssueStatus } from './register-paperclip-issue.js';
import { acquireLock, releaseLock, heartbeat as lockHeartbeat } from './in-flight-lock.js';
import { assertPublishApproval } from './lib/publish-approval.js';
import { createChannelRegistry } from './lib/channel-registry.js';

const ROOT = resolve(import.meta.dirname, '../..');

const WORKSPACE = resolve(import.meta.dirname, '../../workspace');
const LOGS = resolve(import.meta.dirname, '../../logs');
const DATA_ROOT = resolve(process.env.BARROTUBE_DATA || '/Users/beye/BarroTubeData');
const FACTORY_ROOT = resolve(process.env.BARRO_AI_FACTORY || '/Users/beye/BarroAiFactory');
let ACTIVE_CHANNEL_ID = null;

async function loadPublishChannel(channelId) {
  const registry = createChannelRegistry({
    skillRoot: resolve(import.meta.dirname, '../..'),
    dataRoot: DATA_ROOT,
    factoryRoot: FACTORY_ROOT,
    allowedRoots: [DATA_ROOT, FACTORY_ROOT, resolve(import.meta.dirname, '../../../../..')],
  });
  const record = await registry.getChannel(channelId);
  if (record.status !== 'active') throw new Error(`Channel ${channelId} is not active`);
  if (record.unresolvedConflicts.length) {
    throw new Error(`Channel ${channelId} has ${record.unresolvedConflicts.length} unresolved conflict(s)`);
  }
  const youtube = record.manifest.platforms?.youtube;
  if (youtube?.enabled === false) throw new Error(`YouTube publishing is disabled for channel ${channelId}`);
  if (!youtube?.channel_id) throw new Error(`Channel ${channelId} is missing platforms.youtube.channel_id`);
  const refs = record.manifest.credentials?.youtube || {};
  for (const field of ['client_id_env', 'client_secret_env', 'refresh_token_env']) {
    if (!refs[field]) throw new Error(`Channel ${channelId} is missing credentials.youtube.${field}`);
  }
  return {
    record,
    credentialEnv: {
      clientIdEnv: refs.client_id_env,
      clientSecretEnv: refs.client_secret_env,
      refreshTokenEnv: refs.refresh_token_env,
    },
    expectedYouTubeChannelId: youtube.channel_id,
    channelDefaults: {
      privacyStatus: youtube.default_privacy || null,
      categoryId: youtube.category_id || null,
    },
  };
}

const STAGES = [
  { id: 'S0',  name: 'brief',           file: '00_brief.md',           agent: '01-ceo' },
  { id: 'S1',  name: 'ticket_created',  file: null,                    agent: '01-ceo' },
  { id: 'S2',  name: 'market_research', file: '10_market_research.md', agent: '03-market-researcher' },
  { id: 'S3',  name: 'strategy',        file: '20_strategy.md',        agent: '04-strategist' },
  { id: 'S4',  name: 'script',          file: '30_script.md',          agent: '05-writer' },
  { id: 'S5',  name: 'factcheck',       file: '35_factcheck.md',       agent: '06-fact-checker' },
  { id: 'S6',  name: 'assets',          file: '40_assets',             agent: '07-asset-pm' },
  { id: 'S7',  name: 'render',          file: '55_render/video.mp4',   agent: '10-capcut-composer' },
  { id: 'S8',  name: 'qa_review',       file: '60_qa_report.md',       agent: '11-qa-reviewer' },
  { id: 'S9',  name: 'metadata',        file: '70_publish_meta.json',  agent: '12-metadata-writer' },
  { id: 'S10', name: 'board_approval',  file: '75_board_approval.json', agent: '01-ceo' },
  { id: 'S11', name: 'publish',         file: '80_publish_result.json', agent: '13-publisher' },
];

function stageArtifactCandidates(episodeDir, file, platform = null) {
  if (platform) return [join(episodeDir, 'platforms', platform, file), join(episodeDir, file)];
  return [
    join(episodeDir, 'platforms', 'long', file),
    join(episodeDir, 'platforms', 'shorts', file),
    join(episodeDir, file),
  ];
}

function detectLastCompleted(episodeDir, platform = null) {
  for (let i = STAGES.length - 1; i >= 0; i--) {
    const stage = STAGES[i];
    if (!stage.file) continue;
    if (stageArtifactCandidates(episodeDir, stage.file, platform).some(path => existsSync(path))) {
      return i;
    }
  }
  return -1;
}

function inferLegacyPlatform(episodeDir, metadata = {}) {
  if (['long', 'shorts'].includes(metadata.platform)) return metadata.platform;
  const format = String(metadata.format || metadata.video_format || '');
  if (/short/i.test(format)) return 'shorts';
  try {
    const brief = readFileSync(join(episodeDir, '00_brief.md'), 'utf8');
    const briefFormat = brief.match(/^format:\s*["']?([^\n"']+)/m)?.[1] || '';
    if (/short/i.test(briefFormat)) return 'shorts';
  } catch {}
  return 'long';
}

export function resolvePublishBundle(episodeDir, requestedPlatform = null) {
  if (requestedPlatform && !['long', 'shorts'].includes(requestedPlatform)) {
    throw new Error(`Unsupported requested platform: ${requestedPlatform}`);
  }
  const metaCandidates = stageArtifactCandidates(episodeDir, '70_publish_meta.json', requestedPlatform);
  const metaFile = metaCandidates.find(path => existsSync(path));
  if (!metaFile) throw new Error(`Missing 70_publish_meta.json (tried: ${metaCandidates.join(', ')})`);
  const platformDir = dirname(metaFile);
  const isV2 = basename(dirname(platformDir)) === 'platforms';
  let metadata = {};
  try { metadata = JSON.parse(readFileSync(metaFile, 'utf8')); } catch {}
  const platform = isV2 ? basename(platformDir) : (requestedPlatform || inferLegacyPlatform(episodeDir, metadata));
  if (!['long', 'shorts'].includes(platform)) throw new Error(`Unsupported publish platform bundle: ${platform}`);
  return {
    metaFile,
    platformDir,
    platform,
    layout: isV2 ? 'v2' : 'v1',
    videoFile: join(platformDir, '55_render', 'video.mp4'),
    qaFile: join(platformDir, '60_qa_report.md'),
    approvalFile: join(platformDir, '75_board_approval.json'),
    publishResultFile: join(platformDir, '80_publish_result.json'),
  };
}

function auditLog(episodeId, action, details) {
  const logDir = join(LOGS, 'audit');
  mkdirSync(logDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(logDir, `${date}.jsonl`);

  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    episode_id: episodeId,
    channel_id: ACTIVE_CHANNEL_ID,
    action,
    ...details,
  });

  appendFileSync(logFile, entry + '\n', 'utf-8');
}

function updateStatus(episodeDir, episodeId, stageId, status, details = {}) {
  const statusFile = join(episodeDir, '.episode_status.json');
  let statusData = existsSync(statusFile)
    ? JSON.parse(readFileSync(statusFile, 'utf-8'))
    : { episode_id: episodeId, stage_history: [] };

  if (ACTIVE_CHANNEL_ID) statusData.channel_id = ACTIVE_CHANNEL_ID;

  statusData.last_updated = new Date().toISOString();
  statusData.current_stage = stageId;
  statusData.status = status;
  statusData.stage_history.push({
    stage: stageId,
    status,
    timestamp: new Date().toISOString(),
    ...details,
  });

  writeFileSync(statusFile, JSON.stringify(statusData, null, 2), 'utf-8');
}

async function runStage(episodeDir, episodeId, stage, dryRun, opts = {}) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`▶ Stage ${stage.id}: ${stage.name}`);
  console.log(`  Agent: ${stage.agent}`);
  console.log(`  Output: ${stage.file || '(ticket only)'}`);
  console.log(`${'─'.repeat(60)}`);

  if (dryRun) {
    console.log(`  [DRY RUN] Skipping execution`);
    return true;
  }

  auditLog(episodeId, 'stage_start', { stage: stage.id, agent: stage.agent });
  updateStatus(episodeDir, episodeId, stage.id, 'in_progress', { agent: stage.agent });
  try { lockHeartbeat(episodeId, stage.id); } catch { /* lock 없을 수 있음, ignore */ }

  // S7 — 렌더 (ffmpeg 직접 렌더, CapCut 우회)
  if (stage.id === 'S7') {
    try {
      const renderDir = join(episodeDir, '55_render');
      mkdirSync(renderDir, { recursive: true });
      const outPath = join(renderDir, 'video.mp4');
      renderDirect({ episodeDir, outPath, canvas: 'vertical' });
      updateStatus(episodeDir, episodeId, stage.id, 'completed', { agent: stage.agent, output: outPath });
      auditLog(episodeId, 'stage_complete', { stage: stage.id, output: outPath });
      return true;
    } catch (e) {
      console.error(`  ❌ Render failed: ${e.message}`);
      updateStatus(episodeDir, episodeId, stage.id, 'failed', { error: e.message });
      auditLog(episodeId, 'stage_failed', { stage: stage.id, error: e.message });
      return false;
    }
  }

  // S10 — Board 승인 게이트 (Telegram 알림 + 승인 대기)
  if (stage.id === 'S10') {
    let bundle = null;
    try { bundle = resolvePublishBundle(episodeDir, opts.platform); } catch {}
    if (bundle && existsSync(bundle.approvalFile)) {
      try {
        const preliminaryMeta = JSON.parse(readFileSync(bundle.metaFile, 'utf8'));
        const channelId = preliminaryMeta.channel_id || ACTIVE_CHANNEL_ID;
        const publishChannel = await loadPublishChannel(channelId);
        const verified = assertPublishApproval({
          approvalPath: bundle.approvalFile,
          videoPath: bundle.videoFile,
          metaPath: bundle.metaFile,
          qaPath: bundle.qaFile,
          channelId,
          episodeId,
          platform: bundle.platform,
          layout: bundle.layout,
          episodeRoot: episodeDir,
          channelRevision: publishChannel.record.revision,
          youtubeChannelId: publishChannel.expectedYouTubeChannelId,
          youtubeDefaults: publishChannel.channelDefaults,
        });
        if (verified.metadata.channel_id !== channelId) {
          throw new Error('approved metadata channel does not match the episode channel');
        }
        console.log(`  ✅ Approval token found (approved at ${verified.approval.approved_at})`);
        updateStatus(episodeDir, episodeId, stage.id, 'completed', { approved_by: verified.approval.approved_by });
        auditLog(episodeId, 'board_approved', { stage: stage.id, approved_by: verified.approval.approved_by });
        return true;
      } catch (error) {
        console.warn(`  ⚠ Existing approval is not publishable: ${error.message}`);
      }
    }

    console.log(`\n  ⏳ BOARD APPROVAL REQUIRED`);
    console.log(`  → Telegram으로 승인 요청 발송 중...`);
    try {
      await notify('board_approval_needed', {
        episode_id: episodeId,
        video_path: bundle?.videoFile || join(episodeDir, '55_render/video.mp4'),
        approval_command: `node scripts/automation/approve-episode.js --episode ${episodeId}${bundle ? ` --platform ${bundle.platform}` : ''}`,
      });
    } catch (e) {
      console.log(`  ⚠ Telegram 발송 실패 (승인 자체는 수동 가능): ${e.message}`);
    }
    console.log(`  → 승인: node scripts/automation/approve-episode.js --episode ${episodeId}${bundle ? ` --platform ${bundle.platform}` : ''}`);
    updateStatus(episodeDir, episodeId, stage.id, 'awaiting_approval');
    auditLog(episodeId, 'awaiting_board_approval', { stage: stage.id });
    return 'awaiting_approval';
  }

  // S11 — 배포 패키지 생성 + YouTube 자동 업로드 + TikTok/Reels 수동 알림
  if (stage.id === 'S11') {
    try {
      const bundle = resolvePublishBundle(episodeDir, opts.platform);
      // 중복 퍼블리시 가드 (#6): 이미 업로드된 videoId가 있으면 기본적으로 거부
      // 명시된 플랫폼 번들만 검사한다. 다른 플랫폼의 게시 결과는 이 실행을 막지 않는다.
      const publishResultFile = existsSync(bundle.publishResultFile) ? bundle.publishResultFile : null;
      if (publishResultFile && !opts.forceRepublish) {
        let prev;
        try { prev = JSON.parse(readFileSync(publishResultFile, 'utf-8')); }
        catch (error) { throw new Error(`Existing publish result is unreadable; reconcile before retry: ${error.message}`); }
        const prevVideoId = prev?.targets?.youtube?.videoId;
        if (!prevVideoId) throw new Error('Existing publish result has no YouTube videoId; reconcile before retry');
        const prevUrl = prev?.targets?.youtube?.url || `https://youtu.be/${prevVideoId}`;
        console.log(`  ⏭  Already published: ${prevUrl}`);
        console.log(`  → 재업로드하려면 --force-republish`);
        updateStatus(episodeDir, episodeId, stage.id, 'completed', { youtube_url: prevUrl, skipped: 'already_published' });
        auditLog(episodeId, 'publish_skipped_duplicate', { stage: stage.id, videoId: prevVideoId });
        try { updateIssueStatus(episodeId, 'done', { comment: `Already published: ${prevUrl} (duplicate skip)` }); } catch {}
        try { if (releaseLock(episodeId)) auditLog(episodeId, 'inflight_lock_released', { reason: 'duplicate_publish_skip' }); } catch {}
        return true;
      }

      const {
        metaFile, platformDir, videoFile, approvalFile, qaFile,
      } = bundle;
      if (!existsSync(videoFile)) throw new Error(`Missing rendered video: ${videoFile}`);
      if (!existsSync(approvalFile)) throw new Error(`Board approval token missing: ${approvalFile}`);
      if (!existsSync(qaFile)) throw new Error(`QA report missing: ${qaFile}`);

      // SEO 보강 (seo 필드 누락 시 자동 적용)
      const preliminaryMeta = JSON.parse(readFileSync(metaFile, 'utf-8'));
      const channelId = preliminaryMeta.channel_id || ACTIVE_CHANNEL_ID;
      if (!channelId) throw new Error('channel_id missing from metadata and episode status');
      if (ACTIVE_CHANNEL_ID && channelId !== ACTIVE_CHANNEL_ID) {
        throw new Error(`Metadata channel_id ${channelId} does not match episode channel ${ACTIVE_CHANNEL_ID}`);
      }
      const publishChannel = await loadPublishChannel(channelId);
      const verified = assertPublishApproval({
        approvalPath: approvalFile,
        videoPath: videoFile,
        metaPath: metaFile,
        qaPath: qaFile,
        channelId,
        episodeId,
        platform: bundle.platform,
        layout: bundle.layout,
        episodeRoot: episodeDir,
        channelRevision: publishChannel.record.revision,
        youtubeChannelId: publishChannel.expectedYouTubeChannelId,
        youtubeDefaults: publishChannel.channelDefaults,
      });
      const meta = verified.metadata;
      if (meta.channel_id !== channelId) {
        throw new Error(`Approved metadata channel_id ${meta.channel_id || '(missing)'} does not match episode channel ${channelId}`);
      }
      if (!meta.seo || !meta.seo.primary_keyword) {
        throw new Error(
          `SEO metadata missing. Run seo-enhance.js --episode ${episodeDir} --channel ${channelId}, then approve the changed metadata again.`,
        );
      }
      const thumbnailPath = verified.thumbnailPath;
      if (thumbnailPath) console.log(`  🖼  Approved thumbnail: ${thumbnailPath.replace(episodeDir + '/', '')}`);

      console.log(`  📦 Building distribution packages...`);
      buildDistributionPackage({
        episodeDir,
        videoPath: videoFile,
        thumbnailPath,
        meta,
        ticketId: episodeId,
      });

      console.log(`  📤 Publishing to YouTube...`);
      const reservation = reservePublishResult(bundle.publishResultFile, { allowExisting: opts.forceRepublish });
      let uploadAttempted = false;
      let resultPersisted = false;
      let ytResult;
      let publishResult;
      try {
        ytResult = await publishYouTube({
          videoPath: videoFile,
          meta: { ...meta, ...(meta.platforms?.youtube || {}) },
          thumbnailPath,
          videoBuffer: verified.artifacts.video,
          thumbnailBuffer: verified.artifacts.thumbnail,
          credentialEnv: publishChannel.credentialEnv,
          expectedChannelId: publishChannel.expectedYouTubeChannelId,
          channelDefaults: publishChannel.channelDefaults,
          onUploadAttempt: () => { uploadAttempted = true; },
        });
        uploadAttempted ||= Boolean(ytResult.videoId);
        publishResult = {
          episode_id: episodeId,
          channel_id: channelId,
          published_at: new Date().toISOString(),
          targets: {
            youtube: ytResult,
            tiktok: { status: 'pending_manual', package_path: join(episodeDir, 'distribution/tiktok') },
            reels: { status: 'pending_manual', package_path: join(episodeDir, 'distribution/reels') },
          },
        };
        persistPublishResult(reservation, publishResult, { replace: opts.forceRepublish });
        resultPersisted = true;
      } finally {
        releasePublishResultReservation(reservation, { uploaded: uploadAttempted, persisted: resultPersisted });
      }

      await notify('episode_complete', publishResult);

      updateStatus(episodeDir, episodeId, stage.id, 'completed', { youtube_url: ytResult.url });
      auditLog(episodeId, 'published', { stage: stage.id, result: publishResult });
      updateIssueStatus(episodeId, 'done', { comment: `Published: ${ytResult.url}` });

      // ─── S12 Playlist Auto-Register (시리즈 마지막 EP publish 완료 시) ──────────
      try {
        const linkPath = join(episodeDir, 'series_link.json');
        if (existsSync(linkPath)) {
          const link = JSON.parse(readFileSync(linkPath, 'utf-8'));
          if (link?.series_id && link?.series_episode === link?.series_total) {
            console.log(`  🎬 S12 trigger: ${link.series_id} 시리즈 마지막 EP 완료 (${link.series_episode}/${link.series_total}) — 재생목록 자동 생성`);
            const { spawnSync } = await import('node:child_process');
            const playlistTitle = link.series_name || link.series_id;
            const r = spawnSync('node', [
              join(import.meta.dirname, 'create-playlist.js'),
              '--series', link.series_id,
              '--episodes-dir', publishChannel.record.context.episodes_root,
              '--title', playlistTitle,
              '--channel', channelId,
              '--platform', bundle.platform,
            ], { stdio: 'inherit' });
            if (r.status === 0) {
              auditLog(episodeId, 's12_playlist_created', { series_id: link.series_id, title: playlistTitle, trigger: 'last_episode_publish' });
              console.log(`  ✓ S12 재생목록 등록 완료`);
            } else {
              auditLog(episodeId, 's12_playlist_failed', { series_id: link.series_id, exit_code: r.status });
              console.warn(`  ⚠ S12 재생목록 등록 실패 (exit=${r.status}). 수동 재시도: node scripts/automation/create-playlist.js --series ${link.series_id} ...`);
            }
          } else if (link?.series_id) {
            console.log(`  ℹ S12 skip: ${link.series_id} ${link.series_episode}/${link.series_total} (마지막 EP 아님)`);
          }
        }
      } catch (e) {
        console.warn(`  ⚠ S12 trigger error (non-fatal): ${e.message}`);
        auditLog(episodeId, 's12_trigger_error', { error: e.message });
      }

      // ─── In-flight Lock 자동 해제 (S11 publish 성공) ─────────────────────────
      try {
        const released = releaseLock(episodeId);
        if (released) {
          console.log(`  🔓 In-flight lock released (S11 published).`);
          auditLog(episodeId, 'inflight_lock_released', { reason: 's11_publish_success' });
        }
      } catch (e) {
        console.warn(`  ⚠ Lock release failed (non-fatal): ${e.message}`);
      }
      return true;
    } catch (e) {
      console.error(`  ❌ Publish failed: ${e.message}`);
      updateStatus(episodeDir, episodeId, stage.id, 'failed', { error: e.message });
      auditLog(episodeId, 'stage_failed', { stage: stage.id, error: e.message });
      updateIssueStatus(episodeId, 'blocked', { comment: `S11 publish failed: ${e.message.slice(0, 200)}` });
      return false;
    }
  }

  // S2(시장 조사) / S3(전략) 은 이미 작동하는 research-brief.js 에 위임한다.
  // 새 에이전트 호출 경로를 만들지 않는 이유: research-brief.js 가 auto-pipeline 에서
  // 매일 도는 검증된 경로이고, 경쟁 인텔 소비도 거기 배선돼 있다.
  if ((stage.id === 'S2' || stage.id === 'S3') && !runResearchStage(stage, episodeDir, episodeId)) {
    return false;
  }

  // 에이전트 실행
  const agentFile = join(
    resolve(import.meta.dirname, '../../claude-code/.claude/agents'),
    `${stage.agent}.md`
  );

  if (stage.id !== 'S2' && stage.id !== 'S3') {
    if (!existsSync(agentFile)) {
      console.log(`  ⚠ Agent config not found: ${agentFile}`);
      console.log(`  → Skipping (manual execution required)`);
      return false;
    }

    console.log(`  🤖 Invoking agent: ${stage.agent}`);
    console.log(`  📁 Episode: ${episodeDir}`);

    const agentPrompt = buildAgentPrompt(stage, episodeDir, episodeId);
    console.log(`  📝 Prompt prepared (${agentPrompt.length} chars)`);
  }

  // 산출물 게이트 — 파일이 실제로 생겼을 때만 completed 로 넘긴다.
  // 예전에는 무조건 completed 를 찍어 빈 단계가 통과했다 (ADR 이 지적한 게이트 우회).
  if (stage.file) {
    const outputPath = join(episodeDir, stage.file);
    if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
      console.log(`  ⛔ 산출물 없음: ${outputPath}`);
      updateStatus(episodeDir, episodeId, stage.id, 'blocked', { reason: 'missing_output' });
      auditLog(episodeId, 'stage_blocked', { stage: stage.id, file: stage.file });
      return false;
    }
    console.log(`  📄 Output: ${outputPath}`);
  }

  updateStatus(episodeDir, episodeId, stage.id, 'completed', { agent: stage.agent });
  auditLog(episodeId, 'stage_complete', { stage: stage.id, agent: stage.agent });

  return true;
}

/** 00_brief.md frontmatter 에서 슬롯·날짜를 뽑는다. 없으면 null. */
function briefMeta(episodeDir) {
  const p = join(episodeDir, '00_brief.md');
  if (!existsSync(p)) return { slot: null, date: null };
  const src = readFileSync(p, 'utf-8');
  return {
    slot: /^slot:\s*(\S+)/m.exec(src)?.[1] ?? null,
    date: /^date:\s*(\d{4}-\d{2}-\d{2})/m.exec(src)?.[1] ?? null,
  };
}

/** research-brief.js 를 임시 디렉토리에 돌리고 해당 산출물만 에피소드로 복사한다. */
function runResearchStage(stage, episodeDir, episodeId) {
  const { slot, date } = briefMeta(episodeDir);
  const useSlot = slot ?? 'us-close';
  const useDate = date ?? new Date().toISOString().slice(0, 10);
  const tmp = mkdtempSync(join(tmpdir(), `bt-${stage.id.toLowerCase()}-`));

  console.log(`  🔎 ${stage.id} → research-brief.js (slot=${useSlot}, date=${useDate})`);
  const r = spawnSync('node', [
    join(ROOT, 'scripts', 'automation', 'research-brief.js'),
    '--slot', useSlot, '--date', useDate, '--out-dir', tmp,
  ], { cwd: ROOT, stdio: 'inherit', timeout: 900_000 });

  if (r.status !== 0) {
    console.log(`  ⛔ research-brief 실패 (exit ${r.status})`);
    auditLog(episodeId, 'stage_blocked', { stage: stage.id, reason: `research-brief exit ${r.status}` });
    return false;
  }

  const srcName = stage.id === 'S2' ? `research-${useSlot}.md` : `strategy-${useSlot}.md`;
  const srcPath = join(tmp, srcName);
  if (!existsSync(srcPath)) {
    console.log(`  ⛔ research-brief 산출물 없음: ${srcName}`);
    return false;
  }
  copyFileSync(srcPath, join(episodeDir, stage.file));
  return true;
}

function buildAgentPrompt(stage, episodeDir, episodeId) {
  const prompts = {
    'S2': `Analyze references for episode ${episodeId}. Read 00_brief.md and create 10_market_research.md following the schema.`,
    'S3': `Create strategy document for episode ${episodeId}. Read 10_market_research.md and channel brand.md to create 20_strategy.md.`,
    'S4': `Write scene-by-scene script for episode ${episodeId}. Read 20_strategy.md and style-guide.md to create 30_script.md with proper frontmatter schema.`,
    'S5': `Fact-check the script for episode ${episodeId}. Read 30_script.md and verify all claims to create 35_factcheck.md.`,
    'S6': `Generate assets for episode ${episodeId}. Parse 30_script.md scenes and create image/TTS generation tickets.`,
    'S7': `Compose CapCut draft for episode ${episodeId}. Read 30_script.md + 40_assets to create 50_capcut_draft.json.`,
    'S8': `QA review episode ${episodeId}. Check script-voice-image-subtitle consistency. Create 60_qa_report.md.`,
    'S9': `Create metadata for episode ${episodeId}. Read strategy + script + draft timing. Create 70_publish_meta.json.`,
    'S11': `Publish episode ${episodeId}. Read 70_publish_meta.json and upload to YouTube (requires Board approval token).`,
  };

  return prompts[stage.id] || `Execute stage ${stage.id} for episode ${episodeId}.`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string', short: 'e' },
      from: { type: 'string', short: 'f' },
      platform: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'force-republish': { type: 'boolean', default: false },
      'force-release-stale': { type: 'boolean', default: false },
    },
  });

  if (!values.episode) {
    console.error('Usage: node run-episode.js --episode <EP-YYYY-NNNN> [--platform long|shorts] [--from <S2>] [--dry-run] [--force-republish] [--force-release-stale]');
    process.exit(1);
  }
  if (values.platform && !['long', 'shorts'].includes(values.platform)) {
    console.error(`❌ --platform must be long or shorts (received: ${values.platform})`);
    process.exit(1);
  }

  const episodeDir = join(WORKSPACE, 'episodes', values.episode);
  if (!existsSync(episodeDir)) {
    console.error(`❌ Episode not found: ${values.episode}`);
    process.exit(1);
  }

  const statusPath = join(episodeDir, '.episode_status.json');
  const briefPath = join(episodeDir, '00_brief.md');
  try {
    const status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf8')) : null;
    const brief = existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : '';
    ACTIVE_CHANNEL_ID = status?.channel_id
      || brief.match(/^channel_id:\s*["']?([^\n"']+)/m)?.[1]?.trim()
      || brief.match(/^channel:\s*["']?([^\n"']+)/m)?.[1]?.trim()
      || null;
  } catch { ACTIVE_CHANNEL_ID = null; }

  console.log(`\n🎬 BarroTube Episode Runner`);
  console.log(`   Episode: ${values.episode}`);
  console.log(`   Path: ${episodeDir}`);
  console.log(`   Dry Run: ${values['dry-run'] || false}`);

  // ─── In-flight Lock: 직렬 처리 강제 (Producer harness policy) ───────────────
  // dry-run은 실제 변경이 없으므로 lock skip.
  if (!values['dry-run']) {
    try {
      const lock = acquireLock(values.episode, values.from || 'auto', {
        command: `run-episode.js --episode ${values.episode}${values.from ? ' --from ' + values.from : ''}`,
        autoCleanStale: !!values['force-release-stale'],
      });
      console.log(`   🔒 In-flight lock: ${lock.episode_id} (pid=${lock.pid})`);
    } catch (e) {
      console.error(`\n❌ ${e.message}`);
      auditLog(values.episode, 'inflight_lock_denied', { reason: e.code || 'unknown', current: e.lock || null });
      process.exit(e.code === 'ELOCK_HELD' ? 2 : (e.code === 'ELOCK_STALE' ? 3 : 1));
    }
  }

  // 체크포인트 감지 (FR-S-003)
  let startIndex;
  if (values.from) {
    startIndex = STAGES.findIndex(s => s.id === values.from);
    if (startIndex === -1) {
      console.error(`❌ Unknown stage: ${values.from}`);
      process.exit(1);
    }
    console.log(`   Starting from: ${values.from} (manual override)`);
  } else {
    const lastCompleted = detectLastCompleted(episodeDir, values.platform);
    startIndex = lastCompleted + 1;
    if (lastCompleted >= 0) {
      console.log(`   Checkpoint: ${STAGES[lastCompleted].id} completed`);
      console.log(`   Resuming from: ${STAGES[startIndex]?.id || 'all done'}`);
    } else {
      console.log(`   Starting from: S1 (no checkpoint found)`);
      startIndex = 1; // S0 (brief) already exists
    }
  }

  if (startIndex >= STAGES.length) {
    console.log(`\n✅ All stages completed for ${values.episode}`);
    return;
  }

  // 단계별 실행
  for (let i = startIndex; i < STAGES.length; i++) {
    const result = await runStage(episodeDir, values.episode, STAGES[i], values['dry-run'], {
      forceRepublish: values['force-republish'],
      platform: values.platform || null,
    });

    if (result === 'awaiting_approval') {
      console.log(`\n⏸ Paused at ${STAGES[i].id}: Awaiting Board approval`);
      break;
    }

    if (!result) {
      console.log(`\n❌ Stage ${STAGES[i].id} failed. Fix and re-run.`);
      process.exitCode = 1;
      break;
    }
  }

  console.log(`\n📊 Episode status saved to: ${join(episodeDir, '.episode_status.json')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
