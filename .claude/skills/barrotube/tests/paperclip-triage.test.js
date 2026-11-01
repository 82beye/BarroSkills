// 막힘 점검 계약 — 2026-10-25 운영자 「블럭이 너무 많다 — CEO 가 체크해서 서브에이전트들이 처리하게」.
// 그날 blocked 23건 중 9건이 아무도 다시 깨우지 않아 멈춰 있었다. 고르기·실행은 결정론, 판단만 CEO.
// 어긋나면 CEO 가 같은 표를 하루 열 번 읽거나(토큰), 멈춘 이슈를 끝내 아무도 안 보거나, 거버너가 도는 수리를 끊는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  TITLE, actionRefusal, authFailure, classifyIssue, fingerprint, needsJudgment, renderDigest, triageGate, triageOverrides,
} from '../scripts/automation/paperclip/triage.js';
import { pauseStep } from '../scripts/automation/paperclip/token-governor.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const company = JSON.parse(read('config/paperclip/company.json'));
const policy = { ...company.triage, enabled: true };

const NOW = Date.parse('2026-10-25T06:30:00Z'); // 15:30 KST
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();
const agents = {
  sre: { key: 'sre', name: 'SRE Engineer', kind: 'llm', status: 'error' },
  ceo: { key: 'ceo', name: 'CEO', kind: 'llm', status: 'idle' },
  producer: { key: 'producer', name: 'Producer', kind: 'process', status: 'idle' },
  reviewer: { key: 'reviewer', name: 'Code Reviewer', kind: 'llm', status: 'paused' },
};
const blocked = (over = {}) => ({
  id: over.identifier ?? 'x', identifier: 'YOU-1', title: '[수리] 무엇', status: 'blocked', assigneeAgentId: 'sre', originKind: 'manual',
  blockedTransitionAt: ago(3), updatedAt: ago(3), blockerAttention: { unresolvedBlockerCount: 0 }, unblockDescriptor: null, activeRecoveryAction: null, ...over,
});
const kind = (i) => classifyIssue(i, { agents, now: NOW }).kind;

test('분류 — 2026-10-25 실측 모양: 따라감·운영자 몫·복구 대기·멈춤·자기 몫 대기·기다림', () => {
  const child = classifyIssue(blocked({ identifier: 'YOU-512', title: '운영 · 자동 진단 (doctor)', assigneeAgentId: null, originKind: 'routine_execution',
    blockerAttention: { unresolvedBlockerCount: 1, terminalBlocker: { identifier: 'YOU-322' } } }), { agents, now: NOW });
  assert.deepEqual([child.kind, child.blocker], ['child', 'YOU-322'], '장애를 따라 막힌 회차 이슈는 손대지 않는다');
  assert.equal(kind(blocked({ assigneeAgentId: null, originKind: 'routine_execution' })), 'settle', '막던 이슈가 닫힌 회차 이슈는 거버너 정리 몫');
  const board = classifyIssue(blocked({ unblockDescriptor: { owner: 'board', action: 'Studio 에서 껍데기 영상 삭제' } }), { agents, now: NOW });
  assert.deepEqual([board.kind, board.action], ['board', 'Studio 에서 껍데기 영상 삭제']);
  const rec = classifyIssue(blocked({ assigneeAgentId: 'sre', activeRecoveryAction: { id: 'r1', ownerType: 'board', cause: 'stranded_assigned_issue', returnOwnerAgentId: 'sre' } }), { agents, now: NOW });
  assert.deepEqual([rec.kind, rec.assignee, rec.invokable], ['recovery', 'sre', true], 'error 상태는 다시 깨울 수 있다');
  const strand = classifyIssue(blocked(), { agents, now: NOW });
  assert.deepEqual([strand.kind, strand.selfOwned], ['stranded', false], 'YOU-553: 실행 취소 뒤 막힌 것 없이 blocked');
  assert.equal(classifyIssue(blocked({ unblockDescriptor: { owner: { agentId: 'sre' }, action: '운영자 승인' } }), { agents, now: NOW }).selfOwned, true, 'YOU-558: 자기 몫으로 건 사람 대기');
  assert.equal(kind(blocked({ assigneeAgentId: 'ceo', blockerAttention: { unresolvedBlockerCount: 1 } })), 'waiting');
  assert.equal(kind(blocked({ title: `${TITLE} 10-25 09:00 — 판단 필요 3건`, assigneeAgentId: 'ceo' })), 'triage', '점검 이슈 자신은 표에 안 올린다');
});

test('분류 — 진행 중은 도는 실행이 없는 LLM 담당만, 검토 중은 board 응답 대기만', () => {
  const ip = (over) => blocked({ status: 'in_progress', activeRun: null, ...over });
  assert.equal(kind(ip({})), 'stalled', 'YOU-618: SRE 실행이 인증 실패로 끝나고 아무것도 안 돈다');
  assert.equal(kind(ip({ activeRun: { id: 'r' } })), 'working');
  assert.equal(kind(ip({ assigneeAgentId: 'producer' })), 'working', 'process 담당은 파이프라인이 따로 돈다');
  const review = classifyIssue(blocked({ status: 'in_review', reviewAttention: { paths: [{ responder: 'Board', label: 'Pending request confirmation', since: ago(80) }] } }), { agents, now: NOW });
  assert.equal(review.kind, 'board');
  assert.ok(review.ageH > 79, '검토 대기 나이는 응답을 기다린 때부터');
  assert.equal(kind(blocked({ status: 'in_review', reviewAttention: { paths: [] } })), 'working');
});

test('판단 필요 — 막힌 지 1시간부터, 담당이 멈춰 있으면 돌아온 뒤, 운영자 몫은 3일·기다림은 2일 묵으면', () => {
  const e = (over) => ({ kind: 'stranded', ageH: 2, invokable: true, ...over });
  assert.equal(needsJudgment(e({ ageH: 0.5 }), policy), false, '페이퍼클립 자동 복구·담당 진행과 겹치지 않게');
  assert.equal(needsJudgment(e({}), policy), true);
  assert.equal(needsJudgment(e({ kind: 'recovery', invokable: false }), policy), false, '멈춘 담당은 다시 깨워도 못 돈다');
  assert.equal(needsJudgment(e({ invokable: null }), policy), true, '담당이 없으면 맡길 사람을 정한다');
  assert.equal(needsJudgment(e({ kind: 'stalled' }), policy), true);
  assert.equal(needsJudgment(e({ kind: 'waiting', ageH: 47 }), policy), false);
  assert.equal(needsJudgment(e({ kind: 'waiting', ageH: 49 }), policy), true);
  assert.equal(needsJudgment(e({ kind: 'board', ageH: 71 }), policy), false);
  assert.equal(needsJudgment(e({ kind: 'board', ageH: 73 }), policy), true);
  for (const k of ['child', 'settle', 'working', 'triage']) assert.equal(needsJudgment(e({ kind: k, ageH: 500 }), policy), false, k);
});

test('CEO 깨우기 — 하루 2회·4시간 간격·새 항목만, 열린 점검이 있거나 CEO 가 멈췄으면 열지 않는다', () => {
  const due = { identifier: 'YOU-553', kind: 'stranded', ageH: 3, invokable: true, updatedAt: ago(3) };
  const gate = (over = {}) => triageGate({ entries: [due], policy, now: NOW, ...over });
  assert.equal(gate().open, true);
  assert.equal(gate({ policy: { ...policy, enabled: false } }).open, false);
  assert.equal(gate({ entries: [{ ...due, kind: 'child' }] }).reason, '판단 필요 없음');
  assert.match(gate({ openIssue: { identifier: 'YOU-700' } }).reason, /열린 점검 YOU-700/);
  const paused = gate({ ceoInvokable: false });
  assert.deepEqual([paused.open, paused.reason, paused.due.length], [false, 'CEO 멈춤', 1], '멈춘 CEO 대신 운영자에게 알린다');
  assert.equal(gate({ state: { day: '2026-10-25', openedToday: 2 } }).open, false, '하루 2회까지');
  assert.equal(gate({ state: { day: '2026-10-24', openedToday: 2 } }).open, true, '어제 횟수는 세지 않는다');
  assert.equal(gate({ state: { lastOpenedAt: ago(3) } }).open, false, '4시간 간격');
  assert.equal(gate({ state: { seen: { [fingerprint(due)]: ago(5) } } }).open, false, '지난 점검에서 본 그대로');
  assert.equal(gate({ state: { seen: { [fingerprint(due)]: ago(25) } } }).open, true, '하루 지나면 다시 본다');
  assert.equal(gate({ acted: { 'YOU-553': Date.parse(due.updatedAt) - 30_000 } }).open, false, 'CEO 처리가 바꾼 updatedAt 은 새 일이 아니다');
  assert.equal(gate({ acted: { 'YOU-553': Date.parse(due.updatedAt) - 3_600_000 } }).open, true, '처리 뒤 담당이 다시 막았으면 새 일이다');
  const forced = gate({ force: true, state: { day: '2026-10-25', openedToday: 9, seen: { [fingerprint(due)]: ago(1) } } });
  assert.equal(forced.open, true, '--force 는 횟수·간격·새 항목을 무시');
  assert.equal(gate({ force: true, openIssue: { id: 'o' } }).open, false, '--force 여도 열린 점검 위에 또 열지 않는다');
});

test('점검은 절약 모델 — CEO 가 기본(Opus)일 때만 같은 공급자의 가벼운 모델로, 거버너가 바꾼 변형은 그대로', () => {
  assert.deepEqual(triageOverrides(company, 'primary'), { adapterConfig: { model: company.agents.ceo.economy.model, effort: company.agents.ceo.economy.effort } });
  assert.equal(triageOverrides(company, 'economy'), null);
  assert.equal(triageOverrides(company, 'alternate'), null, 'Codex 로 바뀐 CEO 에 Claude 모델을 얹지 않는다');
  assert.equal(triageOverrides({ ...company, triage: { ...company.triage, variant: 'primary' } }, 'primary'), null);
});

test('AI 연결 끊김 — 마지막 실행이 인증 실패면 그 담당에게 다시 맡기지 않는다 (2026-10-25 SRE claude_auth_required)', () => {
  assert.equal(authFailure({ status: 'failed', errorCode: 'claude_auth_required' }), true);
  assert.equal(authFailure({ status: 'failed', errorCode: 'cancelled' }), false);
  assert.equal(authFailure({ status: 'succeeded', errorCode: null }), false);
  assert.equal(authFailure(null), false);
  const e = classifyIssue(blocked(), { agents: { sre: { ...agents.sre, authDown: { code: 'claude_auth_required' } } }, now: NOW });
  assert.equal(e.authDown, true);
  assert.match(renderDigest([{ ...e, lastComment: null, lastRun: null }], { policy, now: NOW }), /SRE Engineer\(error·AI 연결 끊김\)/);
});

test('처리 상한 — 같은 이슈 다시 맡기기는 24시간에 2번, 그 뒤는 사람에게', () => {
  const rows = [{ issue: 'YOU-553', action: 'rewake' }, { issue: 'YOU-553', action: 'assign' }, { issue: 'YOU-554', action: 'rewake' }];
  assert.match(actionRefusal(rows, { issue: 'YOU-553', action: 'rewake' }, policy), /escalate/);
  assert.match(actionRefusal(rows, { issue: 'YOU-553', action: 'assign' }, policy), /2번/);
  assert.equal(actionRefusal(rows, { issue: 'YOU-553', action: 'escalate' }, policy), null, '사람에게 넘기기·정리는 막지 않는다');
  assert.equal(actionRefusal(rows, { issue: 'YOU-554', action: 'rewake' }, policy), null);
  assert.match(actionRefusal(Array(policy.max_actions_per_day).fill({ issue: 'Y', action: 'close' }), { issue: 'YOU-1', action: 'close' }, policy), /건까지/);
});

test('점검 표 — 판단 필요는 마지막 소식과 함께, 따라감은 막던 이슈별로 한 줄', () => {
  const entries = [
    { id: '1', identifier: 'YOU-567', title: '[장애] PX-20261022-slot_omnibus', kind: 'recovery', cause: 'stranded_assigned_issue', assignee: 'sre', assigneeName: 'SRE Engineer', assigneeStatus: 'idle', invokable: true, ageH: 75,
      lastComment: { who: 'system', at: ago(75), text: 'Paperclip cannot safely continue automatic recovery' }, lastRun: null },
    { id: '2', identifier: 'YOU-512', title: '운영 · 자동 진단', kind: 'child', blocker: 'YOU-322', ageH: 140 },
    { id: '3', identifier: 'YOU-529', title: '운영 · 자동 진단', kind: 'child', blocker: 'YOU-322', ageH: 110 },
    { id: '4', identifier: 'YOU-619', title: '운영 · 경쟁 인텔', kind: 'working', ageH: 0 },
  ];
  const md = renderDigest(entries, { policy, now: NOW, down: [{ name: 'SRE Engineer', code: 'claude_auth_required', at: ago(4) }] });
  assert.match(md, /멈춘 이슈 3건 중 판단 필요 1건/);
  assert.match(md, /⚠ \*\*SRE Engineer AI 연결 끊김\*\* \(claude_auth_required, 10-25 11:30\)/, 'YOU-618: 연결이 끊긴 담당은 표 머리에');
  assert.match(md, /\*\*YOU-567\*\* .*들어올 때 담당이 멈춰 있었다 · SRE Engineer\(idle\) · 3일/);
  assert.match(md, /마지막 댓글 system 10-22 /, '시각은 KST');
  assert.match(md, /- YOU-322 ← YOU-512 · YOU-529/);
  assert.doesNotMatch(md, /YOU-619/, '도는 일은 표에 안 올린다');
});

// 2026-10-22: 상한으로 멈춘 SRE 를 운영자가 켰는데 15분 뒤 거버너가 다시 멈춰 도는 수리를 끊었다 → 정합 잠금(YOU-577).
test('거버너 — 실행 중이면 멈추지 않고, 사람이 다시 켠 날은 다시 멈추지 않는다', () => {
  const date = '2026-10-22';
  assert.equal(pauseStep({ variant: 'paused', status: 'idle', was: {}, date }).act, 'pause');
  assert.equal(pauseStep({ variant: 'paused', status: 'running', was: {}, date }).act, 'wait-run', '끝난 뒤 다음 회차에 멈춘다');
  const human = pauseStep({ variant: 'paused', status: 'idle', was: { pausedBy: 'governor-cap' }, date });
  assert.deepEqual(human, { act: 'human', humanDay: date }, '내가 멈춘 것을 사람이 켰다');
  assert.equal(pauseStep({ variant: 'paused', status: 'running', was: { pausedBy: null, humanOverrideDay: date }, date }).act, 'human', '그날은 계속');
  assert.equal(pauseStep({ variant: 'paused', status: 'idle', was: { humanOverrideDay: date }, date: '2026-10-23' }).act, 'pause', '다음 날은 다시 규칙대로');
  assert.equal(pauseStep({ variant: 'primary', status: 'paused', was: { pausedBy: 'governor-cap' }, date }).act, 'resume');
  assert.equal(pauseStep({ variant: 'primary', status: 'paused', was: { pausedBy: null }, date }).act, 'none', '사람이 멈춘 것은 건드리지 않는다');
  assert.equal(pauseStep({ variant: 'paused', status: 'paused', was: { pausedBy: 'governor' }, date }).act, 'none');
});

test('편성·지침 — 점검 정책이 정본에 있고, CEO 지침에 다섯 결정과 도구가, 맡길 곳은 현역 LLM 서브에이전트만', () => {
  const t = company.triage;
  assert.equal(typeof t.enabled, 'boolean');
  assert.ok(t.max_per_day >= 1 && t.max_per_day <= 3, 'CEO 는 하루 몇 번만 깨운다');
  assert.ok(t.min_stuck_minutes >= 30 && t.min_interval_hours >= 2 && t.rewake_per_issue_per_day <= 3);
  for (const k of t.assign_to) {
    assert.equal(company.agents[k]?.kind, 'llm', `${k}: process 담당에게 넘기면 이슈 본문이 파이프라인 명령이 된다`);
    assert.notEqual(k, 'ceo');
  }
  const ceo = read('scripts/automation/paperclip/instructions/ceo.md');
  assert.match(ceo, /## 막힘 점검/);
  for (const cmd of ['rewake', 'assign', 'escalate', 'close']) assert.match(ceo, new RegExp(`node "\\$T" ${cmd} <YOU-n>`), cmd);
  assert.match(ceo, /claude_auth_required/, '인증 오류는 재개하지 않는다');
  assert.match(read('scripts/automation/paperclip/token-governor.js'), /maybeOpenTriage\(\{ ceoVariant \}\)/, '거버너 순회가 점검 문을 연다');
});
