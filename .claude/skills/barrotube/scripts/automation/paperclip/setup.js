#!/usr/bin/env node
/**
 * setup.js — config/paperclip/company.json 대로 페이퍼클립 BarroTube 회사를 맞춘다
 *
 * 에이전트(어댑터·모델·지침·깨우기 정책)·프로젝트·목표·루틴(cron)을 코드로 관리한다. UI 에서 손으로 바꾼 값은
 * 다음 --apply 때 정본으로 돌아간다 — 바꿀 거면 company.json 을 고친다.
 *
 * Usage:
 *   node scripts/automation/paperclip/setup.js                # 계획만 (무엇이 바뀔지)
 *   node scripts/automation/paperclip/setup.js --apply        # 적용 — 새 에이전트·루틴은 정지 상태로
 *   node scripts/automation/paperclip/setup.js --activate     # 가동 — 현역 에이전트 재개 + 루틴 active
 *   node scripts/automation/paperclip/setup.js --deactivate   # 되돌림 — 루틴 paused + 현역 에이전트 pause (launchd 복귀 전)
 *
 * 모델 선택(기본·절약·대체)은 토큰 거버너가 정해 workspace/ops/token-state.json 에 남긴다. 여기서는 그 선택을 따른다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { OPS, ROOT, adapterFor as adapterForEnv, api, canon, chosenVariant, comparableAdapterConfig, readJson, runtimeFor, writeJsonAtomic } from './lib.js';

const opt = parseArgs({
  args: import.meta.filename === process.argv[1] ? process.argv.slice(2) : [],
  options: {
    apply: { type: 'boolean', default: false },
    activate: { type: 'boolean', default: false },
    deactivate: { type: 'boolean', default: false },
  },
}).values;
const WRITE = opt.apply || opt.activate || opt.deactivate;
const company = readJson(join(ROOT, 'config', 'paperclip', 'company.json'));
const C = company.company_id;
const IDS_PATH = join(OPS, 'paperclip-ids.json');
const ids = readJson(IDS_PATH, { companyId: C, agents: {}, projects: {}, goals: {}, routines: {} });
ids.companyId = C;
const changes = [];
const note = (s) => { changes.push(s); console.log(`${WRITE ? '✓' : '·'} ${s}`); };

const INSTRUCTIONS_DIR = join(ROOT, 'scripts', 'automation', 'paperclip', 'instructions');
const LEGACY_FILES = ['SOUL.md', 'HEARTBEAT.md', 'TOOLS.md'];

function instructionsFor(spec) {
  const role = readFileSync(join(INSTRUCTIONS_DIR, spec.instructions), 'utf-8');
  if (spec.kind !== 'llm') return role;
  const common = readFileSync(join(INSTRUCTIONS_DIR, '_common.md'), 'utf-8');
  return `${role.trim()}\n\n---\n\n${common.trim()}\n\n<!-- 정본: ${join('scripts/automation/paperclip/instructions', spec.instructions)} + _common.md · setup.js 가 덮어쓴다 -->\n`;
}

const adapterFor = (spec, variant, existing = {}) => adapterForEnv(spec, variant, existing, company.env);
const same = (a, b) => canon(a) === canon(b);

async function ensureAgents(agentsNow) {
  const byId = new Map(agentsNow.map((a) => [a.id, a]));
  const byName = new Map(agentsNow.map((a) => [a.name, a]));
  // 먼저 ID 를 정한다 (reports_to 가 서로를 가리킨다)
  for (const [key, spec] of Object.entries(company.agents)) {
    const found = (spec.id && byId.get(spec.id)) || (ids.agents[key] && byId.get(ids.agents[key])) || byName.get(spec.name);
    if (found) { ids.agents[key] = found.id; continue; }
    note(`에이전트 생성: ${spec.name} (${spec.kind === 'process' ? 'process' : spec.primary.adapterType + ' ' + spec.primary.model})`);
    if (!WRITE) continue;
    // 이 회사는 새 에이전트에 board 승인을 요구한다 — 채용 요청을 내고 board 로서 승인한다.
    const { adapterType, adapterConfig } = adapterFor(spec, 'primary');
    const hire = await api('POST', `/companies/${C}/agent-hires`, {
      name: spec.name, role: spec.role, title: spec.title, adapterType, adapterConfig, runtimeConfig: runtimeFor(spec),
      instructionsBundle: { entryFile: 'AGENTS.md', files: { 'AGENTS.md': instructionsFor(spec) } },
      permissions: { canCreateAgents: false, canCreateSkills: false },
    });
    const created = hire.agent ?? hire;
    const approvalId = hire.approval?.id ?? hire.approvalId ?? null;
    if (approvalId) await api('POST', `/approvals/${approvalId}/approve`, { decisionNote: 'company.json 정본으로 채용 (setup.js)' });
    else if (created.status === 'pending_approval') await api('POST', `/agents/${created.id}/approve`, {});
    ids.agents[key] = created.id;
    await api('POST', `/agents/${created.id}/pause`, {});
    byId.set(created.id, { ...created, status: 'paused', adapterConfig });
  }
  for (const [key, spec] of Object.entries(company.agents)) {
    const id = ids.agents[key];
    if (!id) continue;
    const cur = byId.get(id) ?? (await api('GET', `/agents/${id}`));
    const cfgNow = (await api('GET', `/agents/${id}/configuration`).catch(() => null)) ?? cur;
    const variant = spec.kind === 'llm' ? chosenVariant(key) : null;
    const want = adapterFor(spec, variant, cfgNow.adapterConfig ?? {});
    const patch = {};
    if (cur.name !== spec.name) patch.name = spec.name;
    if (cur.title !== spec.title) patch.title = spec.title;
    if (cur.role !== spec.role) patch.role = spec.role;
    const reportsTo = spec.reports_to ? ids.agents[spec.reports_to] ?? null : null;
    if ((cur.reportsTo ?? null) !== reportsTo) patch.reportsTo = reportsTo;
    if (cfgNow.adapterType !== want.adapterType || comparableAdapterConfig(cfgNow.adapterConfig) !== comparableAdapterConfig(want.adapterConfig)) {
      patch.adapterType = want.adapterType;
      patch.adapterConfig = want.adapterConfig;
      patch.replaceAdapterConfig = true;
    }
    if (!same(cfgNow.runtimeConfig?.heartbeat ?? {}, runtimeFor(spec).heartbeat)) patch.runtimeConfig = runtimeFor(spec);
    if (Object.keys(patch).length) {
      note(`에이전트 갱신: ${spec.name} — ${Object.keys(patch).filter((k) => k !== 'replaceAdapterConfig').join(', ')}${patch.adapterConfig ? ` → ${want.adapterType} ${want.adapterConfig.model ?? want.adapterConfig.args?.at(-1) ?? ''}` : ''}`);
      if (WRITE) await api('PATCH', `/agents/${id}`, patch);
    }
    if (WRITE) await syncInstructions(id, spec);
    if (WRITE) await api('PATCH', `/agents/${id}/permissions`, { canCreateAgents: false, canCreateSkills: false }).catch(() => {});
  }
}

async function syncInstructions(id, spec) {
  const content = instructionsFor(spec);
  let current = null;
  try { current = await api('GET', `/agents/${id}/instructions-bundle/file?path=AGENTS.md`); } catch {}
  if ((current?.content ?? '') !== content) {
    // 관리형 번들은 compare-and-swap 이다 — 방금 읽은 판을 기준으로만 덮어쓴다.
    await api('PUT', `/agents/${id}/instructions-bundle/file`, {
      path: 'AGENTS.md', content, clearLegacyPromptTemplate: true,
      baseRevisionId: current?.revision?.id ?? null, baseHash: current?.contentHash ?? null,
    });
    note(`지침 갱신: ${spec.name} AGENTS.md (${content.length}자)`);
  }
  // 옛 체제의 SOUL/HEARTBEAT/TOOLS 는 지금 구조와 어긋난다(13명 팀이 단계마다 일한다는 서술). 번들 이력에는 남는다.
  for (const f of LEGACY_FILES) {
    let old = null;
    try { old = await api('GET', `/agents/${id}/instructions-bundle/file?path=${f}`); } catch { continue; }
    try {
      await api('DELETE', `/agents/${id}/instructions-bundle/file?path=${f}&baseHash=${old.contentHash}`);
      note(`옛 지침 제거: ${spec.name} ${f}`);
    } catch (e) { console.error(`⚠ ${spec.name} ${f} 제거 실패: ${e.message}`); }
  }
}

async function retire(agentsNow) {
  const { ids: retiredIds, title_prefix: prefix } = company.retired;
  for (const id of retiredIds) {
    const a = agentsNow.find((x) => x.id === id);
    if (!a) continue;
    if (a.status !== 'paused' && a.status !== 'terminated') { note(`휴면: ${a.name} pause`); if (WRITE) await api('POST', `/agents/${id}/pause`, {}); }
    if (!String(a.title ?? '').startsWith(prefix)) {
      const title = `${prefix}${a.title ?? a.name} — 단계는 auto-pipeline.sh 가 결정론으로 수행`.slice(0, 200);
      note(`휴면 표시: ${a.name}`);
      if (WRITE) await api('PATCH', `/agents/${id}`, { title });
    }
  }
}

async function ensureProjects() {
  const list = await api('GET', `/companies/${C}/projects`);
  const items = Array.isArray(list) ? list : list.items ?? [];
  for (const [key, p] of Object.entries(company.projects)) {
    let found = (ids.projects[key] && items.find((x) => x.id === ids.projects[key])) || items.find((x) => x.name === p.name);
    const lead = ids.agents[p.lead] ?? null;
    if (!found) {
      note(`프로젝트 생성: ${p.name}`);
      if (!WRITE) continue;
      found = await api('POST', `/companies/${C}/projects`, { name: p.name, status: 'in_progress', leadAgentId: lead, color: p.color, icon: p.icon });
    } else if (found.leadAgentId !== lead || found.status !== 'in_progress') {
      note(`프로젝트 갱신: ${p.name}`);
      if (WRITE) await api('PATCH', `/projects/${found.id}`, { leadAgentId: lead, status: 'in_progress', color: p.color, icon: p.icon });
    }
    ids.projects[key] = found.id;
    // 프로젝트 작업 폴더는 두지 않는다. 페이퍼클립은 프로젝트에 묶인 이슈를 에이전트 cwd 가 아니라 프로젝트 폴더에서
    // 깨우는데(없으면 관리 폴더 _default), 폴더를 지정하면 claude_local·codex_local 은 그 폴더가 git 체크아웃이어야
    // 돈다(missing_git_metadata — 2026-10-19 CMO 실행 실패로 실측, 바로 되돌렸다). growth·ops/repairs 는 git 밖이다.
    // 그래서 Codex 는 자기 cwd 를 writable_roots 로 받고(adapterFor), 지침은 $BT 절대 경로로 쓴다.
  }
}

/** 조직도 머리에 보이는 회사 소개. 4~5월 체제 문구(「13개 전문 에이전트가 …」)가 남아 있었다. */
async function ensureCompany() {
  if (!company.description) return;
  const cur = await api('GET', `/companies/${C}`);
  if (cur.description === company.description) return;
  note('회사 소개 갱신');
  if (WRITE) await api('PATCH', `/companies/${C}`, { description: company.description });
}

async function ensureGoals() {
  const list = await api('GET', `/companies/${C}/goals`);
  const items = Array.isArray(list) ? list : list.items ?? [];
  const order = Object.entries(company.goals).sort(([, a], [, b]) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0));
  for (const [key, g] of order) {
    let found = ids.goals[key] && items.find((x) => x.id === ids.goals[key]);
    const body = { level: g.level, status: 'active', parentId: g.parent ? ids.goals[g.parent] ?? null : null, ownerAgentId: ids.agents[g.owner] ?? null };
    if (!found) {
      found = items.find((x) => x.title === g.title || x.title.startsWith(g.title.split(' — ')[0]));
    }
    if (!found) {
      note(`목표 생성: ${g.title}`);
      if (!WRITE) continue;
      found = await api('POST', `/companies/${C}/goals`, { title: g.title, ...body });
    } else if (found.level !== body.level || found.parentId !== body.parentId || found.ownerAgentId !== body.ownerAgentId || found.status !== 'active') {
      // 제목은 kpi-sync 가 현재값을 붙여 바꾸므로 여기서 덮지 않는다.
      note(`목표 갱신: ${g.title}`);
      if (WRITE) await api('PATCH', `/goals/${found.id}`, body);
    }
    ids.goals[key] = found.id;
  }
}

export function routineDescription(r, actions) {
  if (r.action) {
    const spec = actions[r.action] ?? {};
    return [
      `action: ${r.action}`,
      '',
      `${spec.label ?? r.title} — 결정론 실행 (process 에이전트, 토큰 0).`,
      `명령: \`${(spec.cmd ?? []).join(' ')}\` · 로그: \`logs/cron/${spec.log}.log\``,
      '정본: config/paperclip/company.json (편성) · config/paperclip/actions.json (허용 목록)',
    ].join('\n');
  }
  return r.description;
}

async function ensureRoutines(status) {
  const actions = readJson(join(ROOT, 'config', 'paperclip', 'actions.json')).actions;
  const list = await api('GET', `/companies/${C}/routines`);
  for (const r of company.routines) {
    let found = (ids.routines[r.key] && list.find((x) => x.id === ids.routines[r.key])) || list.find((x) => x.title === r.title);
    const body = {
      title: r.title,
      description: routineDescription(r, actions),
      assigneeAgentId: ids.agents[r.agent] ?? null,
      projectId: ids.projects[r.project] ?? null,
      goalId: ids.goals[r.goal] ?? null,
      priority: r.priority,
      concurrencyPolicy: r.concurrency,
      catchUpPolicy: 'skip_missed',
    };
    if (!found) {
      note(`루틴 생성: ${r.title} [${r.crons.join(' | ')}] → ${r.agent}`);
      if (!WRITE) continue;
      found = await api('POST', `/companies/${C}/routines`, { ...body, status: 'paused' });
      found.triggers = [];
    } else {
      const drift = ['title', 'assigneeAgentId', 'projectId', 'goalId', 'priority', 'concurrencyPolicy', 'catchUpPolicy', 'description']
        .filter((k) => (found[k] ?? null) !== (body[k] ?? null));
      if (drift.length) {
        note(`루틴 갱신: ${r.title} — ${drift.join(', ')}`);
        if (WRITE) await api('PATCH', `/routines/${found.id}`, body);
      }
    }
    ids.routines[r.key] = found.id;
    const triggers = (found.triggers ?? []).filter((t) => t.kind === 'schedule' && !t.archived);
    for (const cron of r.crons) {
      if (triggers.some((t) => t.cronExpression === cron && t.timezone === company.timezone)) continue;
      note(`  트리거 추가: ${r.title} ${cron}`);
      if (WRITE) await api('POST', `/routines/${found.id}/triggers`, { kind: 'schedule', cronExpression: cron, timezone: company.timezone, label: `${cron} KST`, enabled: true });
    }
    for (const t of triggers) {
      if (r.crons.includes(t.cronExpression) && t.timezone === company.timezone) continue;
      note(`  트리거 보관: ${r.title} ${t.cronExpression}`);
      if (WRITE) await api('PATCH', `/routine-triggers/${t.id}`, { archived: true, enabled: false });
    }
    if (status && found.status !== status) {
      note(`루틴 ${status}: ${r.title}`);
      if (WRITE) await api('PATCH', `/routines/${found.id}`, { status });
    }
  }
}

async function setActiveAgents(resume) {
  for (const [key, spec] of Object.entries(company.agents)) {
    const id = ids.agents[key];
    if (!id) continue;
    const a = await api('GET', `/agents/${id}`);
    if (resume && a.status === 'paused') { note(`재개: ${spec.name}`); await api('POST', `/agents/${id}/resume`, {}); }
    if (!resume && a.status !== 'paused') { note(`일시정지: ${spec.name}`); await api('POST', `/agents/${id}/pause`, {}); }
  }
}

async function main() {
  const agentsNow = await api('GET', `/companies/${C}/agents`);
  if (opt.deactivate) {
    await ensureRoutines('paused');
    await setActiveAgents(false);
  } else {
    await ensureCompany();
    await ensureAgents(Array.isArray(agentsNow) ? agentsNow : agentsNow.items ?? []);
    await retire(Array.isArray(agentsNow) ? agentsNow : agentsNow.items ?? []);
    await ensureProjects();
    await ensureGoals();
    await ensureRoutines(opt.activate ? 'active' : null);
    if (opt.activate) await setActiveAgents(true);
  }
  // 가동 플래그 — 토큰 거버너는 이게 true 일 때만 에이전트·루틴을 조절한다.
  if (opt.activate) ids.activated = true;
  if (opt.deactivate) ids.activated = false;
  if (WRITE) writeJsonAtomic(IDS_PATH, { ...ids, updatedAt: new Date().toISOString() });
  console.log(`\n${WRITE ? '적용' : '계획'} ${changes.length}건${WRITE ? ` · ID 지도 ${IDS_PATH}` : ' — 적용하려면 --apply'}`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((e) => { console.error(`❌ setup: ${e.stack || e.message}`); process.exit(1); });
}
