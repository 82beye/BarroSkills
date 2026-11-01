#!/usr/bin/env node
/**
 * kpi-sync.js — 성장 KPI 스코어카드를 페이퍼클립 목표(goal) 제목에 현재값으로 붙인다 (LLM 0회)
 *
 * 목표는 config/paperclip/company.json goals 가 정하고, 숫자는 성장 루프(growth-kpi.js)가 만든다.
 * 운영자가 페이퍼클립 목표 화면만 봐도 「지금 어디쯤인지」 보이게 한다. 성장 루프(job:growth) 직후에 돈다.
 *
 * Usage: node scripts/automation/paperclip/kpi-sync.js [--dry-run]
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GROWTH, OPS, api, loadCompany, paperclipHealthy, paperclipIds, readJson, writeJsonAtomic } from './lib.js';

const ICON = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴', NA: '⚪' };

export function latestScorecard(dir = join(GROWTH, 'kpi')) {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().at(-1);
  return f ? readJson(join(dir, f)) : null;
}

/** 목표 제목 = 정본 제목 · 현재 KPI 값과 등급. 정본 제목이 앞에 그대로 있어야 setup.js 가 같은 목표로 알아본다. */
export function goalTitle(goal, scorecard, tokenState) {
  const parts = [];
  for (const id of goal.kpis ?? []) {
    const k = scorecard?.kpis?.find((x) => x.id === id);
    if (k) parts.push(`${k.label.replace(/\(.*?\)/g, '').trim()} ${k.display} ${ICON[k.grade] ?? ''}`.trim());
  }
  if (!goal.kpis?.length && tokenState?.providers) {
    for (const [name, p] of Object.entries(tokenState.providers)) {
      parts.push(`${name === 'claude' ? 'Claude' : 'Codex'} 주간 ${p.week ?? '-'}% ${ICON[String(p.level).toUpperCase()] ?? ''}`.trim());
    }
  }
  const tail = parts.length ? ` · 현재 ${parts.join(' · ')}` : '';
  return `${goal.title}${tail}`.slice(0, 250);
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const company = loadCompany();
  const ids = paperclipIds();
  const card = latestScorecard();
  const token = readJson(join(OPS, 'token-state.json'), {});
  if (!card) { console.log('KPI 스코어카드 없음 — 건너뜀'); return 0; }
  if (!ids?.goals || !(await paperclipHealthy())) { console.log('페이퍼클립 미연결 — 건너뜀'); return 0; }
  const snapshot = { date: card.date, overall: card.overall, goals: {} };
  for (const [key, goal] of Object.entries(company.goals)) {
    const id = ids.goals[key];
    if (!id) continue;
    const title = goalTitle(goal, card, token);
    snapshot.goals[key] = title;
    const cur = await api('GET', `/goals/${id}`, undefined, { auth: false });
    if (cur.title === title) continue;
    console.log(`${dry ? '[dry-run] ' : ''}목표: ${title}`);
    if (!dry) await api('PATCH', `/goals/${id}`, { title }, { auth: false });
  }
  if (!dry) writeJsonAtomic(join(OPS, 'goals.json'), { ...snapshot, syncedAt: new Date().toISOString() });
  return 0;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`⚠ kpi-sync: ${e.message}`); process.exit(0); });
}
