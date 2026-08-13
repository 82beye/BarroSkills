import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { formatToPlatform } from '../scripts/automation/paths.js';
import { brandTagsForFormat } from '../scripts/automation/seo-enhance.js';

test('shorts-3min stays vertical, maps to Shorts, and reserves final-card headroom', () => {
  const config = JSON.parse(readFileSync(resolve(import.meta.dirname, '../config/formats.json'), 'utf8'));
  const format = config.formats.find(({ id }) => id === 'shorts-3min');

  assert.ok(format);
  assert.equal(formatToPlatform(format.id), 'shorts');
  assert.deepEqual(format.canvas, { width: 1080, height: 1920, ratio: '9:16' });
  assert.equal(format.scene_count, 7);
  assert.ok(format.duration.target_seconds < 180);
  assert.equal(format.metadata.shorts_tag, true);
  assert.deepEqual(format.pipeline.skip_stages, []);
  assert.deepEqual(
    brandTagsForFormat({ brand_tags_common: ['BarroTube'], brand_tags_shorts: ['60초경제', 'Shorts'] }, format.id),
    ['BarroTube', '3분경제', 'Shorts'],
  );
});
