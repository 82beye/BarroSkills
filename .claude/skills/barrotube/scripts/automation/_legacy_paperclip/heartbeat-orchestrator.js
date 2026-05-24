#!/usr/bin/env node

/**
 * heartbeat-orchestrator.js — BarroTube 회사의 활성 에이전트들을 순회하며 heartbeat 실행
 *
 * Paperclip의 heartbeat는 단일 agent를 1회 trigger. 여러 에이전트를 주기적으로
 * 자동 실행하려면 외부 스케줄러가 필요 → 본 스크립트가 그 역할.
 *
 * 처리 흐름:
 *   1) BarroTube 회사의 agent list 조회
 *   2) runtimeConfig.heartbeat.enabled == true 이고 status != paused 필터
 *   3) 우선순위: Producer → Writer → Fact Checker → Asset PM → Image/Voice → CapCut → QA → Metadata → Publisher
 *   4) 각 agent heartbeat run (비동기 큐 제출)
 *   5) 결과 로그 → logs/heartbeat.log
 *
 * Usage:
 *   node heartbeat-orchestrator.js                   # 1회 실행
 *   node heartbeat-orchestrator.js --dry-run         # agent 목록만 출력
 *   node heartbeat-orchestrator.js --agent Producer  # 특정 에이전트만
 *   node heartbeat-orchestrator.js --timeout-ms 15000 # agent당 대기 (기본 15s)
 */

import { appendFileSync, mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const LOG_FILE = join(ROOT, 'logs', 'heartbeat.log');
const LOCK_FILE = join(ROOT, 'logs', '.heartbeat.lock');
const COMPANY_ID = '46041d31-43ca-4135-8db6-8a84ba0d22de';

// ── 중복 실행 방지 PID 락 (atomic O_EXCL) ────────────────────────────────
// writeFileSync flag:'wx' = O_CREAT|O_EXCL — 원자적 단독 생성.
// TOCTOU race 제거: check-then-write 대신 create-or-fail 단일 syscall.
// RunAtLoad+StartInterval 동시 fire, launchctl reload 직후 중첩 등 모든 경우 방어.
{
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  let lockAcquired = false;
  try {
    writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', encoding: 'utf-8' });
    lockAcquired = true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      // 락 파일 존재 → PID 살아있는지 확인
      try {
        const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 0); // ESRCH이면 dead
            // 살아있음 → 중복 실행 차단
            const msg = `[${new Date().toISOString()}] ⚠ Already running (pid=${pid}), skip this cycle.\n`;
            try { appendFileSync(LOG_FILE, msg); } catch {}
            process.exit(0);
          } catch (killErr) {
            if (killErr.code === 'ESRCH') {
              // stale 락 → 강제 제거 후 재시도 (1회만)
              try { unlinkSync(LOCK_FILE); } catch {}
              try {
                writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', encoding: 'utf-8' });
                lockAcquired = true;
              } catch {
                // 두 번째도 실패 → 다른 인스턴스가 선점, 종료
                process.exit(0);
              }
            }
            // EPERM: 권한 오류 → 락 무시하고 진행 (lockAcquired=false)
          }
        }
      } catch { /* 읽기 실패 → 락 무시 진행 */ }
    }
  }
  const cleanLock = () => {
    if (lockAcquired) { try { unlinkSync(LOCK_FILE); } catch {} }
  };
  process.on('exit', cleanLock);
  process.on('SIGINT', () => { cleanLock(); process.exit(130); });
  process.on('SIGTERM', () => { cleanLock(); process.exit(143); });
}

// 우선순위 순서 (S0 → S11 흐름)
const PRIORITY_ORDER = [
  'CEO', 'Producer', 'Market Researcher', 'Strategist', 'Writer', 'Fact Checker',
  'Asset PM', 'Image Generator', 'Voice Engineer', 'CapCut Composer',
  'QA Reviewer', 'Metadata Writer', 'Publisher',
];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(resolve(ROOT, 'logs'), { recursive: true });
    appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch {}
}

function pcli(args, { timeout = 60000 } = {}) {
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` };
  const r = spawnSync('npx', ['--yes', 'paperclipai', ...args], {
    encoding: 'utf-8', env, timeout,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      agent: { type: 'string', short: 'a' },
      'timeout-ms': { type: 'string', short: 't', default: '15000' },
      parallel: { type: 'boolean', default: false },   // 기본 직렬, --parallel 플래그로 병렬 허용
      'max-inflight': { type: 'string', default: '1' }, // 동시 진행 가능 에피소드 수 (기본 1)
    },
  });

  const timeout = parseInt(values['timeout-ms']);
  const maxInflight = parseInt(values['max-inflight']);
  const serial = !values.parallel; // 기본 직렬

  log(`🫀 Heartbeat orchestrator starting (timeout/agent=${timeout}ms, mode=${serial ? 'serial' : 'parallel'}, max-inflight=${maxInflight})`);

  // ─ drain-only 모드 + 직렬 게이트 (2026-04-29) ─────────────────
  // drain-only: 현재 in_progress 이슈만 모두 병렬 처리, 신규 이슈 픽업/dispatch 차단
  let drainOnly = false;
  try {
    const fs = await import('node:fs');
    if (fs.existsSync(resolve(ROOT, 'paperclip/config/autonomy-pause.json'))) {
      const j = JSON.parse(fs.readFileSync(resolve(ROOT, 'paperclip/config/autonomy-pause.json'), 'utf-8'));
      drainOnly = j.mode === 'drain-only' || j?.guards?.accept_new_issues === false;
    }
  } catch {}

  let inflightCount = 0;
  let inflightIssues = [];
  let inflightAssignees = new Set();
  if (serial || drainOnly) {
    try {
      const r = await fetch(`http://localhost:3100/api/companies/${COMPANY_ID}/issues?limit=400`);
      if (r.ok) {
        const data = await r.json();
        const items = (Array.isArray(data) ? data : data.items || data.data || [])
          .filter(x => !x.hiddenAt && x.status === 'in_progress');
        inflightCount = items.length;
        inflightIssues = items.map(i => i.identifier);
        items.forEach(i => { if (i.assigneeAgentId) inflightAssignees.add(i.assigneeAgentId); });
        if (inflightCount > 0) {
          log(`⏳ Company-wide in_progress (${inflightCount}): ${inflightIssues.join(', ')}`);
        }
      }
    } catch (e) { log(`⚠ inflight check failed: ${e.message}`); }
  }

  // drain-only 우선: in_progress assignee만 heartbeat (병렬 허용 — 5명까지 동시), 새 이슈 픽업 차단
  // 글로벌 직렬: in_progress >= max-inflight일 때 동일 효과 (drain-only가 더 강한 정책)
  const globalGateActive = drainOnly || (serial && inflightCount >= maxInflight);
  if (drainOnly) {
    log(`🚧 DRAIN-ONLY mode — only assignees of in_progress issues will heartbeat (병렬 허용, 신규 픽업 차단). inflight=${inflightCount}`);
  } else if (globalGateActive) {
    log(`🔒 Global serial gate — only assignees of in_progress issues will heartbeat (${inflightCount}/${maxInflight})`);
  }

  // 1) agent list
  const listRes = pcli(['agent', 'list', '--company-id', COMPANY_ID, '--json']);
  if (listRes.status !== 0) {
    log(`❌ agent list 실패: ${listRes.stderr.slice(-200)}`);
    process.exit(1);
  }
  let agents;
  try { agents = JSON.parse(listRes.stdout); }
  catch { log(`❌ agent list JSON 파싱 실패`); process.exit(1); }

  // 2) 필터 + 정렬
  // heartbeat.enabled는 PaperClip 서버 내장 타이머용 — 우리 orchestrator는
  // 직접 heartbeat run을 trigger하므로 해당 필드를 무시하고 paused 여부만 체크.
  const eligible = agents
    .filter(a => a.status !== 'paused')
    .sort((a, b) => {
      const ai = PRIORITY_ORDER.indexOf(a.name);
      const bi = PRIORITY_ORDER.indexOf(b.name);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  const targets = values.agent
    ? eligible.filter(a => a.name.toLowerCase().includes(values.agent.toLowerCase()))
    : eligible.filter(a => {
        // 글로벌 직렬 게이트: in_progress 이슈가 있으면 그 이슈의 assignee만 heartbeat 허용.
        // 외 모든 에이전트는 skip → 새 이슈 픽업 차단 → 회사 전체 1건만 진행.
        if (globalGateActive) {
          return inflightAssignees.has(a.id);
        }
        return true;
      });

  if (values['dry-run']) {
    log(`🔍 Dry-run — would heartbeat ${targets.length}/${eligible.length} agents:`);
    targets.forEach(a => log(`  · ${a.name} (${a.id.slice(0, 8)}...) [${a.status}]`));
    return;
  }

  if (targets.length === 0) {
    log(`⚠ heartbeat 대상 agent 없음`);
    return;
  }

  log(`🎯 Targets: ${targets.map(a => a.name).join(', ')}`);

  // 3) 순차 heartbeat
  let success = 0, skip = 0, fail = 0;
  for (const agent of targets) {
    log(`  ▶ ${agent.name} heartbeat...`);
    const r = pcli([
      'heartbeat', 'run',
      '--agent-id', agent.id,
      '--source', 'automation',
      '--trigger', 'ping',
      '--timeout-ms', String(timeout),
    ], { timeout: timeout + 5000 });

    // heartbeat run은 queued 상태에서 CLI timeout 가능 — 정상
    if (/queued|completed|running/i.test(r.stdout)) {
      log(`    ✅ ${agent.name} → heartbeat dispatched`);
      success++;
    } else if (/no assigned issue|no todo|nothing to do/i.test(r.stdout + r.stderr)) {
      log(`    ⏭  ${agent.name} — 할 일 없음`);
      skip++;
    } else {
      log(`    ⚠ ${agent.name} — ${(r.stderr || r.stdout).slice(0, 200)}`);
      fail++;
    }
  }

  log(`📊 완료 — dispatched ${success}, skip ${skip}, fail ${fail}`);
}

main().catch(e => { log(`❌ fatal: ${e.message}`); process.exit(1); });
