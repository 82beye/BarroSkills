#!/usr/bin/env node
/**
 * Prompt enrichment dry-run — brief 정보로 cinematic prompt 생성, 출력만 (image gen 안 함).
 *
 * Usage:
 *   node scripts/automation/test-prompt-enrich.js --episode workspace/episodes/EP-2026-0052
 */
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYAML } from 'yaml';
import { enrichPrompt } from './lib/prompt-enrich.js';

const args = process.argv.slice(2);
const epIdx = args.indexOf('--episode');
if (epIdx === -1) {
  console.error('Usage: test-prompt-enrich.js --episode <dir>');
  process.exit(1);
}
const epDir = resolve(args[epIdx + 1]);
const briefPath = join(epDir, '00_brief.md');
if (!existsSync(briefPath)) {
  console.error(`brief not found: ${briefPath}`);
  process.exit(1);
}

const md = readFileSync(briefPath, 'utf-8');
const m = md.match(/^---\n([\s\S]*?)\n---/);
const fm = m ? parseYAML(m[1]) : {};

const topic = fm.topic || '';
const visualHint = (fm.visual_keywords && fm.visual_keywords[0]) || '';
const headline = fm.thumbnail?.intro_headline_text || fm.thumbnail?.headline_text || '오늘의 이슈';
const keyword = fm.thumbnail?.keyword_number || '';
const emotion = fm.thumbnail?.mascot_emotion || 'confident';
const moodMap = { worry: 'tense breaking-news alert', surprise: 'dramatic shock reveal', confident: 'confident analysis', angry: 'urgent critical', crying: 'somber warning', thinking: 'analytical', pointing: 'direct attention call', annoyed: 'frustrated commentary' };
const mood = moodMap[emotion] || 'tense';

console.log('=== INPUT ===');
console.log('topic:', topic);
console.log('visualHint:', visualHint.slice(0, 100));
console.log('headline:', headline);
console.log('keyword:', keyword);
console.log('mood:', mood);

console.log('\n=== ENRICHING (Claude Sonnet 4.6) ===');
const t0 = Date.now();
const result = await enrichPrompt({ topic, visualHint, headline, keyword, mood, useMascot: false, format: 'shorts' });
const dt = Date.now() - t0;

console.log(`\n=== ENRICHED PROMPT (${result.prompt.length} chars, ${dt}ms, $${result.cost_usd.toFixed(4)}) ===\n`);
console.log(result.prompt);
console.log(`\n=== END ===`);
console.log(`tokens: in=${result.input_tokens} out=${result.output_tokens}`);
