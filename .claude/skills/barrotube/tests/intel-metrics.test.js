import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'automation', 'intel-metrics.js');

test('sample-size guards are declared for the rate metrics', () => {
  // 1일치로 "3.3% FAIL" 을 내면 시스템이 고장난 것처럼 읽힌다.
  // 표본 부족은 실패가 아니라 판정 불가다.
  const src = readFileSync(SCRIPT, 'utf-8');
  assert.match(src, /collection_rate:.*min_n:\s*7/, 'collection needs a week before judging');
  assert.match(src, /topic_adoption:.*min_n:\s*3/);
  assert.match(src, /quota_per_day:.*min_n:\s*3/);
  assert.match(src, /INSUFFICIENT/, 'insufficient must be its own verdict, not FAIL');
});

test('collection rate measures from first success, not from adoption date', () => {
  // 도입 전 과거를 실패로 세면 지표가 영원히 "며칠 전에 시작했나"를 잰다.
  const src = readFileSync(SCRIPT, 'utf-8');
  assert.match(src, /firstOk/, 'must locate the first successful collection');
  assert.match(src, /since:/, 'must report the measurement start date');
});

test('topic adoption excludes files written before the S3 wiring', () => {
  // competitor_gap_used 키 자체가 없으면 배선 이전 파일이다.
  // 모수에 넣으면 과거 이력이 영구히 분모를 부풀린다.
  const src = readFileSync(SCRIPT, 'utf-8');
  assert.match(src, /'competitor_gap_used' in t/,
    'presence of the key marks a post-wiring file');
});

test('reports INSUFFICIENT rather than PASS when data is thin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-metrics-'));
  try {
    const intel = join(dir, 'workspace', 'intel', 'competitors');
    mkdirSync(intel, { recursive: true });
    mkdirSync(join(dir, 'logs', 'cron'), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    // 하루치만 심는다
    writeFileSync(join(intel, `${today}.json`), JSON.stringify({ channel_count: 6 }));
    writeFileSync(join(intel, `quota-${today}.json`), JSON.stringify({ units_used: 18, cap: 2000 }));

    const r = spawnSync('node', [SCRIPT, '--json'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 60_000,
    });
    assert.equal(r.status, 0, 'metrics must never fail the caller');
    const m = JSON.parse(r.stdout);
    for (const key of ['collection_rate', 'topic_adoption', 'quota_per_day']) {
      assert.ok(['PASS', 'FAIL', 'SKIP', 'INSUFFICIENT'].includes(m[key].verdict),
        `${key} verdict must be a known value, got ${m[key].verdict}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 0 even when everything is missing — measurement must not block', () => {
  const r = spawnSync('node', [SCRIPT, '--days', '1', '--json'], {
    cwd: ROOT, encoding: 'utf-8', timeout: 60_000,
  });
  assert.equal(r.status, 0);
  const m = JSON.parse(r.stdout);
  assert.ok(m.measured_at, 'must always emit a parseable report');
  assert.equal(m.window_days, 1);
});
