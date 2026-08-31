#!/usr/bin/env node

/**
 * growth-kpi.js — 일일 성장 KPI 스코어카드 (성장 루프의 [판정] 단계)
 *
 * 입력: workspace/growth/channel/{videos.json, history.jsonl} + config/growth.json
 * 산출: workspace/growth/kpi/YYYY-MM-DD.{json,md}
 *
 * 계산은 전부 lib/growth-kpi.js 순수 함수 — LLM·네트워크 0회.
 * stdout 마지막 줄에 `OVERALL=<grade>|<한 줄 요약>` 을 내보낸다.
 * growth-pipeline.sh 가 이 줄을 잡아 텔레그램 발송 여부를 정한다.
 *
 * Usage:
 *   node growth-kpi.js                 # 오늘
 *   node growth-kpi.js --date 2026-08-31
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { computeScorecard, normalizeIndex } from './lib/growth-kpi.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CH_DIR = join(ROOT, 'workspace', 'growth', 'channel');
const KPI_DIR = join(ROOT, 'workspace', 'growth', 'kpi');

const GRADE_ICON = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴', NA: '⚪' };

function loadJSON(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

function loadHistory(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function main() {
  const { values } = parseArgs({ options: { date: { type: 'string' } } });
  const date = values.date || new Date().toISOString().slice(0, 10);
  const now = new Date();

  const config = loadJSON(join(ROOT, 'config', 'growth.json'));
  if (!config) { console.error('❌ config/growth.json 없음'); process.exit(2); }
  const index = loadJSON(join(CH_DIR, 'videos.json'));
  if (!index) { console.error('❌ 채널 인덱스 없음 — fetch-channel-stats.js 를 먼저 실행'); process.exit(2); }
  const history = loadHistory(join(CH_DIR, 'history.jsonl'));

  const videos = normalizeIndex(index);
  const card = computeScorecard({ videos, history, config, now });

  const expState = loadJSON(join(ROOT, 'workspace', 'growth', 'experiments.json'), {});
  const curExp = expState.current ?? null;

  mkdirSync(KPI_DIR, { recursive: true });
  const out = {
    schema_version: 1, date, generated_at: now.toISOString(),
    phase: config.phase?.name ?? 'seed',
    overall: card.overall, kpis: card.kpis,
    top_videos: card.top, bottom_videos: card.bottom,
    experiment: curExp ? { id: curExp.id, directive: curExp.directive, started: curExp.started } : null,
    inputs: { video_count: videos.length, history_rows: history.length },
  };
  writeFileSync(join(KPI_DIR, `${date}.json`), JSON.stringify(out, null, 2));

  const md = [
    `# 성장 KPI — ${date}`, '',
    `전체: ${GRADE_ICON[card.overall]} **${card.overall}** · 단계: ${out.phase} · 영상 ${videos.length}편 · 관측 ${history.length}행`, '',
    `| KPI | 값 | 등급 | 산출 |`, `|---|---:|:-:|---|`,
    ...card.kpis.map((k) => `| ${k.label} | ${k.display} | ${GRADE_ICON[k.grade]} ${k.grade} | ${k.method} |`),
    '',
    curExp ? `**진행 중 실험**: \`${curExp.id}\` — ${curExp.directive}` : '**진행 중 실험**: 없음',
    '',
    '## 최근 14d 상위', ...card.top.map((v) => `- ${v.views.toLocaleString()}회 (${v.vpd}/일) — ${v.title}`),
    '', '## 최근 14d 하위', ...card.bottom.map((v) => `- ${v.views.toLocaleString()}회 (${v.vpd}/일) — ${v.title}`),
    '',
    `> NA = 관측 축적 부족(첫 주 정상). history.jsonl 이 7일 쌓이면 주간 지표가 살아난다.`,
    '',
  ].join('\n');
  writeFileSync(join(KPI_DIR, `${date}.md`), md);

  console.log(`📈 성장 KPI — ${date}`);
  for (const k of card.kpis) console.log(`   ${GRADE_ICON[k.grade]} ${k.label}: ${k.display}`);
  console.log(`✓ Saved: workspace/growth/kpi/${date}.{json,md}`);

  const brief = card.kpis.map((k) => `${GRADE_ICON[k.grade]}${k.label} ${k.display}`).join(' · ');
  console.log(`OVERALL=${card.overall}|${brief}`);
}

main();
