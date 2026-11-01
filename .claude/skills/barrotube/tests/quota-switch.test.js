import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, unlinkSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { profilesFor, configFor, selectProfile, stickySelection, runningReservationsFor } from '../scripts/automation/paperclip/quota-switch.js';
import { atomicWrite, read, reserve, finishReservation, reconcileReservations, withLock, withLockWait } from '../scripts/automation/paperclip/quota-admission.js';

const NOW = Date.now();
const stamp = (offset = 0) => new Date(NOW + offset).toISOString();
const measurement = (used = 50, extra = {}) => ({ weekUsedPercent: used, weekResetAt: stamp(6 * 86_400_000), sessionUsedPercent: 10, measuredAt: stamp(), source: 'test-subscription', modelWindows: [], subscriptionVerified: true, identityHash: 'same-subscription', ...extra });
const agent = (extra = {}) => ({ id: 'engineer', companyId: 'company-one', role: 'engineer', status: 'idle', adapterType: 'claude_local', adapterConfig: { model: 'claude-opus-4-6' }, runtimeConfig: {}, ...extra });

function fixture(t, state = {}, ledger = { reservations: [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'paperclip-admission-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  atomicWrite(join(dir, 'quota-switch-state.json'), {
    enabled: true, estimates: {}, runningReservations: [],
    evidence: { codex: { ok: true, identityHash: 'same-subscription' }, claude: { ok: true, identityHash: 'claude-subscription' } },
    ...state,
  });
  atomicWrite(join(dir, 'quota-admissions.json'), ledger);
  return dir;
}
const admit = (dir, extra = {}) => reserve({ id: 'new-reservation', provider: 'codex', model: 'gpt-6.1-sol', identityHash: 'same-subscription', measurement: measurement(), agentId: 'new-agent', runId: 'new-run', now: NOW, dir, ...extra });

test('waiting runs do not block admission, while running and wrapper reservations still count', (t) => {
  const inventory = [agent({ adapterType: 'codex_local', adapterConfig: { model: 'gpt-6.1-sol' } })];
  const runs = ['queued', 'scheduled_retry', 'succeeded'].map(status => ({ id: status, agentId: 'engineer', status }));
  const dir = fixture(t, { runningReservations: runningReservationsFor(runs, inventory, {}) });
  assert.equal(admit(dir, { measurement: measurement(56) }).allow, true);
  runs.push({ id: 'other-live-run', agentId: 'engineer', status: 'running' });
  const state = read(join(dir, 'quota-switch-state.json'));
  state.runningReservations = runningReservationsFor(runs, inventory, {});
  atomicWrite(join(dir, 'quota-switch-state.json'), state);
  assert.deepEqual(state.runningReservations.map(r => r.runId), ['other-live-run']);
  const result = admit(dir, { id: 'next', runId: 'next', measurement: measurement(56) });
  assert.equal(result.pendingPercent, 10);
  assert.equal(result.allow, false);
});

test('role tiers replace flagship defaults and preserve the original reviewer family', () => {
  assert.deepEqual(profilesFor(agent()), [
    { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
    { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
  ]);
  for (const role of ['ceo', 'pm', 'general']) {
    assert.equal(profilesFor(agent({ role })).at(-1).model, 'gpt-6.1-sol');
    assert.equal(profilesFor(agent({ role })).at(-1).effort, 'medium');
  }
  assert.equal(profilesFor(agent({ role: 'researcher' })).at(-1).model, 'gpt-6-luna');
  assert.deepEqual(profilesFor(agent({ role: 'metadata-writer' }))[0], { provider: 'claude', model: 'claude-haiku-4-5', effort: 'low' });
  assert.equal(profilesFor(agent({ adapterType: 'codex_local', adapterConfig: { model: 'gpt-6-astra' } }))[0].model, 'gpt-6.1-sol');
});

test('config preserves workspace and instructions, converts provider knobs, and installs quota wrapper', () => {
  const original = agent({ adapterConfig: {
    model: 'claude-opus-4-6', cwd: '/work/OneTank', instructionsFilePath: '/managed/AGENTS.md',
    promptTemplate: '{{task}}', timeoutSec: 1800, effort: 'max', maxTurnsPerRun: 20,
    dangerouslySkipPermissions: true, env: { SENTINEL: 'server-managed' },
  }, runtimeConfig: { heartbeat: { intervalSec: 3600, enabled: true, maxConcurrentRuns: 4 }, aiConnection: { mode: 'responsible_user', provider: 'anthropic', method: 'subscription' }, other: 'retained' } });
  const saved = structuredClone(original);
  const patch = configFor(original, { provider: 'codex', model: 'gpt-6.1-sol' });
  assert.equal(patch.adapterType, 'codex_local');
  assert.equal(patch.replaceAdapterConfig, true);
  assert.equal(patch.adapterConfig.cwd, '/work/OneTank');
  assert.equal(patch.adapterConfig.instructionsFilePath, '/managed/AGENTS.md');
  assert.equal(patch.adapterConfig.timeoutSec, 1800);
  assert.equal(patch.adapterConfig.promptTemplate, '{{task}}');
  assert.match(patch.adapterConfig.command, /\/quota-bin\/codex$/);
  assert.equal(patch.adapterConfig.engine, 'cli');
  assert.equal(patch.adapterConfig.dangerouslyBypassApprovalsAndSandbox, true);
  assert.equal('env' in patch.adapterConfig, false);
  assert.equal('effort' in patch.adapterConfig, false);
  assert.equal('maxTurnsPerRun' in patch.adapterConfig, false);
  assert.equal(patch.runtimeConfig.heartbeat.intervalSec, 3600);
  assert.equal(patch.runtimeConfig.heartbeat.maxConcurrentRuns, 1);
  assert.equal(patch.runtimeConfig.other, 'retained');
  assert.deepEqual(patch.runtimeConfig.aiConnection, { mode: 'responsible_user', provider: 'openai', method: 'subscription' });
  assert.deepEqual(original, saved);
});

test('managed provider switch avoids config overrides and retains quota protection', () => {
  const original = agent({ runtimeConfig: { aiConnection: { mode: 'responsible_user', provider: 'anthropic', method: 'subscription' } } });
  const patch = configFor(original, { provider: 'codex', model: 'gpt-6-astra' });
  assert.deepEqual(patch.adapterConfig.extraArgs, ['--skip-git-repo-check']);
  assert.match(patch.adapterConfig.command, /\/quota-bin\/codex$/);
  assert.equal(patch.runtimeConfig.aiConnection.provider, 'openai');
  assert.equal(patch.replaceAdapterConfig, true);
  // Unmanaged CLI configurations keep their existing native arguments.
  assert.ok(configFor(agent(), { provider: 'codex', model: 'gpt-6-astra' }).adapterConfig.extraArgs.includes('-c'));
});

test('selection respects reserve and replaces a healthy flagship with the role tier', () => {
  const original = agent({ role: 'ceo' });
  const profiles = profilesFor(original);
  let selected = selectProfile(original, profiles, { claude: measurement(88), codex: measurement(25) }, {}, [], NOW).selected;
  assert.equal(selected.provider, 'codex');
  assert.equal(selected.model, 'gpt-6.1-sol');
  assert.equal(selectProfile(original, profiles, { claude: measurement(88), codex: measurement(70) }, {}, [], NOW).selected, null);
  assert.equal(selectProfile(original, profiles, { claude: measurement(88) }, {}, [], NOW).selected, null);
  const current = agent({ adapterType: 'codex_local', adapterConfig: { model: 'gpt-6-astra' } });
  selected = selectProfile(current, profiles, { claude: measurement(10), codex: measurement(25) }, {}, [], NOW).selected;
  assert.equal(selected.provider, 'claude');
  assert.equal(selected.model, 'claude-sonnet-5-5');
});

test('model cost estimates and reservations affect selection; QA retains its independent family contract', () => {
  const original = agent();
  const providers = { claude: measurement(50), codex: measurement(20) };
  const estimates = { claude: { models: { 'claude-sonnet-5-5': { percentBudget: 1 } } }, codex: { models: { 'gpt-6.1-sol': { percentBudget: 10 } } } };
  assert.equal(selectProfile(original, profilesFor(original), providers, estimates, [], NOW).selected.model, 'claude-sonnet-5-5');
  const qa = agent({ role: 'qa' });
  assert.equal(selectProfile(qa, profilesFor(qa), { claude: measurement(88), codex: measurement(20) }, {}, [], NOW).selected, null);
  const pending = [{ id: 'other-company-run', provider: 'codex', percent: 20, status: 'running' }];
  assert.equal(selectProfile(original, profilesFor(original), { claude: measurement(88), codex: measurement(45) }, {}, pending, NOW).selected, null);
});

test('reset pacing spreads the remaining shared budget and recalculates after reset', () => {
  const original = agent();
  const profiles = profilesFor(original);
  const providers = { claude: measurement(20, { weekResetAt: stamp(86_400_000) }), codex: measurement(20) };
  let result = selectProfile(original, profiles, providers, {}, [], NOW);
  assert.equal(result.selected.provider, 'claude');
  assert.equal(result.selected.daysUntilReset, 1);
  assert.equal(result.selected.dailyBudgetPercent, 45);
  providers.claude = measurement(92);
  assert.equal(selectProfile(original, profiles, providers, {}, [], NOW).selected.provider, 'codex');
  providers.claude = measurement(0, { weekResetAt: stamp(7 * 86_400_000) });
  assert.equal(selectProfile(original, profiles, providers, {}, [], NOW).selected.provider, 'claude');
  providers.claude = measurement(0, { weekResetAt: null, weeklyWindowVerified: true });
  result = selectProfile(original, profiles, providers, {}, [], NOW);
  assert.equal(result.candidates[0].daysUntilReset, null);
  assert.equal(result.candidates[0].dailyBudgetPercent, 65 / 7);
});

test('role effort overrides inherited high while preserving paused status and permissions', () => {
  const original = agent({ status: 'paused', adapterConfig: { model: 'claude-opus-5-5', effort: 'high', dangerouslySkipPermissions: false } });
  const patch = configFor(original, profilesFor(original)[0]);
  assert.equal(patch.adapterConfig.effort, 'medium');
  assert.equal(patch.adapterConfig.dangerouslySkipPermissions, false);
  assert.equal('status' in patch, false);
  assert.equal(configFor(original, profilesFor(original)[1]).adapterConfig.modelReasoningEffort, 'medium');
});

test('admission refuses uninitialized, unproven, and mismatched accounts before writing a reservation', (t) => {
  const dir = fixture(t);
  assert.throws(() => admit(dir, { identityHash: 'different-subscription' }), /does not match/);
  assert.equal(read(join(dir, 'quota-admissions.json')).reservations.length, 0);
  assert.throws(() => admit(dir, { measurement: measurement(10, { subscriptionVerified: false }) }), /does not match/);
  assert.throws(() => admit(dir, { measurement: measurement(10, { identityHash: undefined }) }), /does not match/);
  atomicWrite(join(dir, 'quota-switch-state.json'), { enabled: false });
  assert.throws(() => admit(dir), /not initialized/);
});

test('a separately verified selected subscription uses its own measurement and reservation ledger', (t) => {
  const dir = fixture(t, {}, { reservations: [{ id: 'host-reservation', identityHash: 'same-subscription', provider: 'codex', percent: 40, status: 'running' }] });
  const result = admit(dir, { identityHash: 'other-subscription', measurement: measurement(50, { identityHash: 'other-subscription' }) });
  assert.equal(result.allow, true);
  assert.equal(result.pendingPercent, 0);
  assert.equal(read(join(dir, 'quota-admissions.json')).reservations.length, 2);
  const host = admit(dir, { id: 'host-new' });
  assert.equal(host.allow, false);
  assert.equal(host.pendingPercent, 40);
});

test('all companies sharing one account compete for the same atomic reserve budget', (t) => {
  const dir = fixture(t);
  for (let i = 0; i < 3; i++) {
    const result = admit(dir, { id: `reservation-${i}`, agentId: `company-${i}-ceo`, runId: `company-${i}-run` });
    assert.equal(result.allow, true);
    assert.equal(result.projectedUsedPercent, 55 + i * 5);
  }
  const blocked = admit(dir, { id: 'company-four', agentId: 'company-four-pm' });
  assert.equal(blocked.allow, false);
  assert.equal(blocked.pendingPercent, 15);
  assert.equal(read(join(dir, 'quota-admissions.json')).reservations.length, 3);
  assert.throws(() => admit(dir, { id: 'reservation-0' }), /already exists/);
});

test('existing runs in every company are counted once alongside admitted runs, including unknown account runs', (t) => {
  const existing = { id: 'admitted', provider: 'codex', model: 'gpt-6.1-sol', identityHash: 'same-subscription', runId: 'run-one', percent: 5, status: 'running' };
  const dir = fixture(t, { runningReservations: [
    { id: 'run-one', runId: 'run-one', provider: 'codex', percent: 5, status: 'running' },
    { id: 'run-two', runId: 'run-two', provider: 'codex', percent: 5, status: 'running' },
    { id: 'new-run', runId: 'new-run', provider: 'codex', percent: 5, status: 'running' },
  ] }, { reservations: [existing] });
  const result = admit(dir);
  assert.equal(result.allow, true);
  assert.equal(result.pendingPercent, 10);
  assert.equal(result.projectedUsedPercent, 65);
});

test('active reservations never expire from age, expiresAt, reset, or dead wrapper PID', (t) => {
  const dir = fixture(t, {}, { reservations: [{ id: 'active-old', identityHash: 'same-subscription', provider: 'codex', percent: 15, status: 'running', pid: 99999999, startedAt: stamp(-8 * 86_400_000), expiresAt: stamp(-1), weekResetAt: stamp(-1) }] });
  const result = admit(dir);
  assert.equal(result.allow, false);
  assert.equal(result.pendingPercent, 15);
  assert.equal(read(join(dir, 'quota-admissions.json')).reservations.length, 1);
});

test('finishing retains the charge until a later fresh observation can include completed consumption', (t) => {
  const dir = fixture(t);
  assert.equal(admit(dir).allow, true);
  finishReservation('new-reservation', dir);
  const finished = read(join(dir, 'quota-admissions.json')).reservations[0];
  assert.equal(finished.status, 'unsettled');
  assert.ok(finished.finishedAt);
  assert.equal(admit(dir, { id: 'second', runId: 'second-run' }).pendingPercent, 5);
  const finishAt = Date.parse(finished.finishedAt);
  const later = Math.max(NOW, finishAt + 60_001);
  const result = admit(dir, { id: 'third', runId: 'third-run', now: later, measurement: measurement(55, { measuredAt: new Date(later).toISOString() }) });
  assert.equal(result.allow, true);
  assert.equal(result.pendingPercent, 5);
  assert.equal(read(join(dir, 'quota-admissions.json')).reservations.some(r => r.id === 'new-reservation'), false);
});

test('invalid measurement cannot settle reservations or grant new work', (t) => {
  const dir = fixture(t, {}, { reservations: [{ id: 'finished', identityHash: 'same-subscription', provider: 'codex', percent: 10, status: 'unsettled', finishedAt: stamp(-120_000) }] });
  for (const measuredAt of [stamp(1), stamp(-16 * 60_000), 'invalid']) {
    assert.equal(admit(dir, { measurement: measurement(10, { measuredAt }) }).allow, false);
    assert.equal(read(join(dir, 'quota-admissions.json')).reservations.length, 1);
  }
});

test('lock holds during sync and async work, rejects live contenders, and releases on errors', async (t) => {
  const dir = fixture(t);
  const lock = join(dir, 'test.lock');
  assert.throws(() => withLock(lock, () => { assert.throws(() => withLock(lock, () => {}), /busy/); throw new Error('work failed'); }), /work failed/);
  assert.equal(existsSync(lock), false);
  let unlock;
  const pending = withLock(lock, () => new Promise(resolve => { unlock = resolve; }));
  assert.equal(existsSync(lock), true);
  assert.throws(() => withLock(lock, () => {}), /busy/);
  unlock('done');
  assert.equal(await pending, 'done');
  assert.equal(existsSync(lock), false);
  await assert.rejects(withLock(lock, async () => { throw new Error('async failed'); }), /async failed/);
  assert.equal(existsSync(lock), false);
});

test('lock reclaims a confirmed dead owner, rejects initializing locks, and serializes recovery', (t) => {
  const dir = fixture(t);
  const lock = join(dir, 'test.lock');
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(child.status, 0);
  writeFileSync(lock, String(child.pid));
  assert.equal(withLock(lock, () => 42), 42);
  assert.equal(existsSync(lock), false);
  writeFileSync(lock, '');
  assert.throws(() => withLock(lock, () => {}), /initializing/);
  writeFileSync(`${lock}.recovery`, String(process.pid));
  assert.throws(() => withLock(lock, () => {}), /recovery is busy/);
});

test('a successor lock cannot be removed if the old owner exits during its liveness check', (t) => {
  const dir = fixture(t);
  const lock = join(dir, 'test.lock');
  const oldPid = 99999999;
  writeFileSync(lock, String(oldPid));
  const realKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid !== oldPid) return realKill(pid, signal);
    // Keep the prior inode allocated while substituting a new live owner.
    renameSync(lock, `${lock}.old`);
    writeFileSync(lock, String(process.pid));
    throw Object.assign(new Error('old owner exited'), { code: 'ESRCH' });
  };
  try { assert.throws(() => withLock(lock, () => assert.fail('must not acquire')), /busy|acquire/); }
  finally { process.kill = realKill; }
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  unlinkSync(lock);
});

test('concurrent processes cannot admit more than the account reserve allows', async (t) => {
  const dir = fixture(t);
  const moduleUrl = new URL('../scripts/automation/paperclip/quota-admission.js', import.meta.url).href;
  const source = `
    import { reserve } from ${JSON.stringify(moduleUrl)};
    const input = JSON.parse(process.argv[1]);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { console.log(JSON.stringify(reserve(input))); process.exit(0); }
      catch (e) {
        if (!/busy|initializing|acquire/.test(e.message)) throw e;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    throw new Error('contention did not settle');
  `;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify({ id: `parallel-${i}`, provider: 'codex', model: 'gpt-6.1-sol', identityHash: 'same-subscription', measurement: measurement(), agentId: `company-${i}-agent`, runId: `company-${i}-run`, now: NOW, dir })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => { if (code !== 0) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); } } });
  })));
  assert.equal(results.filter(r => r.allow).length, 3);
  assert.equal(read(join(dir, 'quota-admissions.json')).reservations.length, 3);
});

const abandoned = (extra = {}) => ({ id: 'abandoned', provider: 'codex', model: 'gpt-6.1-sol', identityHash: 'same-subscription', agentId: 'old-agent', runId: 'old-run', pid: 99999999, status: 'running', percent: 10, startedAt: stamp(-120_000), ...extra });
const terminalRun = (extra = {}) => ({ id: 'old-run', agentId: 'old-agent', companyId: 'old-company', status: 'succeeded', finishedAt: stamp(-90_000), ...extra });

test('reconciliation requires dead wrapper and exact terminal run then keeps 60 seconds of settlement', async (t) => {
  const dir = fixture(t, {}, { reservations: [abandoned()] });
  const result = await reconcileReservations({ dir, now: NOW, getRun: async id => { assert.equal(id, 'old-run'); return terminalRun(); } });
  assert.deepEqual(result.markedUnsettled, ['abandoned']);
  const entry = read(join(dir, 'quota-admissions.json')).reservations[0];
  assert.equal(entry.status, 'unsettled');
  assert.equal(entry.finishedAt, stamp());
  assert.equal(entry.terminalProof.status, 'succeeded');
  const justBefore = admit(dir, { now: NOW + 60_000, measurement: measurement(55, { measuredAt: stamp(60_000) }) });
  assert.equal(justBefore.pendingPercent, 10);
  assert.equal(justBefore.allow, false);
  const after = admit(dir, { now: NOW + 60_001, measurement: measurement(55, { measuredAt: stamp(60_001) }) });
  assert.equal(after.pendingPercent, 0);
  assert.equal(after.allow, true);
});

test('reconciliation retains no-run, live owner, queued, retry, unavailable, and mismatched proof records', async (t) => {
  const rows = [
    abandoned({ id: 'no-run', runId: null }),
    abandoned({ id: 'live', runId: 'live', pid: process.pid }),
    abandoned({ id: 'queued', runId: 'queued' }),
    abandoned({ id: 'retry', runId: 'retry' }),
    abandoned({ id: 'missing', runId: 'missing' }),
    abandoned({ id: 'mismatch', runId: 'mismatch', companyId: 'expected-company' }),
  ];
  const dir = fixture(t, {}, { reservations: rows });
  const result = await reconcileReservations({ dir, now: NOW, getRun: async id => {
    assert.notEqual(id, 'live');
    if (id === 'missing') throw new Error('not found');
    return terminalRun({ id, status: id === 'queued' ? 'queued' : id === 'retry' ? 'scheduled_retry' : 'succeeded' });
  } });
  assert.deepEqual(result.markedUnsettled, []);
  assert.deepEqual(Object.fromEntries(result.retained.map(r => [r.id, r.reason])), {
    'no-run': 'no-run-id', live: 'owner-live-or-unknown', queued: 'run-not-terminal', retry: 'run-not-terminal', missing: 'run-proof-unavailable', mismatch: 'run-proof-mismatch',
  });
  assert.deepEqual(read(join(dir, 'quota-admissions.json')).reservations, rows);
});

test('terminal run finish must be valid, not future, and after the matching reservation started', async (t) => {
  for (const finishedAt of ['invalid', stamp(1), stamp(-120_001)]) {
    const dir = fixture(t, {}, { reservations: [abandoned()] });
    const result = await reconcileReservations({ dir, now: NOW, getRun: async () => terminalRun({ finishedAt }) });
    assert.deepEqual(result.markedUnsettled, []);
    assert.equal(result.retained[0].reason, 'invalid-run-finish-time');
  }
});

test('reconciliation does not overwrite concurrent ledger changes or probe while holding admission lock', async (t) => {
  const dir = fixture(t, {}, { reservations: [abandoned()] });
  const result = await reconcileReservations({ dir, now: NOW, getRun: async () => {
    withLock(join(dir, 'quota-admission.lock'), () => {
      const ledger = read(join(dir, 'quota-admissions.json'));
      ledger.reservations[0].pid = process.pid;
      atomicWrite(join(dir, 'quota-admissions.json'), ledger);
    });
    return terminalRun();
  } });
  assert.deepEqual(result.markedUnsettled, []);
  assert.equal(result.retained[0].reason, 'reservation-changed');
  assert.equal(read(join(dir, 'quota-admissions.json')).reservations[0].status, 'running');
});

test('reconciliation rechecks process liveness after proof and retains permission-unknown owners', async (t) => {
  const dir = fixture(t, {}, { reservations: [abandoned()] });
  const realKill = process.kill;
  let calls = 0;
  process.kill = (pid, signal) => {
    if (pid !== 99999999) return realKill(pid, signal);
    calls++;
    if (calls === 1) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    throw Object.assign(new Error('unknown permission'), { code: 'EPERM' });
  };
  try {
    const result = await reconcileReservations({ dir, now: NOW, getRun: async () => terminalRun() });
    assert.deepEqual(result.markedUnsettled, []);
    assert.equal(result.retained[0].reason, 'owner-live-or-unknown');
  } finally { process.kill = realKill; }
});

test('waiting lock acquires after a live owner releases and still fails fast without a wait budget', async (t) => {
  const dir = fixture(t);
  const lock = join(dir, 'wait.lock');
  let unlock;
  const holder = withLock(lock, () => new Promise((resolve) => { unlock = resolve; }));
  await assert.rejects(withLockWait(lock, () => 'never', { waitMs: 0 }), /busy/);
  setTimeout(() => unlock('released'), 200);
  assert.equal(await withLockWait(lock, () => 'acquired', { waitMs: 3_000, pollMs: 20 }), 'acquired');
  assert.equal(await holder, 'released');
  assert.equal(existsSync(lock), false);
  await assert.rejects(withLockWait(lock, () => { throw new Error('work failed'); }, { waitMs: 1_000 }), /work failed/);
  assert.equal(existsSync(lock), false);
});

test('sticky selection keeps the current provider unless its quota is genuinely spent', () => {
  const claudeAgent = agent();
  const cand = (provider, extra) => ({ provider, model: provider === 'claude' ? 'claude-sonnet-5-5' : 'gpt-6.1-sol', effort: 'medium', admissionLimitPercent: 65, modelBudgetPercent: 5, ...extra });
  const pick = (candidates, record, at = NOW) => stickySelection(claudeAgent, { selected: candidates.filter((c) => c.allow).sort((a, b) => (a.provider === 'codex' ? -1 : 1))[0] || null, candidates }, record, at);
  // Both admissible and codex looks cheaper: stay on claude.
  assert.equal(pick([cand('claude', { allow: true, usedPercent: 10 }), cand('codex', { allow: true, usedPercent: 1 })]).selected.provider, 'claude');
  // Denied only by in-flight reservations: stay, the wrapper gates each run.
  const inflight = pick([cand('claude', { allow: false, usedPercent: 20, pendingPercent: 45, reason: 'projected-use-exceeds-buffer' }), cand('codex', { allow: true, usedPercent: 1 })]);
  assert.equal(inflight.selected.provider, 'claude'); assert.equal(inflight.sticky, 'in-flight-reservations');
  // Measurement missing is not exhaustion.
  assert.equal(pick([cand('claude', { allow: false, reason: 'weekly-quota-unavailable-or-stale' }), cand('codex', { allow: true, usedPercent: 1 })]).selected, null);
  // Genuinely spent: switch, but not twice within an hour.
  const spent = [cand('claude', { allow: false, usedPercent: 63, reason: 'projected-use-exceeds-buffer' }), cand('codex', { allow: true, usedPercent: 1 })];
  assert.equal(pick(spent, {}).selected.provider, 'codex');
  assert.equal(pick(spent, { lastSwitchAt: stamp(-10 * 60_000) }).sticky, 'switch-cooldown');
  assert.equal(pick(spent, { lastSwitchAt: stamp(-61 * 60_000) }).selected.provider, 'codex');
  // A reviewer measured against its original family stays there.
  const reviewer = stickySelection(agent({ role: 'qa', adapterType: 'codex_local' }), { selected: null, candidates: [cand('claude', { allow: false, usedPercent: 63 }), cand('codex', { allow: true, usedPercent: 1 })] }, {}, NOW, 'claude');
  assert.equal(reviewer.selected, null);
});
