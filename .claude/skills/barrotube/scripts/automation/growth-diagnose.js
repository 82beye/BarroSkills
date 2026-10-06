#!/usr/bin/env node

/**
 * growth-diagnose.js — 성장 루프의 [진단·처방 적용] 단계
 *
 * KPI 가 RED·YELLOW 일 때 원인을 최근 발행분에서 찾고(lib/growth-diagnosis.js),
 * 처방을 켜거나 효과를 판정한다(lib/growth-remediation.js). 전부 결정론 — LLM 0회, 네트워크 0회.
 *
 * 입력:
 *   workspace/growth/kpi/<date>.json · workspace/growth/channel/videos.json
 *   lib/growth-dossier.js loadFacts() — 영상·에피소드·감사 로그(성장 매니저와 같은 사실)
 *   config/routines.json · config/growth.json(remedies) + workspace/growth/remedies-dynamic.json
 *   workspace/growth/remediations.json (런타임 상태)
 * 산출:
 *   workspace/growth/diagnosis/<date>.{json,md}   진단서
 *   workspace/growth/proposals/<date>-<id>.md     propose 처방의 설계서 (새로 알릴 때만)
 *   workspace/growth/remediations.json            처방 상태 (켜짐·유지·되돌림)
 *   workspace/growth/remediation-log.jsonl        상태 전이 기록 (append-only)
 *   표준출력 마지막 줄 DIAG=<텔레그램 한 줄>
 *
 * 켜진 처방은 growth-directives.js(지시문 맨 위)와 generate-script.js·generate-summary-script.js
 * (마무리 문장)가 읽어 다음 회차부터 반영한다.
 *
 * Usage:
 *   node growth-diagnose.js --date 2026-10-06
 *   node growth-diagnose.js --date 2026-10-06 --dry-run    # 진단만 찍고 아무것도 쓰지 않는다
 */

import { writeFileSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { diagnose, kstDate, STAGE_CODE } from './lib/growth-diagnosis.js';
import { planRemediation, emptyState, loadCatalog } from './lib/growth-remediation.js';
import { loadJSON, loadFacts } from './lib/growth-dossier.js';

const ROOT = resolve(import.meta.dirname, '../..');
const GROWTH = join(ROOT, 'workspace', 'growth');

// 반복 장애 설계서가 가리킬 코드. 단계 이름의 앞부분("Phase 5")으로 찾는다.
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const MODE_LABEL = { auto: '자동 적용', propose: '설계서', notify: '알림' };

function proposalMarkdown(date, item) {
  const f = item.finding;
  const stage = String(f.id).match(/(Phase \d+)/)?.[1];
  const lines = [
    `# ${item.def.label} — ${date}`, '',
    `- 진단: ${f.summary}`,
    `- KPI: ${f.kpi} (${f.grade})`,
    `- 처방: ${item.remedy} · ${MODE_LABEL[item.def.mode] ?? item.def.mode}`, '',
    '## 무엇을 하나', '', item.def.proposal ?? '', '',
  ];
  if (stage && STAGE_CODE[stage]) lines.push('## 볼 코드', '', `- ${STAGE_CODE[stage]}`, `- 로그: logs/cron/<slot>.log · logs/audit/<날짜>.jsonl`, '');
  lines.push('## 근거', '', '```json', JSON.stringify(f.evidence, null, 2).slice(0, 6000), '```', '');
  return lines.join('\n');
}

function diagnosisMarkdown(date, kpi, findings, plan, active) {
  const lines = [`# KPI 진단 — ${date}`, '', `KPI 전체 ${kpi?.overall ?? '—'} · 진단 ${findings.length}건`, ''];
  if (active.length) {
    lines.push('## 켜져 있는 자동 처방', '');
    for (const a of active) {
      const b = a.baseline?.value != null ? ` · 기준 ${(a.baseline.value * 100).toFixed(2)}%(${a.baseline.episodes}편)` : '';
      lines.push(`- ${a.remedy} (${a.status}, ${a.started_at.slice(0, 10)}~)${b} — ${a.reason ?? ''}`);
    }
    lines.push('');
  }
  lines.push('## 진단', '');
  if (!findings.length) lines.push('- 원인으로 지목할 것이 없다 (KPI 가 GREEN 이거나 표본 부족).');
  for (const f of findings) lines.push(`- **${f.id}** [${f.grade}] ${f.summary} → ${f.remedy}`);
  if (plan.events.length) {
    lines.push('', '## 이번 회차 상태 변화', '');
    for (const e of plan.events) lines.push(`- ${e.remedy}: ${e.transition}${e.lift ? ` (lift ${e.lift.toFixed(2)}×)` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

function summaryLine(date, plan, findings) {
  const by = (kind) => plan.outbox.filter((o) => o.kind === kind);
  const parts = [];
  for (const o of by('adopted')) parts.push(`처방 유지: ${o.def.label} (${o.lift.toFixed(2)}×)`);
  for (const o of by('reverted')) parts.push(`처방 되돌림: ${o.def.label} (${o.lift.toFixed(2)}×)`);
  for (const o of by('stale')) parts.push(`처방 내림(3주간 받은 회차 0편 — 적용 경로 확인): ${o.def.label}`);
  if (by('applied').length) parts.push(`자동 처방 적용: ${by('applied').map((o) => o.def.label).join(', ')}`);
  if (by('propose').length) parts.push(`설계서 ${by('propose').length}건: ${by('propose').map((o) => o.def.label).join(', ')}`);
  if (by('notify').length) parts.push(`알림: ${by('notify').map((o) => o.finding.summary).join(' / ')}`);
  if (!parts.length) return '';
  return `🩹 진단 ${findings.length}건 · ${parts.join(' · ')} — growth/diagnosis/${date}.md`;
}

function main() {
  const { values } = parseArgs({ options: { date: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  const now = new Date();
  const date = values.date || kstDate(now.getTime());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid --date');

  // 고정 처방 + 성장 매니저 처방(R-AI-*). 누가 설계했든 판정은 같은 자로 한다.
  const catalog = loadCatalog(ROOT);
  const slots = loadJSON(join(ROOT, 'config', 'routines.json'), {})?.slots ?? {};
  const kpi = loadJSON(join(GROWTH, 'kpi', `${date}.json`));
  if (!kpi) {
    console.log(`⏭  KPI 스코어카드 없음(${date}) — 진단 건너뜀`);
    console.log('DIAG=');
    return;
  }
  // 영상에는 슬롯이 붙어 나온다 — 슬롯 범위가 있는 처방의 효과를 그 슬롯 영상으로만 잰다.
  const { videos, audit, episodes, cancelled } = loadFacts(ROOT, now);
  const statePath = join(GROWTH, 'remediations.json');
  const state = loadJSON(statePath, emptyState());

  const findings = diagnose({ kpi, slots, audit, cancelled, resolved: state.resolved ?? [], videos, episodes, now });
  const plan = planRemediation({ findings, state, catalog, videos, now });
  const active = plan.state.active;

  for (const f of findings) console.log(`  · [${f.grade}] ${f.id} — ${f.summary} → ${f.remedy}`);
  for (const o of plan.outbox) console.log(`  → ${o.kind}: ${o.remedy} (${o.def.label})`);

  if (!values['dry-run']) {
    mkdirSync(join(GROWTH, 'diagnosis'), { recursive: true });
    mkdirSync(join(GROWTH, 'proposals'), { recursive: true });
    writeAtomic(join(GROWTH, 'diagnosis', `${date}.json`), `${JSON.stringify({
      date, generated_at: now.toISOString(), kpi_overall: kpi.overall, findings,
      outbox: plan.outbox.map((o) => ({ kind: o.kind, remedy: o.remedy, finding: o.finding?.id ?? null })),
      active,
    }, null, 2)}\n`);
    writeAtomic(join(GROWTH, 'diagnosis', `${date}.md`), diagnosisMarkdown(date, kpi, findings, plan, active));
    for (const o of plan.outbox.filter((x) => x.kind === 'propose')) {
      const slug = String(o.finding.id).replace(/[^\w가-힣-]+/g, '-').replace(/-+$/, '');
      writeFileSync(join(GROWTH, 'proposals', `${date}-${slug}.md`), proposalMarkdown(date, o));
    }
    writeAtomic(statePath, `${JSON.stringify(plan.state, null, 2)}\n`);
    for (const e of plan.events) appendFileSync(join(GROWTH, 'remediation-log.jsonl'), `${JSON.stringify(e)}\n`);
    console.log(`✓ workspace/growth/diagnosis/${date}.md · 처방 ${active.length}개 켜짐`);
  }
  console.log(`DIAG=${summaryLine(date, plan, findings)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
