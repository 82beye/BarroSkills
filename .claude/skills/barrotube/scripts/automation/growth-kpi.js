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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { computeScorecard, normalizeIndex, METRICS_VERSION } from './lib/growth-kpi.js';

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

/** 가장 최근 analytics-*.json 을 {day, views, averageViewPercentage, ...} 배열로 편다. */
function loadAnalyticsRows(dir) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^analytics-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch { return null; }
  if (!files.length) return null;
  const doc = loadJSON(join(dir, files[files.length - 1]));
  const cols = (doc?.columnHeaders ?? []).map((c) => c.name);
  if (!cols.length || !Array.isArray(doc?.rows)) return null;
  return doc.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

function main() {
  const { values } = parseArgs({ options: { date: { type: 'string' } } });
  const now = new Date();
  const today = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const date = values.date || today;
  if (date !== today) throw new Error('KPI --date must be today in Asia/Seoul; current snapshots cannot backfill history');

  const config = loadJSON(join(ROOT, 'config', 'growth.json'));
  if (!config) { console.error('❌ config/growth.json 없음'); process.exit(2); }
  const index = loadJSON(join(CH_DIR, 'videos.json'));
  if (!index) { console.error('❌ 채널 인덱스 없음 — fetch-channel-stats.js 를 먼저 실행'); process.exit(2); }
  const observedAt = Date.parse(index.updated_at ?? '');
  if (index.channelId !== config.channel_id) throw new Error('KPI channel identity mismatch');
  if (!Number.isFinite(observedAt) || now - observedAt > 24 * 3600_000 || observedAt > now.getTime()) {
    throw new Error('KPI index is stale or invalid; fetch-channel-stats.js must succeed first');
  }
  const history = loadHistory(join(CH_DIR, 'history.jsonl'));

  const videos = normalizeIndex(index, now);
  // Analytics 행(일별 시청률)은 fetch-channel-stats 가 analytics-YYYY-MM-DD.json 으로 남긴다.
  // 없으면 그 지표만 NA 로 떨어지고 나머지는 그대로 계산된다.
  const analytics = loadAnalyticsRows(CH_DIR);
  const card = computeScorecard({ videos, history, config, now, analytics });

  const expState = loadJSON(join(ROOT, 'workspace', 'growth', 'experiments.json'), {});
  const curExp = expState.current ?? null;

  mkdirSync(KPI_DIR, { recursive: true });
  const out = {
    schema_version: 1, date, generated_at: now.toISOString(),
    // 계산식 판본. 실험 판정이 판본 경계를 넘어 비교하지 않도록 문서에 박아 둔다.
    metrics_version: METRICS_VERSION,
    phase: config.phase?.name ?? 'seed',
    overall: card.overall, kpis: card.kpis,
    top_videos: card.top, bottom_videos: card.bottom,
    experiment: curExp ? { id: curExp.id, directive: curExp.directive, started: curExp.started } : null,
    inputs: { video_count: videos.length, history_rows: history.length, observed_at: index.updated_at,
      channel_id: index.channelId, analytics_latest_day: analytics?.map((r) => r.day).sort().at(-1) ?? null },
  };
  const tmp = join(KPI_DIR, `${date}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  renameSync(tmp, join(KPI_DIR, `${date}.json`));

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
    `> 관측: ${index.updated_at} · Analytics 최신 일자: ${out.inputs.analytics_latest_day ?? '없음'}`,
    `> NA = 비교 가능한 관측 부족. 순증은 7일, WoW는 같은 인덱스의 14일 이력이 필요하다.`,
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
