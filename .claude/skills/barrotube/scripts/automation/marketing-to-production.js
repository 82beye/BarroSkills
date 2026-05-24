#!/usr/bin/env node

/**
 * marketing-to-production.js — 마케팅 → CEO → Producer 자동 브릿지 (오케스트레이션)
 *
 * 단일 명령어로 다음을 순차 실행:
 *   1) fetch-paperclip-report.js        (PaperClip → workspace/intel/marketing/)
 *   2) ceo-analyze-marketing.js         (리포트 → 신규 시리즈 시드 + series.json append)
 *   3) producer-trigger-series.js       (옵션, --auto-produce-first 시 호출)
 *
 * 비용 정책:
 *   - 단계 (1)(2) 는 안전 (네트워크 + 파일 쓰기, LLM 호출 없음).
 *   - 단계 (3) 는 create-series.js 까지만 실행 (EP 디렉토리 부트스트랩 — 무과금).
 *   - 첫 EP 실제 produce(과금) 는 `--auto-produce-first --execute` 두 플래그가
 *     모두 명시될 때만 호출. 기본은 명령어 echo 만.
 *
 * Usage:
 *   node marketing-to-production.js --issue YOU-99 --channel econ-daily
 *   node marketing-to-production.js --issue YOU-99 --channel econ-daily --max-series 2
 *   node marketing-to-production.js --issue YOU-99 --channel econ-daily --dry-run
 *   node marketing-to-production.js --issue YOU-99 --channel econ-daily --auto-produce-first
 *   node marketing-to-production.js --issue YOU-99 --channel econ-daily --auto-produce-first --execute
 *
 * Exit codes:
 *   0  성공
 *   10/11/12/13/14 — fetch 단계 실패 (fetch-paperclip-report 의 코드 그대로 전파)
 *   20/21/22/23   — ceo-analyze 단계 실패 (ceo-analyze-marketing 의 코드 그대로 전파)
 *   30/31/32/33/34 — producer-trigger 단계 실패 (producer-trigger-series 의 코드 그대로 전파)
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const PIPELINE_LOG = resolve(ROOT, 'logs/marketing-pipeline.log');

function logPipeline(entry) {
  try {
    mkdirSync(dirname(PIPELINE_LOG), { recursive: true });
    appendFileSync(PIPELINE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch {/* non-fatal */}
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

function extractResultMarker(stdout) {
  const m = (stdout || '').match(/<!--RESULT-->(.*?)<!--\/RESULT-->/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function main() {
  const { values } = parseArgs({
    options: {
      issue:               { type: 'string' },
      'issue-id':          { type: 'string' },
      channel:             { type: 'string' },
      'max-series':        { type: 'string' },
      'series-id-prefix':  { type: 'string' },
      'dry-run':           { type: 'boolean', default: false },
      'auto-produce-first':{ type: 'boolean', default: false },
      execute:             { type: 'boolean', default: false },
      'force-release-stale':{ type: 'boolean', default: false },
    },
  });

  if ((!values.issue && !values['issue-id']) || !values.channel) {
    console.error('Usage: marketing-to-production.js --issue YOU-99 --channel econ-daily [...]');
    process.exit(10);
  }

  const stages = { fetch: null, analyze: null, trigger: null };
  const t0 = Date.now();
  console.log(`\n========== marketing-to-production: start ==========`);
  console.log(`issue:   ${values.issue || values['issue-id']}`);
  console.log(`channel: ${values.channel}`);
  console.log(`mode:    ${values['dry-run'] ? 'dry-run' : 'live'}${values['auto-produce-first'] ? ' + auto-produce-first' : ''}${values.execute ? ' + execute(💰)' : ''}`);
  console.log(`====================================================\n`);

  // ─── Stage 1: fetch-paperclip-report ───
  console.log('▶ [1/3] fetch-paperclip-report.js');
  const fetchArgs = [];
  if (values.issue) fetchArgs.push('--issue', values.issue);
  if (values['issue-id']) fetchArgs.push('--issue-id', values['issue-id']);
  const f = runNode('scripts/automation/fetch-paperclip-report.js', fetchArgs);
  process.stdout.write(f.stdout || '');
  if (f.status !== 0) {
    process.stderr.write(f.stderr || '');
    logPipeline({ stage: 'orchestrator', status: 'fetch_failed', exit: f.status });
    process.exit(f.status || 11);
  }
  stages.fetch = extractResultMarker(f.stdout) || { ok: true };

  const reportPath = stages.fetch.out
    || join(ROOT, 'workspace/intel/marketing', `${stages.fetch.identifier || values.issue}.json`);

  // ─── Stage 2: ceo-analyze-marketing ───
  console.log('\n▶ [2/3] ceo-analyze-marketing.js');
  const analyzeArgs = ['--report', reportPath, '--channel', values.channel];
  if (values['max-series'])       analyzeArgs.push('--max-series', values['max-series']);
  if (values['series-id-prefix']) analyzeArgs.push('--series-id-prefix', values['series-id-prefix']);
  if (values['dry-run'])          analyzeArgs.push('--dry-run');
  const a = runNode('scripts/automation/ceo-analyze-marketing.js', analyzeArgs);
  process.stdout.write(a.stdout || '');
  if (a.status !== 0) {
    process.stderr.write(a.stderr || '');
    logPipeline({ stage: 'orchestrator', status: 'analyze_failed', exit: a.status });
    process.exit(a.status || 21);
  }
  stages.analyze = extractResultMarker(a.stdout) || { ok: true };

  if (values['dry-run']) {
    console.log('\n🧪 dry-run 종료 — Stage 3는 실행하지 않습니다.');
    logPipeline({ stage: 'orchestrator', status: 'dry_run_complete', stages });
    console.log(`\n✅ Done in ${(Date.now() - t0) / 1000}s`);
    console.log(`<!--RESULT-->${JSON.stringify({ ok: true, dry_run: true, stages })}<!--/RESULT-->`);
    return;
  }

  // ─── Stage 3: producer-trigger-series (옵션) ───
  if (!values['auto-produce-first']) {
    console.log('\n⏭  [3/3] producer-trigger-series.js — skipped (--auto-produce-first 미지정).');
    console.log('   수동 실행: node scripts/automation/producer-trigger-series.js --auto-pick-planned');
    logPipeline({ stage: 'orchestrator', status: 'analyze_only', stages });
    console.log(`\n✅ Done in ${(Date.now() - t0) / 1000}s`);
    console.log(`<!--RESULT-->${JSON.stringify({ ok: true, stages, next_step: 'producer-trigger-series.js manual' })}<!--/RESULT-->`);
    return;
  }

  console.log('\n▶ [3/3] producer-trigger-series.js');
  const newSeries = stages.analyze.new_series && stages.analyze.new_series[0];
  const triggerArgs = [];
  if (newSeries) triggerArgs.push('--series', newSeries);
  else           triggerArgs.push('--auto-pick-planned', '--channel', values.channel);
  triggerArgs.push('--produce-first');
  if (values.execute) triggerArgs.push('--execute');
  if (values['force-release-stale']) triggerArgs.push('--force-release-stale');

  const t = runNode('scripts/automation/producer-trigger-series.js', triggerArgs);
  process.stdout.write(t.stdout || '');
  if (t.status !== 0) {
    process.stderr.write(t.stderr || '');
    logPipeline({ stage: 'orchestrator', status: 'trigger_failed', exit: t.status });
    process.exit(t.status || 31);
  }
  stages.trigger = extractResultMarker(t.stdout) || { ok: true };

  logPipeline({ stage: 'orchestrator', status: 'complete', stages });
  console.log(`\n✅ Done in ${(Date.now() - t0) / 1000}s`);
  console.log(`<!--RESULT-->${JSON.stringify({ ok: true, stages })}<!--/RESULT-->`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('❌', e.message || e); process.exit(40); });
}
