#!/usr/bin/env node

/**
 * intel-metrics.js — PRD §2.2 성공 지표 측정
 *
 * PRD 는 6개 목표를 세웠지만 그것을 잴 수단이 없었다. 이 스크립트가 그 수단이다.
 * 전부 파일에서 읽는 사후 측정이며 API 도 LLM 도 쓰지 않는다.
 *
 *   수집 성공률   intel/competitors/YYYY-MM-DD.json 존재율 (30일 롤링)
 *   주제 반영률   daily-news 하위 topic-<slot>.json 의 competitor_gap_used ≠ null 비율
 *   쿼터 사용량   intel/competitors/quota-*.json 의 일 평균
 *   파이프라인 차단  logs/cron/*.log 에서 인텔 때문에 멈춘 횟수
 *   분석 결정성   analysis 를 2회 생성해 generated_at 제외 비교
 *   LLM 비용     logs/budget/usage-*.json 의 intel 관련 증분
 *
 * Usage:
 *   node intel-metrics.js                 # 30일 롤링
 *   node intel-metrics.js --days 7
 *   node intel-metrics.js --json          # 기계 판독용
 *   node intel-metrics.js --check-determinism   # 분석 2회 실행 (느림)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const INTEL_DIR = join(ROOT, 'workspace', 'intel', 'competitors');
const NEWS_DIR = join(ROOT, 'workspace', 'daily-news');
const BUDGET_DIR = join(ROOT, 'logs', 'budget');
const CRON_DIR = join(ROOT, 'logs', 'cron');

// PRD §2.2 목표치
// min_n: 이만큼 표본이 없으면 판정하지 않는다.
// 1일치로 "수집 성공률 3.3% FAIL" 을 내면 시스템이 고장난 것처럼 읽히지만
// 실제로는 "이제 막 시작했다"는 뜻이다. 표본 부족은 실패가 아니다.
const TARGETS = {
  collection_rate: { min: 0.95, min_n: 7, label: '수집 성공률', fmt: (v) => `${(v * 100).toFixed(1)}%` },
  topic_adoption: { min: 0.60, min_n: 3, label: '주제 반영률', fmt: (v) => `${(v * 100).toFixed(1)}%` },
  // 하루 2회(36) + 주 1회 deep scan(54/7≈7.7) = 약 44. 여유를 둬 50.
  // 2026-08-30 부동산 섹션 개설로 채널이 6 → 27 이 됐다. 하루 비용은 27ch × 3u × 2회 = 162.
  // 자체 상한(competitor-channels.json quota.daily_cap_units = 2000)과 무료 한도(10,000)에는
  // 한참 못 미치지만, 이 지표는 '폭주 감지'용이라 실제 규모에 맞춰 둬야 의미가 있다.
  quota_per_day: { max: 200, min_n: 3, label: 'API 쿼터/일', fmt: (v) => `${v.toFixed(1)} units` },
  pipeline_blocks: { max: 0, label: '파이프라인 차단', fmt: (v) => `${v}건` },
  determinism: { min: 1, label: '분석 결정성', fmt: (v) => (v === 1 ? '일치' : v === null ? '미측정' : '불일치') },
  llm_cost_month: { max: 0.10, label: 'LLM 비용/월', fmt: (v) => `$${v.toFixed(4)}` },
};

function loadJSON(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

function dateRange(days, now) {
  return Array.from({ length: days }, (_, i) =>
    new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10));
}

/** 수집 성공률 — 스냅샷이 있고 채널을 하나라도 담았는가. */
function collectionRate(dates) {
  // 첫 성공일 이후만 모수로 잡는다. 도입 전 과거를 실패로 세면
  // 지표가 영원히 "며칠 전에 시작했나"를 재게 된다.
  const asc = [...dates].sort();
  const firstOk = asc.findIndex((d) => {
    const snap = loadJSON(join(INTEL_DIR, `${d}.json`));
    return snap && (snap.channel_count ?? 0) > 0;
  });
  if (firstOk < 0) return { value: null, ok: 0, total: 0, missing: [], note: '아직 성공한 수집이 없다' };

  const window = asc.slice(firstOk);
  let ok = 0;
  const missing = [];
  for (const d of window) {
    const snap = loadJSON(join(INTEL_DIR, `${d}.json`));
    if (snap && (snap.channel_count ?? 0) > 0) ok++;
    else missing.push(d);
  }
  return {
    value: window.length ? ok / window.length : null,
    ok, total: window.length, since: window[0],
    missing: missing.slice(0, 5),
  };
}

/** 주제 반영률 — 리서치가 실제로 갭을 집어 썼는가. */
function topicAdoption(dates) {
  let total = 0;
  let adopted = 0;
  const samples = [];
  for (const d of dates) {
    const dir = join(NEWS_DIR, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => /^topic-.+\.json$/.test(f))) {
      const t = loadJSON(join(dir, f));
      if (!t) continue;
      // 키가 없으면 S3 배선 이전에 만들어진 파일이다 — 모수에서 뺀다.
      // 넣으면 배선 전 이력이 영구히 분모를 부풀린다.
      if (!('competitor_gap_used' in t)) continue;
      total++;
      if (t.competitor_gap_used) {
        adopted++;
        if (samples.length < 5) samples.push({ date: d, gap: t.competitor_gap_used });
      }
    }
  }
  return { value: total ? adopted / total : null, adopted, total, samples };
}

/** 쿼터 — 원장 기준 일 평균. */
function quotaPerDay(dates) {
  const used = [];
  for (const d of dates) {
    const q = loadJSON(join(INTEL_DIR, `quota-${d}.json`));
    if (q) used.push(q.units_used ?? 0);
  }
  const avg = used.length ? used.reduce((a, b) => a + b, 0) / used.length : 0;
  return { value: avg, days: used.length, peak: used.length ? Math.max(...used) : 0 };
}

/**
 * 파이프라인 차단 — 인텔이 EP 생산을 멈춘 횟수.
 * 인텔 경로는 fail-soft 라 halt/fail_with_alert 가 인텔 문구와 같은 줄에 나오면 계약 위반이다.
 */
function pipelineBlocks() {
  if (!existsSync(CRON_DIR)) return { value: 0, scanned: 0, hits: [] };
  const hits = [];
  let scanned = 0;
  for (const f of readdirSync(CRON_DIR).filter((f) => f.endsWith('.log'))) {
    scanned++;
    const text = readFileSync(join(CRON_DIR, f), 'utf-8');
    for (const line of text.split('\n')) {
      if (!/경쟁|competitor|intel/i.test(line)) continue;
      if (/halt|fail_with_alert|중단|exit 1/i.test(line)) hits.push(`${f}: ${line.trim().slice(0, 100)}`);
    }
  }
  return { value: hits.length, scanned, hits: hits.slice(0, 5) };
}

/** LLM 비용 — 이번 달 인텔 관련 호출 합. */
function llmCost() {
  if (!existsSync(BUDGET_DIR)) return { value: 0, calls: 0 };
  const month = new Date().toISOString().slice(0, 7);
  const ledger = loadJSON(join(BUDGET_DIR, `usage-${month}.json`));
  const calls = (ledger?.calls ?? []).filter((c) => String(c.stage ?? '').startsWith('intel-'));
  return { value: calls.reduce((s, c) => s + (c.usd ?? 0), 0), calls: calls.length };
}

/** 결정성 — 같은 입력으로 2회 분석해 generated_at 만 다른지 확인. */
function determinism(date) {
  const path = join(INTEL_DIR, `analysis-${date}.json`);
  const before = loadJSON(path);
  if (!before) return { value: null, note: '분석 파일 없음' };

  const r = spawnSync('node', [
    join(ROOT, 'scripts', 'automation', 'analyze-competitors.js'), '--date', date,
  ], { cwd: ROOT, encoding: 'utf-8', timeout: 300_000 });
  if (r.status !== 0) return { value: null, note: `재실행 실패 (exit ${r.status})` };

  const after = loadJSON(path);
  const strip = (a) => { const c = { ...a }; delete c.generated_at; return JSON.stringify(c); };
  const same = strip(before) === strip(after);
  return { value: same ? 1 : 0, note: same ? null : 'generated_at 외 필드가 달라졌다' };
}

function verdict(key, value, n = null) {
  const t = TARGETS[key];
  if (value === null || value === undefined) return 'SKIP';
  if (t.min_n !== undefined && n !== null && n < t.min_n) return 'INSUFFICIENT';
  if (t.min !== undefined) return value >= t.min ? 'PASS' : 'FAIL';
  if (t.max !== undefined) return value <= t.max ? 'PASS' : 'FAIL';
  return 'SKIP';
}

function main() {
  const { values } = parseArgs({
    options: {
      days: { type: 'string' },
      json: { type: 'boolean', default: false },
      'check-determinism': { type: 'boolean', default: false },
    },
  });

  const now = new Date();
  const days = parseInt(values.days || '30', 10);
  const dates = dateRange(days, now);
  const today = now.toISOString().slice(0, 10);

  const collection = collectionRate(dates);
  const adoption = topicAdoption(dates);
  const quota = quotaPerDay(dates);
  const blocks = pipelineBlocks();
  const cost = llmCost();
  const det = values['check-determinism']
    ? determinism(today)
    : { value: null, note: '--check-determinism 으로 측정' };

  const metrics = {
    measured_at: now.toISOString(),
    window_days: days,
    collection_rate: { ...collection, verdict: verdict('collection_rate', collection.value, collection.total) },
    topic_adoption: { ...adoption, verdict: verdict('topic_adoption', adoption.value, adoption.total) },
    quota_per_day: { ...quota, verdict: verdict('quota_per_day', quota.value, quota.days) },
    pipeline_blocks: { ...blocks, verdict: verdict('pipeline_blocks', blocks.value) },
    determinism: { ...det, verdict: verdict('determinism', det.value) },
    llm_cost_month: { ...cost, verdict: verdict('llm_cost_month', cost.value) },
  };

  if (values.json) {
    console.log(JSON.stringify(metrics, null, 2));
    return;
  }

  const icon = { PASS: '✅', FAIL: '❌', SKIP: '⏭️ ', INSUFFICIENT: '📉' };
  console.log(`\n📏 경쟁 인텔 성공 지표 — 최근 ${days}일 (PRD §2.2)\n`);
  for (const key of Object.keys(TARGETS)) {
    const t = TARGETS[key];
    const m = metrics[key];
    const target = t.min !== undefined ? `≥ ${t.fmt(t.min)}` : `≤ ${t.fmt(t.max)}`;
    const actual = m.value === null || m.value === undefined ? '—' : t.fmt(m.value);
    const suffix = m.verdict === 'INSUFFICIENT' ? `  (표본 ${m.total ?? m.days ?? 0}/${t.min_n} — 판정 보류)` : '';
    console.log(`  ${icon[m.verdict]} ${t.label.padEnd(14)} ${actual.padStart(12)}   목표 ${target}${suffix}`);
  }

  console.log('');
  if (collection.since) console.log(`  · 수집 측정 시작일: ${collection.since} (${collection.ok}/${collection.total}일 성공)`);
  if (collection.note) console.log(`  · ${collection.note}`);
  if (collection.missing.length) console.log(`  · 수집 누락일: ${collection.missing.join(', ')}${collection.total - collection.ok > 5 ? ' …' : ''}`);
  if (adoption.total) console.log(`  · 주제 ${adoption.adopted}/${adoption.total} 건이 갭을 반영`);
  if (adoption.samples.length) console.log(`  · 반영 예: ${adoption.samples.map((s) => `${s.date} "${s.gap}"`).join(', ')}`);
  if (quota.days) console.log(`  · 쿼터 최대 ${quota.peak} units (${quota.days}일 기록)`);
  if (blocks.hits.length) for (const h of blocks.hits) console.log(`  · ⚠ 차단: ${h}`);
  if (cost.calls) console.log(`  · LLM ${cost.calls}콜`);
  if (det.note) console.log(`  · 결정성: ${det.note}`);

  const failed = Object.keys(TARGETS).filter((k) => metrics[k].verdict === 'FAIL');
  console.log(failed.length ? `\n❌ 미달 ${failed.length}건: ${failed.map((k) => TARGETS[k].label).join(', ')}\n`
                            : '\n✅ 측정된 지표 전부 목표 충족\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`✗ ${e.message}`); }
  process.exitCode = 0; // 측정 실패가 파이프라인을 막지 않는다
}
