#!/usr/bin/env node
/**
 * triage.js — 막힘 점검: 오래 풀리지 않는 이슈를 골라 CEO 에게 맡기고, CEO 가 서브에이전트에게 다시 맡길 때 쓰는 도구
 *
 * 2026-10-25 운영자: 「블럭이 너무 많이 발생한다 — CEO 가 그 이슈도 체크해서 서브에이전트들이 처리하게」.
 * 그날 blocked 23건을 갈라 보니 판단이 필요한 건 9건이었다. 나머지는 장애를 따라 막힌 회차 이슈 11·운영자 몫·CEO 자기 대기.
 * 멈춘 9건은 아무도 다시 깨우지 않아서 멈춰 있었다.
 *   - 담당이 일시정지일 때 들어온 일 → 페이퍼클립이 자동 복구를 멈추고 board 판단을 기다린다(YOU-567·573). 담당이 돌아와도 그대로다.
 *   - 실행이 취소·실패한 뒤 → 페이퍼클립이 재실행을 허락하지 않고 blocked 로 둔다(YOU-553·555·557 은 첫 실행이 취소된 뒤 결과 없이 멈췄다).
 *   - 사람을 기다리면서 자기 몫으로 걸었다 → 운영자 대기 목록에 뜨지 않았다(YOU-558).
 * 고르기와 실행은 결정론이고, 판단(다시 맡길지·사람에게 넘길지·닫을지)만 CEO 가 한다.
 *
 *   토큰 거버너 순회(15분) → maybeOpenTriage: 판단 필요가 있고, 하루 2회·4시간 간격·새 항목일 때만 CEO 에게 [막힘 점검] 이슈
 *   CEO → rewake · assign · escalate · close (이 파일, board 권한, 허용 동작만, 다시 맡기기는 이슈당 하루 2회)
 *
 * Usage:
 *   node scripts/automation/paperclip/triage.js scan                  # 지금 멈춘 이슈 분류 (읽기만)
 *   node scripts/automation/paperclip/triage.js open [--force]        # 조건이 맞으면 CEO 에게 막힘 점검 이슈 (--force: 간격·하루 한도·새 항목 무시)
 *   node scripts/automation/paperclip/triage.js rewake <YOU-n> "<지시>" [--evidence "<끊긴 실행이 한 일·안 한 일>"] [--outcome mixed|completed|not_performed]
 *   node scripts/automation/paperclip/triage.js assign <YOU-n> <sre|reviewer|cmo> "<지시>"
 *   node scripts/automation/paperclip/triage.js escalate <YOU-n> "<운영자가 할 일>"
 *   node scripts/automation/paperclip/triage.js close <YOU-n> <done|cancelled> "<사유>"
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { GROWTH, OPS, api, kstParts, loadCompany, paperclipIds, readJson, writeJsonAtomic } from './lib.js';

// CEO 가 Codex 대체 모드(샌드박스)로 돌아도 쓸 수 있게 자기 작업 폴더(growth) 아래에 둔다.
const DIR = join(GROWTH, 'triage');
const STATE = join(DIR, 'state.json');
const LEDGER = join(DIR, 'actions.jsonl');
export const TITLE = '[막힘 점검]';
const CLOSED = ['done', 'cancelled'];
const NOT_INVOKABLE = new Set(['paused', 'terminated', 'pending_approval']);
const H = 3_600_000;
const STALE_TRIAGE_H = 12;

const items = (x) => (Array.isArray(x) ? x : x?.items ?? []);
/** 마지막 실행이 AI 연결(인증) 실패 — 페이퍼클립은 사람이 연결을 고칠 때까지 그 에이전트 설정 변경도 거부한다(2026-10-25 SRE). */
export const authFailure = (r) => r?.status === 'failed' && /auth/i.test(r.errorCode ?? '');
const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const age = (h) => (h < 48 ? `${Math.round(h)}시간` : `${Math.round(h / 24)}일`);

export function kstShort(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 9 * H).toISOString().slice(5, 16).replace('T', ' ') : '?';
}

// ── 분류 (순수) ────────────────────────────────────────────────────────────

/**
 * 열린 이슈 하나를 목록 응답(blockerAttention·activeRecoveryAction·unblockDescriptor·activeRun·reviewAttention)만으로 가른다.
 *   child    루틴 회차 이슈(담당 없음)가 열린 장애를 따라 막힘 — 장애가 닫히면 거버너가 정리한다
 *   settle   루틴 회차 이슈인데 막던 이슈가 다 닫힘 — 거버너 settleRunIssues 몫
 *   board    사람 몫 — unblockDescriptor.owner="board", 또는 board 응답을 기다리는 검토(in_review)
 *   recovery 페이퍼클립이 자동 복구를 멈추고 board 판단을 기다림 — 대개 담당이 멈춰 있을 때 들어온 일
 *   waiting  담당이 있고 열린 이슈를 기다림
 *   stranded 기다릴 것도 사람 몫 표시도 없는데 blocked — 실행이 끊긴 뒤 아무도 깨우지 않았다
 *   stalled  진행 중인데 도는 실행이 없음 (LLM 담당만 — process 담당은 파이프라인이 따로 돈다)
 *   working  진행·검토 중이고 문제없음 · triage  막힘 점검 이슈 자신 — 둘 다 표에 올리지 않는다
 * agents: id → { key, name, kind, status }
 */
export function classifyIssue(issue, { agents = {}, now = Date.now() } = {}) {
  const ra = issue.activeRecoveryAction?.ownerType === 'board' ? issue.activeRecoveryAction : null;
  const who = ra?.returnOwnerAgentId ?? issue.assigneeAgentId ?? null;
  const a = who ? agents[who] : null;
  const since = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.max(0, (now - t) / H) : 0; };
  const e = {
    id: issue.id, identifier: issue.identifier, title: issue.title ?? '', status: issue.status,
    assignee: who ? a?.key ?? 'other' : null, assigneeName: a?.name ?? null, assigneeStatus: a?.status ?? null,
    invokable: who ? !NOT_INVOKABLE.has(a?.status) : null, authDown: Boolean(a?.authDown),
    ageH: since(issue.blockedTransitionAt ?? issue.updatedAt ?? issue.createdAt),
    updatedAt: issue.updatedAt ?? null,
  };
  if (e.title.startsWith(TITLE)) return { ...e, kind: 'triage' };
  if (issue.status === 'in_review') {
    const human = (issue.reviewAttention?.paths ?? []).find((p) => /board/i.test(p.responder ?? ''));
    return human ? { ...e, kind: 'board', action: `${human.label ?? '확인 요청'} (검토 대기)`, ageH: since(human.since) } : { ...e, kind: 'working' };
  }
  if (issue.status === 'in_progress') {
    return issue.activeRun || a?.kind !== 'llm' ? { ...e, kind: 'working' } : { ...e, kind: 'stalled', ageH: since(issue.updatedAt) };
  }
  const att = issue.blockerAttention ?? {};
  const owner = issue.unblockDescriptor?.owner;
  const routineRun = !issue.assigneeAgentId && !issue.assigneeUserId && /routine/i.test(issue.originKind ?? '');
  if (ra) return { ...e, kind: 'recovery', cause: ra.cause, recoveryActionId: ra.id };
  if (owner === 'board') return { ...e, kind: 'board', action: issue.unblockDescriptor.action ?? '' };
  if ((att.unresolvedBlockerCount ?? 0) > 0) {
    return { ...e, kind: routineRun ? 'child' : 'waiting', blocker: att.terminalBlocker?.identifier ?? att.sampleBlockerIdentifier ?? null };
  }
  if (routineRun) return { ...e, kind: 'settle' };
  return { ...e, kind: 'stranded', selfOwned: Boolean(owner && typeof owner === 'object') };
}

/** CEO 판단이 필요한가. 담당이 멈춰 있으면 돌아온 뒤에 본다(다시 깨워도 못 돈다). 담당이 없으면(null) 맡길 사람을 정해야 한다. */
export function needsJudgment(e, p) {
  const stuck = e.ageH * 60 >= p.min_stuck_minutes;
  switch (e.kind) {
    case 'recovery': case 'stranded': case 'stalled': return stuck && e.invokable !== false;
    case 'waiting': return e.ageH >= p.stale_wait_hours;
    case 'board': return e.ageH >= p.board_remind_hours;
    default: return false;
  }
}

export const fingerprint = (e) => `${e.identifier}|${e.kind}|${e.updatedAt}`;
const recheckHours = (e, p) => (e.kind === 'board' ? p.board_remind_hours : p.recheck_hours);

/**
 * CEO 에게 점검 이슈를 열까. 판단할 게 있어도 하루 max_per_day 회·min_interval_hours 간격,
 * 그리고 지난 점검에서 본 그대로인 항목(지문 = 이슈·분류·updatedAt)만 남았으면 열지 않는다 — CEO 가 같은 표를 두 번 읽지 않게.
 * acted(이슈 → CEO 가 마지막으로 처리한 시각): 처리 자체가 updatedAt 을 바꾸므로, 그 뒤로 아무 일이 없으면 새 항목이 아니다.
 */
export function triageGate({ entries, state = {}, policy, now = Date.now(), ceoInvokable = true, openIssue = null, force = false, acted = {} }) {
  if (!policy?.enabled) return { open: false, reason: '꺼짐', due: [] };
  const due = entries.filter((e) => needsJudgment(e, policy));
  if (!due.length) return { open: false, reason: '판단 필요 없음', due };
  if (openIssue) return { open: false, reason: `열린 점검 ${openIssue.identifier ?? openIssue.id}`, due };
  if (!ceoInvokable) return { open: false, reason: 'CEO 멈춤', due };
  if (force) return { open: true, reason: '강제', due };
  const { date } = kstParts(new Date(now));
  const today = state.day === date ? state.openedToday ?? 0 : 0;
  if (today >= policy.max_per_day) return { open: false, reason: `오늘 ${today}회 — 하루 ${policy.max_per_day}회까지`, due };
  if (state.lastOpenedAt && now - Date.parse(state.lastOpenedAt) < policy.min_interval_hours * H) {
    return { open: false, reason: `${policy.min_interval_hours}시간 간격`, due };
  }
  const fresh = due.filter((e) => {
    const seenAt = Date.parse(state.seen?.[fingerprint(e)] ?? '');
    if (Number.isFinite(seenAt) && now - seenAt < recheckHours(e, policy) * H) return false;
    const actedAt = acted[e.identifier];
    return !(actedAt && Date.parse(e.updatedAt) - actedAt <= 2 * 60_000);
  });
  if (!fresh.length) return { open: false, reason: '새 항목 없음 — 지난 점검에서 본 그대로', due };
  return { open: true, reason: `새 항목 ${fresh.length}`, due };
}

/** 점검은 주간 리뷰보다 가볍다 — CEO 가 기본 모델일 때만 같은 공급자의 절약 모델로 돌린다(거버너가 바꾼 변형은 그대로 둔다). */
export function triageOverrides(company, variant) {
  const ceo = company.agents.ceo;
  const v = ceo.economy;
  if (company.triage?.variant !== 'economy' || variant !== 'primary' || !v || v.adapterType !== ceo.primary.adapterType) return null;
  return { adapterConfig: v.adapterType === 'claude_local' ? { model: v.model, effort: v.effort } : { model: v.model, modelReasoningEffort: v.modelReasoningEffort } };
}

const LABEL = {
  recovery: (e) => (e.cause === 'stranded_assigned_issue' ? '자동 복구 멈춤 — 들어올 때 담당이 멈춰 있었다' : `자동 복구 멈춤 (${e.cause})`),
  stranded: (e) => (e.selfOwned ? '사람을 기다리는데 담당 자기 몫으로 걸림 — 운영자 목록에 안 뜬다' : '막는 것 없이 blocked — 실행이 끊긴 뒤 아무도 안 깨웠다'),
  stalled: (e) => `진행 중인데 도는 실행 없음${e.human ? ` — 사람 응답 대기: ${e.human}` : ''}`,
  waiting: (e) => `기다림 → ${e.blocker ?? '?'}`,
  board: (e) => `운영자 몫: ${oneLine(String(e.action ?? '').replace(/^\s*운영자 할 일\s*:\s*/, ''), 120)}`,
  child: (e) => `따라감 → ${e.blocker}`,
  settle: () => '정리 대기',
};

function itemLines(e, n) {
  const who = e.assignee ? `${e.assigneeName ?? e.assignee}(${e.assigneeStatus ?? '?'}${e.authDown ? '·AI 연결 끊김' : ''})` : '담당 없음';
  const c = e.lastComment;
  const r = e.lastRun;
  const tail = [
    c ? `마지막 댓글 ${c.who} ${kstShort(c.at)}: ${oneLine(c.text, n)}` : '댓글 없음',
    r ? `마지막 실행 ${r.status}${r.reason ? ` (${oneLine(r.reason, 80)})` : ''}` : null,
  ].filter(Boolean);
  return [`- **${e.identifier}** ${oneLine(e.title, 70)} · ${LABEL[e.kind](e)} · ${who} · ${age(e.ageH)}`, `  ↳ ${tail.join(' · ')}`];
}

/** 점검 이슈 본문(짧게)과 전체 표(long). down: AI 연결이 끊긴 에이전트 [{ name, code, at }]. */
export function renderDigest(entries, { policy, now = Date.now(), file = null, long = false, down = [] } = {}) {
  const shown = entries.filter((e) => !['working', 'triage'].includes(e.kind));
  const due = shown.filter((e) => needsJudgment(e, policy));
  const rest = shown.filter((e) => !due.includes(e));
  const children = rest.filter((e) => e.kind === 'child' || e.kind === 'settle');
  const others = rest.filter((e) => !children.includes(e));
  const lines = [
    `막힘 점검 — ${kstShort(new Date(now).toISOString())} KST · 멈춘 이슈 ${shown.length}건 중 판단 필요 ${due.length}건`,
    '지침 「막힘 점검」대로 항목마다 재개·위임·사람에게·정리·둔다 중 하나를 정하고, 이 이슈에 한 줄씩 남긴 뒤 done.',
    `도구: \`node $BT/scripts/automation/paperclip/triage.js <rewake|assign|escalate|close> <YOU-n> …\`${file ? ` · 전체 표: \`${file}\`` : ''}`,
    ...down.map((d) => `⚠ **${d.name} AI 연결 끊김** (${d.code}, ${kstShort(d.at)}) — 사람이 연결을 고칠 때까지 이 담당에게는 다시 맡기지 못한다(도구가 거부). 그 일은 사람에게 묶어 넘긴다.`),
    '',
    `## 판단 필요 (${due.length})`,
    ...due.flatMap((e) => itemLines(e, long ? 400 : 140)),
  ];
  if (others.length) {
    lines.push('', `## 그 밖의 대기 (${others.length}) — 아직 판단할 때가 아니다`,
      ...others.map((e) => `- ${e.identifier} ${oneLine(e.title, 60)} · ${LABEL[e.kind](e)} · ${age(e.ageH)}`));
  }
  if (children.length) {
    const by = {};
    for (const e of children) (by[e.blocker ?? '정리 대기'] ??= []).push(e.identifier);
    lines.push('', `## 따라감 (${children.length}) — 막던 이슈가 닫히면 거버너가 정리한다. 손대지 않는다`,
      ...Object.entries(by).map(([b, xs]) => `- ${b} ← ${xs.join(' · ')}`));
  }
  return `${lines.join('\n')}\n`;
}

/** 다시 맡기기·처리 상한. rows = 최근 24시간 장부. 막히면 사유 문자열. */
export function actionRefusal(rows, { issue, action }, policy) {
  if (rows.length >= policy.max_actions_per_day) return `24시간 안에 막힘 처리 ${rows.length}건 — ${policy.max_actions_per_day}건까지`;
  if (action === 'rewake' || action === 'assign') {
    const n = rows.filter((r) => r.issue === issue && (r.action === 'rewake' || r.action === 'assign')).length;
    if (n >= policy.rewake_per_issue_per_day) return `${issue} 는 24시간 안에 이미 ${n}번 다시 맡겼다 — 그래도 안 풀리면 사람에게(escalate)`;
  }
  return null;
}

// ── 페이퍼클립 읽기 ────────────────────────────────────────────────────────

const lastRunOf = async (companyId, agentId) =>
  items(await api('GET', `/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=1`, undefined, { auth: false }).catch(() => []))[0] ?? null;

/** 에이전트 지도. 현역 LLM 에이전트는 마지막 실행을 보고 AI 연결이 끊겼는지(authDown) 표시한다. */
async function agentMap(ids, company) {
  const keyById = Object.fromEntries(Object.entries(ids.agents ?? {}).map(([k, v]) => [v, k]));
  const list = items(await api('GET', `/companies/${ids.companyId}/agents`, undefined, { auth: false }));
  return Object.fromEntries(await Promise.all(list.map(async (a) => {
    const kind = company.agents[keyById[a.id]]?.kind ?? null;
    const last = kind === 'llm' ? await lastRunOf(ids.companyId, a.id) : null;
    const authDown = authFailure(last) ? { code: last.errorCode, at: last.createdAt } : null;
    return [a.id, { key: keyById[a.id] ?? null, name: a.name, status: a.status, kind, authDown }];
  })));
}

const downList = (agents) => Object.values(agents).filter((a) => a.authDown).map((a) => ({ name: a.name, ...a.authDown }));

export async function scan({ ids = paperclipIds(), company = loadCompany(), now = Date.now() } = {}) {
  const agents = await agentMap(ids, company);
  const lists = await Promise.all(['blocked', 'in_progress', 'in_review'].map((s) =>
    api('GET', `/companies/${ids.companyId}/issues?status=${s}&limit=200`, undefined, { auth: false }).then(items)));
  return { agents, entries: lists.flat().map((i) => classifyIssue(i, { agents, now })) };
}

/** 판단 필요 항목에만 — 마지막 댓글·실행·사람 응답 대기. CEO 가 이슈마다 따로 읽지 않아도 되게. */
async function enrich(e, agents) {
  const get = (p) => api('GET', p, undefined, { auth: false }).then(items).catch(() => []);
  const [comments, runs, inter] = await Promise.all([get(`/issues/${e.id}/comments`), get(`/issues/${e.id}/runs`), get(`/issues/${e.id}/interactions`)]);
  const latest = (xs) => [...xs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
  const c = latest(comments);
  const r = latest(runs);
  const pending = inter.find((x) => x.status === 'pending');
  return {
    ...e,
    lastComment: c ? { who: c.authorAgentId ? agents[c.authorAgentId]?.name ?? 'agent' : c.authorType === 'system' ? 'system' : 'board', at: c.createdAt, text: c.body } : null,
    lastRun: r ? { status: r.status, reason: r.status === 'succeeded' ? null : r.errorCode && r.errorCode !== r.status ? r.errorCode : r.livenessReason ?? null } : null,
    human: pending ? `${pending.title ?? pending.kind}${pending.effectiveResolverPolicy === 'human_only' ? ' (사람만)' : ''}` : null,
  };
}

/** 열린 점검 이슈. 12시간 넘게 안 끝난 것은 접는다(CEO 실행이 실패해 막힌 것) — 다음 점검이 이어 받는다. */
async function openTriageIssue(ids, now) {
  const list = items(await api('GET', `/companies/${ids.companyId}/issues?assigneeAgentId=${ids.agents.ceo}&status=todo,in_progress,blocked,in_review&limit=50`, undefined, { auth: false }));
  let alive = null;
  for (const i of list.filter((x) => String(x.title ?? '').startsWith(TITLE))) {
    if (now - Date.parse(i.createdAt) < STALE_TRIAGE_H * H) { alive = i; continue; }
    try {
      await api('PATCH', `/issues/${i.id}`, { status: 'cancelled', comment: `🧹 ${STALE_TRIAGE_H}시간 넘게 끝나지 않아 접는다 — 다음 막힘 점검이 이어 받는다.` }, { auth: false });
    } catch (e) { console.error(`⚠ 지난 점검 ${i.identifier} 접기 실패: ${e.message}`); alive = i; }
  }
  return alive;
}

async function notify(text) {
  if (process.env.BT_NO_NOTIFY === '1') return;
  try {
    const { sendTelegramText } = await import('../notify.js');
    await sendTelegramText(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  } catch (e) { console.error(`⚠ 텔레그램 실패: ${e.message}`); }
}

/**
 * 거버너 순회가 부른다. 조건이 맞으면 CEO 에게 [막힘 점검] 이슈를 연다.
 * CEO 가 멈춰 있으면 맡기지 못한 사실을 하루 한 번 운영자에게 알린다.
 */
export async function maybeOpenTriage({ ceoVariant = 'primary', force = false, dryRun = false, now = Date.now() } = {}) {
  const ids = paperclipIds();
  const company = loadCompany();
  const policy = company.triage;
  if (!ids?.activated || !ids.agents?.ceo || !policy?.enabled) return { opened: false, reason: '꺼짐' };
  const { agents, entries } = await scan({ ids, company, now });
  const state = readJson(STATE, {});
  const ceo = agents[ids.agents.ceo];
  const openIssue = await openTriageIssue(ids, now);
  const acted = {};
  for (const r of recentActions(now)) acted[r.issue] = Math.max(acted[r.issue] ?? 0, Date.parse(r.at));
  const ceoInvokable = Boolean(ceo) && !NOT_INVOKABLE.has(ceo.status) && !ceo.authDown;
  const gate = triageGate({ entries, state, policy, now, ceoInvokable, openIssue, force, acted });
  const { date, hour, minute } = kstParts(new Date(now));
  if (!gate.open) {
    if (gate.reason === 'CEO 멈춤' && state.notifiedDay !== date && !dryRun) {
      const why = ceo?.authDown ? `AI 연결 끊김(${ceo.authDown.code})` : ceo?.status ?? '없음';
      await notify(`🧭 막힘 점검 — CEO 가 ${why} 이라 맡기지 못했다. 판단 필요 ${gate.due.length}건: ${gate.due.slice(0, 8).map((e) => e.identifier).join(' · ')}`);
      writeJsonAtomic(STATE, { ...state, notifiedDay: date });
    }
    return { opened: false, reason: gate.reason, due: gate.due.length };
  }
  const detailed = new Map((await Promise.all(gate.due.map((e) => enrich(e, agents)))).map((e) => [e.id, e]));
  const all = entries.map((e) => detailed.get(e.id) ?? e);
  const file = join(DIR, `${date}-${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}.md`);
  const down = downList(agents);
  const description = renderDigest(all, { policy, now, file, down });
  if (dryRun) return { opened: false, reason: 'dry-run', due: gate.due.length, description };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file, renderDigest(all, { policy, now, file, long: true, down }));
  const overrides = triageOverrides(company, ceoVariant);
  const issue = await api('POST', `/companies/${ids.companyId}/issues`, {
    title: `${TITLE} ${kstShort(new Date(now).toISOString())} — 판단 필요 ${gate.due.length}건`,
    description,
    status: 'todo',
    priority: 'medium',
    assigneeAgentId: ids.agents.ceo,
    projectId: ids.projects?.reliability ?? null,
    goalId: ids.goals?.publishing ?? null,
    ...(overrides ? { assigneeAdapterOverrides: overrides } : {}),
  }, { auth: false });
  const seen = Object.fromEntries(Object.entries(state.seen ?? {}).filter(([, at]) => now - Date.parse(at) < 7 * 24 * H));
  for (const e of gate.due) seen[fingerprint(e)] = new Date(now).toISOString();
  writeJsonAtomic(STATE, {
    ...state, day: date, openedToday: (state.day === date ? state.openedToday ?? 0 : 0) + 1,
    lastOpenedAt: new Date(now).toISOString(), lastIssue: issue.identifier ?? issue.id, seen,
  });
  return { opened: true, issue: issue.identifier ?? issue.id, due: gate.due.length };
}

// ── CEO 의 처리 동작 (board 권한, 허용 목록) ────────────────────────────────

function recentActions(now = Date.now()) {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf-8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && now - Date.parse(r.at) < 24 * H);
}

function actorKey(ids) {
  const id = process.env.PAPERCLIP_AGENT_ID;
  return Object.entries(ids.agents ?? {}).find(([, v]) => v === id)?.[0] ?? (id ? 'agent' : 'operator');
}

async function act(action, ref, fn) {
  const ids = paperclipIds();
  const policy = loadCompany().triage;
  const issue = await api('GET', `/issues/${encodeURIComponent(ref)}`, undefined, { auth: false });
  if (issue.companyId !== ids.companyId) throw new Error(`${ref} 는 BarroTube 회사 이슈가 아니다`);
  const refusal = actionRefusal(recentActions(), { issue: issue.identifier, action }, policy);
  if (refusal) throw new Error(refusal);
  const result = await fn(issue, ids, policy);
  mkdirSync(DIR, { recursive: true });
  appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), by: actorKey(ids), issue: issue.identifier, action, ...result })}\n`);
  console.log(`✓ ${issue.identifier} ${action} — ${result.summary}`);
}

const directive = (note) => `🧭 **CEO 막힘 점검** — ${String(note).trim()}`;

async function requireAgent(id, label, companyId) {
  const a = await api('GET', `/agents/${id}`, undefined, { auth: false });
  if (NOT_INVOKABLE.has(a.status)) throw new Error(`${label} ${a.name} 이(가) ${a.status} — 돌아온 뒤에 다시 본다`);
  const last = await lastRunOf(companyId, id);
  if (authFailure(last)) {
    throw new Error(`${label} ${a.name} 의 AI 연결이 끊겨 있다(${last.errorCode}, ${kstShort(last.createdAt)}) — 다시 맡겨도 못 돈다. 사람에게(escalate): 페이퍼클립에서 연결 요청 완료·로그인`);
  }
  return a;
}

function requireNoOpenBlockers(issue) {
  const open = (issue.blockedBy ?? []).filter((b) => !CLOSED.includes(b.status));
  if (open.length) throw new Error(`아직 열린 막는 이슈: ${open.map((b) => b.identifier ?? b.id).join(', ')} — 그쪽을 먼저 본다`);
}

/** 담당에게 다시 맡긴다. 페이퍼클립이 board 판단을 기다리는 복구가 있으면 「원 담당에게 돌려주기」로 푼다. */
async function rewake(ref, note, { evidence, outcome }) {
  await act('rewake', ref, async (issue) => {
    if (!['blocked', 'in_progress'].includes(issue.status)) throw new Error(`${issue.identifier} 는 ${issue.status} — 막힌·멈춘 이슈만 다시 맡긴다`);
    if (!issue.assigneeAgentId) throw new Error('담당이 없다 — assign 으로 맡길 에이전트를 정한다');
    const agent = await requireAgent(issue.assigneeAgentId, '담당', issue.companyId);
    requireNoOpenBlockers(issue);
    const ra = (await api('GET', `/issues/${issue.id}/recovery-actions`, undefined, { auth: false }))?.active;
    if (ra?.ownerType === 'board') {
      const body = { actionId: ra.id, outcome: 'restored', sourceIssueStatus: 'todo', resolutionNote: oneLine(note, 2000) };
      if (evidence) {
        body.executionReconciliation = {
          runId: ra.evidence?.runId ?? ra.evidence?.sourceRunId, providerStopped: true, actionOutcome: outcome, outcomeEvidence: String(evidence).trim(),
        };
      }
      try {
        await api('POST', `/issues/${issue.id}/recovery-actions/resolve`, body, { auth: false });
      } catch (e) {
        if (/reconcil/i.test(e.message) && !evidence) {
          throw new Error(`복구(${ra.cause})는 끊긴 실행이 한 일·안 한 일을 적어야 풀린다 — 실행 로그를 보고 --evidence "<한 일/안 한 일>" [--outcome mixed|completed|not_performed] 로 다시 (${e.message})`);
        }
        throw e;
      }
      await api('POST', `/issues/${issue.id}/comments`, { body: directive(note) }, { auth: false });
    } else {
      // 같은 PATCH 의 댓글이 담당을 깨운다 — 상태만 바꾸면 in_progress 에서는 아무도 깨지 않는다.
      await api('PATCH', `/issues/${issue.id}`, { status: 'todo', comment: directive(note) }, { auth: false });
    }
    return { target: agent.name, recovery: ra?.id ?? null, note: oneLine(note, 300), summary: `${agent.name} 에게 다시 맡김${ra ? ' (board 대기 복구 해제)' : ''}` };
  });
}

/** 다른 서브에이전트에게 넘긴다. 복구가 걸린 이슈는 원 담당에게 돌려주는 게 먼저다(rewake). */
async function assign(ref, key, note) {
  await act('assign', ref, async (issue, ids, policy) => {
    if (!policy.assign_to.includes(key)) throw new Error(`맡길 수 있는 에이전트: ${policy.assign_to.join(', ')}`);
    if (!['blocked', 'in_progress'].includes(issue.status)) throw new Error(`${issue.identifier} 는 ${issue.status} — 막힌·멈춘 이슈만 넘긴다`);
    const agent = await requireAgent(ids.agents[key], '받을 에이전트', issue.companyId);
    requireNoOpenBlockers(issue);
    const ra = (await api('GET', `/issues/${issue.id}/recovery-actions`, undefined, { auth: false }))?.active;
    if (ra) throw new Error('board 대기 복구가 걸려 있다 — rewake 로 원 담당에게 돌려주거나 close 로 정리한다');
    await api('PATCH', `/issues/${issue.id}`, { assigneeAgentId: ids.agents[key], status: 'todo', comment: directive(note) }, { auth: false });
    return { target: agent.name, note: oneLine(note, 300), summary: `${agent.name} 에게 넘김` };
  });
}

/**
 * 사람 몫으로 돌린다. blocked 면 unblockDescriptor.owner="board" 로 — 운영자 대기 목록에 뜬다.
 * 댓글은 달지 않는다(열린 이슈의 board 댓글은 담당을 깨워 「아직 사람 대기」 실행만 하나 더 만든다).
 * 진행·검토 중(사람 응답 대기)은 페이퍼클립 화면에 이미 떠 있으니 상태는 두고 기록만 한다. 운영자 알림은 CEO 의 점검 요약 텔레그램에 넣는다.
 */
async function escalate(ref, action) {
  await act('escalate', ref, async (issue) => {
    if (CLOSED.includes(issue.status)) throw new Error(`${issue.identifier} 는 이미 ${issue.status}`);
    if (issue.status === 'blocked') {
      await api('PATCH', `/issues/${issue.id}`, { status: 'blocked', unblockDescriptor: { owner: 'board', action: oneLine(action, 1000) } }, { auth: false });
    }
    return { note: oneLine(action, 300), summary: `운영자 몫${issue.status === 'blocked' ? '으로 표시' : ' (상태 그대로)'} — 텔레그램 요약에 넣는다: ${oneLine(action, 120)}` };
  });
}

/** 닫는다. 닫히는 이슈의 댓글은 아무도 깨우지 않는다. board 대기 복구가 있으면 그것부터 접는다. */
async function close(ref, status, reason) {
  await act('close', ref, async (issue) => {
    if (!CLOSED.includes(status)) throw new Error('상태는 done 또는 cancelled');
    if (CLOSED.includes(issue.status)) throw new Error(`${issue.identifier} 는 이미 ${issue.status}`);
    const ra = (await api('GET', `/issues/${issue.id}/recovery-actions`, undefined, { auth: false }))?.active;
    if (ra) await api('POST', `/issues/${issue.id}/recovery-actions/resolve`, { actionId: ra.id, outcome: 'cancelled', sourceIssueStatus: 'done', resolutionNote: oneLine(reason, 2000) }, { auth: false });
    await api('PATCH', `/issues/${issue.id}`, { status, comment: directive(`정리(${status}) — ${String(reason).trim()}`) }, { auth: false });
    return { status, note: oneLine(reason, 300), summary: `${status}${ra ? ' (board 대기 복구 접음)' : ''}` };
  });
}

async function main() {
  const { values: opt, positionals: [cmd, ...args] } = parseArgs({
    allowPositionals: true,
    options: {
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      evidence: { type: 'string' },
      outcome: { type: 'string', default: 'mixed' },
    },
  });
  const need = (n, usage) => { if (args.length < n || args.slice(0, n).some((a) => !String(a).trim())) throw new Error(`사용법: triage.js ${usage}`); };
  switch (cmd) {
    case 'scan': {
      const company = loadCompany();
      const { agents, entries } = await scan({ company });
      const due = await Promise.all(entries.filter((e) => needsJudgment(e, company.triage)).map((e) => enrich(e, agents)));
      const byId = new Map(due.map((e) => [e.id, e]));
      console.log(renderDigest(entries.map((e) => byId.get(e.id) ?? e), { policy: company.triage, down: downList(agents) }));
      return 0;
    }
    case 'open': {
      const state = readJson(join(OPS, 'token-state.json'), {});
      const r = await maybeOpenTriage({ ceoVariant: state.agents?.ceo?.variant ?? 'primary', force: opt.force, dryRun: opt['dry-run'] });
      console.log(r.opened ? `🧭 ${r.issue} → CEO (판단 필요 ${r.due}건)` : `열지 않음 — ${r.reason}${r.due !== undefined ? ` (판단 필요 ${r.due}건)` : ''}`);
      if (r.description) console.log(`\n${r.description}`);
      return 0;
    }
    case 'rewake':
      need(2, 'rewake <YOU-n> "<지시>" [--evidence "<끊긴 실행이 한 일·안 한 일>"] [--outcome mixed|completed|not_performed]');
      if (!['mixed', 'completed', 'not_performed'].includes(opt.outcome)) throw new Error('--outcome 은 mixed|completed|not_performed');
      await rewake(args[0], args[1], { evidence: opt.evidence, outcome: opt.outcome });
      return 0;
    case 'assign': need(3, 'assign <YOU-n> <sre|reviewer|cmo> "<지시>"'); await assign(args[0], args[1], args[2]); return 0;
    case 'escalate': need(2, 'escalate <YOU-n> "<운영자가 할 일>"'); await escalate(args[0], args[1]); return 0;
    case 'close': need(3, 'close <YOU-n> <done|cancelled> "<사유>"'); await close(args[0], args[1], args[2]); return 0;
    default:
      console.error('사용법: triage.js scan | open [--force] | rewake | assign | escalate | close (파일 머리 주석 참고)');
      return 2;
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().then((c) => process.exit(c ?? 0)).catch((e) => { console.error(`⛔ ${e.message}`); process.exit(1); });
}
