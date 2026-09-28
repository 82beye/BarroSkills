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
// revision 은 **주장이 바뀐 횟수**다 — 여기서 올리면 안 된다.
// 이 단계는 target_seconds 만 TTS 실측에 맞추고 narration 은 한 글자도 건드리지 않는다.
// 그런데 올려 버리면 35_factcheck.md 의 script_revision 과 어긋나고, Phase 6 의
// 판본 불일치 가드가 "고친 대본을 옛 리포트로 심사하려 한다"로 오독해 헛halt한다
// (2026-09-15 EP-2026-0155: 팩트체크는 revision 3 에서 정상 통과했는데 Phase 8 의
//  이 줄이 4로 올려놔서, RESUME 재개가 Phase 6 에서 막혔다).
// 이 단계가 돌았다는 기록은 synced_at 하나로 충분하다.
fm.synced_at = new Date().toISOString();

const newFrontmatter = '---\n' + stringifyYAML(fm) + '---';
writeFileSync(scriptPath, newFrontmatter + body, 'utf-8');

console.log('🔄 Duration sync applied:');
for (const u of updated) {
  console.log(`  scene_${u.id}: ${u.old}s → ${u.new}s (TTS ${u.tts}s + ${padding}s padding)`);
}
console.log(`\n✅ Total: ${fm.target_total_seconds}s (previously target 60s)`);
console.log(`   Script updated: ${scriptPath}`);
