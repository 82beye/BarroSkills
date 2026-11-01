#!/Users/beye/.nvm/versions/node/v24.11.1/bin/node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, userInfo } from 'node:os';
import { normalizeQuota } from './quota-reserve-policy.js';
import { readRuntimeQuota, withoutPaidAuth } from './quota-cli-identity.js';
import { reserve, finishReservation, LOCK_BUSY, read, SWITCH_STATE } from './quota-admission.js';

const nativeBin = join(userInfo().homedir, '.local/bin');
const executablePaths = { claude: join(nativeBin, 'claude'), codex: join(nativeBin, 'codex') };
// Native adapter settings only: auth/model overrides require separate proof.
const codexConfigKeys = new Set(['sandbox_mode', 'sandbox_workspace_write.network_access', 'sandbox_workspace_write.writable_roots', 'shell_environment_policy.inherit', 'approval_policy', 'model_reasoning_effort', 'service_tier', 'features.fast_mode']);
const codexHelloSettings = new Map([['features.plugins', 'false'], ['features.remote_plugin', 'false'], ['project_doc_max_bytes', '0']]);

export function validateQuotaArgs(provider, args) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (/^--(?:profile|api-key|base-url|settings|fallback-model)(?:=|$)/.test(arg)) return false;
    if (arg === '--setting-sources' || arg.startsWith('--setting-sources=')) {
      const source = arg === '--setting-sources' ? args[++index] : arg.slice('--setting-sources='.length);
      if (provider !== 'claude' || source !== 'user') return false;
      continue;
    }
    if (provider === 'codex') {
      if (/^-p/.test(arg) || ['--oss', '--local-provider'].includes(arg) || arg.startsWith('--local-provider=')) return false;
      let setting;
      if (arg === '-c' || arg === '--config') setting = args[++index];
      else if (arg.startsWith('--config=')) setting = arg.slice('--config='.length);
      else if (arg.startsWith('-c')) setting = arg.slice(2).replace(/^=/, '');
      if (setting !== undefined) {
        const key = setting.split('=')[0].trim();
        const value = setting.slice(setting.indexOf('=') + 1).trim();
        if (!setting.includes('=') || (!codexConfigKeys.has(key) && codexHelloSettings.get(key) !== value)) return false;
      } else if (arg === '-c' || arg === '--config') return false;
    }
  }
  return true;
}

// Paperclip defers a run only when the CLI reads like a provider limit; any other
// exit spends its two 30 s retries and strands the issue as board-blocked
// (2026-10-28: 388 denials, most issues of 3 companies). The first stderr line is
// the adapter's own phrase with a retry clock; the guard marker stays on line 2.
const LIMIT_TIME_ZONE = 'Asia/Seoul';
export function deferralNotice(provider, model, retryAt, timeZone = LIMIT_TIME_ZONE) {
  const part = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(retryAt).map((p) => [p.type, p.value]));
  const period = String(part.dayPeriod).toUpperCase();
  if (provider === 'codex') {
    return `You've hit your usage limit for ${model && model !== 'unknown' ? model : 'this model'}. Switch to another model now, or try again at ${part.hour}:${part.minute} ${period} (${timeZone}).`;
  }
  return `Claude usage limit reached. Your limit resets ${part.hour}:${part.minute}${period.toLowerCase()} (${timeZone}).`;
}

// Holds the governor records instead of switching an agent's wakes off (daily
// cost caps; barrojo plan holds). Returns minutes to postpone, or null.
export function admissionHoldMinutes(state, agentId, now = Date.now()) {
  const hold = agentId ? state?.admissionHolds?.[agentId] : null;
  const until = Date.parse(hold?.until);
  if (!Number.isFinite(until) || until <= now) return null;
  return Math.min(23 * 60, Math.max(1, Math.ceil((until - now) / 60_000)));
}

// Paperclip writes the prompt to the child's stdin only after it has recorded the
// spawn, and without an error listener: a wrapper that exits first turns that write
// into an unhandled EPIPE that takes the whole server down (2026-10-28: three
// restarts in the first hour of denials). When no provider started, read the
// prompt to its end before leaving.
export function drainInput(input = process.stdin, timeoutMs = 30_000) {
  if (!input || input.isTTY || input.readableEnded || input.destroyed) return Promise.resolve();
  return new Promise((done) => {
    let open = true;
    const skip = () => {};
    const finish = () => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      input.off('data', skip);
      input.destroy();
      done();
    };
    const timer = setTimeout(finish, timeoutMs);
    input.on('data', skip);
    input.once('end', finish);
    input.once('error', finish);
    input.resume();
  });
}

// dispatch 가 생산 액션에만 붙이고 PAPERCLIP_* 는 지운다 — 에이전트 실행은 어떤 경우에도 이 등급이 아니다.
export const isProductionCall = (env) => env.BT_QUOTA_CLASS === 'production' && !env.PAPERCLIP_AGENT_ID;

// A fixed proof-step code (never CLI output or credentials) says which check failed.
const reasonCode = (value) => (typeof value === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(value) ? value : 'unknown');

function requestedModel(args) {
  let model = 'unknown';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--model' || arg === '-m') model = args[++index] || 'unknown';
    else if (arg.startsWith('--model=')) model = arg.slice(8) || 'unknown';
    else if (/^-m[^-]/.test(arg)) model = arg.slice(2).replace(/^=/, '') || 'unknown';
  }
  return model;
}

/** Injectable lifecycle: tests never start a model or touch the admission ledger. */
export async function runQuotaCli(argv = process.argv, env = process.env, dependencies = {}) {
  const deps = { spawn, randomUUID, normalizeQuota, readRuntimeQuota, reserve, finishReservation,
    readState: () => read(SWITCH_STATE, {}),
    signals: process, report: (message) => console.error(message), now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)), ...dependencies };
  const args = argv.slice(2);
  const provider = basename(argv[1]).includes('quota-claude') ? 'claude'
    : basename(argv[1]).includes('quota-codex') ? 'codex' : args.shift();
  const executable = executablePaths[provider];
  // deferMinutes: null for a configuration fault (Paperclip should surface it);
  // a number when the same run can start later and should only be postponed.
  const deny = (reason, deferMinutes = null) => {
    if (deferMinutes) {
      const retryAt = new Date(Math.ceil((deps.now() + deferMinutes * 60_000) / 60_000) * 60_000);
      deps.report(deferralNotice(provider, requestedModel(args), retryAt));
    }
    deps.report(`PAPERCLIP_RESERVE_GUARD: admission denied; ${reason}. No provider started.`);
    return 78;
  };
  if (!executable) return deny('unknown provider');
  const production = isProductionCall(env);
  // produce-episode 가 이미지 엔진용으로 OPENAI_API_KEY 를 환경에 올리면 그 뒤 S9 codex 가 「유료 인증」으로 거부됐다
  // (2026-10-30 부동산·국내 마감). 구독 CLI 에는 필요 없는 키라 떼고 넘긴다 — 지우는 쪽이라 유료 우회가 될 수 없다.
  if (production) env = withoutPaidAuth(provider, env);
  const versionOnly = args.length === 1 && ['--version', '-v', '--help', '-h'].includes(args[0]);
  let reservation;
  if (!versionOnly) {
    if (!validateQuotaArgs(provider, args)) return deny('credential, provider, or model overrides require separate quota evidence');
    try {
      const held = admissionHoldMinutes(deps.readState(), env.PAPERCLIP_AGENT_ID, deps.now());
      if (held) return deny('agent admission hold is active', held);
      const evidence = await deps.readRuntimeQuota(provider, env);
      if (!evidence.ok || !evidence.identityHash) return deny(`selected subscription evidence unavailable (${reasonCode(evidence.reason)})`, 5);
      const providers = deps.normalizeQuota(evidence.quota, { now: deps.now(), accountEvidence: { [provider]: { measuredAt: evidence.measuredAt } } });
      const model = requestedModel(args);
      reservation = deps.randomUUID();
      const measurement = { ...providers[provider], identityHash: evidence.identityHash, subscriptionVerified: evidence.ok === true };
      // Concurrent starts share the admission ledger lock; wait briefly instead of failing.
      let check;
      for (const deadline = deps.now() + 10_000; ;) {
        try { check = deps.reserve({ id: reservation, provider, model, identityHash: evidence.identityHash, measurement, agentId: env.PAPERCLIP_AGENT_ID, runId: env.PAPERCLIP_RUN_ID, pipeline: production }); break; }
        catch (e) {
          if (!LOCK_BUSY.test(String(e?.message)) || deps.now() >= deadline) throw e;
          await deps.sleep(150 + Math.floor(Math.random() * 150));
        }
      }
      if (!check.allow) {
        reservation = null;
        // Usage alone past the line waits an hour (barrojo may re-plan meanwhile);
        // a denial caused only by in-flight reservations clears within minutes.
        const weekly = [check.usedPercent, check.modelBudgetPercent, check.admissionLimitPercent].every(Number.isFinite)
          && check.usedPercent + check.modelBudgetPercent > check.admissionLimitPercent;
        return deny('weekly reserve or model allowance would be exceeded', weekly ? 60 : 10);
      }
    } catch {
      // Never print raw subprocess output or credential-bearing exception text.
      return deny('runtime quota or reservation check failed', 5);
    }
  }
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (reservation) {
      try { deps.finishReservation(reservation); }
      catch { deps.report('PAPERCLIP_RESERVE_GUARD: reservation retained for reconciliation'); }
    }
  };
  let child;
  try { child = deps.spawn(executable, args, { stdio: 'inherit', env: { ...env, PAPERCLIP_ACTIVE_PROVIDER: provider } }); }
  catch { settle(); return 1; }
  return new Promise((done) => {
    const handlers = new Map(['SIGTERM', 'SIGINT', 'SIGHUP'].map((signal) => [signal, () => child.kill(signal)]));
    for (const [signal, handler] of handlers) deps.signals.on(signal, handler);
    const complete = (code) => {
      for (const [signal, handler] of handlers) deps.signals.removeListener(signal, handler);
      settle();
      done(code);
    };
    child.once('error', () => complete(1));
    child.once('exit', (code, signal) => complete(code ?? (signal ? 128 + (constants.signals[signal] || 0) : 1)));
  });
}

// Alias paths still select their provider using the original argv[1] basename.
const invoked = process.argv[1] && (resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  || /^quota-(?:claude|codex)(?:\.js)?$/.test(basename(process.argv[1])));
if (invoked) {
  let started = false;
  const code = await runQuotaCli(process.argv, process.env, { spawn: (...call) => { const child = spawn(...call); started = true; return child; } });
  if (!started) await drainInput();
  process.exitCode = code;
}
