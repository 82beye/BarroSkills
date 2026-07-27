import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { resolvePaths } from '../scripts/automation/paths.js';

test('distribution-only platform folders do not turn a legacy production bundle into v2', (t) => {
  const episode = mkdtempSync(join(tmpdir(), 'barrotube-paths-'));
  t.after(() => rmSync(episode, { recursive: true, force: true }));
  mkdirSync(join(episode, 'platforms', 'reels'), { recursive: true });
  mkdirSync(join(episode, 'platforms', 'tiktok'), { recursive: true });

  const legacy = resolvePaths(episode, 'long');
  assert.equal(legacy.isV2, false);
  assert.equal(legacy.base, episode);

  mkdirSync(join(episode, 'platforms', 'long'), { recursive: true });
  const v2 = resolvePaths(episode, 'long');
  assert.equal(v2.isV2, true);
  assert.equal(v2.base, join(episode, 'platforms', 'long'));
});
