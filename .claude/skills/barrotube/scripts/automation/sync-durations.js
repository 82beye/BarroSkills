#!/usr/bin/env node

/**
 * sync-durations.js — TTS 실 duration에 맞춰 script의 target_seconds 자동 조정
 * Shorts 싱크 문제(오디오 짧음 → 뒷부분 침묵) 해결.
 *
 * Usage:
 *   node sync-durations.js --script <30_script.md> --tts-dir <assets/tts> [--padding 0.3]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';

const { values } = parseArgs({
  options: {
    script: { type: 'string', short: 's' },
    'tts-dir': { type: 'string', short: 't' },
    padding: { type: 'string', short: 'p', default: '0.3' },
  },
});

if (!values.script || !values['tts-dir']) {
  console.error('Usage: sync-durations.js --script <30_script.md> --tts-dir <assets/tts> [--padding 0.3]');
  process.exit(1);
}

const scriptPath = resolve(values.script);
const ttsDir = resolve(values['tts-dir']);
const padding = parseFloat(values.padding);

const md = readFileSync(scriptPath, 'utf-8');
const m = md.match(/^(---\n[\s\S]*?\n---)([\s\S]*)$/);
if (!m) { console.error('No YAML frontmatter'); process.exit(1); }

const [, frontmatterBlock, body] = m;
const fm = parseYAML(frontmatterBlock.replace(/^---\n|\n---$/g, ''));

let total = 0;
const updated = [];
for (const scene of fm.scenes) {
  const wav = join(ttsDir, `scene_${scene.scene_id}.wav`);
  const duration = parseFloat(
    execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${wav}"`).toString().trim()
  );
  const adjusted = Math.ceil((duration + padding) * 10) / 10; // 0.1s 단위 올림
  updated.push({ id: scene.scene_id, old: scene.target_seconds, new: adjusted, tts: duration.toFixed(2) });
  scene.target_seconds = adjusted;
  total += adjusted;
}

fm.target_total_seconds = Math.round(total * 10) / 10;
fm.revision = (fm.revision || 1) + 1;
fm.synced_at = new Date().toISOString();

const newFrontmatter = '---\n' + stringifyYAML(fm) + '---';
writeFileSync(scriptPath, newFrontmatter + body, 'utf-8');

console.log('🔄 Duration sync applied:');
for (const u of updated) {
  console.log(`  scene_${u.id}: ${u.old}s → ${u.new}s (TTS ${u.tts}s + ${padding}s padding)`);
}
console.log(`\n✅ Total: ${fm.target_total_seconds}s (previously target 60s)`);
console.log(`   Script updated: ${scriptPath}`);
