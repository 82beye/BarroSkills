#!/usr/bin/env node

/**
 * in-flight-lock.js — Producer 직렬 처리 하네스 락
 *
 * 운영 정책: "한 개 에피소드 종료 전에 다른 에피소드 진행되지 않게"
 *
 * 락 파일: workspace/.in-flight.json
 * 구조:
 *   {
 *     "episode_id": "EP-2026-0020",
 *     "stage": "S6c",
 *     "started_at": "2026-04-26T...",
 *     "pid": 12345,
 *     "host": "macbook.local",
 *     "command": "produce-episode.js --episode EP-2026-0020",
 *     "expected_completion": "S11 publish or explicit release",
 *     "heartbeat_at": "2026-04-26T..."
 *   }
 *
 * 사용 모델:
 *   - acquireLock(epId, stage, opts) → throw on conflict, write file on success
 *   - releaseLock(epId)              → unlink file (idempotent)
 *   - getCurrentLock()               → JSON | null
 *   - isStale(lock)                  → boolean (PID dead OR heartbeat timeout)
 *   - forceRelease()                 → unlink regardless
 *   - heartbeat(epId, stage?)        → update heartbeat_at + optional stage
 *
 * Stale 감지:
 *   - PID 가 더 이상 존재하지 않음 (process.kill(pid, 0) ENOENT/ESRCH)
 *   - heartbeat_at + heartbeat_timeout_minutes (governance.json) 초과
 *
 * CLI:
 *   node scripts/automation/in-flight-lock.js status
 *   node scripts/automation/in-flight-lock.js release [--episode EP-XXXX]
 *   node scripts/automation/in-flight-lock.js force-release
 *   node scripts/automation/in-flight-lock.js heartbeat --episode EP-XXXX [--stage S6c]
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE = join(ROOT, 'workspace');
const LOCK_FILE = join(WORKSPACE, '.in-flight.json');
const GOV_FILE = join(ROOT, 'paperclip', 'config', 'company.json');

// ─────────────────────────────────────────────────────────────────────────────
// Defaults / config
// ─────────────────────────────────────────────────────────────────────────────

function getHeartbeatTimeoutMinutes() {
  try {
    const cfg = JSON.parse(readFileSync(GOV_FILE, 'utf-8'));
    const v = cfg?.governance?.escalation_policy?.heartbeat_timeout_minutes;
    return Number.isFinite(v) && v > 0 ? v : 90;
  } catch {
    return 90;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────────────────────────────────────

export function getCurrentLock() {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
  } catch (e) {
    // 깨진 락 파일은 stale로 간주.
    return { __corrupt: true, raw: e.message };
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // signal 0 = 존재 검사. 권한 없으면 EPERM (살아있음). 미존재 ESRCH.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'EPERM') return true;
    return false;
  }
}

export function isStale(lock) {
  if (!lock) return false;
  if (lock.__corrupt) return true;
  // PID가 다른 호스트면 PID 검사 신뢰 불가 → heartbeat만 사용.
  const sameHost = lock.host === hostname();
  if (sameHost && Number.isInteger(lock.pid) && !isPidAlive(lock.pid)) return true;
  const hb = lock.heartbeat_at || lock.started_at;
  if (!hb) return false;
  const ageMin = (Date.now() - new Date(hb).getTime()) / 60000;
  return ageMin > getHeartbeatTimeoutMinutes();
}

function writeLock(data) {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 락 발급. 충돌 시 throw. idempotent on same EP.
 *
 * @param {string} episodeId - "EP-2026-NNNN"
 * @param {string} stage     - "S4", "S6c", ... (선택)
 * @param {object} opts
 *   - command: 호출 명령 (감사용, 선택)
 *   - autoCleanStale: stale 감지 시 자동 강제 해제 후 재시도 (default false)
 * @returns {object} 발급된 lock object
 */
export function acquireLock(episodeId, stage = null, opts = {}) {
  if (!episodeId || !/^EP-\d{4}-\d{4}$/.test(episodeId)) {
    throw new Error(`Invalid episode_id: ${episodeId}`);
  }

  const existing = getCurrentLock();

  if (existing) {
    // 같은 EP — idempotent. heartbeat + stage 만 갱신.
    if (existing.episode_id === episodeId) {
      const updated = {
        ...existing,
        stage: stage || existing.stage,
        heartbeat_at: new Date().toISOString(),
        pid: process.pid, // 재진입한 새 프로세스 ID로 갱신
        host: hostname(),
        command: opts.command || existing.command,
      };
      writeLock(updated);
      return updated;
    }

    // 다른 EP — stale 검사
    if (isStale(existing)) {
      if (opts.autoCleanStale) {
        console.warn(`⚠ Stale lock detected (${existing.episode_id}, pid=${existing.pid}) — auto-releasing.`);
        forceRelease();
      } else {
        const why = existing.__corrupt ? 'corrupt'
                  : (Number.isInteger(existing.pid) && !isPidAlive(existing.pid) ? `pid ${existing.pid} dead`
                  : 'heartbeat timeout');
        const err = new Error(
          `[in-flight-lock] STALE lock for ${existing.episode_id} (${why}). ` +
          `Use --force-release-stale or 'node scripts/automation/in-flight-lock.js force-release'.`
        );
        err.code = 'ELOCK_STALE';
        err.lock = existing;
        throw err;
      }
    } else {
      // 살아있는 다른 EP — 거부
      const err = new Error(
        `[in-flight-lock] Episode ${existing.episode_id} is currently in-flight ` +
        `(stage=${existing.stage}, started_at=${existing.started_at}, pid=${existing.pid}). ` +
        `Cannot start ${episodeId}. ` +
        `Wait for it to finish (S11 publish), or release manually: ` +
        `'node scripts/automation/in-flight-lock.js release --episode ${existing.episode_id}'.`
      );
      err.code = 'ELOCK_HELD';
      err.lock = existing;
      throw err;
    }
  }

  const lock = {
    episode_id: episodeId,
    stage: stage || 'unknown',
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    pid: process.pid,
    host: hostname(),
    command: opts.command || process.argv.slice(1).join(' '),
    expected_completion: 'S11 publish or explicit release',
  };
  writeLock(lock);
  return lock;
}

export function releaseLock(episodeId = null) {
  if (!existsSync(LOCK_FILE)) return false;
  if (episodeId) {
    const cur = getCurrentLock();
    if (cur && !cur.__corrupt && cur.episode_id !== episodeId) {
      // 다른 EP의 락은 release하지 않음 (실수 방지).
      throw new Error(
        `[in-flight-lock] Refuse to release: lock holder is ${cur.episode_id}, not ${episodeId}. ` +
        `Use force-release if intended.`
      );
    }
  }
  unlinkSync(LOCK_FILE);
  return true;
}

export function forceRelease() {
  if (!existsSync(LOCK_FILE)) return false;
  unlinkSync(LOCK_FILE);
  return true;
}

export function heartbeat(episodeId, stage = null) {
  const cur = getCurrentLock();
  if (!cur || cur.__corrupt) return false;
  if (cur.episode_id !== episodeId) return false;
  cur.heartbeat_at = new Date().toISOString();
  if (stage) cur.stage = stage;
  writeLock(cur);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function cliStatus() {
  const lock = getCurrentLock();
  if (!lock) {
    console.log('🟢 No in-flight lock. Workspace is free.');
    process.exit(0);
  }
  if (lock.__corrupt) {
    console.log(`🔴 CORRUPT lock file: ${lock.raw}`);
    console.log(`   Use force-release to clean.`);
    process.exit(2);
  }
  const stale = isStale(lock);
  const ageMin = ((Date.now() - new Date(lock.heartbeat_at || lock.started_at).getTime()) / 60000).toFixed(1);
  console.log(`${stale ? '🟡 STALE' : '🔵 ACTIVE'} in-flight lock`);
  console.log(`   episode_id : ${lock.episode_id}`);
  console.log(`   stage      : ${lock.stage}`);
  console.log(`   started_at : ${lock.started_at}`);
  console.log(`   heartbeat  : ${lock.heartbeat_at} (${ageMin} min ago)`);
  console.log(`   pid        : ${lock.pid} (${isPidAlive(lock.pid) ? 'alive' : 'dead'})`);
  console.log(`   host       : ${lock.host}`);
  console.log(`   command    : ${lock.command || '(n/a)'}`);
  if (stale) {
    console.log(`\n⚠ Lock is stale. Recommended: 'node scripts/automation/in-flight-lock.js force-release'`);
    process.exit(1);
  }
  process.exit(0);
}

function cliRelease(episodeId) {
  try {
    const ok = releaseLock(episodeId);
    if (ok) console.log(`✅ Released lock${episodeId ? ` (${episodeId})` : ''}.`);
    else console.log('ℹ No lock to release.');
    process.exit(0);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}

function cliForceRelease() {
  const ok = forceRelease();
  if (ok) console.log('✅ Force-released lock.');
  else console.log('ℹ No lock to release.');
  process.exit(0);
}

function cliHeartbeat(episodeId, stage) {
  if (!episodeId) {
    console.error('❌ --episode required');
    process.exit(1);
  }
  const ok = heartbeat(episodeId, stage);
  if (ok) console.log(`✅ Heartbeat updated for ${episodeId}${stage ? ` (stage=${stage})` : ''}.`);
  else {
    console.error(`❌ No matching lock for ${episodeId}.`);
    process.exit(1);
  }
}

function cliAcquire(episodeId, stage) {
  if (!episodeId) { console.error('❌ --episode required'); process.exit(1); }
  try {
    const lock = acquireLock(episodeId, stage, { command: 'cli acquire' });
    console.log(`✅ Lock acquired: ${lock.episode_id} (stage=${lock.stage}, pid=${lock.pid})`);
    process.exit(0);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(e.code === 'ELOCK_HELD' ? 2 : (e.code === 'ELOCK_STALE' ? 3 : 1));
  }
}

function cliHelp() {
  console.log(`Usage:
  in-flight-lock.js status
  in-flight-lock.js acquire --episode EP-YYYY-NNNN [--stage S4]
  in-flight-lock.js heartbeat --episode EP-YYYY-NNNN [--stage S6c]
  in-flight-lock.js release [--episode EP-YYYY-NNNN]
  in-flight-lock.js force-release

Exit codes:
  0  ok
  1  generic error
  2  ELOCK_HELD (other EP active)
  3  ELOCK_STALE (other EP stale, requires force-release)`);
}

// CLI 진입점 (이 파일을 직접 실행할 때만)
const isDirect = (() => {
  try { return resolve(process.argv[1]) === resolve(import.meta.filename); }
  catch { return false; }
})();

if (isDirect) {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  let values = {};
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        episode: { type: 'string' },
        stage: { type: 'string' },
      },
      strict: false,
    }));
  } catch {
    values = {};
  }

  switch (sub) {
    case 'status':         cliStatus(); break;
    case 'acquire':        cliAcquire(values.episode, values.stage); break;
    case 'heartbeat':      cliHeartbeat(values.episode, values.stage); break;
    case 'release':        cliRelease(values.episode); break;
    case 'force-release':  cliForceRelease(); break;
    case '-h':
    case '--help':
    case 'help':
    case undefined:        cliHelp(); process.exit(0);
    default:
      console.error(`Unknown sub-command: ${sub}`);
      cliHelp();
      process.exit(1);
  }
}
