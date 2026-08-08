#!/usr/bin/env node

/**
 * validate-tts-policy.js — TTS·자막 숫자 분리 정책 v3.0 검증기
 *
 * narration은 ElevenLabs에 그대로 전달되므로 숫자는 한글 수사여야 한다.
 * subtitle_text는 렌더·CapCut 자막용 숫자 표기다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYAML } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE = resolve(ROOT, 'workspace');

const HELP = `
validate-tts-policy.js — TTS·자막 숫자 분리 정책 v3.0 검증기

Usage:
  node scripts/automation/validate-tts-policy.js --ep EP-2026-0043 [--platform long|shorts]
  node scripts/automation/validate-tts-policy.js --file path/to/30_script.md --strict
  echo "칠백오에서 칠백이십" | node scripts/automation/validate-tts-policy.js

Options:
  --ep <id>            workspace/episodes/<id>/의 30_script.md 탐색
  --platform <id>      long | shorts (기본: 둘 다)
  --file <path>        임의 파일 검증
  --strict             모든 scene의 subtitle_text를 필수로 검사
  --json               결과 JSON 출력
  --quiet              위반 없으면 출력 생략
  --help               이 도움말
`;

function lineOf(text, needle) {
  const index = text.indexOf(needle);
  return index < 0 ? 1 : text.slice(0, index).split(/\r?\n/).length;
}

function issue({ rule, source, sceneId = null, line = 1, text, suggestion, message }) {
  return { rule, source, scene_id: sceneId, line, col: 1, text, suggestion, message };
}

function parseScript(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const meta = parseYAML(match[1]);
    return Array.isArray(meta?.scenes) ? meta : null;
  } catch {
    return null;
  }
}

function validateNarration(narration, source, sceneId, line) {
  const digit = String(narration || '').match(/\d/);
  if (!digit) return null;
  return issue({
    rule: 'arabic-number-in-narration',
    source,
    sceneId,
    line,
    text: String(narration),
    suggestion: '숫자·날짜·소수점·범위를 한글 수사로 쓰고, 숫자 표기는 subtitle_text에 둡니다.',
    message: 'TTS narration에 아라비아 숫자가 있습니다. ElevenLabs 요청 전 수정해야 합니다.',
  });
}

function validateText(text, source, strict) {
  const violations = [];
  const warnings = [];
  const script = parseScript(text);

  if (!script) {
    const violation = validateNarration(text, source, null, 1);
    if (violation) violations.push(violation);
    return { violations, warnings };
  }

  for (const [index, scene] of script.scenes.entries()) {
    const sceneId = scene.scene_id || String(index + 1).padStart(3, '0');
    const narrationLine = lineOf(text, 'narration:');
    const violation = validateNarration(scene.narration, source, sceneId, narrationLine);
    if (violation) violations.push(violation);

    if (!String(scene.subtitle_text || '').trim()) {
      const missing = issue({
        rule: 'missing-subtitle-text',
        source,
        sceneId,
        line: narrationLine,
        text: String(scene.narration || ''),
        suggestion: 'subtitle_text: 화면용 문장과 아라비아 숫자 표기를 추가합니다.',
        message: '자막용 subtitle_text가 없습니다.',
      });
      (strict ? violations : warnings).push(missing);
    }
  }

  return { violations, warnings };
}

function readStdin() {
  return new Promise((resolveInput) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolveInput(data));
    if (process.stdin.isTTY) resolveInput('');
  });
}

function findEpisodeScripts(epId, platformFilter) {
  const epDir = join(WORKSPACE, 'episodes', epId);
  if (!existsSync(epDir)) throw new Error(`EP 디렉토리가 없습니다: ${epDir}`);
  const platforms = platformFilter ? [platformFilter] : ['long', 'long-3min', 'shorts'];
  const candidates = platforms
    .map(platform => ({ platform, path: join(epDir, 'platforms', platform, '30_script.md') }))
    .filter(item => existsSync(item.path));
  const flat = join(epDir, '30_script.md');
  if (existsSync(flat)) candidates.push({ platform: 'v1-flat', path: flat });
  if (candidates.length === 0) throw new Error(`30_script.md를 찾을 수 없습니다: ${epDir}`);
  return candidates;
}

function formatIssue(kind, entry) {
  const scene = entry.scene_id ? ` scene ${entry.scene_id}` : '';
  return `[POLICY ${kind}] ${entry.source}${scene} 줄 ${entry.line}: ${entry.message}\n    ${entry.suggestion}`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        ep: { type: 'string' },
        platform: { type: 'string' },
        file: { type: 'string' },
        strict: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    throw new Error(`인자 파싱 실패: ${error.message}`);
  }

  const sources = [];
  if (values.ep) {
    for (const item of findEpisodeScripts(values.ep, values.platform)) {
      sources.push({ label: item.path, text: readFileSync(item.path, 'utf-8') });
    }
  } else if (values.file) {
    const path = resolve(values.file);
    if (!existsSync(path)) throw new Error(`파일 없음: ${path}`);
    sources.push({ label: path, text: readFileSync(path, 'utf-8') });
  } else {
    const input = await readStdin();
    if (!input.trim()) throw new Error('입력이 없습니다. --ep / --file / stdin 중 하나를 사용하세요.');
    sources.push({ label: '<stdin>', text: input });
  }

  const result = { policy: 'v3.0', strict: values.strict, sources: [] };
  let totalViolations = 0;
  let totalWarnings = 0;
  for (const source of sources) {
    const checked = validateText(source.text, source.label, values.strict);
    totalViolations += checked.violations.length;
    totalWarnings += checked.warnings.length;
    result.sources.push({ source: source.label, violations_count: checked.violations.length, warnings_count: checked.warnings.length, ...checked });

    if (!values.json && (!values.quiet || checked.violations.length || checked.warnings.length)) {
      console.log(`\n=== ${source.label} ===`);
      console.log(`  violations: ${checked.violations.length}, warnings: ${checked.warnings.length}`);
      checked.violations.forEach(entry => console.log(`  ${formatIssue('VIOLATION', entry)}`));
      checked.warnings.forEach(entry => console.log(`  ${formatIssue('WARNING', entry)}`));
      if (!checked.violations.length && !checked.warnings.length) console.log('  [OK] TTS·자막 정책 통과.');
    }
  }

  result.total_violations = totalViolations;
  result.total_warnings = totalWarnings;
  result.passed = totalViolations === 0;
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`\n${result.passed ? '[OK]' : '[FAIL]'} TTS·자막 정책 v3.0 — violations: ${totalViolations}, warnings: ${totalWarnings}`);
  process.exitCode = result.passed ? 0 : 1;
}

main().catch(error => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 1;
});
