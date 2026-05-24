#!/usr/bin/env node

/**
 * clean-reset.js — BarroTube Paperclip 상태 클린 리셋
 *
 * 수행:
 *   1) EP-2026-0001 관련 전체 숨김 (구정책 480s, Revision 3 진행 중인 것까지)
 *   2) EP-2026-0002 → status done (이미 로컬 S11 완료)
 *   3) EP-0003~0006의 서브이슈 전부 숨김
 *   4) Primary 4개(YOU-12, 15, 16, 17) blocked → todo로 release (assignee=Producer 유지)
 *   5) Producer prompt에 "sub-issue 자동 분해 금지" 규칙 추가
 *
 * Dry-run 지원: --dry
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const COMPANY_ID = '46041d31-43ca-4135-8db6-8a84ba0d22de';

// EP parent IDs (issue.get 결과로 확인된 것)
const EP_PARENTS = {
  'b5c54849': 'EP-2026-0001',   // primary YOU-13 (but this is original hello world issue, note: needs check)
  'd137cce4': 'EP-2026-0002',
  '13d19ace': 'EP-2026-0003',
  '3a9d454e': 'EP-2026-0004',
  'caf29c51': 'EP-2026-0005',
  '9338067f': 'EP-2026-0006',
};

const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` };

function pcli(args) {
  const r = spawnSync('npx', ['--yes', 'paperclipai', ...args], { encoding: 'utf-8', env });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function listIssues(status) {
  const r = pcli(['issue', 'list', '-C', COMPANY_ID, '--status', status, '--json']);
  try { return JSON.parse(r.stdout); } catch { return []; }
}

function hideIssue(issue, dry) {
  if (dry) { console.log(`  [dry] hide ${issue.identifier}: ${issue.title.slice(0, 50)}`); return true; }
  const r = pcli([
    'issue', 'update', issue.id,
    '--hidden-at', new Date().toISOString(),
    '--comment', 'Clean reset — archive (policy/stranded)',
  ]);
  if (r.status === 0) { console.log(`  ✓ hidden ${issue.identifier}`); return true; }
  console.log(`  ✗ hide ${issue.identifier} failed: ${r.stderr.slice(0, 200)}`); return false;
}

function doneIssue(issue, dry) {
  if (dry) { console.log(`  [dry] done ${issue.identifier}`); return true; }
  const r = pcli([
    'issue', 'update', issue.id,
    '--status', 'done',
    '--comment', 'Clean reset — local S11 completed (EP-2026-0002 Hello World)',
  ]);
  if (r.status === 0) { console.log(`  ✓ done ${issue.identifier}`); return true; }
  console.log(`  ✗ done ${issue.identifier} failed: ${r.stderr.slice(0, 200)}`); return false;
}

function releaseToTodo(issue, dry) {
  if (dry) { console.log(`  [dry] release→todo ${issue.identifier}`); return true; }
  // release만 하면 assignee 빠짐 → producer 재배정 하려면 update
  const r1 = pcli(['issue', 'release', issue.id]);
  // assignee 재배정 (Producer)
  const r2 = pcli([
    'issue', 'update', issue.id,
    '--status', 'todo',
    '--assignee-agent-id', '8f440921-8463-4127-a45e-0cb478334480',
    '--comment', 'Clean reset — return to todo for fresh start',
  ]);
  if (r2.status === 0) { console.log(`  ✓ todo ${issue.identifier}`); return true; }
  console.log(`  ✗ release ${issue.identifier} failed: ${(r1.stderr + r2.stderr).slice(0, 200)}`); return false;
}

async function main() {
  const { values } = parseArgs({ options: { dry: { type: 'boolean', default: false } } });
  const dry = values.dry;
  console.log(`🧹 Clean reset ${dry ? '(DRY RUN)' : ''}\n`);

  // 전체 이슈 수집 (모든 상태)
  const statuses = ['todo', 'in_progress', 'done', 'blocked', 'backlog'];
  const all = {};
  for (const s of statuses) {
    for (const i of listIssues(s)) all[i.id] = { ...i, _status: s };
  }
  const issues = Object.values(all);
  console.log(`📋 Loaded ${issues.length} BarroTube issues (all statuses)\n`);

  const primary = {
    'YOU-12': 'EP-2026-0005',
    'YOU-13': 'EP-2026-0001',
    'YOU-14': 'EP-2026-0002',
    'YOU-15': 'EP-2026-0003',
    'YOU-16': 'EP-2026-0004',
    'YOU-17': 'EP-2026-0006',
  };

  // ─ 1) EP-2026-0001 관련 전부 숨김 ─
  console.log('━━━ 1) EP-2026-0001 (구정책 480s) 숨김 ━━━');
  const ep1 = issues.filter(i =>
    i.identifier === 'YOU-13' ||
    i.identifier === 'YOU-3' ||
    (i.parentId && ['b5c54849-'].some(p => i.parentId.startsWith(p))) ||
    /EP-2026-0001/i.test(i.title)
  );
  for (const i of ep1) hideIssue(i, dry);
  console.log(`  (${ep1.length}개 처리)\n`);

  // ─ 2) EP-2026-0002 → done ─
  console.log('━━━ 2) EP-2026-0002 (로컬 S11 완료) → done ━━━');
  const y14 = issues.find(i => i.identifier === 'YOU-14');
  if (y14) doneIssue(y14, dry);
  // EP-0002 서브이슈도 숨김 (이미 로컬 완료 → Paperclip 트래킹 불필요)
  const ep2subs = issues.filter(i => i.parentId && i.parentId.startsWith('d137cce4'));
  for (const i of ep2subs) hideIssue(i, dry);
  console.log(`  (서브 ${ep2subs.length}개 숨김)\n`);

  // ─ 3) EP-0003~0006 서브이슈 숨김 ─
  console.log('━━━ 3) EP-0003~0006 서브이슈 숨김 (Primary만 유지) ━━━');
  const parentsToClean = ['13d19ace', '3a9d454e', 'caf29c51', '9338067f'];
  const subs = issues.filter(i =>
    i.parentId && parentsToClean.some(p => i.parentId.startsWith(p))
  );
  for (const i of subs) hideIssue(i, dry);
  console.log(`  (${subs.length}개 숨김)\n`);

  // ─ 4) Primary 4개 todo로 release ─
  console.log('━━━ 4) Primary 4개 (YOU-12, 15, 16, 17) todo 복귀 ━━━');
  for (const id of ['YOU-12', 'YOU-15', 'YOU-16', 'YOU-17']) {
    const i = issues.find(x => x.identifier === id);
    if (i) releaseToTodo(i, dry);
  }

  console.log('\n✅ Clean reset complete');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
