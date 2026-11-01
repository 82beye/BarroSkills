#!/usr/bin/env node
/**
 * token-governor.js — 구독 한도 창을 보고 자동화의 토큰 소비를 조절한다 (LLM 0회)
 *
 * 2026-10-07 운영자: "토큰 소모 체크가 되어야 하고, 구독 중인 Claude·Codex 를 역할에 맞게 모두 쓰되
 * 토큰 모니터링으로 유연하게 소비되어야 한다." 4~5월 페이퍼클립 체제는 이걸 못 해서 캐시 입력 10억 토큰을 썼다.
 *
 * 15분마다 (Token Governor 타이머):
 *   1. 페이퍼클립 costs/quota-windows 로 Claude(세션·주간)·Codex 사용률을 읽어 공급자별 GREEN/YELLOW/RED 를 정한다.
 *   2. 파이프라인 엔진 순서(workspace/ops/engine-routing.env)를 정한다 — guards.sh 가 회차 시작 때 읽는다.
 *   3. LLM 에이전트 모델 변형을 정한다 — GREEN 기본 · YELLOW 절약 · RED 다른 공급자 · 둘 다 RED 면 일시정지.
 *      에이전트별 하루 비용 상한(API 환산 USD, company.json)을 넘기면 다음 날까지 일시정지.
 *   4. 루틴 등급별 보류 — 보류한 루틴은 풀리면 놓친 회차가 한 번 돈다(페이퍼클립 catch-up).
 *   5. 순회 — 주인 없이 끝난 회차 마커 마무리, 이슈 없는 새 장애를 SRE 로, 막던 장애가 닫힌 실패 회차 이슈 정리,
 *      판단할 멈춘 이슈가 있으면 CEO 에게 막힘 점검 이슈(triage.js).
 *   6. 상태가 바뀔 때만 텔레그램. 모든 판단은 workspace/ops/token-state.json·token-ledger.jsonl 에 남는다.
 *
 * 내가 바꾼 것만 되돌린다: 사람이 멈춘 에이전트·루틴은 건드리지 않는다(pausedBy 기록).
 * 회사가 가동 전(paperclip-ids.json activated≠true)이면 판단·엔진 순서만 하고 에이전트·루틴은 두지 않는다.
 *
 * Usage:
 *   node scripts/automation/paperclip/token-governor.js            # 관제 1회
 *   node scripts/automation/paperclip/token-governor.js --dry-run  # 판단만 출력
 *   node scripts/automation/paperclip/token-governor.js --report   # 일일 리포트 (21:00 루틴)
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  OPS, ROOT, adapterFor, api, comparableAdapterConfig, kstParts, loadCompany, openIncidentIssues, paperclipHealthy,
  paperclipIds, pendingIncidents, providerOf, readJson, settleRunIssues, writeJsonAtomic,
} from './lib.js';

const STATE = join(OPS, 'token-state.json');
const LEDGER = join(OPS, 'token-ledger.jsonl');
const ROUTING = join(OPS, 'engine-routing.env');
const LEVELS = ['green', 'yellow', 'red'];
const rank = (l) => Math.max(0, LEVELS.indexOf(l));

// ── 순수 판단 (테스트 대상) ────────────────────────────────────────────────

/**
 * quota-windows 응답 → 공급자별 {session, week, sessionResetAt, weekResetAt, ok}.
 * 창 이름이 공급자마다 다르다(Claude "Current session"/"Current week", Codex "5h limit").
 * 이름보다 리셋까지 남은 시간을 믿는다 — Codex 의 "5h limit" 은 리셋이 엿새 뒤였다(2026-10-07 실측, 사실상 주간 창).
 */
export function parseWindows(quota = [], policy, now = Date.now()) {
  const out = {};
  for (const [name, p] of Object.entries(policy.providers)) {
    const q = quota.find((x) => x.provider === p.quota_provider);
    const m = { ok: Boolean(q?.ok), session: null, week: null, sessionResetAt: null, weekResetAt: null };
    for (const w of q?.windows ?? []) {
      if (typeof w.usedPercent !== 'number') continue;
      const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      const hours = Number.isFinite(reset) ? (reset - now) / 3_600_000 : null;
      const isSession = hours !== null ? hours <= 6 : /session|5h/i.test(w.label);
      const slot = isSession ? 'session' : 'week';
      if (m[slot] === null || w.usedPercent > m[slot]) {
        m[slot] = w.usedPercent;
        m[`${slot}ResetAt`] = w.resetsAt ?? null;
      }
    }
    out[name] = m;
  }
  return out;
}

/** 주간 창을 남은 시간 대비 너무 빨리 쓰고 있는가 (예: 이틀 지났는데 70%). */
export function weekPaceAhead(m, th, now = Date.now()) {
  if (m.week === null || !m.weekResetAt || m.week < th.week_pace_min) return false;
  const left = (Date.parse(m.weekResetAt) - now) / (7 * 86_400_000);
  const elapsedPct = Math.min(100, Math.max(0, (1 - left) * 100));
  return m.week > elapsedPct + th.week_pace_margin;
}

/** 공급자 상태. 내려갈 때는 hysteresis 만큼 더 내려가야 한 단계 회복한다. */
export function levelFor(m, th, prev = 'green', now = Date.now()) {
  if (!m.ok || (m.session === null && m.week === null)) return prev ?? 'green';
  const s = m.session ?? 0;
  const w = m.week ?? 0;
  const raw = s >= th.session.red || w >= th.week.red ? 'red'
    : s >= th.session.yellow || w >= th.week.yellow || weekPaceAhead(m, th, now) ? 'yellow' : 'green';
  if (rank(raw) >= rank(prev)) return raw;
  const h = th.hysteresis;
  const stillRed = s >= th.session.red - h || w >= th.week.red - h;
  const stillYellow = s >= th.session.yellow - h || w >= th.week.yellow - h || weekPaceAhead(m, th, now);
  if (prev === 'red') return stillRed ? 'red' : stillYellow ? 'yellow' : raw;
  return stillYellow ? 'yellow' : raw;
}

/** 엔진 순서 — 둘 다 GREEN 이면 아무것도 쓰지 않는다(스크립트 기본값). */
export function routingFor(levels, policy) {
  const { claude, codex } = levels;
  const r = policy.routing;
  let demote = null;
  if (claude === 'red' && codex !== 'red') demote = 'claude';
  else if (codex === 'red' && claude !== 'red') demote = 'codex';
  else if (r.yellow_prefers_other && claude === 'yellow' && codex === 'green') demote = 'claude';
  else if (r.yellow_prefers_other && codex === 'yellow' && claude === 'green') demote = 'codex';
  if (!demote) return {};
  const env = {};
  for (const [k, chain] of Object.entries(r.chains)) {
    const parts = chain.split(',');
    if (!parts.includes(demote)) continue;
    const next = [...parts.filter((p) => p !== demote), demote].join(',');
    if (next !== chain) env[k] = next;
  }
  return env;
}

/** LLM 에이전트 변형. capHit = 오늘 비용 상한 초과. */
export function variantFor(spec, levels, capHit = false) {
  if (capHit) return 'paused';
  const home = providerOf(spec.primary);
  const away = providerOf(spec.alternate);
  const l = levels[home] ?? 'green';
  if (l === 'green') return 'primary';
  if (l === 'yellow') return spec.economy ? 'economy' : 'primary';
  if (away && levels[away] !== 'red') return 'alternate';
  return 'paused';
}

/**
 * 에이전트를 멈추거나 되살릴 차례인가. pausedBy 가 거버너면 「내가 멈춘 것」이다.
 * 2026-10-25 막힘 점검에서 나온 두 규칙 — 둘 다 거버너가 도는 실행을 끊어 board 손으로만 풀리는 정합 잠금을 만들었다(YOU-577):
 *   - 실행 중이면 멈추지 않는다. 끝난 뒤 다음 회차(15분)에 멈춘다 — 상한을 실행 하나만큼 넘기는 게 수리를 중간에 끊는 것보다 싸다.
 *   - 내가 멈춘 에이전트를 사람이 다시 켰으면 그날은 다시 멈추지 않는다. 10-22 운영자가 SRE 를 켠 지 15분 만에 다시 멈췄다.
 * humanDay: 사람이 다시 켠 날(KST). 다음 날이면 효력이 없다.
 */
export function pauseStep({ variant, status, was = {}, date }) {
  const mine = ['governor', 'governor-cap'].includes(was.pausedBy);
  const humanDay = was.humanOverrideDay === date || (mine && status !== 'paused') ? date : null;
  if (variant !== 'paused') return { act: status === 'paused' && mine ? 'resume' : 'none', humanDay };
  if (status === 'paused') return { act: 'none', humanDay };
  if (humanDay) return { act: 'human', humanDay };
  if (status === 'running') return { act: 'wait-run', humanDay };
  return { act: 'pause', humanDay };
}

/** 루틴을 보류해야 하는가. */
export function routineHeld(routine, levels, agentSpec) {
  const anyRed = Object.values(levels).includes('red');
  const allRed = Object.values(levels).every((l) => l === 'red');
  if (routine.tier === 1) return allRed;
  if (routine.tier === 2) {
    const home = agentSpec?.primary ? providerOf(agentSpec.primary) : null;
    return home ? levels[home] !== 'green' : anyRed;
  }
  return false;
}

export function routingEnvText(env, levels, now = new Date()) {
  const head = `# token-governor ${now.toISOString()} — claude=${levels.claude} codex=${levels.codex}. 비어 있으면 스크립트 기본 순서.\n`;
  return head + Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + (Object.keys(env).length ? '\n' : '');
}

// ── 관찰 ───────────────────────────────────────────────────────────────────

/** 환산 비용이 없는 실행(Codex)의 추정 비용 — 정책의 백만 토큰당 단가로. */
export function estimateCostUsd(u = {}, rates = {}) {
  if (!rates) return 0;
  const cached = u.cachedInputTokens ?? 0;
  const fresh = Math.max(0, (u.inputTokens ?? 0) - cached);
  return (fresh * (rates.input ?? 0) + cached * (rates.cached ?? 0) + (u.outputTokens ?? 0) * (rates.output ?? 0)) / 1e6;
}

/** 오늘(KST) 에이전트별 실행·토큰·API 환산 비용. 구독이라 청구액은 0 이지만 환산값이 한도 소모의 대리 지표다. */
export async function agentUsageToday(companyId, now = new Date(), policy = readJson(join(ROOT, 'config', 'paperclip', 'token-policy.json'))) {
  const { date } = kstParts(now);
  const dayStart = Date.parse(`${date}T00:00:00+09:00`);
  const runs = await api('GET', `/companies/${companyId}/heartbeat-runs?limit=500`, undefined, { auth: false });
  const by = {};
  for (const r of Array.isArray(runs) ? runs : runs.items ?? []) {
    if (Date.parse(r.createdAt) < dayStart) continue;
    const u = r.usageJson ?? {};
    const a = (by[r.agentId] ??= { runs: 0, failed: 0, input: 0, cached: 0, output: 0, costUsd: 0, estimated: false, models: {} });
    a.runs += 1;
    if (r.status === 'failed') a.failed += 1;
    a.input += u.inputTokens ?? 0;
    a.cached += u.cachedInputTokens ?? 0;
    a.output += u.outputTokens ?? 0;
    const reported = u.cacheAdjustedCostUsd ?? u.costUsd;
    if (typeof reported === 'number') a.costUsd += reported;
    else if (u.inputTokens || u.outputTokens) {
      a.costUsd += estimateCostUsd(u, policy?.cost_estimate_per_mtok?.codex);
      a.estimated = true;
    }
    if (u.model) a.models[u.model] = (a.models[u.model] ?? 0) + 1;
  }
  return by;
}

/** 파이프라인 LLM 호출 장부(text-engine 이 남김) 오늘치 요약. */
export function pipelineUsageToday(now = new Date(), path = join(OPS, 'llm-ledger.jsonl')) {
  if (!existsSync(path)) return null;
  const { date } = kstParts(now);
  const sum = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (kstParts(new Date(r.at)).date !== date) continue;
    const k = `${r.engine}:${r.caller}`;
    const s = (sum[k] ??= { calls: 0, input: 0, cached: 0, output: 0, costUsd: 0 });
    s.calls += 1;
    s.input += r.input ?? 0;
    s.cached += r.cached ?? 0;
    s.output += r.output ?? 0;
    s.costUsd += r.costUsd ?? 0;
  }
  return sum;
}

// ── 순회 ───────────────────────────────────────────────────────────────────

async function sweep({ ceoVariant } = {}) {
  const done = [];
  const { finalizeRun } = await import('./dispatch.js');
  const days = [kstParts(new Date(Date.now() - 86_400_000)).date, kstParts().date];
  for (const date of days) {
    const dir = join(OPS, 'runs', date);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const m = readJson(join(dir, f));
      if (m?.status !== 'running') continue;
      const r = await finalizeRun(date, f.slice(0, -5), { quiet: true });
      if (r?.status !== 'running') done.push(`${date}/${f.slice(0, -5)} → ${r?.status}`);
    }
  }
  // 끝내지 못한 생산 회차를 공개 유예 안에서 다시 돌린다. 실행은 분리된 프로세스라 순회를 잡지 않는다.
  try {
    const { rescueAll } = await import('./deadman-recover.js');
    const rescued = (await rescueAll()).filter((r) => ['resume', 'rerun', 'giveup'].includes(r.action) || r.rescued);
    rescued.forEach((r) => done.push(`재개 ${r.slot} → ${r.action}${r.ep ? ` ${r.ep}` : ''}`));
  } catch (e) { console.error(`⚠ 회차 재개 실패: ${e.message}`); }
  const opened = await openIncidentIssues(pendingIncidents(), { production: true });
  let settled = [];
  try { settled = await settleRunIssues(paperclipIds()); } catch (e) { console.error(`⚠ 회차 이슈 정리 실패: ${e.message}`); }
  // 막힘 점검 — 판단할 멈춘 이슈가 있을 때만 CEO 에게 (triage.js 가 하루 횟수·간격·새 항목을 본다).
  // 바로조 막힘 지휘가 켜져 있으면 전 회사 CEO 호출은 바로조가 맡는다 — 두 곳이 같은 CEO 를 겹쳐 깨우지 않게.
  let triage = null;
  const policy = readJson(join(ROOT, 'config', 'paperclip', 'token-policy.json'), {});
  if (policy.barrojo_unblock?.enabled) triage = { skipped: 'barrojo-unblock' };
  else try {
    const { maybeOpenTriage } = await import('./triage.js');
    triage = await maybeOpenTriage({ ceoVariant });
  } catch (e) { console.error(`⚠ 막힘 점검 실패: ${e.message}`); }
  return { finalized: done, opened: opened.filter((o) => !o.existed), settled, triage };
}

async function notify(text) {
  if (process.env.BT_NO_NOTIFY === '1') return;
  try {
    const { sendTelegramText } = await import('../notify.js');
    await sendTelegramText(text);
  } catch (e) { console.error(`⚠ 텔레그램 실패: ${e.message}`); }
}

// ── 관제 ───────────────────────────────────────────────────────────────────

async function govern({ dryRun }) {
  const policy = readJson(join(ROOT, 'config', 'paperclip', 'token-policy.json'));
  if (policy.global_reserve?.enabled) {
    const { governAll } = await import('./quota-switch.js');
    const result = await governAll({ dryRun });
    console.log(JSON.stringify({ controller: 'all-company-reserve-30', ...result }, null, 2));
    if (!dryRun && !result.skipped) {
      const current = readJson(STATE, {});
      await sweep({ ceoVariant: current.agents?.ceo?.variant });
    }
    return 0;
  }
  const company = loadCompany();
  const ids = paperclipIds();
  const prev = readJson(STATE, { providers: {}, agents: {}, routines: {} });
  const now = new Date();
  const { date } = kstParts(now);
  const actions = [];

  if (!(await paperclipHealthy())) {
    console.log('페이퍼클립 응답 없음 — 이번 회차는 건너뛴다 (엔진 순서는 마지막 값 유지)');
    return 0;
  }
  const quota = await api('GET', `/companies/${company.company_id}/costs/quota-windows`, undefined, { auth: false });
  const metrics = parseWindows(quota, policy, now.getTime());
  const levels = {};
  const providers = {};
  for (const [name, m] of Object.entries(metrics)) {
    const before = prev.providers?.[name]?.level ?? 'green';
    levels[name] = levelFor(m, policy.thresholds, before, now.getTime());
    providers[name] = { ...m, level: levels[name], changedAt: levels[name] !== before ? now.toISOString() : prev.providers?.[name]?.changedAt ?? null };
    if (levels[name] !== before) actions.push(`${policy.providers[name].label} ${before.toUpperCase()}→${levels[name].toUpperCase()} (세션 ${m.session ?? '-'}% · 주간 ${m.week ?? '-'}%)`);
  }

  // 1) 파이프라인 엔진 순서
  const routing = routingFor(levels, policy);
  const routingText = routingEnvText(routing, levels, now);
  const routingChanged = !existsSync(ROUTING) || readFileSync(ROUTING, 'utf-8').split('\n').slice(1).join('\n') !== routingText.split('\n').slice(1).join('\n');
  if (routingChanged) actions.push(`엔진 순서: ${Object.keys(routing).length ? Object.entries(routing).map(([k, v]) => `${k.replace(/^BT_|_ENGINE_CHAIN$|_CHAIN$/g, '')}=${v}`).join(' ') : '기본값'}`);
  if (routingChanged && !dryRun) { mkdirSync(OPS, { recursive: true }); writeFileSync(ROUTING, routingText); }

  // 2) 에이전트
  const usage = ids?.companyId ? await agentUsageToday(ids.companyId, now) : {};
  const agentsState = {};
  const newDay = prev.day !== date;
  for (const [key, spec] of Object.entries(company.agents)) {
    if (spec.kind !== 'llm') continue;
    const id = ids?.agents?.[key];
    const u = id ? usage[id] ?? { runs: 0, costUsd: 0 } : { runs: 0, costUsd: 0 };
    const capHit = Boolean(spec.daily_cost_cap_usd) && u.costUsd >= spec.daily_cost_cap_usd;
    const variant = variantFor(spec, levels, capHit);
    const was = prev.agents?.[key] ?? {};
    const st = { variant, pausedBy: newDay && was.pausedBy === 'governor-cap' ? null : was.pausedBy ?? null, costUsdToday: Number(u.costUsd?.toFixed?.(3) ?? 0), runsToday: u.runs };
    if (ids?.activated && id && !dryRun) {
      const agent = await api('GET', `/agents/${id}`, undefined, { auth: false });
      const step = pauseStep({ variant, status: agent.status, was, date });
      st.humanOverrideDay = step.humanDay;
      if (step.act === 'human' && was.humanOverrideDay !== date) {
        st.pausedBy = null;
        actions.push(`${spec.name} — 운영자가 다시 켰다, 오늘은 다시 멈추지 않는다`);
      }
      if (step.act === 'wait-run') actions.push(`${spec.name} 실행 중 — 끝나면 멈춘다`);
      if (step.act === 'pause') {
        await api('POST', `/agents/${id}/pause`, {}, { auth: false });
        st.pausedBy = capHit ? 'governor-cap' : 'governor';
        actions.push(`${spec.name} 일시정지 — ${capHit ? `오늘 $${u.costUsd.toFixed(2)} ≥ 상한 $${spec.daily_cost_cap_usd}` : '두 공급자 모두 RED'}`);
      }
      if (variant !== 'paused') {
        if (step.act === 'resume') {
          await api('POST', `/agents/${id}/resume`, {}, { auth: false });
          st.pausedBy = null;
          actions.push(`${spec.name} 재개`);
        }
        const cfg = await api('GET', `/agents/${id}/configuration`, undefined, { auth: false });
        const want = adapterFor(spec, variant, cfg.adapterConfig ?? {}, company.env);
        const differs = cfg.adapterType !== want.adapterType || comparableAdapterConfig(cfg.adapterConfig) !== comparableAdapterConfig(want.adapterConfig);
        if (differs && agent.status !== 'running') {
          // 한 에이전트의 전환 거부가 회차 전체를 죽이지 않게 한다. 2026-10-25 SRE 의 Claude 연결이 끊기자(claude_auth_required)
          // 페이퍼클립이 SRE 설정 변경을 422 「Reconnect or validate the selected AI account」로 거부했고, 거버너가 그 자리에서 죽어 순회·기록을 건너뛰었다.
          try {
            await api('PATCH', `/agents/${id}`, { adapterType: want.adapterType, adapterConfig: want.adapterConfig, replaceAdapterConfig: true }, { auth: false });
            actions.push(`${spec.name} → ${variant} (${want.adapterType === 'codex_local' ? 'Codex' : 'Claude'} ${want.adapterConfig.model})`);
          } catch (e) {
            actions.push(`${spec.name} → ${variant} 전환 거부 — 다음 회차에 다시 (${e.message.slice(0, 160)})`);
          }
        }
      }
    } else if (variant !== (was.variant ?? 'primary')) {
      actions.push(`${spec.name} → ${variant}${ids?.activated ? '' : ' (가동 전 — 기록만)'}`);
    }
    agentsState[key] = st;
  }

  // 3) 루틴 등급별 보류
  const routinesState = {};
  for (const r of company.routines) {
    const held = routineHeld(r, levels, company.agents[r.agent]);
    const was = prev.routines?.[r.key] ?? {};
    const st = { held, pausedBy: was.pausedBy ?? null };
    const rid = ids?.routines?.[r.key];
    if (ids?.activated && rid && !dryRun && (held || was.pausedBy === 'governor')) {
      const cur = await api('GET', `/routines/${rid}`, undefined, { auth: false });
      if (held && cur.status === 'active') {
        await api('PATCH', `/routines/${rid}`, { status: 'paused' }, { auth: false });
        st.pausedBy = 'governor';
        actions.push(`루틴 보류: ${r.title}`);
      } else if (!held && was.pausedBy === 'governor' && cur.status === 'paused') {
        await api('PATCH', `/routines/${rid}`, { status: 'active' }, { auth: false });
        st.pausedBy = null;
        actions.push(`루틴 재개: ${r.title} (놓친 회차는 한 번 돈다)`);
      }
    }
    routinesState[r.key] = st;
  }

  // 4) 순회
  let swept = { finalized: [], opened: [], settled: [] };
  if (!dryRun && ids?.companyId) {
    try { swept = await sweep({ ceoVariant: agentsState.ceo?.variant }); } catch (e) { console.error(`⚠ 순회 실패: ${e.message}`); }
    swept.finalized.forEach((s) => actions.push(`마커 마무리: ${s}`));
    swept.opened.forEach((o) => actions.push(`장애 이슈: ${o.incident} → ${o.issue}`));
    if (swept.settled?.length) actions.push(`회차 이슈 정리: ${swept.settled.join(', ')}`);
    if (swept.triage?.opened) actions.push(`막힘 점검: ${swept.triage.issue} → CEO (판단 필요 ${swept.triage.due}건)`);
  }

  const state = {
    updatedAt: now.toISOString(), day: date, activated: Boolean(ids?.activated),
    providers, routing, agents: agentsState, routines: routinesState,
    lastActions: actions.length ? actions : prev.lastActions ?? [],
    lastActionsAt: actions.length ? now.toISOString() : prev.lastActionsAt ?? null,
  };
  const line = `claude=${levels.claude}(${metrics.claude.session ?? '-'}%/${metrics.claude.week ?? '-'}%) codex=${levels.codex}(${metrics.codex.session ?? '-'}%/${metrics.codex.week ?? '-'}%)`;
  console.log(`${dryRun ? '[dry-run] ' : ''}${line}`);
  actions.forEach((a) => console.log(`  · ${a}`));
  if (dryRun) return 0;

  writeJsonAtomic(STATE, state);
  appendFileSync(LEDGER, `${JSON.stringify({
    at: now.toISOString(), claude: { s: metrics.claude.session, w: metrics.claude.week, l: levels.claude },
    codex: { s: metrics.codex.session, w: metrics.codex.week, l: levels.codex },
    agents: Object.fromEntries(Object.entries(agentsState).map(([k, v]) => [k, { v: v.variant, usd: v.costUsdToday, n: v.runsToday }])),
  })}\n`);

  const levelChange = actions.filter((a) => /GREEN|YELLOW|RED/.test(a) && a.includes('→'));
  if (levelChange.length && policy.notify.on_level_change) {
    const icon = (l) => ({ green: '🟢', yellow: '🟡', red: '🔴' }[l]);
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    await notify(`${icon(levels.claude)} Claude · ${icon(levels.codex)} Codex — <b>토큰 관제 상태 변경</b>\n${esc(actions.join('\n'))}`);
  }
  return 0;
}

// ── 일일 리포트 ────────────────────────────────────────────────────────────

async function report() {
  const company = loadCompany();
  const ids = paperclipIds();
  const now = new Date();
  const { date } = kstParts(now);
  const state = readJson(STATE, {});
  const usage = ids?.companyId ? await agentUsageToday(ids.companyId, now) : {};
  const pipe = pipelineUsageToday(now);
  const dayStart = Date.parse(`${date}T00:00:00+09:00`);
  const peaks = { claude: { s: 0, w: 0 }, codex: { s: 0, w: 0 } };
  const changes = [];
  if (existsSync(LEDGER)) {
    for (const l of readFileSync(LEDGER, 'utf-8').split('\n')) {
      if (!l) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (Date.parse(r.at) < dayStart) continue;
      for (const p of ['claude', 'codex']) {
        peaks[p].s = Math.max(peaks[p].s, r[p]?.s ?? 0);
        peaks[p].w = Math.max(peaks[p].w, r[p]?.w ?? 0);
      }
    }
  }
  const name = Object.fromEntries(Object.entries(company.agents).map(([k, a]) => [ids?.agents?.[k], a.name]));
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n));
  const lines = [
    `# 토큰 일일 리포트 — ${date}`,
    '',
    '## 구독 한도 창',
    '| 공급자 | 상태 | 세션(5h) | 주간 | 오늘 최고(세션/주간) |',
    '|---|:-:|--:|--:|--:|',
    ...['claude', 'codex'].map((p) => {
      const s = state.providers?.[p] ?? {};
      return `| ${p === 'claude' ? 'Claude' : 'Codex'} | ${(s.level ?? '?').toUpperCase()} | ${s.session ?? '-'}% | ${s.week ?? '-'}% | ${peaks[p].s}% / ${peaks[p].w}% |`;
    }),
    '',
    '## 페이퍼클립 에이전트 (오늘)',
    '| 에이전트 | 실행 | 실패 | 출력 | 캐시 입력 | API 환산 |',
    '|---|--:|--:|--:|--:|--:|',
    ...Object.entries(usage).filter(([id]) => name[id]).map(([id, u]) =>
      `| ${name[id]} | ${u.runs} | ${u.failed} | ${fmt(u.output)} | ${fmt(u.cached)} | $${u.costUsd.toFixed(2)}${u.estimated ? ' (추정 포함)' : ''} |`),
    '',
  ];
  if (pipe && Object.keys(pipe).length) {
    lines.push('## 파이프라인 LLM 호출 (text-engine 장부)', '| 엔진:호출자 | 호출 | 입력 | 출력 | API 환산 |', '|---|--:|--:|--:|--:|');
    for (const [k, s] of Object.entries(pipe).sort((a, b) => b[1].calls - a[1].calls)) lines.push(`| ${k} | ${s.calls} | ${fmt(s.input + s.cached)} | ${fmt(s.output)} | $${s.costUsd.toFixed(2)} |`);
    lines.push('');
  }
  lines.push('## 지금 조절 상태',
    `- 엔진 순서: ${Object.keys(state.routing ?? {}).length ? Object.entries(state.routing).map(([k, v]) => `${k}=${v}`).join(', ') : '기본값'}`,
    `- 에이전트: ${Object.entries(state.agents ?? {}).map(([k, v]) => `${company.agents[k]?.name ?? k}=${v.variant}`).join(' · ')}`,
    `- 보류 루틴: ${Object.entries(state.routines ?? {}).filter(([, v]) => v.held).map(([k]) => k).join(', ') || '없음'}`,
    `- 마지막 조절(${state.lastActionsAt ?? '-'}): ${(state.lastActions ?? []).join(' / ') || '없음'}`);
  const md = `${lines.join('\n')}\n`;
  const dir = join(OPS, 'token-report');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${date}.md`), md);
  console.log(md);
  const totalUsd = Object.values(usage).reduce((a, u) => a + u.costUsd, 0) + Object.values(pipe ?? {}).reduce((a, s) => a + s.costUsd, 0);
  const p = (k) => state.providers?.[k] ?? {};
  await notify(`📊 <b>토큰 일일 리포트</b> ${date}\nClaude ${(p('claude').level ?? '?').toUpperCase()} 세션 ${p('claude').session ?? '-'}% · 주간 ${p('claude').week ?? '-'}%\nCodex ${(p('codex').level ?? '?').toUpperCase()} ${p('codex').week ?? p('codex').session ?? '-'}%\n자동화 API 환산 $${totalUsd.toFixed(2)} (에이전트 ${Object.values(usage).reduce((a, u) => a + u.runs, 0)}회)`);
  return 0;
}

async function main() {
  const { values: opt } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, report: { type: 'boolean', default: false } } });
  return opt.report ? report() : govern({ dryRun: opt['dry-run'] });
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().then((c) => process.exit(c ?? 0)).catch((e) => { console.error(`❌ token-governor: ${e.stack || e.message}`); process.exit(1); });
}
