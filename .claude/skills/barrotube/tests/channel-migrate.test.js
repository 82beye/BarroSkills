import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';

const SKILL_ROOT = resolve(import.meta.dirname, '..');
const MIGRATE = join(SKILL_ROOT, 'scripts', 'automation', 'channel-migrate.js');

function put(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function runMigration(dataRoot, factoryRoot, ...args) {
  const result = spawnSync(process.execPath, [MIGRATE, ...args], {
    cwd: SKILL_ROOT,
    env: {
      ...process.env,
      BARROTUBE_DATA: dataRoot,
      BARRO_AI_FACTORY: factoryRoot,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('econ series refresh derives brief metadata and preserves the prior index as a backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'barrotube-channel-migrate-'));
  const dataRoot = join(root, 'data');
  const factoryRoot = join(root, 'factory');
  const seriesRoot = join(dataRoot, 'workspace', 'channels', 'econ-daily', 'series');
  const brief = join(seriesRoot, '30sec-econ-shorts', 'ep-01-brief.md');
  const indexPath = join(seriesRoot, 'index.json');

  try {
    put(brief, [
      '---',
      'topic: 기준금리 30초 설명',
      'format: shorts',
      '---',
      '# EP01 — 기준금리',
    ].join('\n'));

    const first = runMigration(dataRoot, factoryRoot, '--write', '--channel', 'econ-daily');
    assert.equal(first.channels[0].series.status, 'created');
    let index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const episode = index.series[0].episodes[0];
    assert.equal(episode.episode_no, 1);
    assert.equal(episode.slug, 'ep-01');
    assert.equal(episode.format, 'shorts');
    assert.equal(
      episode.folder,
      '${BARROTUBE_DATA}/workspace/channels/econ-daily/series/30sec-econ-shorts',
    );
    assert.equal(
      episode.brief_path,
      '${BARROTUBE_DATA}/workspace/channels/econ-daily/series/30sec-econ-shorts/ep-01-brief.md',
    );

    index.operator_note = 'preserve until explicitly refreshed';
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    const skipped = runMigration(dataRoot, factoryRoot, '--write', '--channel', 'econ-daily');
    assert.equal(skipped.channels[0].series.status, 'skipped-existing');
    assert.equal(JSON.parse(readFileSync(indexPath, 'utf8')).operator_note, index.operator_note);

    const refreshed = runMigration(
      dataRoot,
      factoryRoot,
      '--write',
      '--refresh-series',
      '--channel',
      'econ-daily',
    );
    assert.equal(refreshed.channels[0].series.status, 'refreshed');
    assert.equal(existsSync(refreshed.channels[0].series.backup_path), true);
    assert.equal(
      JSON.parse(readFileSync(refreshed.channels[0].series.backup_path, 'utf8')).operator_note,
      index.operator_note,
    );
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
    assert.equal(Object.hasOwn(index, 'operator_note'), false);
    assert.equal(
      readdirSync(seriesRoot).filter(name => name.startsWith('index.json.bak.')).length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
