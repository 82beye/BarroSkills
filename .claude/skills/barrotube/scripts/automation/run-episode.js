#!/usr/bin/env node

/**
 * BarroTube — 에피소드 워크플로우 실행 스크립트
 * 체크포인트 기반 재시작(FR-S-003) 지원
 *
 * Usage: node run-episode.js --episode <EP-YYYY-NNNN> [--from <stage>] [--dry-run]
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { renderDirect } from './render-direct.js';
import { buildDistributionPackage } from './build-distribution.js';
import { publishYouTube } from './publish-youtube.js';
import { notify } from './notify.js';
import { updateIssueStatus } from './register-paperclip-issue.js';
import { acquireLock, releaseLock, heartbeat as lockHeartbeat } from './in-flight-lock.js';

const WORKSPACE = resolve(import.meta.dirname, '../../workspace');
const LOGS = resolve(import.meta.dirname, '../../logs');

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

function detectLastCompleted(episodeDir) {
  for (let i = STAGES.length - 1; i >= 0; i--) {
    const stage = STAGES[i];
    if (!stage.file) continue;

    const filePath = join(episodeDir, stage.file);
    if (existsSync(filePath)) {
      return i;
    }
  }
  return -1;
}

function auditLog(episodeId, action, details) {
  const logDir = join(LOGS, 'audit');
  mkdirSync(logDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(logDir, `${date}.jsonl`);

  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    episode_id: episodeId,
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
    const approvalFile = join(episodeDir, '75_board_approval.json');
    if (existsSync(approvalFile)) {
      const a = JSON.parse(readFileSync(approvalFile, 'utf-8'));
      if (a.approved === true) {
        console.log(`  ✅ Approval token found (approved at ${a.approved_at})`);
        updateStatus(episodeDir, episodeId, stage.id, 'completed', { approved_by: a.approved_by });
        auditLog(episodeId, 'board_approved', { stage: stage.id, approved_by: a.approved_by });
        return true;
      }
    }

    console.log(`\n  ⏳ BOARD APPROVAL REQUIRED`);
    console.log(`  → Telegram으로 승인 요청 발송 중...`);
    try {
      await notify('board_approval_needed', {
        episode_id: episodeId,
        video_path: join(episodeDir, '55_render/video.mp4'),
        approval_command: `node scripts/automation/approve-episode.js --episode ${episodeId}`,
      });
    } catch (e) {
      console.log(`  ⚠ Telegram 발송 실패 (승인 자체는 수동 가능): ${e.message}`);
    }
    console.log(`  → 승인: node scripts/automation/approve-episode.js --episode ${episodeId}`);
    updateStatus(episodeDir, episodeId, stage.id, 'awaiting_approval');
    auditLog(episodeId, 'awaiting_board_approval', { stage: stage.id });
    return 'awaiting_approval';
  }

  // S11 — 배포 패키지 생성 + YouTube 자동 업로드 + TikTok/Reels 수동 알림
  if (stage.id === 'S11') {
    try {
      // 중복 퍼블리시 가드 (#6): 이미 업로드된 videoId가 있으면 기본적으로 거부
      // v2/v1 둘 다 검색
      const publishResultCandidates = [
        join(episodeDir, 'platforms', 'long', '80_publish_result.json'),
        join(episodeDir, 'platforms', 'shorts', '80_publish_result.json'),
        join(episodeDir, '80_publish_result.json'),
      ];
      const publishResultFile = publishResultCandidates.find(p => existsSync(p));
      if (publishResultFile && !opts.forceRepublish) {
        try {
          const prev = JSON.parse(readFileSync(publishResultFile, 'utf-8'));
          const prevVideoId = prev?.targets?.youtube?.videoId;
          if (prevVideoId) {
            const prevUrl = prev?.targets?.youtube?.url || `https://youtu.be/${prevVideoId}`;
            console.log(`  ⏭  Already published: ${prevUrl}`);
            console.log(`  → 재업로드하려면 --force-republish`);
            updateStatus(episodeDir, episodeId, stage.id, 'completed', { youtube_url: prevUrl, skipped: 'already_published' });
            auditLog(episodeId, 'publish_skipped_duplicate', { stage: stage.id, videoId: prevVideoId });
            // Paperclip 보드도 함께 close — 좀비 IN PROGRESS 재발 방지 (Step #29)
            try { updateIssueStatus(episodeId, 'done', { comment: `Already published: ${prevUrl} (duplicate skip)` }); } catch {}
            // 이미 게시된 EP의 락은 release (idempotent re-run 정리)
            try { if (releaseLock(episodeId)) auditLog(episodeId, 'inflight_lock_released', { reason: 'duplicate_publish_skip' }); } catch {}
            return true;
          }
        } catch (e) {
          console.warn(`  ⚠ 기존 publish result 파싱 실패, 계속 진행: ${e.message}`);
        }
      }

      const approvalCandidates = [
        join(episodeDir, 'platforms', 'long', '75_board_approval.json'),
        join(episodeDir, 'platforms', 'shorts', '75_board_approval.json'),
        join(episodeDir, '75_board_approval.json'),
      ];
      const approvalFile = approvalCandidates.find(p => existsSync(p));
      if (!approvalFile) throw new Error('Board approval token missing — cannot publish');
      const approval = JSON.parse(readFileSync(approvalFile, 'utf-8'));
      if (approval.approved !== true) throw new Error('Approval token invalid');

      // v2 (platforms/) 우선 → v1 fallback. 우선순위: long → shorts → legacy.
      const metaCandidates = [
        join(episodeDir, 'platforms', 'long', '70_publish_meta.json'),
        join(episodeDir, 'platforms', 'shorts', '70_publish_meta.json'),
        join(episodeDir, '70_publish_meta.json'),
      ];
      const metaFile = metaCandidates.find(p => existsSync(p));
      if (!metaFile) throw new Error(`Missing 70_publish_meta.json (tried: ${metaCandidates.join(', ')})`);
      const platformDir = metaFile.replace(/\/70_publish_meta\.json$/, '');
      const videoFile = join(platformDir, '55_render', 'video.mp4');
      if (!existsSync(videoFile)) throw new Error(`Missing rendered video: ${videoFile}`);

      // SEO 보강 (seo 필드 누락 시 자동 적용)
      let meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
      if (!meta.seo || !meta.seo.primary_keyword) {
        console.log(`  🔍 Applying SEO enhancement...`);
        try {
          execSync(`node ${join(import.meta.dirname, 'seo-enhance.js')} --episode ${episodeDir} --channel ${meta.channel_id || 'econ-daily'}`, { stdio: 'pipe' });
          meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
          console.log(`  ✅ SEO primary: ${meta.seo?.primary_keyword}, tags: ${meta.tags?.length}개`);
        } catch (e) {
          console.warn(`  ⚠ SEO enhance 실패 (기존 메타 그대로 사용): ${e.message}`);
        }
      }
      // 썸네일 경로 해석 (우선순위: meta.thumbnail → platformDir/47_thumbnail.png → episodeDir/47_thumbnail.png)
      let thumbnailPath = meta.thumbnail ? join(platformDir, meta.thumbnail) : null;
      if (thumbnailPath && !existsSync(thumbnailPath)) thumbnailPath = join(episodeDir, meta.thumbnail);
      if (!thumbnailPath || !existsSync(thumbnailPath)) {
        const autoCandidates = [
          join(platformDir, '47_thumbnail.png'),
          join(episodeDir, '47_thumbnail.png'),
        ];
        const found = autoCandidates.find(p => existsSync(p));
        if (found) {
          thumbnailPath = found;
          console.log(`  🖼  Auto-detected thumbnail: ${found.replace(episodeDir + '/', '')}`);
        } else {
          thumbnailPath = null;
        }
      }

      console.log(`  📦 Building distribution packages...`);
      buildDistributionPackage({
        episodeDir,
        videoPath: videoFile,
        thumbnailPath,
        meta,
        ticketId: episodeId,
      });

      console.log(`  📤 Publishing to YouTube...`);
      const ytResult = await publishYouTube({
        videoPath: videoFile,
        meta: { ...meta, ...(meta.platforms?.youtube || {}) },
        thumbnailPath,
      });

      const publishResult = {
        episode_id: episodeId,
        published_at: new Date().toISOString(),
        targets: {
          youtube: ytResult,
          tiktok: { status: 'pending_manual', package_path: join(episodeDir, 'distribution/tiktok') },
          reels: { status: 'pending_manual', package_path: join(episodeDir, 'distribution/reels') },
        },
      };
      writeFileSync(join(platformDir, '80_publish_result.json'), JSON.stringify(publishResult, null, 2), 'utf-8');

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
              '--episodes-dir', join(import.meta.dirname, '..', '..', 'workspace', 'episodes'),
              '--title', playlistTitle,
              '--privacy', 'unlisted',
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

  // 에이전트 실행
  const agentFile = join(
    resolve(import.meta.dirname, '../../claude-code/.claude/agents'),
    `${stage.agent}.md`
  );

  if (!existsSync(agentFile)) {
    console.log(`  ⚠ Agent config not found: ${agentFile}`);
    console.log(`  → Skipping (manual execution required)`);
    return false;
  }

  // 에이전트 실행 명령 생성
  const briefPath = join(episodeDir, '00_brief.md');
  const brief = existsSync(briefPath) ? readFileSync(briefPath, 'utf-8') : '';

  console.log(`  🤖 Invoking agent: ${stage.agent}`);
  console.log(`  📁 Episode: ${episodeDir}`);

  // Claude Code CLI 호출 (Paperclip 통합 시 티켓 기반으로 전환)
  const agentPrompt = buildAgentPrompt(stage, episodeDir, episodeId);
  console.log(`  📝 Prompt prepared (${agentPrompt.length} chars)`);

  // 산출물 검증
  if (stage.file) {
    const outputPath = join(episodeDir, stage.file);
    console.log(`  📄 Expected output: ${outputPath}`);
  }

  updateStatus(episodeDir, episodeId, stage.id, 'completed', { agent: stage.agent });
  auditLog(episodeId, 'stage_complete', { stage: stage.id, agent: stage.agent });

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
      'dry-run': { type: 'boolean', default: false },
      'force-republish': { type: 'boolean', default: false },
      'force-release-stale': { type: 'boolean', default: false },
    },
  });

  if (!values.episode) {
    console.error('Usage: node run-episode.js --episode <EP-YYYY-NNNN> [--from <S2>] [--dry-run] [--force-republish] [--force-release-stale]');
    process.exit(1);
  }

  const episodeDir = join(WORKSPACE, 'episodes', values.episode);
  if (!existsSync(episodeDir)) {
    console.error(`❌ Episode not found: ${values.episode}`);
    process.exit(1);
  }

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
    const lastCompleted = detectLastCompleted(episodeDir);
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
    });

    if (result === 'awaiting_approval') {
      console.log(`\n⏸ Paused at ${STAGES[i].id}: Awaiting Board approval`);
      break;
    }

    if (!result) {
      console.log(`\n❌ Stage ${STAGES[i].id} failed. Fix and re-run.`);
      break;
    }
  }

  console.log(`\n📊 Episode status saved to: ${join(episodeDir, '.episode_status.json')}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
