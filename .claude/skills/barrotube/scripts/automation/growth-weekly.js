#!/usr/bin/env node

/**
 * growth-weekly.js — 주간 성장 회고 + 실험 로테이션 (성장 루프의 [회고] 단계)
 *
 * 매주 월요일 growth-pipeline.sh 가 호출한다. 하는 일:
 *   1. 주간 스코어카드 비교 — 오늘 KPI vs 7일 전 KPI 파일
 *   2. 진행 중 실험 판정 — 시작 시점 대비 히트율·좋아요율 (결정론: 20% 개선=성공)
 *   3. 로테이션 — 판정 끝난 실험을 history 로 옮기고 백로그 다음 항목 승격
 *   4. workspace/growth/weekly/YYYY-Www.md 리포트
 *
 * 실험 상태는 workspace/growth/experiments.json (런타임) — config/growth.json 의
 * backlog(정적 정의)와 분리한다. config 를 자동화가 매일 고쳐 쓰면 git 이 소음이 된다.
 *
 * stdout 마지막 줄: `WEEKLY=<한 줄 요약>` — growth-pipeline.sh 가 텔레그램으로 발송.
 *
 * Usage:
 *   node growth-weekly.js                # 이번 주
 *   node growth-weekly.js --dry-run      # 로테이션 없이 리포트만 stdout
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const GROWTH_DIR = join(ROOT, 'workspace', 'growth');
const KPI_DIR = join(GROWTH_DIR, 'kpi');
const EXP_PATH = join(GROWTH_DIR, 'experiments.json');

function loadJSON(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

/** ISO 주차 라벨 (YYYY-Www). */
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** date 이전(포함) 가장 가까운 KPI 파일. */
export function nearestKpi(dir, date, files) {
  const list = (files ?? (existsSync(dir) ? readdirSync(dir) : []))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10)).sort();
  const eligible = list.filter((d) => d <= date);
  return eligible.at(-1) ?? null;
}

function kpiValue(kpiDoc, id) {
  const k = (kpiDoc?.kpis ?? []).find((x) => x.id === id);
  return Number.isFinite(k?.value) ? k.value : null;
}

/**
 * 실험 판정 — 시작 시점 스코어카드 대비 (히트율, 좋아요율).
 *   success:      둘 중 하나 ≥20% 개선이고 나머지가 10% 이상 악화하지 않음
 *   fail:         둘 중 하나 ≥20% 악화
 *   inconclusive: 그 외 (표본 부족 NA 포함)
 */
export function judgeExperiment(startKpi, endKpi) {
  const pairs = ['video_hit_rate_7d', 'like_rate_7d'].map((id) => ({
    id, before: kpiValue(startKpi, id), after: kpiValue(endKpi, id),
  }));
  const deltas = pairs
    .filter((p) => p.before !== null && p.after !== null && p.before > 0)
    .map((p) => ({ ...p, rel: (p.after - p.before) / p.before }));
  if (!deltas.length) return { verdict: 'inconclusive', deltas: pairs };
  const improved = deltas.some((d) => d.rel >= 0.2);
  const degraded = deltas.some((d) => d.rel <= -0.2);
  const mildBad = deltas.some((d) => d.rel <= -0.1);
  if (degraded) return { verdict: 'fail', deltas };
  if (improved && !mildBad) return { verdict: 'success', deltas };
  return { verdict: 'inconclusive', deltas };
}

function main() {
  const { values } = parseArgs({ options: {
    'dry-run': { type: 'boolean', default: false },
    // 파이프라인이 KST 날짜를 넘긴다. 없으면 UTC — 월요일 05:40 KST 는 일요일 20:40 UTC 라
    // 방금 만든 당일 KPI 파일이 nearestKpi 에서 걸러지는 어긋남이 있었다.
    date: { type: 'string' },
    // 이번 주 회고가 이미 있으면 조용히 종료. 파이프라인이 매 아침 회차에 이 플래그로
    // 호출해서, 월요일 회차가 절전 등으로 빠져도 화~일 아침에 만회한다 (멱등).
    'if-due': { type: 'boolean', default: false },
  } });
  const now = new Date();
  const today = values.date || now.toISOString().slice(0, 10);
  const week = isoWeek(new Date(`${today}T12:00:00Z`));

  if (values['if-due'] && existsSync(join(GROWTH_DIR, 'weekly', `${week}.md`))) {
    console.log(`· 주간 회고 ${week} 이미 작성됨 — 건너뜀`);
    return;
  }

  const config = loadJSON(join(ROOT, 'config', 'growth.json'), {});
  const state = loadJSON(EXP_PATH, { current: null, history: [] });

  const todayKpiDate = nearestKpi(KPI_DIR, today);
  const todayKpi = todayKpiDate ? loadJSON(join(KPI_DIR, `${todayKpiDate}.json`)) : null;
  const weekAgo = new Date(now.getTime() - 7 * 86400_000).toISOString().slice(0, 10);
  const prevKpiDate = nearestKpi(KPI_DIR, weekAgo);
  const prevKpi = prevKpiDate && prevKpiDate !== todayKpiDate ? loadJSON(join(KPI_DIR, `${prevKpiDate}.json`)) : null;

  const lines = [`# 주간 성장 회고 — ${week} (${today})`, ''];

  // 1) 주간 스코어카드 비교
  lines.push('## KPI 추이 (vs 지난주)', '', '| KPI | 지난주 | 이번주 | 등급 |', '|---|---:|---:|:-:|');
  for (const k of todayKpi?.kpis ?? []) {
    const prev = (prevKpi?.kpis ?? []).find((x) => x.id === k.id);
    lines.push(`| ${k.label} | ${prev?.display ?? '—'} | ${k.display} | ${k.grade} |`);
  }
  lines.push('');

  // 2) 실험 판정 + 로테이션
  let rotated = null, verdictLine = '실험 없음';
  const evalDays = config.experiments?.eval_after_days ?? 7;
  if (state.current) {
    const startedDays = (now - Date.parse(state.current.started)) / 86400_000;
    if (startedDays >= evalDays) {
      const startKpiDate = nearestKpi(KPI_DIR, state.current.started);
      const startKpi = startKpiDate ? loadJSON(join(KPI_DIR, `${startKpiDate}.json`)) : null;
      const j = judgeExperiment(startKpi, todayKpi);
      verdictLine = `${state.current.id} → **${j.verdict}**`;
      lines.push(`## 실험 판정 — ${state.current.id}`, '',
        `- 지시: ${state.current.directive}`,
        `- 판정: **${j.verdict}**`,
        ...j.deltas.map((d) => `- ${d.id}: ${d.before ?? '—'} → ${d.after ?? '—'}${Number.isFinite(d.rel) ? ` (${(d.rel * 100).toFixed(0)}%)` : ''}`),
        '');
      state.history.push({ ...state.current, ended: today, verdict: j.verdict });
      rotated = 'ended';
      state.current = null;
    } else {
      verdictLine = `${state.current.id} 진행 중 (${Math.floor(startedDays)}/${evalDays}일)`;
      lines.push(`## 실험 진행 중 — ${state.current.id} (${Math.floor(startedDays)}/${evalDays}일)`, '');
    }
  }
  if (!state.current) {
    const done = new Set(state.history.map((h) => h.id));
    const next = (config.experiments?.backlog ?? []).find((b) => !done.has(b.id));
    if (next) {
      state.current = { ...next, started: today };
      rotated = rotated ? 'rotated' : 'started';
      lines.push(`## 다음 실험 시작 — ${next.id}`, '', `- 지시: ${next.directive}`, `- 근거: ${next.evidence ?? '—'}`, '');
    } else {
      lines.push('## 실험 백로그 소진 — config/growth.json 에 후보를 보충할 것', '');
    }
  }

  lines.push('## 운영 노트', '',
    '- Analytics API(CTR·시청지속)는 yt-analytics.readonly 스코프 재동의 시 자동 활성 — 운영자 선택 사항.',
    '- NA 지표는 관측 축적 부족(history.jsonl 7일 미만)이며 실패가 아니다.', '');

  const md = lines.join('\n') + '\n';
  if (values['dry-run']) { console.log(md); return; }

  mkdirSync(join(GROWTH_DIR, 'weekly'), { recursive: true });
  writeFileSync(join(GROWTH_DIR, 'weekly', `${week}.md`), md);
  writeFileSync(EXP_PATH, JSON.stringify(state, null, 2));
  console.log(`✓ workspace/growth/weekly/${week}.md`);
  if (rotated) console.log(`✓ 실험 로테이션: ${rotated} (current=${state.current?.id ?? '없음'})`);

  const overall = todayKpi?.overall ?? 'NA';
  console.log(`WEEKLY=${week} 전체 ${overall} · ${verdictLine} · 다음 실험 ${state.current?.id ?? '없음'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
