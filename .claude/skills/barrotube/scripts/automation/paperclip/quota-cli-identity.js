import { createHash } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { read, atomicWrite, withLockWait, QUOTA_DIR } from './quota-admission.js';

const execFile = promisify(execFileCallback);
const moduleFile = fileURLToPath(import.meta.url);
const hostHome = userInfo().homedir;
const cleanKeys = /^(?:ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|AZURE_OPENAI_|PAPERCLIP_|XDG_|AWS_|GOOGLE_|VERTEX_)/;
const nonempty = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (reason) => ({ ok: false, kind: null, identityHash: null, reason });
const providerName = (provider) => ({ claude: 'anthropic', claude_local: 'anthropic', codex: 'openai', codex_local: 'openai' }[provider] || provider);
const claudeSubscriptions = new Set(['max', 'pro', 'team', 'enterprise']);
const claudeProfileSubscriptions = new Set([...claudeSubscriptions].map((plan) => `claude_${plan}`));

// Deliberately choose the original installed CLI, never an adapter-configured wrapper.
function realCli(provider, opts = {}) {
  return opts.cliPath || path.join(hostHome, '.local/bin', provider === 'anthropic' ? 'claude' : 'codex');
}

export function cleanHostEnvironment(env = process.env) {
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => !cleanKeys.test(key)));
  result.HOME = hostHome;
  result.PATH = `${path.join(hostHome, '.local/bin')}:${result.PATH || '/usr/bin:/bin'}`;
  return result;
}

// The official endpoint is not an alternate route; BarroShopping pins it on its
// claude_local hires (company.json), and the CLI's own status still gates the login.
const officialBase = { ANTHROPIC_BASE_URL: /^https:\/\/api\.anthropic\.com\/?$/i };

const paidAuthKeys = (provider) => (provider === 'anthropic'
  ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
  : ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT']);

function hasPaidOrAlternateAuth(provider, env) {
  return paidAuthKeys(provider).some((key) => nonempty(env[key]) && env[key] !== '0' && env[key] !== 'false' && !officialBase[key]?.test(env[key].trim()));
}

/** 구독 CLI 에 넘기면 안 되는 유료·대체 인증 값을 뺀 환경. 공식 주소는 대체 경로가 아니므로 남긴다. */
export function withoutPaidAuth(provider, env) {
  const keys = paidAuthKeys(providerName(provider));
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => !keys.includes(key) || officialBase[key]?.test(String(value).trim())));
}

function jwtClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : {};
  } catch { return {}; }
}

// Claude's native auth-status command intentionally omits account/plan metadata for
// CLAUDE_CODE_OAUTH_TOKEN. Verify that exact bearer with the same profile endpoint
// used by the CLI; never fall back to the host's cached login or an API key.
async function claudeTokenIdentity(token, opts) {
  let profile;
  try {
    const response = await (opts.fetch || fetch)('https://api.anthropic.com/api/oauth/profile', {
      method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'paperclip-quota-guard/1.0' },
      signal: AbortSignal.timeout(opts.profileTimeoutMs || 8_000),
    });
    // The HTTP status separates an expired/revoked bearer (401), a scope it lacks (403)
    // and rate limiting (429); the response body is never read.
    if (!response.ok) return fail(Number.isInteger(response.status) ? `claude_oauth_profile_http_${response.status}` : 'claude_oauth_profile_unavailable');
    profile = await response.json();
  } catch (error) { return fail(error?.name === 'TimeoutError' ? 'claude_oauth_profile_timeout' : 'claude_oauth_profile_unavailable'); }
  if (!claudeProfileSubscriptions.has(profile?.organization?.organization_type)) return fail('claude_subscription_not_proven');
  const account = nonempty(profile?.account?.uuid);
  const email = nonempty(profile?.account?.email)?.toLowerCase();
  const organization = nonempty(profile?.organization?.uuid);
  if (!account || !email || !organization) return fail('claude_account_identity_missing');
  return { ok: true, kind: 'subscription', identityHash: hash(`anthropic:claude.ai:${email}:${organization}`), reason: null, source: 'claude-oauth-profile' };
}

async function codexAuth(env, opts) {
  const codexHome = nonempty(env.CODEX_HOME) || path.join(nonempty(env.HOME) || hostHome, '.codex');
  const reader = opts.readFile || readFile;
  // A named alternate provider can use paid credentials despite a ChatGPT auth.json.
  let config = '';
  try { config = await reader(path.join(codexHome, 'config.toml'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') return { error: 'codex_config_unreadable' }; }
  const topLevel = config.split(/^\s*\[/m)[0];
  if (/^\s*model_provider\s*=\s*["'](?!openai["'])/m.test(topLevel) || /^\s*forced_login_method\s*=\s*["']api/m.test(topLevel)) {
    return { error: 'alternate_provider_config' };
  }
  if (/^\s*(?:profile|chatgpt_base_url|openai_base_url)\s*=/m.test(topLevel) || /^\s*\[model_providers\.openai(?:\]|\.)/m.test(config)) {
    return { error: 'unverified_provider_profile' };
  }
  if (/^\s*cli_auth_credentials_store\s*=\s*["'](?!file["'])/m.test(topLevel)) {
    return { error: 'non_file_credential_store' };
  }
  try { return { auth: JSON.parse(await reader(path.join(codexHome, 'auth.json'), 'utf8')) }; }
  catch { return { error: 'codex_auth_unavailable' }; }
}

/** Account proof only. Never returns credentials, email, organization IDs or CLI output. */
export async function readIdentity(provider, env = process.env, opts = {}) {
  provider = providerName(provider);
  if (!['anthropic', 'openai'].includes(provider)) return fail('unsupported_provider');
  if (hasPaidOrAlternateAuth(provider, env)) return fail('paid_or_alternate_auth_present');
  if (provider === 'anthropic') {
    let status;
    try {
      const result = await (opts.execFile || execFile)(realCli(provider, opts), ['auth', 'status', '--json'], {
        env: { ...env }, timeout: opts.timeoutMs || 12_000, maxBuffer: 256 * 1024, windowsHide: true,
      });
      status = JSON.parse(result.stdout);
    } catch { return fail('claude_auth_status_unavailable'); }
    if (status.loggedIn !== true || (status.apiProvider && status.apiProvider !== 'firstParty')) {
      return fail('claude_subscription_not_proven');
    }
    const runtimeToken = nonempty(env.CLAUDE_CODE_OAUTH_TOKEN);
    if (runtimeToken) {
      if (status.authMethod !== 'oauth_token') return fail('claude_runtime_auth_conflict');
      return claudeTokenIdentity(runtimeToken, opts);
    }
    if (status.authMethod !== 'claude.ai') return fail('claude_subscription_not_proven');
    const subscription = nonempty(status.subscriptionType);
    const email = nonempty(status.email)?.toLowerCase();
    const organization = nonempty(status.orgId) || nonempty(status.orgUuid);
    if (!claudeSubscriptions.has(subscription)) return fail('claude_subscription_not_proven');
    if (!email || !organization) return fail('claude_account_identity_missing');
    return { ok: true, kind: 'subscription', identityHash: hash(`anthropic:claude.ai:${email}:${organization}`), reason: null, source: 'claude-auth-status' };
  }
  const result = await codexAuth(env, opts);
  if (result.error) return fail(result.error);
  const auth = result.auth;
  if (!auth || typeof auth !== 'object' || nonempty(auth.OPENAI_API_KEY) || (auth.auth_mode && auth.auth_mode !== 'chatgpt')) {
    return fail('codex_subscription_not_proven');
  }
  const tokens = auth.tokens || {};
  if (!nonempty(tokens.access_token)) return fail('codex_subscription_token_missing');
  const claims = [jwtClaims(tokens.id_token || ''), jwtClaims(tokens.access_token)];
  const accounts = new Set([tokens.account_id, ...claims.map((claim) => claim['https://api.openai.com/auth']?.chatgpt_account_id)].map(nonempty).filter(Boolean));
  const users = new Set(claims.map((claim) => claim['https://api.openai.com/auth']?.chatgpt_user_id).map(nonempty).filter(Boolean));
  if (accounts.size !== 1 || users.size > 1) return fail('codex_account_identity_missing_or_conflicting');
  if (!auth.auth_mode && users.size !== 1) return fail('codex_subscription_not_proven');
  // Account ID is the quota scope; do not hash refreshable access tokens.
  return { ok: true, kind: 'subscription', identityHash: hash(`openai:chatgpt:${[...accounts][0]}`), reason: null, source: 'codex-auth-json' };
}

export async function hostIdentity(provider, opts = {}) {
  return readIdentity(provider, cleanHostEnvironment(opts.hostEnv || process.env), opts);
}

function quotaWindow(raw, durationMinutes, limitId = 'codex') {
  const percent = raw.usedPercent ?? raw.used_percent;
  const reset = raw.resetsAt ?? raw.reset_at;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const duration = typeof durationMinutes === 'number' && Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : null;
  const scope = duration === 10080 ? 'weekly' : duration === 300 ? 'session' : 'unknown';
  let resetsAt = typeof reset === 'number' ? new Date(reset * 1000).toISOString() : typeof reset === 'string' ? reset : null;
  if (resetsAt && !Number.isFinite(Date.parse(resetsAt))) resetsAt = null;
  return { label: scope === 'weekly' ? 'Weekly limit' : scope === 'session' ? '5h limit' : 'Unclassified limit', scope, limitId, durationMinutes: duration, usedPercent: percent, resetsAt };
}

export function normalizeCodexRateLimits(result) {
  const limits = new Map(Object.entries(result.rateLimitsByLimitId || {}));
  if (result.rateLimits) limits.set(result.rateLimits.limitId || 'codex', result.rateLimits);
  const windows = [];
  for (const [limitId, limit] of limits) {
    for (const name of ['primary', 'secondary']) {
      if (!limit?.[name]) continue;
      const window = quotaWindow(limit[name], limit[name].windowDurationMins, limitId);
      if (window) windows.push(window);
    }
  }
  return windows;
}

// Only initialize and account reads are permitted here; no thread/turn or model request.
async function codexRpcWindows(env) {
  const child = spawn(realCli('openai'), ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let sequence = 0;
  const pending = new Map();
  const rejectPending = () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('rpc_unavailable')); }
    pending.clear();
  };
  child.on('error', rejectPending);
  child.on('exit', rejectPending);
  child.stderr.resume();
  child.stdin.on('error', rejectPending);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) { rejectPending(); child.kill(); return; }
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const item = pending.get(message.id); if (!item) continue;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error('rpc_request_failed')); else item.resolve(message.result);
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('rpc_timeout')); }, 6_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await request('initialize', { clientInfo: { name: 'paperclip-quota-proof', version: '1.0.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    return normalizeCodexRateLimits(await request('account/rateLimits/read'));
  } finally { rejectPending(); child.kill('SIGTERM'); }
}

async function nativeQuotaModule(provider) {
  const adapter = provider === 'anthropic' ? 'adapter-claude-local' : 'adapter-codex-local';
  const filename = path.resolve(path.dirname(process.execPath), `../lib/node_modules/paperclipai/node_modules/@paperclipai/${adapter}/dist/server/quota.js`);
  return import(pathToFileURL(filename).href);
}

export async function probeClaudeQuota(native, env, opts = {}) {
  let token = nonempty(env.CLAUDE_CODE_OAUTH_TOKEN);
  if (!token && env.HOME === hostHome && !nonempty(env.CLAUDE_CONFIG_DIR)) {
    token = await native.readClaudeToken({ allowKeychain: true });
    if (token) {
      const [selected, bearer] = await Promise.all([readIdentity('anthropic', env, opts), claudeTokenIdentity(token, opts)]);
      if (!selected.ok || !bearer.ok || selected.identityHash !== bearer.identityHash) return { ok: false, windows: [] };
    }
  }
  const result = token ? { ok: true, source: 'claude-oauth-runtime', windows: await native.fetchClaudeQuota(token) } : await native.getQuotaWindows();
  return { ...result, windows: (result.windows || []).map((window) => ({
    label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt,
    scope: /current week/i.test(window.label) ? 'weekly' : /current session/i.test(window.label) ? 'session' : 'unknown',
    durationMinutes: /current week/i.test(window.label) ? 10080 : /current session/i.test(window.label) ? 300 : null,
  })) };
}

async function probeQuota(provider, env) {
  if (provider === 'anthropic') {
    return probeClaudeQuota(await nativeQuotaModule(provider), env);
  }
  try {
    const windows = await codexRpcWindows(env);
    if (windows.length) return { ok: true, source: 'codex-rpc-runtime', windows };
  } catch { /* The direct subscription usage endpoint retains actual window duration. */ }
  const { auth } = await codexAuth(env, {});
  if (!auth?.tokens?.access_token) return { ok: false, source: 'codex-wham-runtime', windows: [] };
  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: { Authorization: `Bearer ${auth.tokens.access_token}`, 'ChatGPT-Account-Id': auth.tokens.account_id },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return { ok: false, source: 'codex-wham-runtime', windows: [] };
  const body = await response.json();
  const windows = ['primary_window', 'secondary_window'].flatMap((name) => {
    const raw = body.rate_limit?.[name];
    const window = raw && quotaWindow(raw, typeof raw.limit_window_seconds === 'number' ? raw.limit_window_seconds / 60 : null);
    return window ? [window] : [];
  });
  return { ok: windows.length > 0, source: 'codex-wham-runtime', windows };
}

/** Exact runtime environment is isolated in a child; credentials remain in memory. */
export async function readRuntimeQuota(provider, env = process.env, opts = {}) {
  provider = providerName(provider);
  const identity = await readIdentity(provider, env, opts);
  const observedAt = new Date().toISOString();
  const output = (value) => ({ ...value, measuredAt: value.observedAt, quota: [{ provider, ok: value.ok, source: value.source || null, windows: value.windows }] });
  if (!identity.ok) return output({ ...identity, provider, observedAt, windows: [] });
  const cacheDir = opts.cacheDir !== undefined ? opts.cacheDir
    : opts.probeQuota || opts.execFile || opts.readFile ? null : path.join(QUOTA_DIR, 'quota-observations');
  const cacheFile = cacheDir && path.join(cacheDir, `${provider}-${identity.identityHash}.json`);
  const sharedObservation = () => {
    if (!cacheFile) return null;
    try {
      const cached = read(cacheFile, null);
      const age = Date.now() - Date.parse(cached?.observedAt);
      return cached?.provider === provider && cached?.identityHash === identity.identityHash
        && cached?.result?.ok === true && cached.result.windows?.length > 0 && age >= 0 && age < 5 * 60_000 ? cached : null;
    } catch { return null; }
  };
  const collect = async (cached = sharedObservation()) => {
    const reusable = Boolean(cached);
    let result;
    try {
      if (reusable) result = cached.result;
      else if (opts.probeQuota) result = await opts.probeQuota(provider, env);
      else {
        const child = await (opts.execFile || execFile)(process.execPath, [moduleFile, '--quota-probe', provider], {
          // Native Claude quota fallback resolves `claude` through PATH. A server
          // PATH containing guarded launchers must not recursively admit a quota
          // read. Keep all account selectors; only this read-only child uses the
          // original CLI directory first.
          env: { ...env, PATH: `${path.dirname(realCli(provider, opts))}:${env.PATH || '/usr/bin:/bin'}` },
          timeout: opts.quotaTimeoutMs || 35_000, maxBuffer: 512 * 1024, windowsHide: true,
        });
        result = JSON.parse(child.stdout);
      }
    } catch { return output({ ...identity, ok: false, provider, observedAt, reason: 'runtime_quota_unavailable', windows: [] }); }
    const after = await readIdentity(provider, env, opts);
    if (!after.ok || after.identityHash !== identity.identityHash) return output({ ...identity, ok: false, provider, observedAt, reason: 'runtime_identity_changed', windows: [] });
    // Keep the original observation time so cached readings cannot settle later consumption reservations.
    const measuredAt = reusable ? cached.observedAt : new Date().toISOString();
    if (cacheFile && !reusable && result.ok === true && result.windows?.length > 0) {
      atomicWrite(cacheFile, { provider, identityHash: identity.identityHash, observedAt: measuredAt, result });
    }
    return output({ ...identity, provider, observedAt: measuredAt, source: result.source || null, ok: result.ok === true,
      reason: result.ok ? null : 'runtime_quota_unavailable', windows: Array.isArray(result.windows) ? result.windows : [] });
  };
  try {
    if (!cacheFile) return await collect();
    // A fresh shared observation needs no lock: atomicWrite replaces whole files.
    const shared = sharedObservation();
    if (shared) return await collect(shared);
    // One process probes an account at a time; the others wait for its observation
    // instead of failing their run (the probe child may take up to 35 s).
    return await withLockWait(`${cacheFile}.lock`, () => collect(), { waitMs: opts.lockWaitMs ?? 45_000 });
  }
  catch { return output({ ...identity, ok: false, provider, observedAt, reason: 'runtime_quota_unavailable', windows: [] }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile && process.argv[2] === '--quota-probe') {
  try {
    const provider = providerName(process.argv[3]);
    const identity = await readIdentity(provider, process.env);
    if (!identity.ok) process.stdout.write(JSON.stringify({ ok: false, windows: [] }));
    else {
      const result = await probeQuota(provider, process.env);
      process.stdout.write(JSON.stringify({ ok: result.ok === true, source: result.source || null, windows: result.windows || [] }));
    }
  } catch { process.stdout.write(JSON.stringify({ ok: false, windows: [] })); }
}
