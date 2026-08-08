import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolvePublishBundle } from '../scripts/automation/run-episode.js';

test('explicit platform resolves only that publish bundle', (t) => {
  const episode = mkdtempSync(join(tmpdir(), 'bt-publish-platform-'));
  t.after(() => rmSync(episode, { recursive: true, force: true }));

  for (const platform of ['long', 'shorts']) {
    const base = join(episode, 'platforms', platform);
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, '70_publish_meta.json'), JSON.stringify({ platform }));
  }

  assert.equal(resolvePublishBundle(episode).platform, 'long');
  const shorts = resolvePublishBundle(episode, 'shorts');
  assert.equal(shorts.platform, 'shorts');
  assert.equal(shorts.videoFile, join(episode, 'platforms', 'shorts', '55_render', 'video.mp4'));
  assert.equal(shorts.publishResultFile, join(episode, 'platforms', 'shorts', '80_publish_result.json'));
  assert.throws(() => resolvePublishBundle(episode, 'reels'), /Unsupported requested platform/);
});
