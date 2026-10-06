#!/usr/bin/env node

/**
 * growth-manager.js — 성장 매니저: 매일 저녁 KPI·영상 성과·처방 결과를 읽고 가설과 처방을 갱신한다
 *
 * 규칙 진단(growth-diagnose.js, 05:40·15:40)이 정해진 원인을 찾아 처방을 켜고 판정한다면, 이 매니저는
 * 그 결과와 KPI 추이를 해석해 **새 가설을 세우고 새 처방을 설계한다**. 판단은 LLM 이 하고, 적용은
 * lib/growth-manager.js validatePlan 이 허용한 것만, 효과 판정과 되돌리기는 결정론 엔진이 한다.
 *
 * 성장 루프의 「LLM 0회」 원칙에서 이 판단 단계 하나만 예외다(2026-10-06 운영자: 단순 자동화로는
 * 성장 관리가 안 된다). 하루 1회, codex 먼저 — 새벽 회차들이 쓰는 claude 세션 한도를 아끼려고.
 *
 * 산출
 *   workspace/growth/journal/<date>.md         일지 — 판단·가설·결정·거른 것
 *   workspace/growth/strategy.json             가설 장부 + 일지 요약(다음 판단의 기억)
 *   workspace/growth/remedies-dynamic.json     매니저가 설계한 처방 정의(R-AI-*)
 *   workspace/growth/remediations.json         켜진 처방 상태(진단기와 공유)
 *   workspace/growth/proposals/<date>-<id>.md  설계서(사람이 정할 것)
 *   텔레그램 요약 1건
 *
 * Usage
 *   node growth-manager.js                       # 오늘(KST)
 *   node growth-manager.js --print-prompt        # 자료집·지시문만 찍고 끝
 *   node growth-manager.js --plan-file plan.json # LLM 대신 주어진 계획으로 (시험용)
 *   node growth-manager.js --dry-run             # LLM 은 부르되 아무것도 쓰지 않는다
 *   node growth-manager.js --force               # 오늘 일지가 있어도 다시 판단
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { kstDate } from './lib/growth-diagnosis.js';
import { buildDossier, loadFacts, loadJSON } from './lib/growth-dossier.js';
import { loadCatalog, emptyState, remedyProgress } from './lib/growth-remediation.js';
import { buildPrompt, validatePlan, applyPlan, journalMarkdown, telegramText } from './lib/growth-manager.js';
import { callClaudeCode, callCodex, resolveChain, runEngineChain } from './lib/text-engine.js';
import { sendTelegramText } from './notify.js';

const ROOT = resolve(import.meta.dirname, '../..');
const GROWTH = join(ROOT, 'workspace', 'growth');

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  const { values } = parseArgs({ options: {
    date: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'print-prompt': { type: 'boolean', default: false },
    'plan-file': { type: 'string' },
    engine: { type: 'string' },
    force: { type: 'boolean', default: false },
  } });
  const now = new Date();
  const date = values.date || kstDate(now.getTime());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid --date');
  // 하루 두 번 판단하면 처방이 하루에 둘 켜져 무엇이 효과였는지 못 가른다
  const writes = !values['dry-run'] && !values['print-prompt'];
  if (writes && !values.force && existsSync(join(GROWTH, 'journal', `${date}.md`))) {
    console.log(`📈 성장 매니저 — ${date} 이미 판단함 (journal/${date}.md). 다시 하려면 --force`);
    return;
  }
  const slots = loadJSON(join(ROOT, 'config', 'routines.json'), {})?.slots ?? {};

  const dossier = buildDossier({ root: ROOT, date, now, slots });
  const { system, user } = buildPrompt(dossier);
  if (values['print-prompt']) {
    console.log(system, '\n\n', user);
    console.log(`\n(지시문 ${system.length}자 · 자료집 ${user.length}자)`);
    return;
  }

  let raw;
  let engine = 'plan-file';
  if (values['plan-file']) {
    raw = JSON.parse(readFileSync(values['plan-file'], 'utf-8'));
  } else {
    const chain = values.engine ? [values.engine] : resolveChain(process.env.BT_GROWTH_MANAGER_CHAIN, 'codex,claude');
    // 러너 안에서 파싱해야 깨진 JSON 도 다음 엔진으로 넘어간다
    const got = await runEngineChain(chain, {
      codex: () => ({ plan: JSON.parse(callCodex(system, user, null, 900)), used: 'codex' }),
      claude: () => ({ plan: JSON.parse(callClaudeCode(system, user, 'sonnet', 900)), used: 'claude-code' }),
    });
    engine = got.engineUsed;
    raw = got.plan;
  }

  const catalog = loadCatalog(ROOT);
  const statePath = join(GROWTH, 'remediations.json');
  const state = loadJSON(statePath, emptyState());
  const dynamicPath = join(GROWTH, 'remedies-dynamic.json');
  const strategyPath = join(GROWTH, 'strategy.json');
  const { videos } = loadFacts(ROOT, now);

  const experiment = loadJSON(join(GROWTH, 'experiments.json'), {})?.current ?? null;
  const { plan, rejected } = validatePlan(raw, { catalog, state, slots, now, experiment });
  const applied = applyPlan(plan, {
    dynamic: loadJSON(dynamicPath, {}), state, strategy: loadJSON(strategyPath, { hypotheses: {}, journal: [] }),
    videos, now, date,
  });
  const merged = { ...catalog, ...applied.dynamic };
  const progress = (applied.state.active ?? []).map((a) => ({
    id: a.remedy, status: a.status, progress: remedyProgress(a, merged[a.remedy], videos, now),
  }));

  console.log(`📈 성장 매니저 — ${date} (${engine})`);
  console.log(`   ${plan.summary}`);
  for (const e of applied.events) console.log(`   → ${e.transition}: ${e.remedy}`);
  for (const p of applied.proposals) console.log(`   📝 설계서: ${p.title}`);
  for (const r of rejected) console.log(`   ✖ 거름: ${r.item ?? '?'} — ${r.reason}`);
  if (values['dry-run']) return;

  mkdirSync(join(GROWTH, 'journal'), { recursive: true });
  mkdirSync(join(GROWTH, 'proposals'), { recursive: true });
  writeAtomic(dynamicPath, `${JSON.stringify(applied.dynamic, null, 2)}\n`);
  writeAtomic(statePath, `${JSON.stringify(applied.state, null, 2)}\n`);
  writeAtomic(strategyPath, `${JSON.stringify(applied.strategy, null, 2)}\n`);
  writeAtomic(join(GROWTH, 'journal', `${date}.md`), journalMarkdown({ date, plan, rejected, events: applied.events, progress, engine }));
  for (const p of applied.proposals) {
    const slug = String(p.id).replace(/[^\w-]+/g, '-');
    writeFileSync(join(GROWTH, 'proposals', `${date}-${slug}.md`),
      `# ${p.title} — ${date}\n\n- 출처: 성장 매니저 (${engine})\n- KPI: ${p.kpi || '—'}\n\n${p.body}\n`);
  }
  for (const e of applied.events) appendFileSync(join(GROWTH, 'remediation-log.jsonl'), `${JSON.stringify(e)}\n`);
  console.log(`✓ workspace/growth/journal/${date}.md`);

  try {
    await sendTelegramText(escapeHtml(telegramText({ date, plan, events: applied.events, proposals: applied.proposals, progress })));
  } catch (e) {
    console.warn(`⚠ 텔레그램 실패: ${e.message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`❌ 성장 매니저 실패: ${e.message}`); process.exit(1); });
}
