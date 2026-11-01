import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve(import.meta.dirname, '../scripts/automation/validate-script-quality.js');

test('strict production gate stops missing scenes and factual-looking numeric TTS text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'barrotube-script-gate-'));
  const path = join(dir, '30_script.md');
  const run = () => spawnSync(process.execPath, [cli, '--file', path, '--strict', '--json'], { encoding: 'utf8' });
  try {
    writeFileSync(path, '---\nformat: shorts\nscenes: []\n---\n');
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /invalid-script/);
    writeFileSync(path, '---\nformat: shorts\nscenes:\n  - scene_id: "001"\n    role: hook\n    narration: "미 국채 30년물 금리 때문입니다."\n    target_seconds: 9\n---\n');
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /narration-digits/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pipeline checks every saved script before factcheck and asset generation', () => {
  const shell = readFileSync(resolve(import.meta.dirname, '../lib/auto-pipeline.sh'), 'utf8');
  const quality = [...shell.matchAll(/node scripts\/automation\/validate-script-quality\.js --file "\$SCRIPT_PATH" --strict \\\n\s*\|\| fail_with_alert/g)];
  assert.equal(quality.length, 3, 'initial, image prompt rewrite, and factcheck rewrite each need a failing gate');
  const positions = quality.map((m) => m.index);
  const rewritten = shell.indexOf('generate_episode_script --force');
  const factcheck = shell.indexOf('run_or_echo node scripts/automation/run-factcheck.js');
  const assets = shell.indexOf('node scripts/automation/summary-assets.js');
  assert.ok(positions[0] < rewritten && rewritten < positions[1] && positions[1] < factcheck);
  assert.ok(factcheck < positions[2] && positions[2] < assets);
});
