import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runQuotaCli, validateQuotaArgs, deferralNotice, admissionHoldMinutes, drainInput, isProductionCall } from '../scripts/automation/paperclip/quota-cli.js';
import { configFor } from '../scripts/automation/paperclip/quota-switch.js';
import { adapterFor } from '../scripts/automation/paperclip/lib.js';

function fixture(overrides = {}) {
  const calls = { spawned: [], reserved: [], finished: [], reports: [], quotas: 0 };
  const signals = new EventEmitter();
  const deps = {
    signals, report: (message) => calls.reports.push(message), randomUUID: () => 'test-reservation', readState: () => ({}),
    readRuntimeQuota: async () => { calls.quotas++; return { ok: true, identityHash: 'account-hash', quota: [], measuredAt: '2026-10-26T03:00:00Z' }; },
    normalizeQuota: () => ({ claude: {}, codex: {} }),
    reserve: (value) => { calls.reserved.push(value); return { allow: true }; },
    finishReservation: (id) => calls.finished.push(id),
    spawn: (...args) => {
      calls.spawned.push(args);
      const child = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    }, ...overrides,
  };
  return { deps, calls, signals };
}

test('one exact version flag bypasses quota and preserves real executable/arguments', async () => {
  for (const provider of ['claude', 'codex']) {
    const { deps, calls } = fixture();
    const code = await runQuotaCli(['node', `/scripts/quota-${provider}`, '--version'], { HOME: '/selected' }, deps);
    assert.equal(code, 0); assert.equal(calls.quotas, 0); assert.equal(calls.reserved.length, 0);
    assert.equal(calls.spawned[0][0], join(userInfo().homedir, '.local/bin', provider));
    assert.deepEqual(calls.spawned[0][1], ['--version']);
    assert.equal(calls.spawned[0][2].stdio, 'inherit');
  }
});

test('denied evidence or allowance never spawns the CLI', async () => {
  for (const overrides of [{ readRuntimeQuota: async () => ({ ok: false }) }, { reserve: () => ({ allow: false, reason: 'blocked' }) }]) {
    const { deps, calls } = fixture(overrides);
    assert.equal(await runQuotaCli(['node', '/scripts/quota-cli.js', 'codex', 'exec', '--json', '-'], {}, deps), 78);
    assert.equal(calls.spawned.length, 0); assert.equal(calls.finished.length, 0);
    assert.match(calls.reports.at(-1), /^PAPERCLIP_RESERVE_GUARD: admission denied; .*\. No provider started\.$/);
  }
});

test('version mixed with model flags is guarded and exceptions never expose secrets', async () => {
  const { deps, calls } = fixture({ readRuntimeQuota: async () => { throw new Error('PRIVATE_ACCESS_TOKEN'); } });
  assert.equal(await runQuotaCli(['node', '/scripts/quota-claude', '--version', '--print'], {}, deps), 78);
  assert.equal(calls.spawned.length, 0);
  assert.ok(!calls.reports.join('').includes('PRIVATE_ACCESS_TOKEN'));
});

test('native managed Claude settings and Codex arguments pass; account overrides fail', () => {
  assert.equal(validateQuotaArgs('claude', ['--print', '--setting-sources', 'user', '--model', 'claude-sonnet-5']), true);
  assert.equal(validateQuotaArgs('claude', ['--print', '--setting-sources=user']), true);
  assert.equal(validateQuotaArgs('codex', ['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '-c', 'model_reasoning_effort="high"', '--model', 'gpt-6-sol', '-']), true);
  for (const args of [['--setting-sources', 'project,user'], ['--settings', '/private/settings.json'], ['--fallback-model', 'other']]) {
    assert.equal(validateQuotaArgs('claude', args), false);
  }
  for (const setting of ['-cmodel_provider="paid"', '-c=model_provider="paid"', '--config=cli_auth_credentials_store="keyring"', '-cmodel="unreserved"', '-cprofiles.paid.model_provider="paid"']) {
    assert.equal(validateQuotaArgs('codex', ['exec', setting, '-']), false);
  }
  for (const args of [['--profile', 'paid'], ['-ppaid'], ['-c'], ['--config'], ['--oss'], ['--local-provider=ollama']]) {
    assert.equal(validateQuotaArgs('codex', args), false);
  }
  for (const setting of ['features.plugins=true', 'features.remote_plugin=true', 'project_doc_max_bytes=100000']) {
    assert.equal(validateQuotaArgs('codex', ['exec', '-c', setting, '-']), false);
  }
});

test('admitted native call keeps exact environment, model attribution, and settles once', async () => {
  const env = { CODEX_HOME: '/managed/account', PAPERCLIP_AGENT_ID: 'agent', PAPERCLIP_RUN_ID: 'run' };
  const { deps, calls, signals } = fixture({ readRuntimeQuota: async (_, selected) => {
    assert.equal(selected, env); return { ok: true, identityHash: 'selected-hash', quota: [], measuredAt: '2026-10-26T03:00:00Z' };
  } });
  const args = ['exec', '--json', '--model=gpt-6-sol', '-'];
  assert.equal(await runQuotaCli(['node', '/scripts/quota-codex', ...args], env, deps), 0);
  assert.deepEqual(calls.spawned[0][1], args);
  assert.equal(calls.spawned[0][2].env.CODEX_HOME, '/managed/account');
  assert.equal(calls.reserved[0].model, 'gpt-6-sol');
  assert.equal(calls.reserved[0].identityHash, 'selected-hash');
  assert.equal(calls.reserved[0].measurement.subscriptionVerified, true);
  assert.deepEqual(calls.finished, ['test-reservation']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('child signals are forwarded, conventional exit status returned, and spawn failure settles', async () => {
  const fixture1 = fixture();
  const killed = [];
  fixture1.deps.spawn = () => {
    const child = new EventEmitter(); child.kill = (signal) => { killed.push(signal); child.emit('exit', null, signal); };
    queueMicrotask(() => fixture1.signals.emit('SIGTERM'));
    return child;
  };
  assert.equal(await runQuotaCli(['node', '/scripts/quota-codex', 'exec', '-'], {}, fixture1.deps), 143);
  assert.deepEqual(killed, ['SIGTERM']);
  assert.deepEqual(fixture1.calls.finished, ['test-reservation']);
  const fixture2 = fixture({ spawn: () => { throw new Error('spawn unavailable'); } });
  assert.equal(await runQuotaCli(['node', '/scripts/quota-codex', 'exec', '-'], {}, fixture2.deps), 1);
  assert.deepEqual(fixture2.calls.finished, ['test-reservation']);
});

const nativeBuilderPath = resolve(dirname(process.execPath), '../lib/node_modules/paperclipai/node_modules/@paperclipai/adapter-codex-local/dist/server/codex-args.js');
test('full installed native argv from both controller and existing organization configs passes', { skip: !existsSync(nativeBuilderPath) }, async () => {
  const { buildCodexExecArgs } = await import(pathToFileURL(nativeBuilderPath).href);
  const spec = { kind: 'agent', cwd: '/workspace/ops', timeout_sec: 300, codex_bypass: false,
    primary: { adapterType: 'codex_local', model: 'gpt-6.1-sol', modelReasoningEffort: 'high' } };
  const organizationConfig = adapterFor(spec, 'primary').adapterConfig;
  const currentAgent = { adapterType: 'codex_local', adapterConfig: organizationConfig, runtimeConfig: {} };
  const retainedConfig = configFor(currentAgent, { provider: 'codex', model: 'gpt-6.1-sol' }).adapterConfig;
  const switchedConfig = configFor({ adapterType: 'claude_local', adapterConfig: { model: 'claude-sonnet-5', dangerouslySkipPermissions: true }, runtimeConfig: {} }, { provider: 'codex', model: 'gpt-6.1-sol' }).adapterConfig;
  for (const config of [organizationConfig, retainedConfig, switchedConfig]) {
    const { args } = buildCodexExecArgs(config, { skipGitRepoCheck: true, resumeSessionId: 'existing-session' });
    assert.ok(args.includes('shell_environment_policy.inherit="all"'));
    assert.equal(validateQuotaArgs('codex', args), true);
    const { deps, calls } = fixture();
    assert.equal(await runQuotaCli(['node', '/scripts/quota-codex', ...args], {}, deps), 0);
    assert.deepEqual(calls.spawned[0][1], args);
    const helloArgs = [...buildCodexExecArgs({ ...config, fastMode: false }, { skipGitRepoCheck: true }).args];
    helloArgs.splice(helloArgs.length - 1, 0, '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false', '-c', 'project_doc_max_bytes=0', '--ephemeral');
    assert.equal(validateQuotaArgs('codex', helloArgs), true);
    const hello = fixture();
    assert.equal(await runQuotaCli(['node', '/scripts/quota-cli.js', 'codex', ...helloArgs], {}, hello.deps), 0);
    assert.equal(hello.calls.quotas, 1);
    assert.equal(hello.calls.reserved.length, 1);
    assert.deepEqual(hello.calls.spawned[0][1], helloArgs);
  }
  assert.ok(organizationConfig.extraArgs.some((arg) => arg.startsWith('sandbox_workspace_write.writable_roots=')));
});

test('exact-name native launchers forward version only without starting a model', { skip: !existsSync('/Users/beye/.local/bin/claude') || !existsSync('/Users/beye/.local/bin/codex') }, () => {
  for (const provider of ['claude', 'codex']) {
    const filename = new URL(`../scripts/automation/paperclip/quota-bin/${provider}`, import.meta.url);
    const output = execFileSync(filename.pathname, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    assert.match(output, provider === 'claude' ? /Claude Code/ : /codex/i);
  }
});

const adapterParse = (adapter) => resolve(dirname(process.execPath), `../lib/node_modules/paperclipai/node_modules/@paperclipai/${adapter}/dist/server/parse.js`);
const NOW_FIXED = Date.parse('2026-10-28T12:10:30Z');

test('deferrable denials lead with the adapter limit phrase and keep the guard marker on line 2', async () => {
  const cases = [
    [{ readRuntimeQuota: async () => ({ ok: false }) }, 5],
    [{ readRuntimeQuota: async () => { throw new Error('probe failed'); } }, 5],
    [{ reserve: () => ({ allow: false, usedPercent: 64, modelBudgetPercent: 5, admissionLimitPercent: 65 }) }, 60],
    [{ reserve: () => ({ allow: false, usedPercent: 10, modelBudgetPercent: 5, pendingPercent: 55, admissionLimitPercent: 65 }) }, 10],
  ];
  for (const [overrides, minutes] of cases) {
    for (const provider of ['claude', 'codex']) {
      const { deps, calls } = fixture({ now: () => NOW_FIXED, ...overrides });
      const args = provider === 'claude' ? ['--print', '--model', 'claude-sonnet-5-5'] : ['exec', '--model', 'gpt-6.1-sol', '-'];
      assert.equal(await runQuotaCli(['node', `/scripts/quota-${provider}`, ...args], {}, deps), 78);
      const retryAt = new Date(Math.ceil((NOW_FIXED + minutes * 60_000) / 60_000) * 60_000);
      assert.equal(calls.reports[0], deferralNotice(provider, provider === 'claude' ? 'claude-sonnet-5-5' : 'gpt-6.1-sol', retryAt));
      assert.match(calls.reports[1], /^PAPERCLIP_RESERVE_GUARD: admission denied; .*\. No provider started\.$/m);
      assert.equal(calls.spawned.length, 0);
    }
  }
});

test('configuration denials are not dressed up as a provider limit', async () => {
  const { deps, calls } = fixture();
  assert.equal(await runQuotaCli(['node', '/scripts/quota-claude', '--print', '--settings', '/x.json'], {}, deps), 78);
  assert.equal(calls.reports.length, 1);
  assert.match(calls.reports[0], /^PAPERCLIP_RESERVE_GUARD/);
});

test('a busy admission ledger is waited for instead of denying the run', async () => {
  let attempts = 0;
  const { deps, calls } = fixture({ sleep: async () => {}, reserve: (value) => {
    attempts++;
    if (attempts < 3) throw new Error('Quota controller is busy; retry later');
    calls.reserved.push(value); return { allow: true };
  } });
  assert.equal(await runQuotaCli(['node', '/scripts/quota-codex', 'exec', '-'], {}, deps), 0);
  assert.equal(attempts, 3);
  assert.equal(calls.spawned.length, 1);
});

test('Paperclip classifies both notices as provider_quota with the intended retry time', { skip: !existsSync(adapterParse('adapter-claude-local')) || !existsSync(adapterParse('adapter-codex-local')) }, async () => {
  const claude = await import(pathToFileURL(adapterParse('adapter-claude-local')).href);
  const codex = await import(pathToFileURL(adapterParse('adapter-codex-local')).href);
  const now = new Date(NOW_FIXED);
  const guard = 'PAPERCLIP_RESERVE_GUARD: admission denied; selected subscription evidence unavailable. No provider started.';
  for (const minutes of [5, 10, 60]) {
    const retryAt = new Date(Math.ceil((NOW_FIXED + minutes * 60_000) / 60_000) * 60_000);
    const claudeStderr = `${deferralNotice('claude', 'claude-sonnet-5-5', retryAt)}\n${guard}\n`;
    const claudeInput = { parsed: null, stdout: '', stderr: claudeStderr, errorMessage: `Claude exited with code 78: ${claudeStderr.split('\n')[0]}` };
    assert.equal(claude.isClaudeProviderQuotaError(claudeInput), true);
    assert.equal(claude.detectClaudeLoginRequired(claudeInput).requiresLogin, false);
    assert.equal(claude.extractClaudeRetryNotBefore(claudeInput, now)?.toISOString(), retryAt.toISOString());
    const codexStderr = `${deferralNotice('codex', 'gpt-6.1-sol', retryAt)}\n${guard}\n`;
    const codexInput = { stdout: '', stderr: codexStderr, errorMessage: codexStderr.split('\n')[0] };
    assert.equal(codex.isCodexProviderQuotaError(codexInput), true);
    assert.equal(codex.extractCodexRetryNotBefore(codexInput, now)?.toISOString(), retryAt.toISOString());
  }
});

test('a governor admission hold postpones the agent without reading quota or starting a model', async () => {
  const until = new Date(NOW_FIXED + 90 * 60_000).toISOString();
  const state = { admissionHolds: { held: { until, reason: 'daily operational cost cap' } } };
  const { deps, calls } = fixture({ now: () => NOW_FIXED, readState: () => state });
  assert.equal(await runQuotaCli(['node', '/scripts/quota-claude', '--print'], { PAPERCLIP_AGENT_ID: 'held' }, deps), 78);
  assert.equal(calls.quotas, 0); assert.equal(calls.spawned.length, 0);
  assert.match(calls.reports[0], /^Claude usage limit reached\. Your limit resets /);
  const free = fixture({ now: () => NOW_FIXED, readState: () => state });
  assert.equal(await runQuotaCli(['node', '/scripts/quota-claude', '--print'], { PAPERCLIP_AGENT_ID: 'other' }, free.deps), 0);
  assert.equal(admissionHoldMinutes(state, 'held', NOW_FIXED), 90);
  assert.equal(admissionHoldMinutes(state, 'held', Date.parse(until) + 1), null);
  assert.equal(admissionHoldMinutes({ admissionHolds: { held: { until: new Date(NOW_FIXED + 3 * 86_400_000).toISOString() } } }, 'held', NOW_FIXED), 23 * 60);
});

test('a denied run reads the prompt to its end so Paperclip never writes into a closed pipe', async () => {
  // Paperclip writes the prompt without an error listener; over a pipe buffer (64 KiB)
  // the write is still pending when a denying wrapper exits, and the EPIPE kills the server.
  const script = new URL('../scripts/automation/paperclip/quota-cli.js', import.meta.url).pathname;
  for (let round = 0; round < 3; round++) {
    const child = spawn(process.execPath, [script, 'claude', '--settings', 'x.json', '--print'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const pipeErrors = [];
    child.stdin.on('error', (error) => pipeErrors.push(error.code));
    child.stdin.write('x'.repeat(256 * 1024));
    child.stdin.end();
    assert.equal(await new Promise((done) => child.once('exit', done)), 78);
    await new Promise((done) => setTimeout(done, 100));
    assert.deepEqual(pipeErrors, []);
    assert.match(stderr, /admission denied; credential, provider, or model overrides/);
  }
});

test('draining stops at the end of input, or after the bound when input never ends', async () => {
  const input = new PassThrough();
  let read = 0;
  input.on('data', (chunk) => { read += chunk.length; });
  const drained = drainInput(input, 5_000);
  input.write('y'.repeat(100_000)); input.end();
  await drained;
  assert.equal(read, 100_000);
  const silent = new PassThrough();
  const started = Date.now();
  await drainInput(silent, 50);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(silent.destroyed, true);
  await drainInput({ isTTY: true });
});

test('only a dispatched production run counts as production — never an agent run', () => {
  assert.equal(isProductionCall({ BT_QUOTA_CLASS: 'production' }), true);
  assert.equal(isProductionCall({ BT_QUOTA_CLASS: 'production', PAPERCLIP_AGENT_ID: 'agent' }), false);
  assert.equal(isProductionCall({}), false);
});

test('a production call drops the pipeline API keys before proving the subscription and spawning', async () => {
  const seen = [];
  const { deps, calls } = fixture({ readRuntimeQuota: async (provider, env) => { seen.push(env); return { ok: true, identityHash: 'account-hash', quota: [], measuredAt: '2026-10-26T03:00:00Z' }; } });
  const env = { BT_QUOTA_CLASS: 'production', OPENAI_API_KEY: 'sk-pipeline', CODEX_API_KEY: 'x', GOOGLE_AI_API_KEY: 'keep', HOME: '/h' };
  assert.equal(await runQuotaCli(['node', '/scripts/quota-codex', 'exec', '--json', '-'], env, deps), 0);
  assert.equal(calls.reserved[0].pipeline, true);
  for (const passed of [seen[0], calls.spawned[0][2].env]) {
    assert.equal(passed.OPENAI_API_KEY, undefined);
    assert.equal(passed.CODEX_API_KEY, undefined);
    assert.equal(passed.GOOGLE_AI_API_KEY, 'keep');
  }
});

test('an agent run keeps its environment, so a paid key is still refused by the identity proof', async () => {
  const { deps, calls } = fixture();
  await runQuotaCli(['node', '/scripts/quota-codex', 'exec', '--json', '-'], { OPENAI_API_KEY: 'sk-agent', PAPERCLIP_AGENT_ID: 'a', BT_QUOTA_CLASS: 'production' }, deps);
  assert.equal(calls.reserved[0].pipeline, false);
  assert.equal(calls.spawned[0][2].env.OPENAI_API_KEY, 'sk-agent');
});
