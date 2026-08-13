#!/usr/bin/env node

/**
 * validate-script-quality.js — 대본 분석 밀도 계약 검증기
 *
 * 판정 기준의 정본은 lib/script-quality-contract.js 다. 여기에는 수치를 적지 않는다.
 *
 * 기본은 리포트만 하고 종료코드 0 이다. generate-script.js 가 이미 생성 시점에
 * 한 번 되돌려 재작성시키므로, 여기서 또 파이프라인을 세우면 같은 위반으로 두 번
 * 멈추게 된다. CI·수동 점검처럼 실패시키고 싶을 때만 --strict 를 준다.
 *
 * Usage:
 *   node scripts/automation/validate-script-quality.js --ep EP-2026-0091
 *   node scripts/automation/validate-script-quality.js --file <path/30_script.md> --strict
 *   node scripts/automation/validate-script-quality.js --all --json
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import { parse as parseYAML } from 'yaml';
import { validateScript, formatIssue } from './lib/script-quality-contract.js';

const ROOT = resolve(import.meta.dirname, '../..');
const EPISODES = join(ROOT, 'workspace', 'episodes');

function scenesOf(path) {
  const match = readFileSync(path, 'utf-8').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const meta = parseYAML(match[1]);
    return Array.isArray(meta?.scenes) ? meta.scenes : null;
  } catch {
    return null;
  }
}

function resolveTargets(values) {
  if (values.file) return [values.file];
  const root = values.ep ? join(EPISODES, values.ep) : EPISODES;
  if (!existsSync(root)) return [];
  // 백업·아카이브 사본은 세지 않는다 — 고쳐 놓은 EP 가 옛 사본 때문에 계속 실패로 보인다.
  return execSync(`find ${JSON.stringify(root)} -name 30_script.md`, { encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean)
    .filter((p) => !/(^|\/)(_backup|_archive)/.test(p));
}

function main() {
  const { values } = parseArgs({ options: {
    ep: { type: 'string' },
    file: { type: 'string' },
    all: { type: 'boolean' },
    strict: { type: 'boolean' },
    json: { type: 'boolean' },
  } });

  if (!values.ep && !values.file && !values.all) {
    console.error('Usage: validate-script-quality.js --ep <EP-ID> | --file <path> | --all [--strict] [--json]');
    process.exit(1);
  }

  const targets = resolveTargets(values);
  const report = [];
  let errorCount = 0;

  for (const path of targets) {
    const scenes = scenesOf(path);
    if (!scenes) continue;
    const issues = validateScript(scenes);
    errorCount += issues.filter((i) => i.severity === 'error').length;
    if (issues.length) report.push({ file: path, issues });
  }

  if (values.json) {
    console.log(JSON.stringify({ checked: targets.length, errors: errorCount, report }, null, 2));
  } else {
    for (const entry of report) {
      console.log(`\n${entry.file}`);
      for (const issue of entry.issues) console.log(`  ${formatIssue(issue)}`);
    }
    const clean = targets.length - report.length;
    console.log(`\n검사 ${targets.length}편 · 위반 없음 ${clean}편 · error ${errorCount}건`);
  }

  process.exit(values.strict && errorCount > 0 ? 1 : 0);
}

main();
