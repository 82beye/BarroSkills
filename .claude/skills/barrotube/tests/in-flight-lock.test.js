import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';

import { isStale, releaseIfStale, getCurrentLock } from '../scripts/automation/in-flight-lock.js';

const ROOT = resolve(import.meta.dirname, '..');
const LOCK_FILE = join(ROOT, 'workspace', '.in-flight.json');

/**
 * 이 테스트는 **실제 락 파일 경로**를 쓴다 (모듈이 상수로 들고 있어 주입이 안 된다).
 * 그래서 돌기 전에 락이 있으면 통째로 건너뛴다 — 테스트가 돌아가는 파이프라인의
 * 락을 지우면 두 에피소드가 동시에 돌 수 있고, 그건 이 락이 막으려던 사고다.
 */
function liveLockPresent() {
  return existsSync(LOCK_FILE);
}

function writeLock(obj) {
  mkdirSync(join(ROOT, 'workspace'), { recursive: true });
  writeFileSync(LOCK_FILE, `${JSON.stringify(obj, null, 2)}\n`);
}

/** 절대 살아 있을 수 없는 PID. macOS/Linux 기본 pid_max 를 넘긴다. */
const DEAD_PID = 999_999;

const baseLock = (over = {}) => ({
  episode_id: 'EP-2026-9999',
  stage: 'S6c',
  started_at: '2026-01-01T00:00:00.000Z',
  heartbeat_at: new Date().toISOString(),
  pid: DEAD_PID,
  host: hostname(),
  command: 'test',
  ...over,
});

test('같은 호스트에서 pid 가 죽었으면 stale 이다', () => {
  assert.equal(isStale(baseLock()), true);
  // 살아 있는 pid — 이 프로세스 자신.
  assert.equal(isStale(baseLock({ pid: process.pid })), false);
});

test('다른 호스트의 pid 는 신뢰하지 않는다 — heartbeat 로만 판정한다', () => {
  // 남의 머신 pid 가 이 머신에 없다고 죽었다고 볼 수 없다. heartbeat 가 최신이면 살아 있다.
  const other = baseLock({ host: 'someone-elses-mac.local', pid: DEAD_PID });
  assert.equal(isStale(other), false);
});

test('releaseIfStale 은 죽은 락만 지우고 살아 있는 락은 남긴다', (t) => {
  if (liveLockPresent()) return t.skip('실제 락이 잡혀 있다 — 건드리지 않는다');

  // 락이 없을 때
  assert.deepEqual(releaseIfStale(), { released: false, reason: 'no_lock', lock: null });

  // 죽은 pid → 해제
  writeLock(baseLock());
  const dead = releaseIfStale();
  assert.equal(dead.released, true, 'pid 가 죽었으면 해제해야 한다');
  assert.equal(dead.reason, 'pid_dead');
  assert.equal(existsSync(LOCK_FILE), false, '파일이 지워져야 한다');

  // 살아 있는 pid → 보존
  writeLock(baseLock({ episode_id: 'EP-2026-9998', pid: process.pid }));
  const alive = releaseIfStale();
  assert.equal(alive.released, false, '살아 있는 락은 지우면 안 된다');
  assert.equal(alive.reason, 'alive');
  assert.equal(existsSync(LOCK_FILE), true, '파일이 남아야 한다');
  assert.equal(getCurrentLock().episode_id, 'EP-2026-9998');

  unlinkSync(LOCK_FILE);
});

test('깨진 락 파일은 stale 로 보고 정리된다', (t) => {
  if (liveLockPresent()) return t.skip('실제 락이 잡혀 있다 — 건드리지 않는다');

  // 파싱 불가 = 누가 쓰다 만 것. 영원히 막고 있게 두면 안 된다.
  mkdirSync(join(ROOT, 'workspace'), { recursive: true });
  writeFileSync(LOCK_FILE, '{ this is not json');
  const r = releaseIfStale();
  assert.equal(r.released, true);
  assert.equal(r.reason, 'corrupt');
  assert.equal(existsSync(LOCK_FILE), false);
});
