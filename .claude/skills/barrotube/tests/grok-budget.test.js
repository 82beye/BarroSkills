import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  DEFAULTS, clearExhausted, exhaustedUntil, loadGrokBudget, loadSceneRoles, markExhausted,
  planGrokScenes, readLedger, recordSubmission, usedInWindow,
} from '../scripts/automation/lib/grok-budget.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUTO = join(ROOT, 'lib', 'auto-pipeline.sh');
const APPLESCRIPT = join(ROOT, 'scripts', 'automation', 'grok-motion-applescript.js');
const PLAYWRIGHT = join(ROOT, 'scripts', 'automation', 'grok-motion.js');
const PRODUCE = join(ROOT, 'scripts', 'automation', 'produce-episode.js');
const BUDGET_CLI = join(ROOT, 'scripts', 'automation', 'lib', 'grok-budget.js');

const NOW = new Date('2026-09-28T09:00:00Z');
const SCENES = [
  { id: '001', role: 'hook' }, { id: '002', role: 'context' }, { id: '003', role: 'insight' },
  { id: '004', role: 'implication' }, { id: '005', role: 'cta' },
];
const ledgerWith = (n, at = NOW, episode = 'EP-OTHER') => ({
  version: 1,
  exhausted: null,
  submissions: Array.from({ length: n }, (_, i) => ({ at: new Date(at.getTime() - i * 60_000).toISOString(), episode, scene: '001' })),
});

test('편당 상한만큼 훅부터 Grok 에 맡기고 나머지는 계획된 로컬이다', () => {
  const plan = planGrokScenes({ scenes: SCENES, episode: 'EP-1', ledger: ledgerWith(0), budget: DEFAULTS, now: NOW });
  assert.equal(plan.allowed, 2);
  assert.deepEqual(plan.grok, ['001', '003'], '훅 다음은 인사이트(왜) 씬이다');
  assert.deepEqual(plan.local, ['002', '004', '005']);
});

test('최근 7일 제출이 주간 예산에 닿으면 그 편은 Grok 을 쓰지 않는다', () => {
  const full = planGrokScenes({ scenes: SCENES, episode: 'EP-1', ledger: ledgerWith(30), budget: DEFAULTS, now: NOW });
  assert.equal(full.allowed, 0);
  assert.match(full.reason, /주간 예산 소진 30\/30/);

  const oneLeft = planGrokScenes({ scenes: SCENES, episode: 'EP-1', ledger: ledgerWith(29), budget: DEFAULTS, now: NOW });
  assert.equal(oneLeft.allowed, 1, '남은 예산보다 많이 주지 않는다');

  const old = ledgerWith(30, new Date(NOW.getTime() - 8 * 86_400_000));
  assert.equal(usedInWindow(old, NOW, 7), 0, '창 밖 제출은 세지 않는다');
  assert.equal(planGrokScenes({ scenes: SCENES, episode: 'EP-1', ledger: old, budget: DEFAULTS, now: NOW }).allowed, 2);
});

test('같은 편이 이미 낸 제출은 편당 상한에서 뺀다 — 두 경로가 따로 세지 않는다', () => {
  const plan = planGrokScenes({ scenes: SCENES, episode: 'EP-1', ledger: ledgerWith(2, NOW, 'EP-1'), budget: DEFAULTS, now: NOW });
  assert.equal(plan.allowed, 0);
  assert.match(plan.reason, /이미 2컷/);
});

test('한도 소진 표시가 있으면 백오프 동안 건너뛰고, 끝나면 1컷만 확인한다', () => {
  const ledger = { ...ledgerWith(0), exhausted: { at: new Date(NOW.getTime() - 3_600_000).toISOString(), reason: '연속 2컷 정체' } };
  const during = planGrokScenes({ scenes: SCENES, episode: 'EP-1', ledger, budget: DEFAULTS, now: NOW });
  assert.equal(during.allowed, 0);
  assert.match(during.reason, /백오프/);
  assert.ok(exhaustedUntil(ledger, NOW, 24));

  const later = new Date(NOW.getTime() + 24 * 3_600_000);
  const probe = planGrokScenes({ scenes: SCENES, episode: 'EP-1', ledger, budget: DEFAULTS, now: later });
  assert.equal(probe.allowed, 1);
  assert.equal(probe.probe, true);
  assert.deepEqual(probe.grok, ['001']);
});

test('이미 클립이 있는 씬은 후보에서 빠진다', () => {
  const plan = planGrokScenes({ scenes: SCENES, have: new Set(['001']), episode: 'EP-1', ledger: ledgerWith(0), budget: DEFAULTS, now: NOW });
  assert.deepEqual(plan.grok, ['003', '004']);
  const all = planGrokScenes({ scenes: SCENES, have: new Set(SCENES.map((s) => s.id)), episode: 'EP-1', ledger: ledgerWith(0), budget: DEFAULTS, now: NOW });
  assert.equal(all.allowed, 0);
  assert.match(all.reason, /모든 씬/);
});

test('원장은 제출·소진 표시를 남기고 30일 넘은 기록은 버린다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-grok-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'grok-usage.json');
  recordSubmission(path, { episode: 'EP-1', scene: '001', at: '2026-08-01T00:00:00Z' });
  recordSubmission(path, { episode: 'EP-1', scene: '003', post: '/imagine/post/x', at: NOW.toISOString() });
  assert.deepEqual(readLedger(path).submissions.map((s) => s.scene), ['003']);

  markExhausted(path, '테스트', NOW.toISOString());
  assert.equal(readLedger(path).exhausted.reason, '테스트');
  assert.equal(clearExhausted(path), true);
  assert.equal(readLedger(path).exhausted, null);
  assert.equal(clearExhausted(path), false);
});

test('설정 파일의 예산이 코드 기본값을 덮는다', () => {
  const cfg = loadGrokBudget(join(ROOT, 'config', 'motion-engines.json'));
  assert.equal(typeof cfg.max_clips_per_episode, 'number');
  assert.equal(typeof cfg.weekly_budget, 'number');
  assert.ok(cfg.max_clips_per_episode * 17 > 0 && cfg.scene_priority[0] === 'hook');
});

test('CLI 는 허용이 0 이면 exit 3 이고 파이프라인이 그걸 로컬 전환 신호로 쓴다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-grok-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, 'EP-2026-9999', 'platforms', 'shorts');
  mkdirSync(join(base, '40_assets', 'videos'), { recursive: true });
  writeFileSync(join(base, '30_script.md'), `---\nscenes:\n${SCENES.map((s) => `  - scene_id: "${s.id}"\n    role: ${s.role}\n    narration: x`).join('\n')}\n---\n`);
  assert.deepEqual(loadSceneRoles(base).map((s) => s.role), SCENES.map((s) => s.role));

  const ledger = join(dir, 'grok-usage.json');
  const run = () => spawnSync(process.execPath, [BUDGET_CLI, '--episode', join(dir, 'EP-2026-9999')], {
    env: { ...process.env, BT_GROK_LEDGER: ledger }, encoding: 'utf8',
  });
  const open = run();
  assert.equal(open.status, 0, open.stderr);
  assert.match(open.stdout, /Grok 예산 2컷 \(씬 001·003\)/);

  markExhausted(ledger, '테스트');
  const closed = run();
  assert.equal(closed.status, 3, closed.stdout + closed.stderr);
  assert.match(closed.stdout, /백오프/);
});

test('파이프라인이 브라우저 단계 전에 예산을 보고, 0 이면 로컬 모션으로 전환한다', () => {
  const src = readFileSync(AUTO, 'utf8');
  const check = src.indexOf('node scripts/automation/lib/grok-budget.js --episode');
  const browser = src.indexOf('BROWSER_MOTION=$(');
  assert.ok(check > 0 && check < browser, '브라우저 작업을 정하기 전에 예산을 봐야 스틸 굽는 시간까지 아낀다');
  assert.match(src.slice(check, browser), /GROK_BUDGET_RC" -eq 3[\s\S]*export BT_MOTION_ENGINE="local-only"/);
  // 브라우저 에이전트가 Grok 영상을 직접 만들면 원장 밖에서 한도를 쓴다.
  assert.ok(!/Grok Imagine에서 각 scene_NNN\.png를 첨부해 영상/.test(src), '브라우저에 Grok 영상 생성을 시키지 않는다');
});

test('계획된 로컬 씬은 모션 게이트와 폴백 경보에서 빠진다', (t) => {
  const src = readFileSync(AUTO, 'utf8');
  const fn = src.match(/^media_assets_ready\(\) \{[\s\S]*?\n\}/m);
  assert.ok(fn, 'media_assets_ready 를 찾지 못했다');
  const dir = mkdtempSync(join(tmpdir(), 'bt-grok-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '40_assets', 'images'), { recursive: true });
  mkdirSync(join(dir, '40_assets', 'videos'), { recursive: true });
  for (const id of ['001', '002', '003', '004', '005']) writeFileSync(join(dir, '40_assets', 'images', `scene_${id}.png`), `png-${id}`);
  const gate = () => spawnSync('/bin/bash', ['-c', `${fn[0]}\nmedia_assets_ready "${dir}" motion; echo "MISSING=$MEDIA_ASSETS_MISSING"`], {
    env: { ...process.env, BT_MOTION_ENGINE: 'grok' }, encoding: 'utf8',
  });
  assert.match(gate().stdout, /MISSING=.*videos\/scene_001\.mp4/, '계획이 없으면 Grok 클립을 요구한다');
  writeFileSync(join(dir, '40_assets', 'videos', '_grok_plan.json'), JSON.stringify({ grok: [], local: ['001', '002', '003', '004', '005'] }));
  assert.match(gate().stdout, /MISSING=\s*$/m, '로컬로 배정한 씬은 요구하지 않는다');

  assert.match(src, /FALLBACK_CLIPS=\$\(python3[\s\S]*?k not in local[\s\S]*?_grok_plan\.json/, '폴백 경보는 계획분을 빼고 센다');
});

test('Grok 스크립트가 예산대로만 제출하고, 한도 소진을 표시한다', () => {
  const as = readFileSync(APPLESCRIPT, 'utf8');
  assert.match(as, /planGrokScenes\(/);
  assert.match(as, /submitPrompt\(tab, motionFor\(scene\)\);\n\s+\/\/[^\n]*\n\s+recordSubmission\(/, '제출 직후 원장에 적는다');
  assert.match(as, /e\.code === 'GROK_QUOTA'[\s\S]{0,120}markExhausted/);
  assert.match(as, /made === 0 && stalls > 0[\s\S]{0,120}markExhausted/, '성공 없이 전부 정체면 소진으로 본다');

  const quota = new RegExp(as.match(/const QUOTA_PATTERN = \/(.+)\/i;/)[1], 'i');
  for (const s of ['주간 한도에 도달했습니다', '이번 주 동영상 생성 한도를 모두 사용했습니다', "You've reached your weekly video limit", 'Rate limit exceeded']) {
    assert.ok(quota.test(s), `한도 문구를 놓친다: ${s}`);
  }
  for (const s of ['speed limit sign', 'red warning lights', '동영상 만들기']) {
    assert.ok(!quota.test(s), `본문 단어를 한도로 오인한다: ${s}`);
  }

  const pw = readFileSync(PLAYWRIGHT, 'utf8');
  assert.match(pw, /planGrokScenes\(/, 'Playwright 경로도 같은 예산을 쓴다');
  assert.match(readFileSync(PRODUCE, 'utf8'), /grok-motion\.js[\s\S]{0,700}if \(!motionExists\(\)\)[\s\S]{0,200}generate-motion\.js/,
    'Grok 이 비워 둔 계획분은 S6c 가 로컬로 채운다');
});
