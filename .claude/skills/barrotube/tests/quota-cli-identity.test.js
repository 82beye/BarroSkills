import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { cleanHostEnvironment, hostIdentity, normalizeCodexRateLimits, readIdentity, readRuntimeQuota, probeClaudeQuota, withoutPaidAuth } from '../scripts/automation/paperclip/quota-cli-identity.js';

const token = (account = 'account-a', extra = {}) => `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_user_id: 'user-a', ...extra } })).toString('base64url')}.signature`;
const auth = (account = 'account-a') => ({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { account_id: account, access_token: token(account), id_token: token(account) } });
function files(value = auth(), config = '') {
  return { readFile: async (filename) => filename.endsWith('config.toml') ? config : JSON.stringify(value) };
}
const claudeStatus = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'PERSON@example.test', orgId: 'org-a', subscriptionType: 'max' };
const managedClaudeStatus = { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' };
const claudeProfile = { account: { uuid: 'account-a', email: 'person@example.test' }, organization: { uuid: 'org-a', organization_type: 'claude_max' } };

test('Claude invokes only the original CLI auth status and hashes identity', async () => {
  let call;
  const result = await readIdentity('anthropic', { HOME: '/selected', CLAUDE_CONFIG_DIR: '/selected/claude' }, {
    execFile: async (...args) => { call = args; return { stdout: JSON.stringify(claudeStatus) }; },
  });
  assert.equal(result.ok, true);
  assert.match(result.identityHash, /^[a-f0-9]{64}$/);
  assert.match(call[0], /\.local\/bin\/claude$/);
  assert.deepEqual(call[1], ['auth', 'status', '--json']);
  assert.equal(call[2].env.HOME, '/selected');
  assert.ok(!JSON.stringify(result).includes('example.test'));
  assert.ok(!JSON.stringify(result).includes('org-a'));
});

test('Claude refuses alternate paid auth, incomplete identities and raw error disclosure', async () => {
  assert.equal((await readIdentity('claude', { ANTHROPIC_API_KEY: 'secret' })).reason, 'paid_or_alternate_auth_present');
  const incomplete = await readIdentity('claude', {}, { execFile: async () => ({ stdout: JSON.stringify({ ...claudeStatus, orgId: null }) }) });
  assert.equal(incomplete.ok, false);
  const error = await readIdentity('claude', {}, { execFile: async () => { throw new Error('PRIVATE_TOKEN'); } });
  assert.equal(error.reason, 'claude_auth_status_unavailable');
  assert.ok(!JSON.stringify(error).includes('PRIVATE_TOKEN'));
});

test('managed Claude verifies its exact bearer profile and shares the host account hash', async () => {
  let request;
  const env = { HOME: '/isolated', CLAUDE_CONFIG_DIR: '/isolated/provider', CLAUDE_CODE_OAUTH_TOKEN: 'PRIVATE_RUNTIME_TOKEN' };
  const managed = await readIdentity('claude', env, {
    execFile: async (_binary, args, options) => {
      assert.deepEqual(args, ['auth', 'status', '--json']);
      assert.deepEqual(options.env, env);
      return { stdout: JSON.stringify(managedClaudeStatus) };
    },
    fetch: async (...args) => { request = args; return { ok: true, json: async () => claudeProfile }; },
  });
  assert.equal(managed.ok, true);
  assert.equal(managed.source, 'claude-oauth-profile');
  assert.equal(request[0], 'https://api.anthropic.com/api/oauth/profile');
  assert.equal(request[1].method, 'GET');
  assert.equal(request[1].redirect, 'error');
  assert.equal(request[1].headers.Authorization, 'Bearer PRIVATE_RUNTIME_TOKEN');
  assert.equal(request[1].headers['Cache-Control'], 'no-cache');
  const host = await readIdentity('claude', {}, { execFile: async () => ({ stdout: JSON.stringify(claudeStatus) }) });
  assert.equal(managed.identityHash, host.identityHash);
  for (const privateValue of ['PRIVATE_RUNTIME_TOKEN', 'example.test', 'org-a', 'account-a']) assert.ok(!JSON.stringify(managed).includes(privateValue));
});

test('managed Claude rejects unverifiable profiles, paid plans and conflicting auth without a host fallback', async () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'PRIVATE_RUNTIME_TOKEN' };
  const status = { execFile: async () => ({ stdout: JSON.stringify(managedClaudeStatus) }) };
  const profileCase = async (profile) => readIdentity('claude', env, { ...status, fetch: async () => ({ ok: true, json: async () => profile }) });
  assert.equal((await profileCase({ ...claudeProfile, organization: { ...claudeProfile.organization, organization_type: 'api' } })).reason, 'claude_subscription_not_proven');
  assert.equal((await profileCase({ ...claudeProfile, account: { email: 'person@example.test' } })).reason, 'claude_account_identity_missing');
  for (const plan of ['claude_pro', 'claude_team', 'claude_enterprise']) {
    assert.equal((await profileCase({ ...claudeProfile, organization: { ...claudeProfile.organization, organization_type: plan } })).ok, true);
  }
  const refused = await readIdentity('claude', env, { ...status, fetch: async () => ({ ok: false, json: async () => { throw new Error('Must not read error payload'); } }) });
  assert.equal(refused.reason, 'claude_oauth_profile_unavailable');
  const fault = await readIdentity('claude', env, { ...status, fetch: async () => { throw new Error('PRIVATE_RUNTIME_TOKEN'); } });
  assert.equal(fault.reason, 'claude_oauth_profile_unavailable');
  assert.ok(!JSON.stringify(fault).includes('PRIVATE_RUNTIME_TOKEN'));
  const mustNotFetch = async () => { assert.fail('Must not fetch a different authentication source'); };
  assert.equal((await readIdentity('claude', env, { execFile: async () => ({ stdout: JSON.stringify(claudeStatus) }), fetch: mustNotFetch })).reason, 'claude_runtime_auth_conflict');
  assert.equal((await readIdentity('claude', {}, { ...status, fetch: mustNotFetch })).ok, false);
  assert.equal((await readIdentity('claude', { ...env, ANTHROPIC_API_KEY: 'PRIVATE_KEY' }, { ...status, fetch: mustNotFetch })).reason, 'paid_or_alternate_auth_present');
});

test('managed Claude profile account changes prevent quota admission', async () => {
  let profilesRead = 0;
  const result = await readRuntimeQuota('claude', { CLAUDE_CODE_OAUTH_TOKEN: 'PRIVATE_RUNTIME_TOKEN' }, {
    execFile: async () => ({ stdout: JSON.stringify(managedClaudeStatus) }),
    fetch: async () => ({ ok: true, json: async () => ++profilesRead === 1 ? claudeProfile : { ...claudeProfile, organization: { ...claudeProfile.organization, uuid: 'org-b' } } }),
    probeQuota: async () => ({ ok: true, windows: [{ scope: 'weekly', usedPercent: 20 }] }),
  });
  assert.equal(result.reason, 'runtime_identity_changed');
  assert.equal(result.ok, false);
});

test('Codex uses selected CODEX_HOME and stable account identity across rotated tokens', async () => {
  const seen = [];
  const first = await readIdentity('codex', { CODEX_HOME: '/managed/account' }, { readFile: async (filename) => {
    seen.push(filename); return filename.endsWith('config.toml') ? '' : JSON.stringify(auth());
  } });
  const rotated = auth(); rotated.tokens.access_token = `${token()}.rotated`;
  const second = await readIdentity('openai', {}, files(rotated));
  assert.equal(first.ok, true);
  assert.equal(first.identityHash, second.identityHash);
  assert.ok(seen.every((filename) => filename.startsWith('/managed/account/')));
  assert.ok(!JSON.stringify(first).includes('account-a'));
});

test('Codex rejects API keys, alternate providers and conflicting account claims', async () => {
  assert.equal((await readIdentity('codex', { OPENAI_API_KEY: 'private' }, files())).ok, false);
  assert.equal((await readIdentity('codex', {}, files({ ...auth(), auth_mode: 'apikey' }))).ok, false);
  assert.equal((await readIdentity('codex', {}, files({ ...auth(), OPENAI_API_KEY: 'private' }))).ok, false);
  assert.equal((await readIdentity('codex', {}, files(auth(), 'model_provider = "third-party"\n'))).reason, 'alternate_provider_config');
  assert.equal((await readIdentity('codex', {}, files(auth(), 'profile = "paid"\n[profiles.paid]\nmodel_provider = "azure"\n'))).reason, 'unverified_provider_profile');
  assert.equal((await readIdentity('codex', {}, files(auth(), '[model_providers.openai]\nbase_url="https://example.test"\n'))).reason, 'unverified_provider_profile');
  assert.equal((await readIdentity('codex', {}, files(auth(), 'cli_auth_credentials_store = "keyring"\n'))).reason, 'non_file_credential_store');
  assert.equal((await readIdentity('codex', {}, files(auth(), 'cli_auth_credentials_store = "file"\n'))).ok, true);
  const conflicting = auth(); conflicting.tokens.id_token = token('account-b');
  assert.equal((await readIdentity('codex', {}, files(conflicting))).ok, false);
  assert.equal((await readIdentity('codex', {}, files({ auth_mode: 'chatgpt', tokens: {} }))).ok, false);
});

test('host identity clears managed credential and home overrides', async () => {
  const env = cleanHostEnvironment({ HOME: '/managed', CODEX_HOME: '/managed/provider', CLAUDE_CODE_OAUTH_TOKEN: 'private', OPENAI_API_KEY: 'private', PATH: '/usr/bin', LANG: 'C' });
  assert.notEqual(env.HOME, '/managed');
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.LANG, 'C');
  assert.equal((await hostIdentity('codex', { ...files(), hostEnv: { CODEX_HOME: '/managed', OPENAI_API_KEY: 'private' } })).ok, true);
});

test('actual duration, not secondary position, proves a Codex weekly window', () => {
  const result = normalizeCodexRateLimits({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 2_000_000_000 } } });
  assert.deepEqual(result.map((window) => window.scope), ['session', 'weekly']);
  const ambiguous = normalizeCodexRateLimits({ rateLimits: { secondary: { usedPercent: 1, resetsAt: 2_000_000_000 } } });
  assert.equal(ambiguous[0].scope, 'unknown');
  assert.equal(ambiguous[0].durationMinutes, null);
  assert.ok(!ambiguous[0].label.includes('Weekly'));
  assert.deepEqual(normalizeCodexRateLimits({ rateLimits: { secondary: { usedPercent: 101, windowDurationMins: 10080 } } }), []);
});

test('runtime quota checks exact environment and sanitizes probe failures', async () => {
  const environment = { CODEX_HOME: '/selected' };
  const quota = await readRuntimeQuota('codex', environment, { ...files(), probeQuota: async (provider, env) => {
    assert.equal(provider, 'openai'); assert.equal(env, environment);
    return { ok: true, source: 'test-account-usage', windows: [{ scope: 'weekly', usedPercent: 20 }] };
  } });
  assert.equal(quota.ok, true);
  assert.equal(quota.kind, 'subscription');
  assert.equal(quota.source, 'test-account-usage');
  assert.equal(quota.windows[0].usedPercent, 20);
  assert.equal(quota.quota[0].provider, 'openai');
  assert.equal(quota.quota[0].windows[0].usedPercent, 20);
  assert.equal(quota.measuredAt, quota.observedAt);
  const failure = await readRuntimeQuota('codex', environment, { ...files(), probeQuota: async () => { throw new Error('PRIVATE'); } });
  assert.equal(failure.reason, 'runtime_quota_unavailable');
  assert.ok(!JSON.stringify(failure).includes('PRIVATE'));
});

test('runtime quota denies a changed account and never probes paid routes', async () => {
  let reads = 0;
  const changed = await readRuntimeQuota('codex', {}, { readFile: async (filename) => filename.endsWith('config.toml') ? '' : JSON.stringify(auth(++reads === 1 ? 'a' : 'b')), probeQuota: async () => ({ ok: true, windows: [] }) });
  assert.equal(changed.reason, 'runtime_identity_changed');
  let called = false;
  const paid = await readRuntimeQuota('codex', { OPENAI_API_KEY: 'private' }, { probeQuota: async () => { called = true; } });
  assert.equal(paid.ok, false); assert.equal(called, false);
});

test('native quota child resolves original CLI before guarded server PATH without changing account selectors', async () => {
  const env = { HOME: '/managed/home', CODEX_HOME: '/managed/provider', PATH: '/guard/quota-bin:/usr/bin', PAPERCLIP_AGENT_ID: 'agent-a' };
  let child;
  const result = await readRuntimeQuota('codex', env, { ...files(), execFile: async (binary, args, options) => {
    child = { binary, args, options };
    return { stdout: JSON.stringify({ ok: true, source: 'test', windows: [{ scope: 'weekly', usedPercent: 1 }] }) };
  } });
  assert.equal(result.ok, true);
  assert.equal(child.binary, process.execPath);
  assert.equal(child.args[1], '--quota-probe');
  assert.match(child.options.env.PATH, /^\/Users\/[^/]+\/\.local\/bin:\/guard\/quota-bin:/);
  assert.equal(child.options.env.HOME, env.HOME);
  assert.equal(child.options.env.CODEX_HOME, env.CODEX_HOME);
  assert.equal(child.options.env.PAPERCLIP_AGENT_ID, env.PAPERCLIP_AGENT_ID);
  assert.equal(env.PATH, '/guard/quota-bin:/usr/bin');
});

test('same-account quota cache avoids repeated usage reads without advancing observation time', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'quota-cache-'));
  let probes = 0;
  const options = { ...files(), cacheDir, probeQuota: async () => {
    probes++;
    return { ok: true, source: 'verified-usage', windows: [{ scope: 'weekly', usedPercent: 20 }] };
  } };
  try {
    const first = await readRuntimeQuota('codex', {}, options);
    const second = await readRuntimeQuota('codex', {}, options);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(probes, 1);
    assert.equal(first.measuredAt, second.measuredAt);
    assert.equal(second.windows[0].usedPercent, 20);
    const paid = await readRuntimeQuota('codex', { OPENAI_API_KEY: 'PRIVATE' }, options);
    assert.equal(paid.ok, false);
    assert.equal(probes, 1);
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

test('expired, future, failed and wrong-account cache entries never authorize cached work', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'quota-cache-'));
  let probes = 0;
  const options = { ...files(), cacheDir, probeQuota: async () => {
    probes++;
    return { ok: true, windows: [{ scope: 'weekly', usedPercent: 20 }] };
  } };
  try {
    await readRuntimeQuota('codex', {}, options);
    const filename = join(cacheDir, readdirSync(cacheDir).find(f => f.endsWith('.json')));
    const original = JSON.parse(readFileSync(filename, 'utf8'));
    for (const patch of [
      { observedAt: new Date(Date.now() - 301_000).toISOString() },
      { observedAt: new Date(Date.now() + 60_000).toISOString() },
      { identityHash: 'another-account' },
      { provider: 'anthropic' },
      { result: { ok: false, windows: original.result.windows } },
    ]) {
      writeFileSync(filename, JSON.stringify({ ...original, ...patch }));
      const before = probes;
      assert.equal((await readRuntimeQuota('codex', {}, options)).ok, true);
      assert.equal(probes, before + 1);
    }
    writeFileSync(filename, JSON.stringify({ ...original, observedAt: new Date(Date.now() - 301_000).toISOString() }));
    const failed = await readRuntimeQuota('codex', {}, { ...options, probeQuota: async () => { throw new Error('429'); } });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'runtime_quota_unavailable');
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

test('a cached quota still requires unchanged runtime account proof', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'quota-cache-'));
  try {
    await readRuntimeQuota('codex', {}, { ...files(), cacheDir, probeQuota: async () => ({ ok: true, windows: [{ scope: 'weekly', usedPercent: 20 }] }) });
    let reads = 0;
    const changed = await readRuntimeQuota('codex', {}, { cacheDir,
      readFile: async filename => filename.endsWith('config.toml') ? '' : JSON.stringify(auth(++reads === 1 ? 'account-a' : 'account-b')),
      probeQuota: async () => { assert.fail('cache should avoid usage read'); },
    });
    assert.equal(changed.ok, false);
    assert.equal(changed.reason, 'runtime_identity_changed');
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

test('host Claude Keychain quota requires the bearer to prove the selected account', async () => {
  let quotaReads = 0;
  const native = { readClaudeToken: async options => { assert.equal(options.allowKeychain, true); return 'PRIVATE'; },
    fetchClaudeQuota: async token => { assert.equal(token, 'PRIVATE'); quotaReads++; return [{ label: 'Current week (all models)', usedPercent: 2 }]; },
    getQuotaWindows: async () => { assert.fail('host token must use exact bearer'); },
  };
  const opts = { execFile: async () => ({ stdout: JSON.stringify(claudeStatus) }), fetch: async () => ({ ok: true, json: async () => claudeProfile }) };
  const result = await probeClaudeQuota(native, { HOME: userInfo().homedir }, opts);
  assert.equal(result.ok, true);
  assert.equal(result.windows[0].durationMinutes, 10080);
  assert.equal(quotaReads, 1);
  const denied = await probeClaudeQuota(native, { HOME: userInfo().homedir }, { ...opts, fetch: async () => ({ ok: true, json: async () => ({ ...claudeProfile, organization: { ...claudeProfile.organization, uuid: 'other-account' } }) }) });
  assert.equal(denied.ok, false);
  assert.equal(quotaReads, 1);
});

test('custom Claude homes never borrow the unsuffixed host Keychain', async () => {
  const native = { readClaudeToken: async () => { assert.fail('must not read host Keychain'); }, getQuotaWindows: async () => ({ ok: false, windows: [] }) };
  assert.equal((await probeClaudeQuota(native, { HOME: '/isolated' })).ok, false);
  assert.equal((await probeClaudeQuota(native, { HOME: userInfo().homedir, CLAUDE_CONFIG_DIR: '/selected' })).ok, false);
});

test('concurrent readers of one account wait for a single probe instead of failing', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'quota-cache-'));
  let probes = 0;
  const options = { ...files(), cacheDir, lockWaitMs: 5_000, probeQuota: async () => {
    probes++;
    await new Promise((done) => setTimeout(done, 300));
    return { ok: true, source: 'verified-usage', windows: [{ scope: 'weekly', usedPercent: 20 }] };
  } };
  try {
    const results = await Promise.all([readRuntimeQuota('codex', {}, options), readRuntimeQuota('codex', {}, options), readRuntimeQuota('codex', {}, options)]);
    assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
    assert.equal(probes, 1);
    assert.equal(new Set(results.map((r) => r.measuredAt)).size, 1);
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

test('the official Anthropic endpoint is not an alternate route, any other base URL is', async () => {
  const status = { execFile: async () => ({ stdout: JSON.stringify(claudeStatus) }) };
  assert.equal((await readIdentity('claude', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, status)).ok, true);
  assert.equal((await readIdentity('claude', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }, status)).ok, true);
  for (const value of ['https://gateway.example.test', 'http://api.anthropic.com', 'https://api.anthropic.com.example.test']) {
    assert.equal((await readIdentity('claude', { ANTHROPIC_BASE_URL: value }, status)).reason, 'paid_or_alternate_auth_present');
  }
});

test('a managed bearer the profile endpoint refuses says why, without reading the body', async () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'PRIVATE_RUNTIME_TOKEN' };
  const status = { execFile: async () => ({ stdout: JSON.stringify(managedClaudeStatus) }) };
  for (const code of [401, 403, 429]) {
    const refused = await readIdentity('claude', env, { ...status, fetch: async () => ({ ok: false, status: code, json: async () => { throw new Error('Must not read error payload'); } }) });
    assert.equal(refused.reason, `claude_oauth_profile_http_${code}`);
  }
  const slow = await readIdentity('claude', env, { ...status, fetch: async () => { throw Object.assign(new Error('PRIVATE_RUNTIME_TOKEN'), { name: 'TimeoutError' }); } });
  assert.equal(slow.reason, 'claude_oauth_profile_timeout');
  assert.ok(!JSON.stringify(slow).includes('PRIVATE_RUNTIME_TOKEN'));
});

test('withoutPaidAuth removes only the selected provider credentials and keeps the official endpoint', () => {
  const env = { ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', OPENAI_API_KEY: 'o', PATH: '/bin' };
  assert.deepEqual(withoutPaidAuth('claude', env), { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', OPENAI_API_KEY: 'o', PATH: '/bin' });
  assert.deepEqual(withoutPaidAuth('codex', env), { ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', PATH: '/bin' });
  assert.equal(withoutPaidAuth('claude', { ANTHROPIC_BASE_URL: 'https://proxy.example' }).ANTHROPIC_BASE_URL, undefined);
});
