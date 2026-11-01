import { openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, fstatSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { userInfo } from 'node:os';
import { assessCandidate } from './quota-reserve-policy.js';

export const QUOTA_DIR = join(userInfo().homedir, 'BarroTubeData/workspace/ops');
export const SWITCH_STATE = join(QUOTA_DIR, 'quota-switch-state.json');
export const ADMISSIONS = join(QUOTA_DIR, 'quota-admissions.json');
export const read = (file, fallback = {}) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
export function atomicWrite(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

function releaseLock(file, fd) {
  const held = fstatSync(fd);
  closeSync(fd);
  try {
    const current = statSync(file);
    if (held.dev === current.dev && held.ino === current.ino) unlinkSync(file);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// Serialize reapers: two observers of the same dead PID must not unlink a
// successor's live lock. A crashed recovery itself fails closed for inspection.
function recoverDeadLock(file) {
  const recovery = `${file}.recovery`;
  let fd, owner;
  try { fd = openSync(recovery, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Quota lock recovery is busy; retry later'); throw e; }
  try {
    writeFileSync(fd, String(process.pid));
    let pid, observed;
    try {
      owner = openSync(file, 'r');
      observed = fstatSync(owner);
      pid = Number(readFileSync(owner, 'utf8'));
    }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Quota lock is initializing; retry later');
    try { process.kill(pid, 0); }
    catch (e) {
      if (e.code !== 'ESRCH') throw e;
      // The observed owner might have exited normally while we checked it.
      // Never remove a fresh successor that acquired the path in that interval.
      try {
        const current = statSync(file);
        if (observed.dev === current.dev && observed.ino === current.ino) unlinkSync(file);
      } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      return;
    }
    throw new Error('Quota controller is busy; retry later');
  } finally { if (owner !== undefined) closeSync(owner); releaseLock(recovery, fd); }
}

function acquireLock(file) {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return openSync(file, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      recoverDeadLock(file);
    }
  }
  throw new Error('Could not acquire quota lock');
}

function runLocked(file, fd, work) {
  let result;
  try { writeFileSync(fd, String(process.pid)); result = work(); }
  catch (e) { releaseLock(file, fd); throw e; }
  if (result && typeof result.then === 'function') return Promise.resolve(result).finally(() => releaseLock(file, fd));
  releaseLock(file, fd);
  return result;
}

// A dead owner can be reclaimed; a slow live process never loses its lock.
// Promise callbacks retain ownership until their asynchronous work settles.
export function withLock(file, work) {
  return runLocked(file, acquireLock(file), work);
}

export const LOCK_BUSY = /busy|initializing|Could not acquire quota lock/;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// Same lock, but a live owner is waited for instead of failing the caller.
// 2026-10-28: agent starts that met the governor's 35 s usage probe were denied
// (exit 78 "evidence unavailable") 388 times, and Paperclip stranded their issues.
export async function withLockWait(file, work, { waitMs = 0, pollMs = 250 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd;
    try { fd = acquireLock(file); }
    catch (e) {
      if (!LOCK_BUSY.test(String(e?.message)) || Date.now() >= deadline) throw e;
      await pause(pollMs + Math.floor(Math.random() * pollMs));
      continue;
    }
    return runLocked(file, fd, work);
  }
}

export function reserve({ id, provider, model, identityHash, measurement, agentId, runId, pipeline = false, now = Date.now(), dir = QUOTA_DIR }) {
  return withLock(join(dir, 'quota-admission.lock'), () => {
    const state = read(join(dir, 'quota-switch-state.json'));
    if (state.enabled !== true) throw new Error('Global reserve policy is not initialized');
    if (!identityHash || !measurement) throw new Error('Selected subscription account or weekly evidence is missing');
    // The wrapper proves the exact runtime subscription. Host observations are
    // only planning inputs; another proven subscription has its own balance.
    if (measurement.subscriptionVerified !== true || measurement.identityHash !== identityHash) {
      throw new Error('Selected subscription account does not match verified runtime quota evidence');
    }
    if (typeof id !== 'string' || !id.trim()) throw new Error('A unique quota reservation ID is required');
    const file = join(dir, 'quota-admissions.json');
    const ledger = read(file, { reservations: [] });
    if (!Array.isArray(ledger.reservations) || ledger.reservations.some(r => !r || typeof r !== 'object')) throw new Error('Quota reservation ledger is invalid');
    if (ledger.reservations.some(r => r.id === id)) throw new Error('Quota reservation ID already exists');
    // Completed reservations stay charged until a later measurement can include them.
    ledger.reservations = ledger.reservations.filter(r => !(r.identityHash === identityHash && r.provider === provider && r.finishedAt && Date.parse(measurement.measuredAt) > Date.parse(r.finishedAt) + 60_000));
    // 파이프라인 예약에는 실행 ID가 없어 reconcile 이 풀어 주지 못한다 — 회차가 KILL 되면 여기서 치운다.
    ledger.reservations = ledger.reservations.filter(r => !(r.pipeline && !r.finishedAt && ownerGone(r.pid)));
    // 생산 호출은 자기들끼리만 센다. 돌고 있는 에이전트 예약(건당 5~8%)에 막히면 시간당 CEO·SRE 실행이 발행을 멈춘다.
    const pending = ledger.reservations.filter(r => r.identityHash === identityHash && r.provider === provider && (!pipeline || r.pipeline));
    const recordedRuns = new Set(pending.map(r => r.runId).filter(Boolean));
    for (const r of pipeline ? [] : state.runningReservations ?? []) {
      if (r.provider === provider && r.runId !== runId && !recordedRuns.has(r.runId)) pending.push(r);
    }
    const result = assessCandidate({ provider, model, providers: { [provider]: measurement }, estimates: state.estimates ?? {}, reservations: pending, now, pipeline });
    if (!result.allow) return result;
    ledger.reservations.push({ id, provider, model, identityHash, agentId, runId, percent: result.modelBudgetPercent, startedAt: new Date(now).toISOString(), status: 'running', pid: process.pid, ...(pipeline ? { pipeline: true } : {}) });
    atomicWrite(file, ledger);
    return result;
  });
}

export function finishReservation(id, dir = QUOTA_DIR) {
  withLock(join(dir, 'quota-admission.lock'), () => {
    const file = join(dir, 'quota-admissions.json');
    const ledger = read(file, { reservations: [] });
    const r = ledger.reservations.find(x => x.id === id);
    if (r) { r.finishedAt = new Date().toISOString(); r.status = 'unsettled'; atomicWrite(file, ledger); }
  });
}

const TERMINAL_RUNS = new Set(['succeeded', 'interrupted', 'failed', 'cancelled', 'timed_out']);
function ownerGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (e) { return e.code === 'ESRCH'; }
}

/**
 * Recover abandoned wrappers only with exact terminal Paperclip run proof.
 * This marks an unsettled charge; reserve() alone releases it after a later
 * verified same-account measurement and the normal 60-second settling delay.
 * No run ID, unknown process state, or missing proof means retain and report.
 */
export async function reconcileReservations({ getRun, now = Date.now(), dir = QUOTA_DIR }) {
  if (typeof getRun !== 'function' || !Number.isFinite(now)) throw new Error('Run proof reader and valid reconciliation time are required');
  const file = join(dir, 'quota-admissions.json');
  const ledger = read(file, { reservations: [] });
  if (!Array.isArray(ledger.reservations) || ledger.reservations.some(r => !r || typeof r !== 'object')) throw new Error('Quota reservation ledger is invalid');
  const result = { checked: ledger.reservations.length, markedUnsettled: [], retained: [] };
  const retain = (record, reason) => result.retained.push({ id: record.id ?? null, reason });
  const proven = [];
  // Network reads must not monopolize the admission lock.
  for (const record of ledger.reservations) {
    if (record.finishedAt) { retain(record, 'awaiting-fresh-measurement'); continue; }
    if (!record.runId) { retain(record, 'no-run-id'); continue; }
    if (record.status !== 'running' || typeof record.id !== 'string' || !record.id || !record.agentId
        || !Number.isInteger(record.pid) || record.pid <= 0 || !Number.isFinite(Date.parse(record.startedAt))) {
      retain(record, 'invalid-record'); continue;
    }
    if (!ownerGone(record.pid)) { retain(record, 'owner-live-or-unknown'); continue; }
    let run;
    try { run = await getRun(record.runId); }
    catch { retain(record, 'run-proof-unavailable'); continue; }
    if (!run) { retain(record, 'run-proof-unavailable'); continue; }
    if (run.id !== record.runId || run.agentId !== record.agentId || (record.companyId && run.companyId !== record.companyId)) {
      retain(record, 'run-proof-mismatch'); continue;
    }
    if (!TERMINAL_RUNS.has(run.status)) { retain(record, 'run-not-terminal'); continue; }
    const finished = Date.parse(run.finishedAt);
    if (!Number.isFinite(finished) || finished > now || finished < Date.parse(record.startedAt)) {
      retain(record, 'invalid-run-finish-time'); continue;
    }
    proven.push({ record, run });
  }
  if (!proven.length) return result;
  return withLock(join(dir, 'quota-admission.lock'), () => {
    const current = read(file, { reservations: [] });
    if (!Array.isArray(current.reservations) || current.reservations.some(r => !r || typeof r !== 'object')) throw new Error('Quota reservation ledger is invalid');
    const fields = ['id', 'pid', 'agentId', 'runId', 'companyId', 'provider', 'identityHash', 'startedAt', 'finishedAt', 'status', 'percent'];
    for (const { record, run } of proven) {
      const entry = current.reservations.find(r => r.id === record.id);
      if (!entry || fields.some(key => entry[key] !== record[key])) { retain(record, 'reservation-changed'); continue; }
      if (!ownerGone(entry.pid)) { retain(record, 'owner-live-or-unknown'); continue; }
      entry.status = 'unsettled';
      // Reconciliation time is conservative even if the run finished long ago.
      entry.finishedAt = new Date(now).toISOString();
      entry.terminalProof = { runId: run.id, status: run.status, finishedAt: run.finishedAt, checkedAt: entry.finishedAt };
      result.markedUnsettled.push(entry.id);
    }
    if (result.markedUnsettled.length) atomicWrite(file, current);
    return result;
  });
}
