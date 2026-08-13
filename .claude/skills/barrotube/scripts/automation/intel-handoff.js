#!/usr/bin/env node

/**
 * intel-handoff.js — 경쟁 인텔 → 의사결정 핸드오프
 *
 * lifecycle-bridge.js 의 Rule 1 / 1b 를 PaperClip 없이 재구현한 것.
 * 원본은 PaperClip 이슈 트래커 REST API 의존이라 _legacy_paperclip/ 에 봉인돼 있다.
 * 여기서는 데몬·HTTP·상태머신 없이 파일 큐 + 승인 마커만 쓴다.
 * (이 파일에 그 API 주소를 적으면 doctor 의 격리 검사가 YELLOW 로 떨어진다 — 주석에도 쓰지 말 것)
 *
 *   Rule I1  analysis-<date>.json 생김        → <date>-ceo-review.md 작성 + 텔레그램 1건
 *   Rule I2  <date>-ceo-review.approved 생김  → ceo-analyze-marketing.js 실행 (시리즈 planned 등록)
 *
 * 승인 경로: 텔레그램 `/intel approve <date>` 또는 운영자가 .approved 파일을 직접 생성.
 *
 * 멱등성: workspace/intel/handoffs/queue.jsonl 에 key 를 남기고 재실행 시 건너뛴다.
 *
 * 게이트: autonomy-pause 가 active 가 아니면 아무 규칙도 실행하지 않는다.
 *   (수집·분석은 관측이라 pause 와 무관하게 돌지만, 핸드오프는 의사결정을 유발한다)
 *
 * Usage:
 *   node intel-handoff.js --date 2026-08-13
 *   node intel-handoff.js --date 2026-08-13 --dry-run
 *   node intel-handoff.js --date 2026-08-13 --approve   # .approved 마커 생성
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const INTEL_DIR = join(ROOT, 'workspace', 'intel', 'competitors');
const HANDOFF_DIR = join(ROOT, 'workspace', 'intel', 'handoffs');
const QUEUE = join(HANDOFF_DIR, 'queue.jsonl');
const PAUSE_PATH = join(ROOT, 'config', 'autonomy-pause.json');

function loadJSON(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

function readQueue() {
  if (!existsSync(QUEUE)) return [];
  return readFileSync(QUEUE, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function appendQueue(rec) {
  mkdirSync(HANDOFF_DIR, { recursive: true });
  appendFileSync(QUEUE, `${JSON.stringify(rec)}\n`);
}

const hasKey = (rows, key) => rows.some((r) => r.key === key);

/** 하루 상한. 구 lifecycle-bridge 의 "일일 1건" 규칙을 그대로 옮겼다. */
function todayCount(rows, prefix, date) {
  return rows.filter((r) => r.key?.startsWith(prefix) && r.at?.slice(0, 10) === date).length;
}

function isPaused() {
  const p = loadJSON(PAUSE_PATH, {});
  return p.status !== 'active';
}

/**
 * 발송은 조건부다 — 매일 "발견 0건" 알림은 운영자가 채널 전체를 무시하게 만든다.
 * 이상치가 있거나 갭이 3건 이상이거나 수집이 degraded 일 때만 보낸다.
 */
function shouldNotify(a) {
  return (a.outliers?.length ?? 0) >= 1
      || (a.content_gaps?.length ?? 0) >= 3
      || a.degraded != null;
}

function notifyTelegram(analysis, date) {
  const payload = {
    date,
    gaps: analysis.content_gaps?.length ?? 0,
    outliers: analysis.outliers?.length ?? 0,
    blue_ocean: analysis.blue_ocean_keywords?.length ?? 0,
    top: (analysis.content_gaps ?? []).slice(0, 3).map((g) => g.term).join(', '),
  };
  const r = spawnSync('node', [
    join(ROOT, 'scripts', 'automation', 'notify.js'), 'intel_ready', JSON.stringify(payload),
  ], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 });
  return r.status === 0;
}

function renderReview(analysis, date) {
  const L = [];
  L.push(`# 경쟁 인텔 리뷰 요청 — ${date}`, '');
  L.push(`채널 ${analysis.channel_count} · 갭 ${analysis.content_gaps.length} · 이상치 ${analysis.outliers.length} · 블루오션 ${analysis.blue_ocean_keywords.length}`, '');

  if (analysis.content_gaps.length) {
    L.push('## 콘텐츠 갭 상위 5', '');
    for (const g of analysis.content_gaps.slice(0, 5)) {
      const ev = g.evidence.map((e) => `[${e.channel}](https://youtu.be/${e.videoId})`).join(' ');
      L.push(`- **${g.term}** — ${g.comp_df}개 채널, 조회수 합 ${g.comp_views.toLocaleString()} ${ev}`);
    }
    L.push('');
  }

  if (analysis.outliers.length) {
    L.push('## 성과 이상치 상위 3 (오늘 다루지 말 것)', '');
    for (const o of analysis.outliers.slice(0, 3)) {
      L.push(`- ${o.multiple}× — ${o.channel} · [${o.title.slice(0, 60)}](https://youtu.be/${o.videoId})`);
    }
    L.push('');
  }

  if (analysis.blue_ocean_keywords.length) {
    L.push('## 블루오션 상위 5', '');
    for (const b of analysis.blue_ocean_keywords.slice(0, 5)) {
      L.push(`- **${b.keyword}** — score ${b.score}, 경쟁도 ${b.competition}`);
    }
    L.push('');
  }

  const pos = (analysis.patterns?.title_features ?? []).filter((f) => f.direction === 'positive');
  if (pos.length) {
    L.push('## 제목 후킹 (positive)', '');
    for (const f of pos) L.push(`- \`${f.feature}\` — ${f.lift}× (n=${f.n_with}/${f.n_without})`);
    L.push('');
  }

  L.push('---', '');
  L.push('승인하면 CEO 시리즈 기획이 `status: planned` 로 등록된다 (첫 EP 생산은 자동 실행하지 않는다).', '');
  L.push(`텔레그램: \`/intel approve ${date}\``);
  L.push(`직접: \`touch workspace/intel/handoffs/${date}-ceo-review.approved\``);
  return L.join('\n');
}

function main() {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      approve: { type: 'boolean', default: false },
    },
  });

  const date = values.date || new Date().toISOString().slice(0, 10);
  const reviewPath = join(HANDOFF_DIR, `${date}-ceo-review.md`);
  const approvedPath = `${reviewPath.replace(/\.md$/, '')}.approved`;

  if (values.approve) {
    mkdirSync(HANDOFF_DIR, { recursive: true });
    writeFileSync(approvedPath, '');
    console.log(`✓ 승인 마커 생성: ${approvedPath.replace(ROOT + '/', '')}`);
    return;
  }

  if (isPaused()) {
    console.log('⏸  autonomy-pause 가 active 가 아니다 — 핸드오프를 건너뛴다 (수집·분석은 계속된다)');
    return;
  }

  const analysisPath = join(INTEL_DIR, `analysis-${date}.json`);
  const analysis = loadJSON(analysisPath);
  if (!analysis) {
    console.log(`ℹ 분석 파일 없음: analysis-${date}.json — 할 일 없음`);
    return;
  }

  const rows = readQueue();

  // ── Rule I1: 분석 완료 → 사람이 읽는 리뷰 요청
  const keyI1 = `competitor-analysis:${date}`;
  if (hasKey(rows, keyI1)) {
    console.log(`⏭  Rule I1 skip (already emitted): ${keyI1}`);
  } else if (todayCount(rows, 'competitor-analysis:', date) >= 1) {
    console.log('⏭  Rule I1 skip — 일일 상한 1건');
  } else if (values['dry-run']) {
    console.log(`[DRY_RUN] Rule I1 → ${reviewPath.replace(ROOT + '/', '')}`);
  } else {
    mkdirSync(HANDOFF_DIR, { recursive: true });
    writeFileSync(reviewPath, renderReview(analysis, date));
    const sent = shouldNotify(analysis) ? notifyTelegram(analysis, date) : false;
    appendQueue({
      key: keyI1, at: new Date().toISOString(), rule: 'I1',
      source: `workspace/intel/competitors/analysis-${date}.json`,
      target: 'operator', artifact: `workspace/intel/handoffs/${date}-ceo-review.md`,
      status: 'emitted', telegram: sent,
    });
    console.log(`✓ Rule I1 — 리뷰 요청 생성: ${reviewPath.replace(ROOT + '/', '')}${sent ? ' (텔레그램 발송)' : ''}`);
  }

  // ── Rule I2: 승인 마커 → CEO 시리즈 기획 (status: planned 로만)
  const keyI2 = `ceo-review-approved:${date}`;
  if (!existsSync(approvedPath)) {
    console.log(`ℹ Rule I2 대기 — 승인 마커 없음 (${date}-ceo-review.approved)`);
    return;
  }
  if (hasKey(rows, keyI2)) {
    console.log(`⏭  Rule I2 skip (already executed): ${keyI2}`);
    return;
  }
  if (todayCount(rows, 'ceo-review-approved:', date) >= 1) {
    console.log('⏭  Rule I2 skip — 일일 상한 1건');
    return;
  }
  if (values['dry-run']) {
    console.log('[DRY_RUN] Rule I2 → ceo-analyze-marketing.js --report ...');
    return;
  }

  const r = spawnSync('node', [
    join(ROOT, 'scripts', 'automation', 'ceo-analyze-marketing.js'),
    '--report', analysisPath, '--channel', 'econ-daily',
  ], { cwd: ROOT, stdio: 'inherit', timeout: 300_000 });

  appendQueue({
    key: keyI2, at: new Date().toISOString(), rule: 'I2',
    source: `workspace/intel/handoffs/${date}-ceo-review.approved`,
    target: 'ceo', status: r.status === 0 ? 'executed' : 'failed', exit_code: r.status,
  });
  console.log(r.status === 0 ? '✓ Rule I2 — 시리즈 기획 등록 (planned)' : `⚠ Rule I2 실패 (exit ${r.status})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(`✗ ${e.message}`);
  }
  process.exitCode = 0; // 핸드오프 실패가 루틴을 막지 않는다
}
