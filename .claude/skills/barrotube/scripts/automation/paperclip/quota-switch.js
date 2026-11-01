import { writeFileSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { api, loadCompany, paperclipIds, ROOT } from './lib.js';
import { estimateCostUsd, routingFor, routingEnvText } from './token-governor.js';
import { normalizeQuota, modelEstimates, assessCandidate } from './quota-reserve-policy.js';
import { readRuntimeQuota, cleanHostEnvironment } from './quota-cli-identity.js';
import { retryGuardRun } from './quota-retry.js';
import { QUOTA_DIR, SWITCH_STATE, read, atomicWrite, withLock, reconcileReservations } from './quota-admission.js';
import { PLAN_CONTRACT, loadPlan, ladderFor, holdFor, seedColdStart, pickRung } from './quota-plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(QUOTA_DIR, 'quota-switch-baselines.json');
const family = a => ({ claude_local: 'claude', codex_local: 'codex' })[a.adapterType];
const providerName = f => f === 'claude' ? 'anthropic' : 'openai';
const ACTIVE = new Set(['running', 'queued', 'scheduled_retry']);
export function runningReservationsFor(runs, inventory, estimates) {
  // Waiting runs reserve atomically in the CLI wrapper when they actually start.
  return runs.filter(r => r.status === 'running').map(r => {
    const a = inventory.find(a => a.id === r.agentId);
    const provider = r.usageJson?.provider === 'openai' ? 'codex' : r.usageJson?.provider === 'anthropic' ? 'claude' : family(a || {});
    const model = r.usageJson?.model || a?.adapterConfig?.model || 'unknown';
    return { id: r.id, runId: r.id, provider, model, percent: estimates[provider]?.models?.[model]?.percentBudget || Math.max(5, estimates[provider]?.maxBudgetPercent || 0), status: 'running' };
  }).filter(r => r.provider);
}

export function profilesFor(agent) {
  const routine = ['metadata-writer', 'publisher', 'asset-manager', 'image-artist', 'voice-engineer', 'video-composer'].includes(agent.role);
  const economy = routine || ['writer', 'researcher', 'strategist', 'cmo'].includes(agent.role) || agent.name === 'Content Manager';
  const effort = routine ? 'low' : 'medium';
  const codex = { provider: 'codex', model: economy ? 'gpt-6-luna' : 'gpt-6.1-sol', effort };
  const claude = { provider: 'claude', model: routine ? 'claude-haiku-4-5' : 'claude-sonnet-5-5', effort };
  return family(agent) === 'claude' ? [claude, codex] : [codex, claude];
}

export function configFor(agent, selected) {
  const changing = family(agent) !== selected.provider;
  const cfg = { ...agent.adapterConfig };
  // Secret env values stay server-side; the PATCH route preserves them on adapter changes.
  delete cfg.env;
  for (const key of ['effort', 'modelReasoningEffort', 'maxTurnsPerRun', 'dangerouslySkipPermissions', 'dangerouslyBypassApprovalsAndSandbox', 'extraArgs']) delete cfg[key];
  Object.assign(cfg, { engine: 'cli', command: join(HERE, 'quota-bin', selected.provider), model: selected.model });
  if (selected.provider === 'claude') {
    cfg.effort = selected.effort || agent.adapterConfig.effort || 'medium';
    cfg.maxTurnsPerRun = agent.adapterConfig.maxTurnsPerRun || 40;
    cfg.dangerouslySkipPermissions = changing ? Boolean(agent.adapterConfig.dangerouslyBypassApprovalsAndSandbox) : Boolean(agent.adapterConfig.dangerouslySkipPermissions);
    if (!changing && agent.adapterConfig.extraArgs) cfg.extraArgs = agent.adapterConfig.extraArgs;
  } else {
    cfg.modelReasoningEffort = selected.effort || agent.adapterConfig.modelReasoningEffort || 'medium';
    cfg.dangerouslyBypassApprovalsAndSandbox = changing ? Boolean(agent.adapterConfig.dangerouslySkipPermissions) : Boolean(agent.adapterConfig.dangerouslyBypassApprovalsAndSandbox);
    // Managed bindings reject user-supplied -c overrides. The native adapter
    // supplies its own shell environment policy; keep the quota wrapper intact.
    cfg.extraArgs = changing
      ? (agent.runtimeConfig?.aiConnection ? ['--skip-git-repo-check'] : ['--skip-git-repo-check', '-c', 'shell_environment_policy.inherit="all"'])
      : agent.adapterConfig.extraArgs || [];
  }
  const body = { adapterType: selected.provider === 'claude' ? 'claude_local' : 'codex_local', adapterConfig: cfg };
  if (changing) body.replaceAdapterConfig = true;
  const runtime = structuredClone(agent.runtimeConfig || {});
  runtime.heartbeat = { ...runtime.heartbeat, maxConcurrentRuns: 1 };
  if (runtime.aiConnection && changing) runtime.aiConnection = { mode: 'responsible_user', provider: providerName(selected.provider), method: 'subscription' };
  body.runtimeConfig = runtime;
  return body;
}

export function selectProfile(agent, profiles, providers, estimates, reservations, now) {
  const candidates = profiles.map(p => {
    const assessment = assessCandidate({ ...p, providers, estimates, reservations, now });
    const reset = Date.parse(providers[p.provider]?.weekResetAt);
    const daysUntilReset = Number.isFinite(reset) && reset > now ? (reset - now) / 86_400_000 : null;
    const dailyBudgetPercent = assessment.allow
      ? Math.max(0, assessment.admissionLimitPercent - assessment.usedPercent - assessment.pendingPercent) / Math.max(0.25, daysUntilReset ?? 7) : 0;
    return { ...p, ...assessment, daysUntilReset, dailyBudgetPercent,
      dailyShareEstimate: dailyBudgetPercent > 0 ? assessment.modelBudgetPercent / dailyBudgetPercent : null };
  });
  // Reviewer author-family separation survives provider pressure and weekly resets.
  const reviewer = ['qa', 'qa-reviewer', 'fact-checker'].includes(agent.role);
  const eligible = candidates.filter(p => p.allow && (!reviewer || p.provider === profiles[0].provider));
  eligible.sort((a, b) => a.dailyShareEstimate - b.dailyShareEstimate);
  return { selected: eligible[0] || null, candidates };
}

const REVIEWER_ROLES = new Set(['qa', 'qa-reviewer', 'fact-checker']);
const SWITCH_COOLDOWN_MS = 60 * 60_000;

// Switching provider resets every session and reinstalls connections, while the
// in-flight reservations that move the admission math change minute to minute.
// Keep the current provider unless its weekly/session quota is genuinely spent,
// and switch at most once an hour (2026-10-28: 10 agents flipped within minutes,
// each flip wrote a revision and reset the next run's session).
export function stickySelection(agent, result, record = {}, now = Date.now(), home = family(agent)) {
  const current = result.candidates.find((c) => c.provider === home);
  if (!current) return { ...result, sticky: 'no-home-candidate' };
  if (current.allow) return { ...result, selected: current, sticky: 'current-admissible' };
  const usageOnly = [current.usedPercent, current.modelBudgetPercent, current.admissionLimitPercent].every(Number.isFinite)
    ? current.usedPercent + current.modelBudgetPercent > current.admissionLimitPercent : null;
  // Only in-flight reservations block it: the wrapper postpones single runs.
  if (usageOnly === false) return { ...result, selected: current, sticky: 'in-flight-reservations' };
  // No fresh measurement is not exhaustion; switching would not be safer.
  if (/unavailable-or-stale/.test(current.reason || '')) return { ...result, selected: null, sticky: 'measurement-unavailable' };
  const other = result.selected && result.selected.provider !== home ? result.selected : null;
  if (!other) return { ...result, selected: null, sticky: 'no-admissible-provider' };
  const last = Date.parse(record.lastSwitchAt);
  if (Number.isFinite(last) && now - last < SWITCH_COOLDOWN_MS) return { ...result, selected: null, sticky: 'switch-cooldown' };
  return { ...result, selected: other, sticky: 'home-exhausted' };
}

async function installConnection(agent, selected, connections) {
  if (!agent.runtimeConfig?.aiConnection || family(agent) === selected.provider) return;
  const connection = connections.find(c => c.provider === providerName(selected.provider) && c.isDefault && c.method === 'subscription' && c.status === 'connected');
  if (!connection) throw new Error(`${selected.provider}: company subscription connection is not available`);
  const path = `/tool-connections/${connection.id}/installs`;
  const prior = await api('GET', path, undefined, { auth: false });
  const installs = prior.installs || prior;
  if (installs.some(x => x.targetType === 'company' && x.targetId === agent.companyId || x.targetType === 'agent' && x.targetId === agent.id)) return;
  await api('PUT', path, { installs: [...installs.map(({ targetType, targetId }) => ({ targetType, targetId })), { targetType: 'agent', targetId: agent.id }] }, { auth: false });
}

export async function governAll({ dryRun = false } = {}) {
  try { return await withLock(join(QUOTA_DIR, 'quota-switch.lock'), () => runGovernor({ dryRun })); }
  catch (e) { if (/busy|initializing/.test(e.message)) return { skipped: 'controller already running' }; throw e; }
}

async function runGovernor({ dryRun }) {
  let now = Date.now();
  const before = read(SWITCH_STATE, { agents: {} });
  const baselines = read(BASELINES, { agents: {} });
  const companies = (await api('GET', '/companies', undefined, { auth: false })).filter(c => c.status === 'active');
  const inventory = [], runs = [], connections = {};
  for (const c of companies) {
    const [agents, history, accounts] = await Promise.all([
      api('GET', `/companies/${c.id}/agents`, undefined, { auth: false }),
      api('GET', `/companies/${c.id}/heartbeat-runs?limit=500`, undefined, { auth: false }),
      api('GET', `/companies/${c.id}/ai-connections`, undefined, { auth: false }),
    ]);
    inventory.push(...agents.filter(a => family(a) && a.status !== 'terminated'));
    runs.push(...(Array.isArray(history) ? history : history.items || []));
    connections[c.id] = accounts.connections || [];
  }
  const hostEnv = cleanHostEnvironment(process.env);
  const evidence = {};
  for (const f of ['claude', 'codex']) {
    try { evidence[f] = await readRuntimeQuota(f, hostEnv); }
    catch { evidence[f] = { ok: false, reason: 'Host subscription quota unavailable' }; }
  }
  const quota = Object.values(evidence).flatMap(e => e.quota || []);
  now = Date.now();
  const snapshot = read(join(userInfo().homedir, '.claude/usage-snapshot.json'), null);
  const providers = normalizeQuota(quota, { now, claudeSnapshot: snapshot, accountEvidence: Object.fromEntries(Object.entries(evidence).map(([f,e]) => [f, { measuredAt: e.measuredAt || new Date(now).toISOString() }])) });
  const estimates = seedColdStart(modelEstimates(runs, { now }));
  const reconciliation = dryRun ? null : await reconcileReservations({ getRun: id => api('GET', `/heartbeat-runs/${id}`, undefined, { auth: false }), now });
  const active = runs.filter(r => ACTIVE.has(r.status));
  const runningReservations = runningReservationsFor(runs, inventory, estimates);
  const next = { enabled: true, updatedAt: new Date(now).toISOString(), reservePercent: 30, safetyBufferPercent: 5, providers, estimates, runningReservations, agents: {}, admissionHolds: {}, companies: companies.map(c => ({ id: c.id, name: c.name })), evidence: Object.fromEntries(Object.entries(evidence).map(([f,e]) => [f, { ok: e.ok, identityHash: e.identityHash, reason: e.reason }])) };
  // barrojo 의 모델 배분 계획(있으면). shadow 는 고를 칸만 기록하고, applied 일 때만 선택을 바꾼다.
  const planLoad = loadPlan({ now, lastRev: ['applied', 'shadow'].includes(before.plan?.status) ? before.plan?.rev : null });
  next.plan = { status: planLoad.status, rev: planLoad.plan?.rev ?? null, day: planLoad.plan?.day ?? null, generatedAt: planLoad.plan?.generatedAt ?? null, error: planLoad.error };
  next.planContract = PLAN_CONTRACT;
  for (const a of inventory) {
    if (!baselines.agents[a.id]) baselines.agents[a.id] = { companyId: a.companyId, name: a.name, original: a };
    baselines.agents[a.id].profiles = profilesFor({ ...baselines.agents[a.id].original, role: a.role, name: a.name });
  }
  if (!dryRun) { atomicWrite(BASELINES, baselines); atomicWrite(SWITCH_STATE, { ...next, agents: before.agents || {} }); }
  const actions = [];
  const tubeIds = paperclipIds(), tube = loadCompany();
  const policy = read(join(ROOT, 'config/paperclip/token-policy.json'));
  const dayStart = Date.parse(new Date(now + 9 * 3_600_000).toISOString().slice(0, 10) + 'T00:00:00+09:00');
  for (const initial of inventory) {
    const baseline = baselines.agents[initial.id];
    const was = before.agents?.[initial.id] || {};
    const record = { name: initial.name, companyId: initial.companyId, ...was, updatedAt: new Date(now).toISOString() };
    next.agents[initial.id] = record;
    if (initial.status === 'paused' && !was.pausedBy) {
      const profile = baseline.profiles.find(p => p.provider === family(initial));
      const effort = initial.adapterConfig.effort || initial.adapterConfig.modelReasoningEffort;
      if (!dryRun && profile && (initial.adapterConfig.model !== profile.model || effort !== profile.effort)) {
        await api('PATCH', `/agents/${initial.id}`, configFor(initial, profile), { auth: false });
        actions.push(`${initial.name}: paused configuration ${profile.provider}/${profile.model}/${profile.effort}`);
      }
      record.action = 'manual-pause'; record.reason = 'manual pause preserved'; continue;
    }
    if (was.pausedBy && initial.status === 'paused' && was.pausedUpdatedAt && initial.updatedAt !== was.pausedUpdatedAt) { delete record.pausedBy; record.reason = 'manual change preserved'; continue; }
    const home = REVIEWER_ROLES.has(initial.role) ? family(baseline.original) || family(initial) : family(initial);
    let result = stickySelection(initial, selectProfile(initial, baseline.profiles, providers, estimates, runningReservations, now), was, now, home);
    const planned = planLoad.plan && ['applied', 'shadow'].includes(planLoad.status)
      ? ladderFor(planLoad.plan, initial, { reviewerFamily: REVIEWER_ROLES.has(initial.role) ? home : null }) : null;
    delete record.planShadow;
    if (planned) {
      const current = { provider: family(initial), model: initial.adapterConfig?.model, effort: initial.adapterConfig?.effort || initial.adapterConfig?.modelReasoningEffort };
      const pick = pickRung(current, home, planned, (r) => assessCandidate({ ...r, providers, estimates, reservations: runningReservations, now }), was, now);
      if (planLoad.status === 'applied') result = pick;
      else record.planShadow = { provider: pick.selected?.provider ?? null, model: pick.selected?.model ?? null, effort: pick.selected?.effort ?? null, why: pick.sticky };
    }
    const planHold = planLoad.status === 'applied' ? holdFor(planLoad.plan, initial, now) : null;
    if (planHold) next.admissionHolds[initial.id] = planHold;
    const tubeKey = Object.keys(tubeIds?.agents || {}).find(key => tubeIds.agents[key] === initial.id);
    const cap = tube.agents[tubeKey]?.daily_cost_cap_usd;
    const spent = runs.filter(r => r.agentId === initial.id && Date.parse(r.createdAt) >= dayStart).reduce((sum, r) => sum + (r.usageJson?.cacheAdjustedCostUsd ?? r.usageJson?.costUsd ?? estimateCostUsd(r.usageJson || {}, policy.cost_estimate_per_mtok?.codex)), 0);
    delete record.dailyCapHit;
    // 2026-10-28 operator: CEOs stop only for the subscription week, so barrojo can
    // always wake them for decisions. Other daily caps now hold at admission.
    const managerless = !initial.reportsTo;
    if (cap && spent >= cap && !managerless) {
      result.selected = null; record.dailyCapHit = true;
      next.admissionHolds[initial.id] = { until: new Date(dayStart + 86_400_000 + 60_000).toISOString(), reason: `daily operational cost cap (${spent.toFixed(2)} >= ${cap} USD estimate)` };
    }
    record.sticky = result.sticky;
    record.candidates = result.candidates; record.selected = result.selected && { provider: result.selected.provider, model: result.selected.model, effort: result.selected.effort, percentBudget: result.selected.modelBudgetPercent };
    if (dryRun) { record.action = result.selected ? 'configure' : 'quota-wait'; continue; }
    let agent = await api('GET', `/agents/${initial.id}`, undefined, { auth: false });
    if (agent.status === 'paused' && (!record.pausedBy || record.pausedUpdatedAt && agent.updatedAt !== record.pausedUpdatedAt)) { delete record.pausedBy; record.action = 'manual-pause'; continue; }
    try {
      // Wakes are never switched off any more: Paperclip cancelled due retries and
      // dropped blocker/recovery wakes while they were off, stranding issues as
      // board-blocked. Quota waits are postponed per run by quota-cli instead.
      if (record.heldHeartbeat) {
        const heartbeat = agent.runtimeConfig?.heartbeat || {};
        if (heartbeat.enabled === false && heartbeat.wakeOnDemand === false) {
          agent = await api('PATCH', `/agents/${agent.id}`, { runtimeConfig: { ...agent.runtimeConfig, heartbeat: { ...heartbeat, ...record.heldHeartbeat } } }, { auth: false });
          actions.push(`${agent.name}: wakes restored`);
        }
        delete record.heldHeartbeat;
      }
      // Install the current adapter's gate first, including for the next run of a busy agent.
      const gate = configFor(agent, { provider: family(agent), model: agent.adapterConfig.model || baseline.profiles[0].model });
      if (agent.adapterConfig.command !== gate.adapterConfig.command || agent.adapterConfig.engine !== 'cli' || agent.runtimeConfig?.heartbeat?.maxConcurrentRuns !== 1) {
        agent = await api('PATCH', `/agents/${agent.id}`, gate, { auth: false });
      }
      const live = await api('GET', `/companies/${agent.companyId}/heartbeat-runs?agentId=${agent.id}&summary=true`, undefined, { auth: false });
      if (agent.status === 'running' || active.some(r => r.agentId === agent.id) || (Array.isArray(live) ? live : live.items || []).some(r => r.agentId === agent.id && ACTIVE.has(r.status))) {
        record.action = 'wait-active-run'; continue;
      }
      if (was.retryAt && Date.parse(was.retryAt) > now) { record.action = 'wait-connection-retry'; continue; }
      const selected = result.selected || baseline.profiles.find(p => p.provider === family(agent));
      await installConnection(agent, selected, connections[agent.companyId]);
      const patch = configFor(agent, selected);
      const switching = family(agent) !== selected.provider;
      const needsPatch = switching || agent.adapterConfig.model !== selected.model || (agent.adapterConfig.modelReasoningEffort || agent.adapterConfig.effort) !== selected.effort || agent.adapterConfig.command !== patch.adapterConfig.command || agent.adapterConfig.engine !== 'cli' || agent.runtimeConfig?.heartbeat?.maxConcurrentRuns !== 1;
      if (needsPatch) { agent = await api('PATCH', `/agents/${agent.id}`, patch, { auth: false }); actions.push(`${agent.name}: ${selected.provider}/${selected.model}`); }
      if (switching) record.lastSwitchAt = new Date(now).toISOString();
      if (needsPatch && planned && planLoad.status === 'applied') {
        const day = new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
        record.planChanges = record.planChangesDay === day ? (record.planChanges || 0) + 1 : 1;
        record.planChangesDay = day; record.lastPlanChangeAt = new Date(now).toISOString();
      }
      delete record.retryAt; delete record.error;
      if (!result.selected) {
        record.action = 'quota-wait'; record.reason = record.dailyCapHit ? `Daily operational cost cap reached (${spent.toFixed(2)} >= ${cap} USD estimate)` : `${result.sticky}: ${result.candidates.map(c => `${c.provider}: ${c.reason}`).join('; ')}`;
      } else {
        if (agent.status === 'paused' && record.pausedBy === 'quota-switch') await api('POST', `/agents/${agent.id}/resume`, {}, { auth: false });
        delete record.pausedBy; delete record.pausedUpdatedAt; record.action = 'ready'; record.reason = result.selected.reason;
        record.guardRetry = await retryGuardRun({ agent, runs, stateRecord: record, api, now });
      }
    } catch (e) {
      record.action = 'connection-wait'; record.error = String(e.message).slice(0, 400); record.retryAt = new Date(now + 60_000).toISOString();
      // A failed fallback never authorizes the exhausted original provider: the
      // unchanged config keeps its own quota wrapper, which postpones each run.
    }
    atomicWrite(SWITCH_STATE, { ...next, agents: { ...before.agents, ...next.agents } });
  }
  if (!dryRun) {
    atomicWrite(SWITCH_STATE, next);
    // Compatibility readers consume the same fresh, fail-closed company-wide policy.
    const legacy = read(join(QUOTA_DIR, 'token-state.json'));
    const states = Object.fromEntries(['claude', 'codex'].map(f => {
      const p = providers[f]; const check = assessCandidate({ provider: f, model: 'unknown', providers, estimates, reservations: runningReservations, now });
      return [f, { ok: Boolean(p?.weekUsedPercent != null), week: p?.weekUsedPercent ?? null, weekResetAt: p?.weekResetAt, session: p?.sessionUsedPercent ?? null, level: check.allow ? (p.weekUsedPercent >= 60 ? 'yellow' : 'green') : 'red', source: p?.source, measuredAt: p?.measuredAt }];
    }));
    const ids = paperclipIds(), spec = loadCompany();
    const variants = { ...legacy.agents };
    for (const [key, id] of Object.entries(ids?.agents || {})) {
      const r = next.agents[id]; if (!r || !spec.agents[key]?.primary) continue;
      const variant = r.action?.endsWith('wait') || r.action === 'manual-pause' ? 'paused' : ['primary', 'economy', 'alternate'].find(v => spec.agents[key][v]?.model === r.selected?.model) || 'primary';
      variants[key] = { ...variants[key], variant };
    }
    atomicWrite(join(QUOTA_DIR, 'token-state.json'), { ...legacy, updatedAt: next.updatedAt, providers: states, agents: variants, quotaController: 'global-reserve-30' });
    const levels = Object.fromEntries(Object.entries(states).map(([f, s]) => [f, s.level]));
    const routing = join(QUOTA_DIR, 'engine-routing.env');
    writeFileSync(`${routing}.tmp`, routingEnvText(routingFor(levels, policy), levels));
    renameSync(`${routing}.tmp`, routing);
  }
  return { dryRun, providers, actions, agents: next.agents, activeRuns: active.length, enabled: true, reconciliation };
}

if (process.argv[1] && process.argv[1] !== '-' && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) governAll({ dryRun: process.argv.includes('--dry-run') }).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
