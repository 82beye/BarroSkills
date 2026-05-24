#!/usr/bin/env node

/**
 * register-paperclip-issue.js
 *
 * 에피소드를 Paperclip AI(BarroTube 회사)의 이슈로 등록한다.
 * - 이미 등록된 에피소드는 skip (idempotent)
 * - Producer 에이전트에게 기본 배정 (8f440921-...)
 * - 결과 issue ID를 .episode_status.json에 저장
 *
 * Usage:
 *   node register-paperclip-issue.js --episode EP-YYYY-NNNN
 *   node register-paperclip-issue.js --all-unregistered
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE = join(ROOT, 'workspace/episodes');

const PAPERCLIP_COMPANY_ID = '46041d31-43ca-4135-8db6-8a84ba0d22de'; // BarroTube
const DEFAULT_ASSIGNEE = '8f440921-8463-4127-a45e-0cb478334480';    // Producer (PD)

// Paperclip 통합은 옵션. PAPERCLIP_DISABLED=1 또는 자동 감지로 비활성.
// 명시적 비활성 시 모든 호출이 즉시 null 반환 (silent skip이 아니라 일관된 단일 안내).
const PAPERCLIP_DISABLED = process.env.PAPERCLIP_DISABLED === '1';

let _paperclipAvailable = null; // 첫 호출 시 1회 검증 후 캐시

function isPaperclipAvailable() {
  if (PAPERCLIP_DISABLED) return false;
  if (_paperclipAvailable !== null) return _paperclipAvailable;
  // npx paperclipai --help 가능성 검사 (1회 cache)
  try {
    const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` };
    const r = spawnSync('npx', ['--yes', '--no', 'paperclipai', '--help'], { encoding: 'utf-8', env, timeout: 5000 });
    _paperclipAvailable = r.status === 0;
  } catch {
    _paperclipAvailable = false;
  }
  if (!_paperclipAvailable && !process.env.BARROTUBE_PAPERCLIP_NOTICE_SHOWN) {
    process.env.BARROTUBE_PAPERCLIP_NOTICE_SHOWN = '1';
    console.warn('  ℹ Paperclip CLI 미설치/미사용 — 이슈 등록 단계는 비활성화됨 (파이프라인은 정상 진행).');
    console.warn('    활성화하려면: npm i -g paperclipai && paperclipai login. 일시 비활성: PAPERCLIP_DISABLED=1');
  }
  return _paperclipAvailable;
}

function getPaperclipBin() {
  // npx paperclipai — PATH 이슈 회피
  return { cmd: 'npx', prefix: ['--yes', 'paperclipai'] };
}

function extractTopic(briefContent) {
  const m = briefContent.match(/^topic:\s*"?([^"\n]+)"?/m);
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

function recordPaperclipSkipInStatus(episodeId, reason) {
  try {
    const sp = join(WORKSPACE, episodeId, '.episode_status.json');
    if (!existsSync(sp)) return;
    const s = JSON.parse(readFileSync(sp, 'utf-8'));
    // 기존 issue_id가 있으면 그대로 유지 (재등록 시도 흔적만 추가).
    if (s.paperclip?.issue_id) return;
    s.paperclip = {
      ...(s.paperclip || {}),
      registered: false,
      skip_reason: reason,
      detected_at: new Date().toISOString(),
    };
    s.last_updated = new Date().toISOString();
    writeFileSync(sp, JSON.stringify(s, null, 2), 'utf-8');
  } catch {/* non-fatal */}
}

function registerIssue(episodeId, { skipIfRegistered = true } = {}) {
  if (!isPaperclipAvailable()) {
    // 명시적 비활성: 호출자에게 null 반환 + .episode_status.json 에 흔적 기록 (silent-skip 가시화)
    recordPaperclipSkipInStatus(episodeId, 'paperclip_cli_unavailable');
    return null;
  }
  const epDir = join(WORKSPACE, episodeId);
  if (!existsSync(epDir)) {
    console.error(`❌ ${episodeId} 없음`);
    return null;
  }

  const briefPath = join(epDir, '00_brief.md');
  const statusPath = join(epDir, '.episode_status.json');

  if (!existsSync(briefPath)) {
    console.error(`❌ ${episodeId}/00_brief.md 없음`);
    return null;
  }

  // 기존 등록 여부 확인
  let status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf-8')) : {};
  if (skipIfRegistered && status.paperclip?.issue_id) {
    console.log(`  ⏭  ${episodeId} 이미 등록됨: ${status.paperclip.identifier || status.paperclip.issue_id}`);
    return status.paperclip;
  }

  const brief = readFileSync(briefPath, 'utf-8');
  const topic = extractTopic(brief) || '(no topic)';
  const title = `${episodeId}: ${topic}`.slice(0, 200);

  const { cmd, prefix } = getPaperclipBin();
  const args = [
    ...prefix, 'issue', 'create',
    '--company-id', PAPERCLIP_COMPANY_ID,
    '--title', title,
    '--description', brief,
    '--assignee-agent-id', DEFAULT_ASSIGNEE,
    '--priority', 'high',
    '--status', 'todo',
    '--json',
  ];

  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` };
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', env });

  if (r.status !== 0) {
    console.error(`❌ ${episodeId} issue 생성 실패:`);
    console.error(r.stderr.slice(-500));
    return null;
  }

  let issue;
  try { issue = JSON.parse(r.stdout); }
  catch { console.error(`❌ ${episodeId} JSON 파싱 실패`); console.error(r.stdout.slice(-300)); return null; }

  // .episode_status.json 업데이트
  status.paperclip = {
    issue_id: issue.id,
    identifier: issue.identifier,
    issue_number: issue.issueNumber,
    assignee_agent_id: issue.assigneeAgentId,
    registered_at: new Date().toISOString(),
  };
  writeFileSync(statusPath, JSON.stringify(status, null, 2), 'utf-8');

  console.log(`  ✅ ${episodeId} → ${issue.identifier} (${issue.id.slice(0, 8)}...)`);
  return status.paperclip;
}

const VALID_ISSUE_STATUS = new Set(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done']);

function readEpisodeIssueId(episodeId) {
  const statusPath = join(WORKSPACE, episodeId, '.episode_status.json');
  if (!existsSync(statusPath)) return null;
  try {
    const s = JSON.parse(readFileSync(statusPath, 'utf-8'));
    return s.paperclip?.issue_id || null;
  } catch { return null; }
}

function updateIssueStatus(episodeId, nextStatus, { comment = null, silent = false } = {}) {
  if (!VALID_ISSUE_STATUS.has(nextStatus)) {
    throw new Error(`Invalid issue status: ${nextStatus}`);
  }
  if (!isPaperclipAvailable()) return null;
  const issueId = readEpisodeIssueId(episodeId);
  if (!issueId) {
    // Paperclip은 사용 가능하지만 이 EP가 등록되지 않은 경우 (단발 fallback)
    if (!silent) console.log(`  ⏭  ${episodeId} no paperclip issue_id — skipping status=${nextStatus}`);
    return null;
  }

  const { cmd, prefix } = getPaperclipBin();
  const args = [...prefix, 'issue', 'update', issueId, '--status', nextStatus, '--json'];
  if (comment) { args.push('--comment', comment); }

  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` };
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', env });

  if (r.status !== 0) {
    if (!silent) {
      console.warn(`  ⚠ ${episodeId} issue status update (${nextStatus}) failed: ${r.stderr.slice(-200).trim()}`);
    }
    return null;
  }

  if (!silent) console.log(`  🔄 ${episodeId} issue → ${nextStatus}`);
  try { return JSON.parse(r.stdout); } catch { return { status: nextStatus }; }
}

async function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string', short: 'e' },
      'all-unregistered': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });

  if (values.episode) {
    const r = registerIssue(values.episode, { skipIfRegistered: !values.force });
    if (!r) process.exit(1);
    return;
  }

  if (values['all-unregistered']) {
    const eps = existsSync(WORKSPACE) ? readdirSync(WORKSPACE).filter(d => d.startsWith('EP-')).sort() : [];
    console.log(`🔍 Scanning ${eps.length} episodes for registration...`);
    let registered = 0, skipped = 0, failed = 0;
    for (const ep of eps) {
      const r = registerIssue(ep, { skipIfRegistered: !values.force });
      if (!r) failed++;
      else if (r.registered_at && Date.parse(r.registered_at) >= Date.now() - 60000) registered++;
      else skipped++;
    }
    console.log(`\n📊 Done — 신규 ${registered}, 기존 ${skipped}, 실패 ${failed}`);
    return;
  }

  console.error('Usage: register-paperclip-issue.js --episode EP-YYYY-NNNN');
  console.error('   or: register-paperclip-issue.js --all-unregistered');
  process.exit(1);
}

export { registerIssue, updateIssueStatus, readEpisodeIssueId };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('❌', e.message); process.exit(1); });
}
