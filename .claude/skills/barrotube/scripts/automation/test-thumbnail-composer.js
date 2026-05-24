#!/usr/bin/env node
// One-off integration test for thumbnail-composer.
// Uses an existing EP thumbnail as the Gemini base and applies a sample spec.

import { composeThumbnail } from './lib/thumbnail-composer.js';
import { existsSync, statSync } from 'fs';

const baseImagePath = 'workspace/episodes/EP-2026-0050/platforms/shorts/47_thumbnail.png';
const outPath = '/tmp/test-thumbnail-composed.png';

if (!existsSync(baseImagePath)) {
  console.error('base image missing:', baseImagePath);
  process.exit(1);
}

const spec = {
  headline_text: '미중 정상회담 분석',
  keyword_number: '25%',
  accent_color: 'red',
  background_style: 'dark',
  mascot_emotion: 'thinking',
  featured_person: { id: 'trump', treatment: 'photo-citation', position: 'right', size: 'medium' },
  brand_logos: [{ id: 'nvidia', position: 'top-right' }]
};

console.log('Composing test thumbnail...');
console.log('base:', baseImagePath);
console.log('spec:', JSON.stringify(spec, null, 2));

const t0 = Date.now();
const result = await composeThumbnail({ baseImagePath, spec, outPath });
const dt = Date.now() - t0;
const st = statSync(outPath);
console.log(`\n✅ ${result.path}`);
console.log(`   layers: ${result.layers}`);
console.log(`   size:   ${(st.size/1024).toFixed(1)}KB`);
console.log(`   time:   ${dt}ms`);
