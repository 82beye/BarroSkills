import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { getSecret } from '../scripts/automation/config-loader.js';
import { assertPublishControls } from '../scripts/automation/publish-youtube.js';
import { isStale } from '../scripts/automation/in-flight-lock.js';
import { sendTelegramText, telegramRequest } from '../scripts/automation/notify.js';

const ROOT = resolve(import.meta.dirname, '..');
function fixture(t, prefix = 'bt-security-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const p of ['lib', 'config', 'workspace/.reject-window', 'scripts/automation/lib']) mkdirSync(join(dir, p), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const p of ['lib/guards.sh', 'scripts/automation/lib/publish-approval.js', 'scripts/automation/notify.js', 'scripts/automation/config-loader.js']) copyFileSync(join(ROOT, p), join(dir, p));
  writeFileSync(join(dir, 'config/autonomy-pause.json'), JSON.stringify({ status: 'active', guards: { auto_pipeline_enabled: true, qa_min_score: 60, publish_reject_window_minutes: 30 } }));
  return dir;
}

test('secret keys cannot execute shell expressions', () => {
  for (const key of ['$(touch /tmp/bt-key-injection)', 'X";false;#', 'X\nY']) {
    assert.throws(() => getSecret(key), /Invalid secret key/);
  }
});

test('a live local renderer never loses its lock just because its heartbeat is old', () => {
  assert.equal(isStale({ pid: process.pid, host: hostname(), heartbeat_at: '2000-01-01T00:00:00Z' }), false);
});

test('cron rejects out-of-range clock times before generating a schedule', () => {
  const source = readFileSync(join(ROOT, 'lib/install-cron.sh'), 'utf8');
  const helper = source.slice(source.indexOf('valid_time()'), source.indexOf('cmd_install()'));
  for (const [hour, minute, expected] of [['00', '00', 0], ['09', '08', 0], ['23', '59', 0], ['24', '00', 1], ['12', '60', 1]]) {
    const out = spawnSync('/bin/bash', ['-c', helper + '\nvalid_time "$1" "$2"', 'time-check', hour, minute], { encoding: 'utf8' });
    assert.equal(out.status, expected, `${hour}:${minute}: ${out.stderr}`);
  }
});

test('all publish entry points share pause, rejection, and window checks', (t) => {
  const dir = fixture(t), id = 'EP-2026-9999';
  const base = join(dir, 'workspace/.reject-window', id);
  assert.doesNotThrow(() => assertPublishControls(id, dir));
  for (const deadline of ['notification_failed', new Date(Date.now() + 60_000).toISOString()]) {
    writeFileSync(`${base}.open`, deadline);
    assert.throws(() => assertPublishControls(id, dir), /window/);
  }
  writeFileSync(`${base}.open`, '2000-01-01T00:00:00Z');
  writeFileSync(`${base}.flag`, 'rejected');
  assert.throws(() => assertPublishControls(id, dir), /rejected/);
  rmSync(`${base}.flag`);
  writeFileSync(join(dir, 'config/autonomy-pause.json'), '{"status":"paused"}');
  assert.throws(() => assertPublishControls(id, dir), /paused/);
  assert.throws(() => assertPublishControls('../escape', dir), /Invalid/);
});

test('shell gates reject invalid QA and undelivered notifications without deleting a rejection', (t) => {
  const dir = fixture(t);
  const qa = join(dir, '60_qa_report.md');
  const run = (script) => spawnSync('/bin/bash', ['-c', 'source "$BARROTUBE_HOME/lib/guards.sh"\n' + script], {
    cwd: dir, env: { ...process.env, BARROTUBE_HOME: dir, BT_NO_NOTIFY: '1', DRY_RUN: '0' }, encoding: 'utf8', timeout: 10_000,
  });
  writeFileSync(join(dir, '.env'), 'BT_OK="literal $(touch should-not-exist)"\nBT_BAD[$(touch should-not-exist)]=x\n');
  writeFileSync(qa, 'QA pending');
  assert.equal(run('guard_qa_pass "$BARROTUBE_HOME"').status, 1);
  writeFileSync(qa, `**Risk**: \`LOW\`\n**Video SHA-256**: \`${'a'.repeat(64)}\`\n## Verdict\n**PASS** (risk: LOW)\n`);
  assert.equal(run('guard_qa_pass "$BARROTUBE_HOME"').status, 0);
  assert.equal(existsSync(join(dir, 'should-not-exist')), false);
  const disabled = run('notify_telegram test 1');
  assert.equal(disabled.status, 1, disabled.stdout + disabled.stderr);
  assert.doesNotMatch(disabled.stdout, /Usage: node notify/);
  assert.equal(run('wait_telegram_reject_window EP-2026-9999').status, 1);
  assert.match(readFileSync(join(dir, 'workspace/.reject-window/EP-2026-9999.open'), 'utf8'), /notification_failed/);
  writeFileSync(join(dir, 'workspace/.reject-window/EP-2026-9999.flag'), 'operator rejected');
  assert.equal(run('wait_telegram_reject_window EP-2026-9999').status, 1);
  assert.equal(readFileSync(join(dir, 'workspace/.reject-window/EP-2026-9999.flag'), 'utf8'), 'operator rejected');
  writeFileSync(join(dir, 'config/autonomy-pause.json'), '{"guards":{"publish_reject_window_minutes":0}}');
  assert.equal(run('wait_telegram_reject_window EP-2026-9998').status, 1);
});

test('Telegram keeps credentials out of process arguments and rejects API-level failure', async (t) => {
  const dir = fixture(t), trace = join(dir, 'curl-trace.json');
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env python3\nimport sys,json\nfrom pathlib import Path\nPath(${JSON.stringify(trace)}).write_text(json.dumps({'args':sys.argv[1:],'input':sys.stdin.read()}))\nprint('{"ok":false,"error_code":400}')\n`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  await assert.rejects(sendTelegramText('test', 'HTML', { botToken: '12345:dummy_test_only', chatId: '123' }), /rejected message/);
  const captured = JSON.parse(readFileSync(trace, 'utf8'));
  assert.ok(!captured.args.join(' ').includes('dummy_test_only'));
  assert.ok(captured.input.includes('dummy_test_only'));
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf \'{"ok":true,"result":[]}\\n\'\n');
  assert.deepEqual(await telegramRequest('getUpdates', { offset: 1, timeout: 30 }, '12345:dummy_test_only'), { ok: true, result: [] });
  await assert.rejects(telegramRequest('getUpdates\nurl=bad', {}, '12345:dummy_test_only'), /Invalid/);
});

test('quota counts unique KST publications and malformed budget data fails closed', (t) => {
  const dir = fixture(t);
  const run = (script) => spawnSync('/bin/bash', ['-c', 'source "$BARROTUBE_HOME/lib/guards.sh"\n' + script], {
    env: { ...process.env, BARROTUBE_HOME: dir, BT_NO_NOTIFY: '1', DRY_RUN: '0' }, encoding: 'utf8', timeout: 10_000,
  });
  const policy = join(dir, 'config/autonomy-pause.json');
  writeFileSync(policy, '{"guards":{"max_episodes_per_day":2}}');
  const base = join(dir, 'workspace/episodes/EP-2026-9999');
  mkdirSync(join(base, 'platforms/shorts'), { recursive: true });
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const first = { videoId: 'same', publishedAt: `${day}T00:15:00+09:00`, privacyStatus: 'public' };
  writeFileSync(join(base, '80_publish_result.json'), JSON.stringify(first));
  writeFileSync(join(base, 'platforms/shorts/80_publish_result.json'), JSON.stringify({ targets: { youtube: first } }));
  assert.equal(run('guard_daily_quota').status, 0, 'same video in two layouts counts once');
  writeFileSync(join(base, '80_publish_result.json'), JSON.stringify({ ...first, videoId: 'future', publishedAt: new Date(Date.now() + 86400_000).toISOString(), privacyStatus: 'private', status: 'scheduled' }));
  assert.equal(run('guard_daily_quota').status, 0, 'tomorrow scheduled is not today');
  writeFileSync(join(base, '80_publish_result.json'), JSON.stringify({ ...first, videoId: 'second' }));
  assert.equal(run('guard_daily_quota').status, 1);
  writeFileSync(join(dir, 'config/budget-policy.json'), '{"budget_policy":{"roles":{"render":{"monthly_limit":100}}}}');
  assert.equal(run('guard_budget').status, 0);
  const usage = join(dir, 'usage.json');
  writeFileSync(usage, '{"render":{"total_usd":90}}');
  assert.equal(run('USAGE_FILE="$BARROTUBE_HOME/usage.json"; guard_budget').status, 1);
  writeFileSync(usage, '{"render":{"total_usd":"$(touch should-not-exist)"}}');
  assert.equal(run('USAGE_FILE="$BARROTUBE_HOME/usage.json"; guard_budget').status, 1);
  assert.equal(existsSync(join(dir, 'should-not-exist')), false);
});

test('Chrome JavaScript permission denial fails immediately without a second navigation attempt', (t) => {
  const dir = fixture(t), bin = join(dir, 'bin'), trace = join(dir, 'js-attempts');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf \'777 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/playwright\n52864 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n\'\n', { mode: 0o700 });
  writeFileSync(join(bin, 'osascript'), '#!/bin/bash\n[[ "$5" == 52864 ]] || exit 91\ncase "$6" in\n eval) echo attempted >> "$BT_TEST_TRACE"; echo "JavaScript execution is disabled (12)" >&2; exit 1;;\n navigate) echo ok;;\n find) echo \'{"tabId":"123","windowId":"456","windowIdx":1,"tabIdx":1}\';;\n *) exit 92;;\nesac\n', { mode: 0o700 });
  const out = spawnSync(process.execPath, [join(ROOT, 'scripts/automation/grok-motion-applescript.js'), '--check'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BT_TEST_TRACE: trace }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(out.status, 3, out.stderr);
  assert.match(out.stderr, /Chrome 자동화 권한 필요/);
  assert.equal(readFileSync(trace, 'utf8'), 'attempted\n');
});

test('Grok rejects unavailable quality and waits past the attached-image post', async () => {
  const source = readFileSync(join(ROOT, 'scripts/automation/grok-motion-applescript.js'), 'utf8');
  const functions = source.slice(source.indexOf('async function requireVideoOptions()'), source.indexOf('async function waitForOwnVideo('));
  let selectable = false, clicks = 0;
  const buttons = ['720p', '10s'].map(textContent => ({
    textContent, checked: false,
    getAttribute(name) { return name === 'aria-checked' ? String(this.checked) : null; },
    click() { clicks++; if (selectable) this.checked = true; },
  }));
  const context = { sleep: async () => {}, chromeJS: js => runInNewContext(js, {
    document: { querySelectorAll: () => buttons },
  }) };
  const api = runInNewContext(functions + '\n({ requireVideoOptions, submitPrompt })', context);
  await assert.rejects(api.requireVideoOptions(), e => e.code === 'GROK_PLAN');
  selectable = true;
  await api.requireVideoOptions();
  const selectedClicks = clicks;
  await api.requireVideoOptions();
  assert.equal(clicks, selectedClicks, 'selected radio options must not be toggled');

  const paths = ['/imagine/post/still', '/imagine/post/still', '/imagine/post/video'];
  let submits = 0;
  context.requireVideoOptions = async () => {};
  context.chromeJS = js => {
    if (js === 'location.pathname') return paths.shift();
    if (js.includes('sb.click()')) submits++;
    return '{"ok":true}';
  };
  assert.equal(await api.submitPrompt({}, 'animate the attached still'), '/imagine/post/video');
  assert.equal(submits, 1, 'an existing attachment post is not a new video or a reason to resubmit');
  assert.equal(paths.length, 0);
});

test('growth fetch failure is visible and cannot stamp stale KPI files as fresh', (t) => {
  const dir = fixture(t), trace = join(dir, 'steps.txt');
  copyFileSync(join(ROOT, 'lib/growth-pipeline.sh'), join(dir, 'lib/growth-pipeline.sh'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'node'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$BT_TEST_TRACE"\nexit 1\n', { mode: 0o700 });
  const out = spawnSync('/bin/bash', ['lib/growth-pipeline.sh'], {
    cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BARROTUBE_HOME: dir, BT_TEST_TRACE: trace, BT_NO_NOTIFY: '1', DRY_RUN: '0' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(out.status, 1, out.stderr);
  const calls = readFileSync(trace, 'utf8');
  assert.match(calls, /fetch-channel-stats/);
  assert.doesNotMatch(calls, /growth-kpi|growth-weekly|growth-directives/);
});

test('publish resume preserves pending uploads and reports failure or missing results to launchd', (t) => {
  const dir = fixture(t, 'bt publish-'), base = join(dir, 'workspace/episodes/EP-2026-9999/platforms/shorts');
  mkdirSync(join(base, '55_render'), { recursive: true });
  writeFileSync(join(base, '75_board_approval.json'), '{}');
  writeFileSync(join(base, '55_render/video.mp4'), 'fixture only');
  copyFileSync(join(ROOT, 'lib/publish-resume.sh'), join(dir, 'lib/publish-resume.sh'));
  const result = join(base, '80_publish_result.json'), trace = join(dir, 'attempts.txt'), bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), '#!/bin/bash\nif [[ "$1" == scripts/automation/run-episode.js ]]; then\n  echo attempted >> "$BT_TEST_TRACE"\n  if [[ "${BT_TEST_CREATE_RESULT:-0}" == 1 ]]; then echo \'{"videoId":"fixture"}\' > "$BT_TEST_RESULT"; fi\n  exit "${BT_TEST_EXIT:-1}"\nfi\nexit 1\n', { mode: 0o700 });
  const run = (extra = {}) => spawnSync('/bin/bash', ['lib/publish-resume.sh'], {
    cwd: dir, env: { ...process.env, BARROTUBE_HOME: dir, PATH: `${bin}:${process.env.PATH}`, BT_NO_NOTIFY: '1', DRY_RUN: '0', BT_TEST_TRACE: trace, BT_TEST_RESULT: result, ...extra }, encoding: 'utf8', timeout: 10_000,
  });
  writeFileSync(`${result}.lock`, '{"pid":999999}');
  assert.equal(run().status, 1);
  assert.equal(existsSync(trace), false, 'pending upload must not invoke S11 again');
  assert.equal(readFileSync(`${result}.lock`, 'utf8'), '{"pid":999999}');
  rmSync(`${result}.lock`);
  assert.equal(run().status, 1, 'child failure must reach launchd');
  assert.equal(run({ BT_TEST_EXIT: '0' }).status, 1, 'exit 0 without a result is not publication');
  const done = run({ BT_TEST_EXIT: '0', BT_TEST_CREATE_RESULT: '1' });
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(existsSync(result), true);
});
