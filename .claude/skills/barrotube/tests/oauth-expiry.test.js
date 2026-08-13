import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessExpiry, TESTING_MODE_TTL_DAYS, WARN_DAYS, CRITICAL_DAYS,
} from '../scripts/automation/check-oauth-expiry.js';

const ROOT = join(import.meta.dirname, '..');
const NOW = new Date('2026-08-13T00:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400_000).toISOString();

test('thresholds sit inside the 7-day testing-mode TTL', () => {
  assert.equal(TESTING_MODE_TTL_DAYS, 7);
  assert.ok(WARN_DAYS < CRITICAL_DAYS, 'warn must precede critical');
  assert.ok(CRITICAL_DAYS < TESTING_MODE_TTL_DAYS, 'critical must fire before expiry, not at it');
});

test('escalates OK → WARN → CRITICAL → EXPIRED as days pass', () => {
  const level = (d) => assessExpiry({ issuedAt: daysAgo(d), now: NOW }).level;
  assert.equal(level(0), 'OK');
  assert.equal(level(4.9), 'OK');
  assert.equal(level(5), 'WARN');
  assert.equal(level(5.9), 'WARN');
  assert.equal(level(6), 'CRITICAL');
  assert.equal(level(7), 'EXPIRED');
  assert.equal(level(30), 'EXPIRED');
});

test('reports days_left so the operator knows how long they have', () => {
  const r = assessExpiry({ issuedAt: daysAgo(5), now: NOW });
  assert.equal(r.days_since, 5);
  assert.equal(r.days_left, 2);
  assert.equal(r.source, 'issued_at');
});

test('production publishing removes expiry entirely', () => {
  const r = assessExpiry({ issuedAt: daysAgo(90), published: true, now: NOW });
  assert.equal(r.level, 'OK');
  assert.equal(r.published, true);
  assert.match(r.message, /프로덕션/);
});

test('falls back to .env mtime and says so', () => {
  // 2026-08-13 실제 상황: 발급 기록이 없어 .env mtime(08-06) 으로 추정했다.
  const r = assessExpiry({ issuedAt: null, envMtime: new Date('2026-08-06T00:00:00Z'), now: NOW });
  assert.equal(r.level, 'EXPIRED');
  assert.equal(r.source, 'env_mtime');
  assert.match(r.message, /추정/, 'the estimate must be labelled as one');
});

test('no basis at all is UNKNOWN, never a false OK', () => {
  const r = assessExpiry({ issuedAt: null, envMtime: null, now: NOW });
  assert.equal(r.level, 'UNKNOWN');
  assert.equal(r.days_since, null);
});

test('an unparseable timestamp does not masquerade as fresh', () => {
  const r = assessExpiry({ issuedAt: 'not-a-date', now: NOW });
  assert.equal(r.level, 'UNKNOWN');
});

test('assessExpiry demands an injected clock', () => {
  assert.throws(() => assessExpiry({ issuedAt: daysAgo(1) }), TypeError);
});

test('the setup wizard records the issuance time it later depends on', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'automation', 'setup-youtube-oauth.js'), 'utf-8');
  assert.match(src, /YOUTUBE_OAUTH_ISSUED_AT/,
    'without this the expiry check can only guess from .env mtime');
});

test('the daily routine checks OAuth before spending quota', () => {
  const src = readFileSync(join(ROOT, 'lib', 'competitor-pipeline.sh'), 'utf-8');
  const check = src.indexOf('check-oauth-expiry.js');
  const fetch = src.indexOf('fetch-competitor-stats.js');
  assert.ok(check >= 0 && check < fetch, 'the warning must precede collection');
  assert.match(src, /--notify/, 'the routine must be able to reach the operator');
});

test('doctor surfaces expiry as RED', () => {
  const src = readFileSync(join(ROOT, 'lib', 'doctor-cli.sh'), 'utf-8');
  assert.match(src, /youtube_oauth/);
  assert.match(src, /EXPIRED\).*RED/s, 'an expired token is a red health check');
});
