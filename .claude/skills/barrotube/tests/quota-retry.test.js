import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retryGuardRun } from '../scripts/automation/paperclip/quota-retry.js';

const here = dirname(fileURLToPath(import.meta.url));
const now = Date.parse('2026-10-26T04:00:00Z');
function fixture(change = {}) {
  const agent = { id: 'agent', companyId: 'company', status: 'error', adapterConfig: { command: resolve(here, '../scripts/automation/paperclip/quota-bin/codex') }, runtimeConfig: { heartbeat: { wakeOnDemand: true } } };
  const run = { id: 'run', companyId: 'company', agentId: 'agent', status: 'failed', exitCode: 78,
    createdAt: '2026-10-26T03:00:00Z', finishedAt: '2026-10-26T03:01:00Z',
    runnerProfileJson: { adapterDispatch: { adapterType: 'codex_local' } }, contextSnapshot: { issueId: 'issue' },
    stderrExcerpt: 'PAPERCLIP_RESERVE_GUARD: admission denied; selected subscription evidence unavailable. No provider started.\n', stdoutExcerpt: '', usageJson: null };
  const issue = { id: 'issue', companyId: 'company', assigneeAgentId: 'agent', status: 'in_progress' };
  const post = [];
  const data = { agent, run, issue, freshRuns: [run], issueRuns: [{ ...run, id: undefined, runId: run.id }], recovery: { active: null }, activity: [], interactions: [], approvals: [],
    diagnostics: { readiness: { isDependencyReady: true, unresolvedBlockerCount: 0, pendingFinalizeBlockerCount: 0 }, truncated: false, omittedUnauthorizedBlockerCount: 0 }, ...change };
  const api = async (method, path, body) => {
    if (method === 'POST') { post.push({ path, body }); return data.respond ? data.respond(path, body) : { id: 'successor', status: 'queued' }; }
    if (path === '/heartbeat-runs/run') return data.run;
    if (path === '/agents/agent') return data.agent;
    if (path === '/issues/issue') return data.issue;
    if (path.endsWith('/diagnostics/blockers')) return data.diagnostics;
    if (path.endsWith('/interactions')) return data.interactions;
    if (path.endsWith('/approvals')) return data.approvals;
    if (path.endsWith('/recovery-actions')) return data.recovery;
    if (path.endsWith('/activity')) return data.activity;
    if (path.endsWith('/runs')) return data.issueRuns;
    if (path.startsWith('/companies/company/heartbeat-runs?')) return data.freshRuns;
    throw new Error('unexpected test URL');
  };
  const input = { agent: data.agent, runs: [run], stateRecord: { selected: { provider: 'codex', model: 'gpt-6-sol' } }, api, now };
  return { data, input, post };
}

test('proven denied run retries exact server-owned context with a stable idempotency key', async () => {
  const { input, post } = fixture();
  const result = await retryGuardRun(input);
  assert.equal(result.status, 'accepted'); assert.equal(result.successorRunId, 'successor');
  assert.equal(post.length, 1);
  assert.deepEqual(post[0], { path: '/agents/agent/wakeup', body: { source: 'on_demand', triggerDetail: 'manual', reason: 'retry_failed_run', failedRunId: 'run', idempotencyKey: 'quota-resume:run' } });
  const repeated = await retryGuardRun({ ...input, stateRecord: { ...input.stateRecord, guardRetry: result } });
  assert.equal(repeated.status, 'accepted'); assert.equal(post.length, 1);
});

test('generic errors, provider output, usage, foreign account and missing immutable adapter proof never retry', async () => {
  for (const override of [{ exitCode: 1 }, { stderrExcerpt: 'ordinary failure' }, { stdoutExcerpt: '{"type":"event"}' }, { usageJson: { inputTokens: 1 } }, { companyId: 'other' }, { runnerProfileJson: {} }]) {
    const { input, data, post } = fixture(); Object.assign(data.run, override);
    assert.equal((await retryGuardRun(input)).status, 'skipped'); assert.equal(post.length, 0);
  }
});

test('manual pause, disabled wakes, true dependency, pending decision and changed owner never retry', async () => {
  for (const mutate of [
    (f) => { f.data.agent.status = 'paused'; },
    (f) => { f.data.agent.runtimeConfig.heartbeat.wakeOnDemand = false; },
    (f) => { f.data.diagnostics.readiness.unresolvedBlockerCount = 1; },
    (f) => { f.data.interactions = [{ status: 'pending' }]; },
    (f) => { f.data.approvals = [{ status: 'pending' }]; },
    (f) => { f.data.issue.assigneeAgentId = 'new-owner'; },
    (f) => { f.data.issue.status = 'blocked'; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal((await retryGuardRun(f.input)).status, 'skipped'); assert.equal(f.post.length, 0);
  }
});

test('a fresh newer run or existing scheduled retry prevents duplication', async () => {
  for (const where of ['freshRuns', 'issueRuns']) {
    const f = fixture();
    f.data[where].push({ id: 'new', agentId: 'agent', companyId: 'company', status: 'queued', createdAt: '2026-10-26T03:05:00Z' });
    assert.equal((await retryGuardRun(f.input)).status, 'skipped'); assert.equal(f.post.length, 0);
  }
});

function sourceAction(cause) {
  return { id: 'action', companyId: 'company', sourceIssueId: 'issue', returnOwnerAgentId: 'agent', ownerType: 'board', status: 'active', cause, evidence: { runId: 'run' } };
}

test('matching legacy action records proven not-performed outcomes and owns the only continuation', async () => {
  const f = fixture({ recovery: { active: sourceAction('legacy_execution_requires_reconciliation') }, respond: () => ({ recoveryAction: { status: 'resolved' } }) });
  const result = await retryGuardRun(f.input);
  assert.equal(result.status, 'accepted'); assert.equal(f.post.length, 1);
  assert.equal(f.post[0].path, '/issues/issue/recovery-actions/resolve');
  assert.equal(f.post[0].body.executionReconciliation.actionOutcome, 'not_performed');
  assert.equal(f.post[0].body.executionReconciliation.providerStopped, true);
  assert.equal(f.post[0].body.sourceIssueStatus, 'todo');
});

test('blocked source resumes only when latest status activity belongs to this guard recovery', async () => {
  const f = fixture({ recovery: { active: sourceAction('stranded_assigned_issue') }, respond: () => ({ recoveryAction: { status: 'resolved' } }) });
  f.data.issue.status = 'blocked';
  f.data.activity = [{ actorType: 'system', createdAt: '2026-10-26T03:02:00Z', details: { status: 'blocked', recoveryActionId: 'action', latestRunId: 'run', source: 'recovery.reconcile_stranded_assigned_issue' } }];
  assert.equal((await retryGuardRun(f.input)).status, 'accepted');
  assert.equal(f.post[0].body.executionReconciliation, undefined);
  f.post.length = 0; f.data.activity.push({ actorType: 'user', createdAt: '2026-10-26T03:03:00Z', details: { status: 'blocked' } });
  assert.equal((await retryGuardRun(f.input)).status, 'skipped'); assert.equal(f.post.length, 0);
});

test('foreign recovery sources and action causes never resolve', async () => {
  for (const action of [{ ...sourceAction('stranded_assigned_issue'), evidence: { runId: 'other' } }, sourceAction('configuration_incomplete')]) {
    const f = fixture({ recovery: { active: action } });
    assert.equal((await retryGuardRun(f.input)).status, 'skipped'); assert.equal(f.post.length, 0);
  }
});

test('transport failure is contained with bounded per-run retry and no raw secret disclosure', async () => {
  const f = fixture({ respond: () => { throw new Error('SECRET_BODY'); } });
  let state = await retryGuardRun(f.input);
  assert.equal(state.status, 'waiting'); assert.equal(state.attempts, 1);
  assert.equal(Date.parse(state.nextAttemptAt), now + 60_000);
  assert.ok(!JSON.stringify(state).includes('SECRET_BODY'));
  assert.equal((await retryGuardRun({ ...f.input, stateRecord: { ...f.input.stateRecord, guardRetry: state } })).attempts, 1);
  assert.equal(f.post.length, 1);
  state = await retryGuardRun({ ...f.input, now: now + 60_001, stateRecord: { ...f.input.stateRecord, guardRetry: state } });
  state = await retryGuardRun({ ...f.input, now: now + 360_002, stateRecord: { ...f.input.stateRecord, guardRetry: state } });
  assert.equal(state.attempts, 3);
  const stopped = await retryGuardRun({ ...f.input, now: now + 1_300_000, stateRecord: { ...f.input.stateRecord, guardRetry: state } });
  assert.equal(stopped.status, 'exhausted'); assert.equal(f.post.length, 3);
});
