#!/usr/bin/env node

/**
 * producer-trigger-series.js — 신규 시리즈를 Producer 파이프라인 진입점으로 넘긴다.
 *
 * 마케팅 → CEO → Producer 자동 브릿지의 3단계.
 *
 * 동작:
 *   1) paperclip/config/series.json에서 대상 시리즈 조회
 *      - --series <id> 직접 지정, 또는 --auto-pick-planned (가장 오래된 status='planned' 1개)
 *   2) curriculum + 5 brief가 모두 있는지 검증
 *   3) in-flight 락 검사 — 다른 EP 진행 중이면 거부 (exit 32)
 *   4) create-series.js 호출 → 5개 EP-YYYY-NNNN 디렉토리 부트스트랩
 *   5) (옵션) --produce-first 시 첫 EP에 대해 produce-episode.js 호출
 *      - 비용 발생을 줄이기 위해 기본은 OFF
 *      - --produce-first --dry 면 produce-episode.js의 "no-op 시연" (해당 스크립트가 dry-run을 직접 지원하지
 *        않으므로 본 스크립트는 명령어만 echo함). 기본 권장 모드.
 *      - --produce-first --execute 가 명시될 때만 실제 비용 발생 호출 (이중 가드)
 *
 * Usage:
 *   node producer-trigger-series.js --series ai-econ-basic
 *   node producer-trigger-series.js --auto-pick-planned
 *   node producer-trigger-series.js --series ai-econ-basic --produce-first --dry
 *   node producer-trigger-series.js --series ai-econ-basic --produce-first --execute  # 실제 과금
 *
 * Exit codes:
 *   0  성공
 *   30 잘못된 인자 / 시리즈 없음
 *   31 시리즈 자산 누락 (curriculum/brief 부재)
 *   32 in-flight 락 충돌 (다른 EP 진행 중)
 *   33 create-series 실패
 *   34 produce-episode 실패 (--execute 모드)
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const SERIES_CONFIG_PATH = resolve(ROOT, 'paperclip/config/series.json');
const PIPELINE_LOG = resolve(ROOT, 'logs/marketing-pipeline.log');
const IN_FLIGHT_PATH = resolve(ROOT, 'workspace/.in-flight.json');

function logPipeline(entry) {
  try {
    mkdirSync(dirname(PIPELINE_LOG), { recursive: true });
    appendFileSync(PIPELINE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch {/* non-fatal */}
}

function readJSON(p) { return JSON.parse(readFileSync(p, 'utf-8')); }

function pickSeries({ seriesId, autoPickPlanned, channel }) {
  const cfg = readJSON(SERIES_CONFIG_PATH);
  const all = cfg.series || [];
  if (seriesId) {
    const hit = all.find(s => s.id === seriesId);
    if (!hit) {
      throw new Error(`Series id not found in series.json: ${seriesId}`);
    }
    return hit;
  }
  if (autoPickPlanned) {
    const planned = all
      .filter(s => s.status === 'planned' && (!channel || s.channel === channel))
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    if (planned.length === 0) {
      throw new Error(`No 'planned' series available${channel ? ' for channel=' + channel : ''}`);
    }
    return planned[0];
  }
  throw new Error('Either --series <id> or --auto-pick-planned is required.');
}

function validateSeriesAssets(series) {
  const curriculum = resolve(ROOT, series.curriculum_path);
  const missing = [];
  if (!existsSync(curriculum)) missing.push(curriculum);
  for (const bp of series.brief_paths || []) {
    if (!existsSync(resolve(ROOT, bp))) missing.push(bp);
  }
  return missing;
}

function checkInFlight() {
  if (!existsSync(IN_FLIGHT_PATH)) return null;
  try {
    const lock = readJSON(IN_FLIGHT_PATH);
    if (!lock || !lock.episode_id) return null;
    return lock;
  } catch {
    return null;
  }
}

function runNode(scriptRel, args, { capture = true } = {}) {
  const scriptPath = join(ROOT, scriptRel);
  if (!existsSync(scriptPath)) throw new Error(`Script not found: ${scriptRel}`);
  return spawnSync('node', [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      series:               { type: 'string' },
      'auto-pick-planned':  { type: 'boolean', default: false },
      channel:              { type: 'string' },
      'produce-first':      { type: 'boolean', default: false },
      dry:                  { type: 'boolean', default: false },
      execute:              { type: 'boolean', default: false },
      'force-release-stale':{ type: 'boolean', default: false },
    },
  });

  let series;
  try {
    series = pickSeries({
      seriesId: values.series,
      autoPickPlanned: values['auto-pick-planned'],
      channel: values.channel,
    });
  } catch (e) {
    console.error('❌', e.message);
    process.exit(30);
  }

  console.log(`📚 Series: ${series.id} — ${series.name}`);
  console.log(`   Channel: ${series.channel} | Format: ${series.format} | Status: ${series.status}`);

  // 자산 유효성
  const missing = validateSeriesAssets(series);
  if (missing.length > 0) {
    console.error(`❌ 시리즈 자산 누락 (${missing.length}):`);
    missing.forEach(m => console.error(`   - ${m}`));
    logPipeline({ stage: 'producer-trigger', status: 'missing_assets', series: series.id, missing });
    process.exit(31);
  }

  // in-flight 락 검사
  const lock = checkInFlight();
  if (lock) {
    const stage = lock.stage || 'unknown';
    const epId  = lock.episode_id;
    const startedAt = lock.started_at || lock.acquired_at || 'unknown';
    console.error(`⛔ in-flight 락 충돌: ${epId} (stage=${stage}, started=${startedAt})`);
    if (values['force-release-stale']) {
      console.error('   --force-release-stale 가 명시되었으므로 in-flight-lock.js force-release를 시도합니다.');
      const fr = runNode('scripts/automation/in-flight-lock.js', ['force-release']);
      if (fr.status !== 0) {
        console.error('   force-release 실패:', (fr.stderr || fr.stdout).slice(-200));
        process.exit(32);
      }
      console.error('   ✅ stale 락 해제 완료. 진행합니다.');
    } else {
      console.error('   다른 EP가 진행 중이므로 신규 시리즈 부트스트랩을 거부합니다.');
      console.error('   대안: 기존 EP 종료 후 재시도 또는 --force-release-stale (stale 의심 시).');
      logPipeline({ stage: 'producer-trigger', status: 'lock_held', series: series.id, lock });
      process.exit(32);
    }
  }

  // create-series.js 호출
  console.log(`\n🎬 Bootstrapping series episodes via create-series.js...`);
  const cs = runNode('scripts/automation/create-series.js', ['--series', series.id], { capture: false });
  if (cs.status !== 0) {
    console.error(`❌ create-series.js 실패 (exit ${cs.status})`);
    logPipeline({ stage: 'producer-trigger', status: 'create_series_failed', series: series.id, exit: cs.status });
    process.exit(33);
  }

  // 생성된 EP 디렉토리 추정 — 가장 최근 5개
  const episodesDir = join(ROOT, 'workspace/episodes');
  const eps = (existsSync(episodesDir)
    ? readdirSync(episodesDir).filter(d => d.startsWith('EP-')).sort()
    : []).slice(-(series.total_episodes || 5));
  console.log(`\n✅ Bootstrapped ${eps.length} episodes:`);
  eps.forEach(e => console.log(`   - ${e}`));

  logPipeline({
    stage: 'producer-trigger',
    status: 'series_bootstrapped',
    series: series.id,
    episodes: eps,
  });

  // produce-first 옵션
  if (values['produce-first']) {
    const target = eps[0];
    if (!target) {
      console.error('❌ produce 대상 EP를 찾지 못했습니다.');
      process.exit(34);
    }
    console.log(`\n🎯 First EP: ${target}`);
    if (values.execute) {
      console.log('⚠️  --execute 모드: 실제 produce-episode.js 호출 (TTS/이미지 비용 발생).');
      const pe = runNode('scripts/automation/produce-episode.js', ['--episode', target], { capture: false });
      if (pe.status !== 0) {
        console.error(`❌ produce-episode 실패 (exit ${pe.status})`);
        logPipeline({ stage: 'producer-trigger', status: 'produce_failed', series: series.id, episode: target, exit: pe.status });
        process.exit(34);
      }
      logPipeline({ stage: 'producer-trigger', status: 'produced_first_ep', series: series.id, episode: target });
    } else {
      console.log('🧪 --produce-first 만 지정됨 (--execute 없음). 실제 호출 대신 명령어 시연:');
      console.log(`   node scripts/automation/produce-episode.js --episode ${target}`);
      console.log('   비용 발생 작업이므로 운영자가 명시적으로 --execute 또는 직접 호출해야 합니다.');
      logPipeline({ stage: 'producer-trigger', status: 'produce_first_dry', series: series.id, episode: target });
    }
  }

  console.log(`\n🎉 Series ${series.id} → Producer 파이프라인 진입 완료.`);
  console.log(`<!--RESULT-->${JSON.stringify({ ok: true, series: series.id, episodes: eps, produced: !!(values['produce-first'] && values.execute) })}<!--/RESULT-->`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('❌', e.message || e); process.exit(30); });
}

export { pickSeries, validateSeriesAssets };
