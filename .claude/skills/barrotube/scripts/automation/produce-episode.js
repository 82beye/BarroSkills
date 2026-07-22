#!/usr/bin/env node

/**
 * produce-episode.js — S4~S9b 원샷 체인 (shorts-style 콘텐츠용 경량 체인)
 *
 * 커버리지:
 *   S0 (brief) → [S2 Research 생략] → [S3 Strategy 생략]
 *     → S4 Script → S5 Factcheck 생략(⚠ 별도 gate 미구현, docs/ backlog) → S6~S9b
 *
 *   S2/S3는 의도적으로 건너뜀:
 *     - 00_brief.md + 05_topic_references.md 만으로 S4 진행
 *     - 장시간/조사 중심 에피소드는 run-episode.js (전체 S0~S11 파이프라인) 사용
 *
 * 실행 순서:
 *   1) S4  Script 생성           (Gemini)
 *   2) S6a TTS 생성              (ElevenLabs)
 *   3) S6b Duration sync         (script target_seconds → TTS 실길이)
 *   4) S6c Images 생성           (Gemini Nano Banana 2)
 *   5) S7  Render (mp4)          (ffmpeg + PIL subtitle)
 *   6) S7b CapCut 프로젝트       (draft_info.json)
 *   7) S8  QA Report (자동)      (ffprobe 기반)
 *   8) S9  Metadata (Gemini)     + SEO 3-layer 자동 보강
 *
 * 상태 전이 (Paperclip 이슈):
 *   시작 → in_progress, 성공 종료 → in_review (Board 승인 대기), 실패 → blocked
 *
 * 중단 후 재실행: 각 단계 산출물 존재 시 skip (--force 로 전 단계 재생성).
 * S4~S9b 각 단계의 stage_start/complete/failed 는 .episode_status.json 및 logs/audit/YYYY-MM-DD.jsonl 에 기록됨.
 *
 * Usage:
 *   node produce-episode.js --episode EP-2026-0009
 *   node produce-episode.js --episode EP-2026-0009 --force        # 모든 단계 재생성 (자산 재과금 주의)
 *   node produce-episode.js --episode EP-2026-0009 --skip-capcut  # CapCut draft 생성 skip
 *
 * 관련 플래그 (run-episode.js):
 *   --force-republish — S11 중복 업로드 방지 해제 (이 스크립트와 무관, S11 범위)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse as parseYAML } from 'yaml';
import { updateIssueStatus } from './register-paperclip-issue.js';
import { resolvePaths, formatToPlatform } from './paths.js';
import { getSecret } from './config-loader.js';
import { acquireLock, releaseLock, heartbeat as lockHeartbeat } from './in-flight-lock.js';

const ROOT = resolve(import.meta.dirname, '../..');
const LOGS = join(ROOT, 'logs');

function auditLog(episodeId, action, details = {}) {
  try {
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
  } catch (e) {
    console.warn(`  ⚠ auditLog failed: ${e.message}`);
  }
}

function updateStageStatus(episodeDir, episodeId, stageId, status, details = {}) {
  try {
    const statusFile = join(episodeDir, '.episode_status.json');
    const data = existsSync(statusFile)
      ? JSON.parse(readFileSync(statusFile, 'utf-8'))
      : { episode_id: episodeId, stage_history: [] };
    data.stage_history = data.stage_history || [];
    data.stage_history.push({
      stage: stageId,
      status,
      timestamp: new Date().toISOString(),
      ...details,
    });
    data.last_updated = new Date().toISOString();
    data.current_stage = stageId;
    data.status = status;
    writeFileSync(statusFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.warn(`  ⚠ updateStageStatus failed: ${e.message}`);
  }
}

function run(label, cmd, args) {
  console.log(`\n▶ ${label}`);
  console.log(`  $ node ${cmd} ${args.join(' ')}`);
  const r = spawnSync('node', [cmd, ...args], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${label} 실패 (exit ${r.status})`);
}

function runTracked(episodeDir, episodeId, stageId, label, agent, cmd, args) {
  auditLog(episodeId, 'stage_start', { stage: stageId, agent });
  updateStageStatus(episodeDir, episodeId, stageId, 'in_progress', { agent });
  // 락 heartbeat — long-running stage 중 stale 오인 방지.
  try { lockHeartbeat(episodeId, stageId); } catch { /* lock 없을 수 있음, ignore */ }
  try {
    run(label, cmd, args);
    auditLog(episodeId, 'stage_complete', { stage: stageId, agent });
    updateStageStatus(episodeDir, episodeId, stageId, 'completed', { agent });
  } catch (e) {
    auditLog(episodeId, 'stage_failed', { stage: stageId, agent, error: e.message });
    updateStageStatus(episodeDir, episodeId, stageId, 'failed', { agent, error: e.message });
    throw e;
  }
}

function exists(p) { return existsSync(p); }

async function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string', short: 'e' },
      platform: { type: 'string' },           // long | shorts (v2 멀티 플랫폼 빌드 시 명시)
      force: { type: 'boolean', default: false },
      'skip-capcut': { type: 'boolean', default: false },
      'force-release-stale': { type: 'boolean', default: false },
      'image-engine': { type: 'string' },      // openai(기본) | gemini | auto — 모든 이미지 단계(S6c/d/e/f) 엔진 선택
    },
  });
  if (!values.episode) {
    console.error('Usage: produce-episode.js --episode EP-YYYY-NNNN [--platform long|shorts] [--image-engine openai|gemini|auto] [--force] [--skip-capcut] [--force-release-stale]');
    process.exit(1);
  }

  // ── 이미지 엔진 선택 (2026-06-27) ─────────────────────────────────────────────
  // 기본값 openai(gpt-image-1). --image-engine 으로 전환. 우선순위: CLI > BT_IMAGE_ENGINE env > openai.
  // 하위 이미지 스크립트(S6c 씬 / S6d 인트로 v10 / S6e 썸네일 / S6f 엔드카드)는 spawnSync로
  // process.env 를 상속하므로, 여기서 BT_IMAGE_ENGINE 전역 override + OPENAI_API_KEY hydrate 한 번이면 일괄 적용된다.
  //   openai → gpt-image-1, gemini → gemini-3.1-flash-image-preview, auto → config/image-engines.json 단계별 설정.
  // openai 인데 키/결제 문제로 실패하면 각 스크립트가 자동으로 Gemini 폴백.
  // 2026-07-02: 'media-render' 추가 — S6c 씬 이미지를 barrotube-media-render 스킬
  // (브라우저 ChatGPT/Grok, PD 수행)으로 사전 생성하는 기본 모드. API 호출 없음.
  // 명시(explicit) 값과 미지정을 구분해 S6c 기본값을 config.stages.S6c_scene에서 가져온다.
  const explicitEngine = (values['image-engine'] || process.env.BT_IMAGE_ENGINE || '').toLowerCase() || null;
  const imageEngine = explicitEngine || 'openai';
  if (!['openai', 'gemini', 'auto', 'media-render'].includes(imageEngine)) {
    console.error(`❌ --image-engine 는 openai|gemini|auto|media-render 중 하나여야 합니다 (받음: ${imageEngine})`);
    process.exit(1);
  }
  if (imageEngine === 'openai' || imageEngine === 'gemini') {
    process.env.BT_IMAGE_ENGINE = imageEngine;   // resolveImageEngine 이 config.stages/global 보다 우선 적용
  } else {
    // auto / media-render: S6d 인트로·S6e 썸네일 하위 스크립트는 config 단계별 설정 그대로
    delete process.env.BT_IMAGE_ENGINE;
  }
  // S6c 씬 엔진 resolution: 명시(CLI/env, auto 제외) > config.stages.S6c_scene > openai
  let sceneEngine = (explicitEngine && explicitEngine !== 'auto') ? explicitEngine : null;
  if (!sceneEngine) {
    try {
      const engCfg = JSON.parse(readFileSync(join(ROOT, 'config/image-engines.json'), 'utf-8'));
      sceneEngine = (engCfg.stages && engCfg.stages.S6c_scene) || engCfg.global || 'openai';
    } catch { sceneEngine = 'openai'; }
  }
  if (imageEngine === 'openai' || imageEngine === 'auto') {
    if (!process.env.OPENAI_API_KEY) {
      try { const k = getSecret('OPENAI_API_KEY'); if (k) process.env.OPENAI_API_KEY = k; } catch { /* keychain 미설정 무시 */ }
    }
  }
  console.log(`🎨 Image engine: ${imageEngine} (OpenAI key ${process.env.OPENAI_API_KEY ? '✓' : '✗ 없음 → openai 요청 시 Gemini 폴백'})`);

  // --episode 가 ID 만인지 경로인지 처리
  let epDir = values.episode;
  if (!epDir.startsWith('/') && !epDir.startsWith('workspace/')) {
    epDir = join('workspace/episodes', values.episode);
  }
  const absEp = resolve(ROOT, epDir);
  if (!existsSync(absEp)) { console.error(`❌ Episode not found: ${absEp}`); process.exit(1); }

  // Brief 검색: --platform 명시 시 platforms/{platform}/00_brief.md 우선,
  // 없으면 episodeDir/00_brief.md (long 또는 v1 legacy).
  let briefPath;
  if (values.platform) {
    const v2 = join(absEp, 'platforms', values.platform, '00_brief.md');
    const root = join(absEp, '00_brief.md');
    briefPath = existsSync(v2) ? v2 : root;
  } else {
    const v2Long = join(absEp, 'platforms', 'long', '00_brief.md');
    const root = join(absEp, '00_brief.md');
    briefPath = existsSync(v2Long) ? v2Long : root;
  }
  if (!existsSync(briefPath)) { console.error(`❌ 00_brief.md 없음 (tried: ${briefPath})`); process.exit(1); }

  const force = values.force;
  const relEp = epDir;
  const episodeId = relEp.split('/').pop();

  // brief에서 format 추출 → 어느 platforms/{long|shorts}/ 디렉토리에 산출물을 둘지 결정.
  const briefRaw = readFileSync(briefPath, 'utf-8');
  const briefFM = (() => {
    const m = briefRaw.match(/^---\n([\s\S]*?)\n---/);
    return m ? parseYAML(m[1]) : {};
  })();
  const format = values.platform === 'shorts' ? 'shorts'
               : values.platform === 'long' ? 'long-3min'
               : (briefFM.format || 'long-3min');
  const platform = formatToPlatform(format);
  const p = resolvePaths(absEp, format);

  // v2 layout 보장: platforms/{platform}/ 디렉토리 미리 생성
  mkdirSync(p.base, { recursive: true });

  // 하위 스크립트에 --script/--out-dir 등을 절대 경로로 전달 (cwd 상관없이 동일하게 작동).
  const scriptArg = p.script;
  const ttsDirArg = p.ttsDir + '/';
  const imgDirArg = p.imagesDir + '/';
  const renderOutArg = p.video;

  console.log(`🎬 Produce episode: ${absEp}`);
  console.log(`   Format: ${format} → platform=${platform}, layout=${p.isV2 ? 'v2 (platforms/)' : 'v1 (legacy)'}`);
  console.log(`   Force: ${force}, Skip CapCut: ${values['skip-capcut']}`);

  // ─── In-flight Lock: 직렬 처리 강제 (Producer harness policy) ───────────────
  // 다른 EP가 in-flight면 즉시 거부. 같은 EP면 idempotent (heartbeat 갱신).
  try {
    const lock = acquireLock(episodeId, 'S4', {
      command: `produce-episode.js --episode ${episodeId}${values.platform ? ' --platform ' + values.platform : ''}`,
      autoCleanStale: !!values['force-release-stale'],
    });
    console.log(`🔒 In-flight lock acquired: ${lock.episode_id} (pid=${lock.pid})`);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    auditLog(episodeId, 'inflight_lock_denied', { reason: e.code || 'unknown', current: e.lock || null });
    process.exit(e.code === 'ELOCK_HELD' ? 2 : (e.code === 'ELOCK_STALE' ? 3 : 1));
  }

  auditLog(episodeId, 'produce_start', { force, skip_capcut: values['skip-capcut'], platform, layout: p.isV2 ? 'v2' : 'v1' });
  updateIssueStatus(episodeId, 'in_progress', { comment: 'produce-episode: S4~S9 chain started' });

  try {
    // S4 Script
    // FIX (2026-05-09): --platform을 generate-script.js에 명시적으로 전달.
    //   이전에는 누락되어, --platform shorts 호출 시 generate-script가 EP/00_brief.md(long-form master)를
    //   읽고 platforms/long/30_script.md를 silently 덮어쓰는 사고가 발생 (EP-2026-0048 rev.4 clobber).
    if (!exists(p.script) || force) {
      const s4Args = ['--episode', relEp, '--platform', platform];
      if (force) s4Args.push('--force');
      runTracked(absEp, episodeId, 'S4', 'S4 Script (Gemini)', '05-writer',
        'scripts/automation/generate-script.js', s4Args);
    } else {
      console.log(`\n⏭  S4 Script: ${p.script} 존재 (skip, --force로 재생성)`);
    }

    // S6a TTS
    const ttsDone = exists(join(p.ttsDir, 'scene_001.wav')) && exists(join(p.ttsDir, 'scene_005.wav'));
    if (!ttsDone || force) {
      runTracked(absEp, episodeId, 'S6a', 'S6a TTS (ElevenLabs)', '09-voice-engineer',
        'scripts/automation/generate-tts.js', [
          '--script', scriptArg,
          '--out-dir', ttsDirArg,
          '--force',
        ]);
    } else {
      console.log(`\n⏭  S6a TTS: 이미 있음 (skip)`);
    }

    // S6b Duration sync
    runTracked(absEp, episodeId, 'S6b', 'S6b Duration Sync', '09-voice-engineer',
      'scripts/automation/sync-durations.js', [
        '--script', scriptArg,
        '--tts-dir', ttsDirArg,
      ]);

    // S6c Images — 기본: media-render(브라우저, PD 사전 생성) / 레거시: API(gemini|openai)
    const imgDone = exists(join(p.imagesDir, 'scene_001.png')) && exists(join(p.imagesDir, 'scene_005.png'));
    if (sceneEngine === 'media-render') {
      if (imgDone) {
        console.log(`\n⏭  S6c Images: media-render 산출물 존재 (skip) — ${p.imagesDir}`);
      } else {
        console.error(`\n❌ S6c Images (media-render 기본 모드): ${p.imagesDir}/scene_NNN.png 이 없습니다.`);
        console.error(`   → PD가 barrotube-media-render 스킬(브라우저 ChatGPT)로 씬 이미지를 먼저 생성한 뒤 재실행하세요.`);
        console.error(`   → 씬 모션 클립(Grok)은 40_assets/videos/scene_NNN.mp4 에 두면 S7 렌더가 자동 사용합니다.`);
        console.error(`   → 레거시 API 경로로 진행하려면: --image-engine openai|gemini`);
        releaseLock();
        process.exit(3);
      }
    } else if (!imgDone || force) {
      runTracked(absEp, episodeId, 'S6c', 'S6c Images (Nano Banana 2)', '08-image-generator',
        'scripts/automation/generate-image-gemini.js', [
          '--script', scriptArg,
          '--out-dir', imgDirArg,
          '--force',
        ]);
    } else {
      console.log(`\n⏭  S6c Images: 이미 있음 (skip)`);
    }

    // S6d Intro Card — 시리즈 EP: Gemini 브랜드 카드 생성 / 단발 EP: S6e 완료 후 thumbnail 복사
    const hasSeriesId = !!briefFM.series_id;
    if (hasSeriesId) {
      if (!exists(p.intro) || force) {
        runTracked(absEp, episodeId, 'S6d', 'S6d Intro Card (Gemini)', '08-image-generator',
          'scripts/automation/generate-intro.js', [
            '--episode', relEp,
            '--platform', platform,
            ...(force ? ['--force'] : []),
          ]);
      } else {
        console.log(`\n⏭  S6d Intro: 이미 있음 (skip)`);
      }
    }
    // 단발 EP S6d는 S6e(thumbnail) 완료 후 복사 처리 (아래 참고)

    // S6e Thumbnail (YouTube feed thumbnail)
    if (!exists(p.thumbnail) || force) {
      runTracked(absEp, episodeId, 'S6e', 'S6e Thumbnail (Gemini)', '08-image-generator',
        'scripts/automation/generate-thumbnail.js', [
          '--episode', relEp,
          '--platform', platform,
          ...(force ? ['--force'] : []),
        ]);
    } else {
      console.log(`\n⏭  S6e Thumbnail: 이미 있음 (skip)`);
    }

    // S6d 단발 EP: 채널 시그니처 카드 생성 (2026-05-16 — thumbnail 복사 폐기)
    // 운영자 피드백 (EP-0052): 인트로 == 썸네일 동일 문제 → 인트로 카드 역할 못함.
    // 단발 EP도 generate-intro.js standalone 모드로 별도 시그니처 카드 생성.
    if (!hasSeriesId) {
      if (!exists(p.intro) || force) {
        runTracked(absEp, episodeId, 'S6d', 'S6d Intro Card (standalone signature)', '08-image-generator',
          'scripts/automation/generate-intro.js', [
            '--episode', relEp,
            '--platform', platform,
            ...(force ? ['--force'] : []),
          ]);
      } else {
        console.log(`\n⏭  S6d Intro (standalone): 이미 있음 (skip)`);
      }
    }

    // S6f Outro/Endcard (구독/좋아요/알림 CTA 카드).
    // 브라우저 생성 48_outro.png가 있으면 그대로 사용하고, 없을 때만 로컬 CTA 카드를 만든다.
    const endcardPath = join(p.base, '48_endcard.png');
    const outroPath = join(p.base, '48_outro.png');
    if ((!exists(endcardPath) && !exists(outroPath)) || force) {
      runTracked(absEp, episodeId, 'S6f', 'S6f Endcard (구독/좋아요)', '08-image-generator',
        'scripts/automation/generate-endcard.js', [
          '--episode', relEp,
          '--platform', platform,
          ...(force ? ['--force'] : []),
        ]);
    } else {
      console.log(`\n⏭  S6f Outro/Endcard: 이미 있음 (skip)`);
    }

    // S7 Render
    mkdirSync(p.renderDir, { recursive: true });
    if (!exists(p.video) || force) {
      runTracked(absEp, episodeId, 'S7', 'S7 Render (ffmpeg + PIL subtitles)', '10-capcut-composer',
        'scripts/automation/render-direct.js', [
          '--episode', relEp,
          '--out', renderOutArg,
          '--canvas', platform === 'long' ? 'horizontal' : 'vertical',
          '--platform', platform,
        ]);
    } else {
      console.log(`\n⏭  S7 Render: ${p.video} 존재 (skip)`);
    }

    // S7b CapCut (optional)
    if (!values['skip-capcut']) {
      const capName = `BT-${episodeId}-Auto`;
      runTracked(absEp, episodeId, 'S7b', 'S7b CapCut Draft', '10-capcut-composer',
        'scripts/automation/build-capcut-from-episode.js', [
          '--episode', relEp,
          '--name', capName,
        ]);
    }

    // S8 QA
    runTracked(absEp, episodeId, 'S8', 'S8 QA Report (auto)', '11-qa-reviewer',
      'scripts/automation/generate-qa-report.js', ['--episode', relEp, '--platform', platform]);

    // S9 Metadata + SEO
    const metaPath = p.meta;
    if (!exists(metaPath) || force) {
      runTracked(absEp, episodeId, 'S9', 'S9 Metadata (Gemini)', '12-metadata-writer',
        'scripts/automation/generate-metadata.js', ['--episode', relEp, '--platform', platform]);
    } else {
      console.log(`\n⏭  S9 Metadata: 존재 (skip)`);
    }
    runTracked(absEp, episodeId, 'S9b', 'S9b SEO Enhance', '12-metadata-writer',
      'scripts/automation/seo-enhance.js', ['--episode', relEp, '--channel', 'econ-daily']);
  } catch (e) {
    auditLog(episodeId, 'produce_failed', { error: e.message });
    updateIssueStatus(episodeId, 'blocked', { comment: `produce-episode failed: ${e.message.slice(0, 200)}` });
    throw e;
  }

  auditLog(episodeId, 'produce_complete', {});
  updateIssueStatus(episodeId, 'in_review', { comment: 'S4~S9 complete — awaiting Board approval' });

  // 락 정책: produce-episode 성공 후에도 락 유지 (S10/S11 이전).
  // 운영자가 같은 EP 흐름을 이어서 진행하므로 다른 EP가 끼어들면 안됨.
  // 락은 run-episode.js가 S11 publish 성공 시 자동 release, 또는 명시적 release.
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ S4~S9 완료');
  console.log(`   📁 ${absEp}`);
  console.log(`   🔒 In-flight lock: ${episodeId} (유지 — S11 publish 시 자동 해제)`);
  console.log('\n다음:');
  console.log(`   승인 (Telegram): /approve ${relEp.split('/').pop()}`);
  console.log(`   승인 (CLI):      node scripts/automation/approve-episode.js --episode ${relEp.split('/').pop()} --by "Board"`);
  console.log(`   배포 (auto):     run-episode.js가 S11 자동 실행`);
  console.log(`   락 강제 해제:    node scripts/automation/in-flight-lock.js release --episode ${episodeId}`);
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1); });
