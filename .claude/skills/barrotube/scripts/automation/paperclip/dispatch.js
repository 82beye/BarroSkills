#!/usr/bin/env node
/**
 * dispatch.js — 페이퍼클립 process 에이전트(Producer · Ops Runner)가 부르는 실행기
 *
 * 페이퍼클립 루틴이 정시에 이슈를 만들고 담당 에이전트를 깨우면, process 어댑터가 이 스크립트를 띄운다.
 * 여기서 이슈 본문의 `action:` 을 허용 목록(config/paperclip/actions.json)으로 풀어 로컬 파이프라인을 돌리고,
 * 결과를 그 이슈에 댓글·상태로 돌려준다. 실패·멈춤이면 SRE 에게 장애 이슈를 연다.
 *
 * 지켜야 하는 것 (페이퍼클립 쪽 동작에서 나온 규칙 — 2026-10-07 실측):
 *   1. 같은 회차를 두 번 돌리지 않는다. 페이퍼클립은 실패한 실행의 배정 이슈를 「복구」한다며 다시 깨우고,
 *      잠들었다 깨면 놓친 루틴을 한 번 쏜다. launchd 데드맨도 같은 회차를 노린다 → 마커(O_EXCL)로 한쪽만 돈다.
 *   2. 파이프라인은 분리된 프로세스 그룹으로 띄운다. 페이퍼클립이 재시작되거나 실행을 취소해도 렌더 중인
 *      회차가 죽지 않는다. 끝나면 종료코드를 파일로 남기고, 이 실행기가 없더라도 거버너 순회가 마무리한다.
 *   3. 끝나면 반드시 이슈에 댓글을 남긴다 — 배정으로 깬 실행이 댓글 없이 끝나면 페이퍼클립이 다시 깨운다.
 *   4. 실패·멈춤 이슈는 blocked + 배정 해제로 닫는다 — 배정이 남아 있으면 「배정 복구」가 회차를 다시 돌린다.
 *   5. 1분마다 진행 줄을 찍는다 — 출력이 오래 끊긴 실행은 페이퍼클립 안전망이 죽인다.
 *
 * Usage:
 *   (페이퍼클립)   node scripts/automation/paperclip/dispatch.js
 *   (직접)         node scripts/automation/paperclip/dispatch.js --direct slot:us-close
 *                  node scripts/automation/paperclip/dispatch.js --direct resume --slot us-close --ep EP-2026-0215
 *   (데드맨)       node scripts/automation/paperclip/dispatch.js --direct slot:us-close --if-missing --via deadman
 *   (마무리만)     node scripts/automation/paperclip/dispatch.js --finalize 2026-10-08/us-close
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readOperatorDirective } from '../lib/operator-directive.js';
import {
  ROOT, GROWTH, api, claimMarker, classifyOutcome, fileSize, findEp, incidentsSince, kstParts, lastAttempt,
  markerKeyFor, markerPath, openIncidentIssues, paperclipHealthy, paperclipIds, parseIssueAction, pidAlive,
  readMarker, readTailSince, resolveAction, updateMarker,
} from './lib.js';

const say = (...a) => console.log(...a);
const INCIDENTS = join(GROWTH, 'incidents.jsonl');

// 액션별로 누가 이슈로 시킬 수 있는가. 루틴(=편성표)과 board 는 전부, SRE 는 재개·재실행만.
function allowedCreator(issue, actionKey, ids) {
  if (issue.createdByUserId) return true;                         // board(운영자)
  if (issue.originKind && /routine/i.test(issue.originKind)) return true;
  const agent = issue.createdByAgentId;
  if (!agent || !ids?.agents) return false;
  if (agent === ids.agents.sre) return actionKey === 'resume' || actionKey.startsWith('slot:');
  return false;
}

async function locateIssue() {
  const runId = process.env.PAPERCLIP_RUN_ID;
  if (!runId) return { run: null, issue: null };
  const run = await api('GET', `/heartbeat-runs/${runId}`);
  const issueId = run?.contextSnapshot?.issueId;
  if (!issueId) return { run, issue: null };
  return { run, issue: await api('GET', `/issues/${issueId}`) };
}

/** 오늘 만들어져 아직 열려 있는, 이 액션의 페이퍼클립 이슈가 있는가 (데드맨 판단용). */
async function paperclipPending(actionKey, date) {
  const ids = paperclipIds();
  if (!ids?.companyId || !(await paperclipHealthy())) return false;
  try {
    const list = await api('GET', `/companies/${ids.companyId}/issues?status=todo,in_progress&limit=100`);
    const items = Array.isArray(list) ? list : list?.items ?? [];
    for (const i of items) {
      if (kstParts(new Date(i.createdAt)).date !== date) continue;
      const desc = i.description ?? (await api('GET', `/issues/${i.id}`)).description;
      if (parseIssueAction(desc)?.action === actionKey) return true;
    }
  } catch (e) {
    console.error(`⚠ 페이퍼클립 대기열 확인 실패: ${e.message}`);
  }
  return false;
}

async function comment(issueId, body) {
  if (!issueId) return;
  try { await api('POST', `/issues/${issueId}/comments`, { body }); } catch (e) { console.error(`⚠ 댓글 실패: ${e.message}`); }
}

async function setIssue(issueId, patch) {
  if (!issueId) return;
  try { await api('PATCH', `/issues/${issueId}`, patch, { auth: false }); } catch (e) { console.error(`⚠ 이슈 상태 변경 실패: ${e.message}`); }
}

/**
 * 실패·멈춤 이슈를 닫는 모양. 페이퍼클립은 blocked 에 「무엇이 막고 있나」를 요구한다 —
 * SRE 장애 이슈가 있으면 그것에 막힌 것으로, 없으면 운영자 확인 대기로 건다.
 * 배정은 푼다: 배정이 남으면 「배정 복구」가 같은 회차를 다시 깨운다.
 */
export function blockedPatch(opened = []) {
  const blockers = opened.map((o) => o.issueId).filter(Boolean);
  return blockers.length
    ? { status: 'blocked', blockedByIssueIds: blockers, assigneeAgentId: null }
    : { status: 'blocked', unblockDescriptor: { owner: 'board', action: '로그 확인 후 재개 결정' }, assigneeAgentId: null };
}

function lastPhase(text) {
  const lines = text.split('\n').filter((l) => /Phase \d|S1?\d[a-e]?\b|━━|▶|✅|❌|🖐|🛑/.test(l));
  return lines.length ? lines[lines.length - 1].trim().slice(0, 140) : '';
}

function logPaths(log) {
  return { out: join(ROOT, 'logs', 'cron', `${log}.log`), err: join(ROOT, 'logs', 'cron', `${log}.err`) };
}

// 파이프라인은 영상을 못 내도 exit 0 으로 끝나는 길이 있다. done·guarded 로 남으면 장애도 재시도도 없이 그날 편이 사라진다.
//   idle   — 다룰 주제가 없음 (2026-10-26 월 us-close: 세션 한도로 리서치·데스크가 비었다), 앞 회차가 잠금을 쥐고 있어 건너뜀
//   halted — QA 가 게시를 막음 (2026-10-26 EP-0258·10-30 EP-0270)
// 그 밖의 🛑(운영자 정지·일일 상한·예산)는 의도된 멈춤이다.
const QA_BLOCK = /🛑 QA[^\n]*publish 차단/;
export function cleanExitStatus(text = '') {
  if (QA_BLOCK.test(text)) return 'halted';
  if (/안전한 폴백 토픽이 없습니다|🛑 In-flight lock active/.test(text)) return 'idle';
  return text.includes('🛑') ? 'guarded' : 'done';
}

/** 끝난 회차에서 재개 판단에 쓸 사실 — 한도 거부로 멈췄는가, 어느 단계에서 멈췄는가. */
export function runFacts(text = '', incidents = []) {
  return {
    quotaDenied: text.includes('PAPERCLIP_RESERVE_GUARD'),
    stage: incidents.at(-1)?.stage ?? (QA_BLOCK.test(text) ? 'Phase 9 QA' : null),
  };
}

function tailLines(path, offset, n = 25) {
  return readTailSince(path, offset, 60_000).split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}

/**
 * 끝난(또는 주인이 사라진) 실행을 마무리한다. dispatch 자신과 거버너 순회가 같은 함수를 쓴다.
 * 마커에 이미 결과가 있으면 아무것도 하지 않는다.
 */
export async function finalizeRun(date, key, { quiet = false } = {}) {
  const m = readMarker(date, key);
  if (!m || m.status !== 'running') return m;
  const exitFile = markerPath(date, key).replace(/\.json$/, '.exit');
  const alive = pidAlive(m.pid);
  if (alive) return m;
  const exitCode = existsSync(exitFile) ? Number.parseInt(readFileSync(exitFile, 'utf-8').trim(), 10) : null;
  const { out, err } = logPaths(m.log);
  const text = readTailSince(out, m.outOffset ?? 0) + '\n' + readTailSince(err, m.errOffset ?? 0);
  const newIncidents = m.incidents ? incidentsSince(m.incidentsOffset ?? 0) : [];
  let status = classifyOutcome({ exitCode: Number.isFinite(exitCode) ? exitCode : null, newIncidents });
  const guard = text.split('\n').find((l) => l.includes('🛑'));
  if (status === 'done') status = cleanExitStatus(text);
  // 재개는 어떤 EP 를 돌렸는지 안다 — 로그의 첫 언급은 지난 EP 의 잠금 해제 줄일 수 있다.
  const ep = m.params?.ep ?? findEp(text.replace(/EP-2026-DRYRUN/g, '')) ?? null;
  const finishedAt = new Date().toISOString();
  const mins = Math.max(1, Math.round((Date.parse(finishedAt) - Date.parse(m.startedAt)) / 60000));
  let next = updateMarker(date, key, { status, exitCode, finishedAt, ep, incidentIds: newIncidents.map((r) => r.id), guard: guard?.trim() ?? null, ...runFacts(text, newIncidents) });

  // 성장 루프 뒤에는 목표(goal) 수치를 맞춘다. 실패해도 회차 결과는 바꾸지 않는다.
  if (status === 'done' && m.after === 'kpi-sync' && existsSync(join(ROOT, 'scripts/automation/paperclip/kpi-sync.js'))) {
    await new Promise((res) => {
      const c = spawn('node', ['scripts/automation/paperclip/kpi-sync.js'], { cwd: ROOT, stdio: 'inherit' });
      c.on('exit', res);
      c.on('error', res);
    });
  }

  // 실패·멈춤 → SRE 이슈. 장애 분석기가 남긴 기록이 없으면(가드 밖에서 죽음) 실행기 기록으로 대신 만든다.
  let opened = [];
  if (['failed', 'halted', 'lost'].includes(status)) {
    const rows = newIncidents.length ? newIncidents : [{
      id: `PX-${date.replace(/-/g, '')}-${key.replace(/[^\w]+/g, '-')}`,
      ep, slot: m.params?.slot ?? (m.action.startsWith('slot:') ? m.action.slice(5) : null),
      kind: status === 'lost' ? 'lost' : 'fail', stage: m.action, class: null,
      root_cause: `종료코드 ${exitCode ?? '없음(프로세스 유실)'} — 장애 분석기 기록 없음. 로그 꼬리:\n${tailLines(err, m.errOffset ?? 0, 12) || tailLines(out, m.outOffset ?? 0, 12)}`,
    }];
    // 자동 재개가 또 실패해도 SRE 이슈를 새로 열지 않는다 — 시도마다 Opus 가 같은 진단을 다시 한다.
    const rootIssue = m.rescueOf ? readMarker(date, m.rescueOf)?.sreIssues?.[0] : null;
    opened = await openIncidentIssues(rows, {
      action: m.action, log: m.log, production: m.kind === 'production', slotIssue: m.issueIdentifier, slotIssueId: m.issueId, text, rootIssue,
    });
    next = updateMarker(date, key, { sreIssues: opened });
  }

  const icon = { done: '✅', halted: '🖐', failed: '❌', lost: '❓', guarded: '⏸', idle: '💤' }[status] ?? '•';
  const head = `${icon} **${m.label ?? m.action}** — ${status} · ${mins}분${ep ? ` · ${ep}` : ''}${exitCode !== null ? ` · exit ${exitCode}` : ''}`;
  const extra = [
    guard ? `가드: ${guard.trim()}` : null,
    opened.length ? `장애 이슈: ${opened.map((o) => `${o.incident} → ${o.issue}${o.recurrence ? ` (같은 원인 재발 ${o.recurrence}회째 — 새 SRE 이슈 없이 묶음)` : ''}`).join(', ')}` : null,
    newIncidents.length && !opened.length ? `장애 기록: ${newIncidents.map((r) => r.id).join(', ')} (이미 이슈 있음)` : null,
    `마커: \`${markerPath(date, key)}\` · 로그: \`${out}\``,
  ].filter(Boolean);
  const tail = tailLines(status === 'done' || status === 'guarded' ? out : err, status === 'done' || status === 'guarded' ? (m.outOffset ?? 0) : (m.errOffset ?? 0), 15)
    || tailLines(out, m.outOffset ?? 0, 15);
  if (m.issueId) {
    await comment(m.issueId, [head, '', ...extra, '', '```', tail.slice(-3000), '```'].join('\n'));
    if (['done', 'guarded', 'idle'].includes(status)) await setIssue(m.issueId, { status: 'done' });
    else await setIssue(m.issueId, blockedPatch(opened));
  }
  if (!quiet) {
    say(head);
    extra.forEach((l) => say(`  ${l}`));
  }
  return next;
}

/**
 * 종료 감시는 spawn 직후에 건다. 시작 댓글을 다는 await 사이에 자식이 끝나 버리면 'exit' 이벤트가
 * 이미 지나가 영원히 기다린다 (2026-10-07 test:fail 실측 — 즉시 끝나는 명령에서만 드러났다).
 */
function exitPromise(child) {
  return new Promise((res) => {
    child.on('exit', (code, signal) => res(code ?? (signal ? 128 : null)));
    child.on('error', () => res(127));
  });
}

async function waitForExit(exited, outPath, outOffset) {
  const started = Date.now();
  const beat = setInterval(() => {
    const phase = lastPhase(readTailSince(outPath, outOffset, 200_000));
    say(`… ${Math.round((Date.now() - started) / 60000)}분 경과${phase ? ` · ${phase}` : ''}`);
  }, 60_000);
  try { return await exited; } finally { clearInterval(beat); }
}

async function attach(date, key, m) {
  say(`↪ 이미 돌고 있는 실행에 붙는다 — pid ${m.pid} (${m.via}, ${m.startedAt})`);
  const { out } = logPaths(m.log);
  let n = 0;
  while (pidAlive(m.pid)) {
    await new Promise((r) => setTimeout(r, 15_000));
    n += 1;
    if (n % 4 === 0) say(`… 대기 중${lastPhase(readTailSince(out, m.outOffset ?? 0, 200_000)) ? ` · ${lastPhase(readTailSince(out, m.outOffset ?? 0, 200_000))}` : ''}`);
  }
  return finalizeRun(date, key);
}

async function main() {
  // 인자는 여기서만 읽는다 — 거버너가 finalizeRun 을 가져다 쓸 때 그쪽 인자로 죽지 않게.
  const { values: opt } = parseArgs({
    options: {
      direct: { type: 'string' },
      slot: { type: 'string' },
      ep: { type: 'string' },
      rerun: { type: 'boolean', default: false },
      'if-missing': { type: 'boolean', default: false },
      via: { type: 'string' },
      'rescue-of': { type: 'string' },
      finalize: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (opt.finalize) {
    const [date, key] = opt.finalize.split('/');
    const r = await finalizeRun(date, key);
    say(r ? `${key}: ${r.status}` : '마커 없음');
    return 0;
  }

  const ids = paperclipIds();
  let issue = null;
  let run = null;
  let actionKey = opt.direct;
  let params = { slot: opt.slot, ep: opt.ep };
  let rerun = opt.rerun;

  if (!actionKey) {
    ({ run, issue } = await locateIssue());
    if (!issue) {
      say('이 실행에 연결된 이슈가 없다 — 할 일이 없다. (루틴이 만든 이슈로 깨어야 한다)');
      return 0;
    }
    const parsed = parseIssueAction(issue.description);
    if (!parsed) {
      await comment(issue.id, '이슈 본문에 `action:` 줄이 없어 실행하지 않았다. 허용 액션은 config/paperclip/actions.json 참고.');
      await setIssue(issue.id, blockedPatch());
      return 0;
    }
    actionKey = parsed.action;
    params = parsed.params;
    rerun = /^(true|yes|1)$/i.test(params.rerun ?? '');
    if (!allowedCreator(issue, actionKey, ids)) {
      await comment(issue.id, `⛔ \`${actionKey}\` 는 이 이슈를 만든 주체가 시킬 수 없는 액션이다. 실행하지 않았다.`);
      await setIssue(issue.id, blockedPatch());
      return 0;
    }
  }

  let resolved;
  try {
    resolved = resolveAction(actionKey, params);
  } catch (e) {
    say(`⛔ ${e.message}`);
    if (issue) {
      await comment(issue.id, `⛔ 실행 거부: ${e.message}`);
      await setIssue(issue.id, blockedPatch());
    }
    return opt.direct ? 2 : 0;
  }

  const now = new Date();
  const { date } = kstParts(now);
  const via = opt.via ?? (issue ? 'paperclip' : 'direct');
  const attemptInfo = resolved.spec.idempotency === 'attempt' || rerun ? lastAttempt(date, resolved, { now, rerun }) : null;
  let key = markerKeyFor(resolved, { now, rerun, attempt: attemptInfo?.next ?? 1 });

  // 이미 있는 회차: 돌고 있으면 붙고, 끝났으면 건너뛴다. attempt 류(재개·재실행)는 앞 시도가
  // 실패·멈춤으로 끝났을 때만 새 번호로 다시 돈다 — 성공한 재개를 또 돌리면 단계가 겹친다.
  const prevKey = attemptInfo && attemptInfo.last ? markerKeyFor(resolved, { now, rerun, attempt: attemptInfo.next - 1 }) : key;
  const existing = readMarker(date, prevKey);
  const blocking = existing && (!attemptInfo || ['running', 'done', 'guarded'].includes(existing.status));
  if (blocking) {
    if (opt['if-missing']) { say(`데드맨: ${prevKey} 이미 ${existing.via} 로 ${existing.status} — 할 일 없음`); return 0; }
    if (existing.status === 'running' && pidAlive(existing.pid)) {
      if (issue && existing.issueId !== issue.id) await comment(issue.id, `↪ 같은 회차가 이미 돌고 있다 (${existing.via}, pid ${existing.pid}). 끝날 때까지 지켜본다.`);
      const r = await attach(date, prevKey, existing);
      if (issue && existing.issueId !== issue.id) await setIssue(issue.id, { status: 'done' });
      return ['done', 'guarded'].includes(r?.status) ? 0 : 1;
    }
    if (existing.status === 'running') {
      const r = await finalizeRun(date, prevKey);
      say(`주인 없는 실행을 마무리했다: ${r?.status}`);
    }
    const again = readMarker(date, prevKey);
    const note = `⏭ 오늘 이 회차는 이미 실행됐다 — ${again?.via ?? '?'} · ${again?.status ?? '?'} · ${again?.startedAt ?? ''}${again?.ep ? ` · ${again.ep}` : ''}. 다시 돌리려면 \`rerun: true\`.`;
    say(note);
    if (issue) { await comment(issue.id, note); await setIssue(issue.id, { status: 'done' }); }
    return 0;
  }
  // 데드맨은 페이퍼클립이 이 회차를 아예 못 띄웠을 때만 나선다. 큐에서 앞 실행을 기다리는 중이면
  // 끼어들지 않는다 — 끼어들면 파이프라인의 in-flight 가드가 한쪽을 조용히 건너뛰어 회차가 사라진다.
  if (opt['if-missing'] && await paperclipPending(resolved.key, date)) {
    say(`데드맨: ${resolved.key} 가 페이퍼클립 큐에서 대기 중 — 끼어들지 않는다`);
    return 0;
  }
  if (opt['dry-run']) {
    say(`[dry-run] ${resolved.key} → ${resolved.cmd.join(' ')} env=${JSON.stringify(resolved.env)} log=${resolved.log} marker=${date}/${key}`);
    return 0;
  }

  const { out, err } = logPaths(resolved.log);
  const outOffset = fileSize(out);
  const errOffset = fileSize(err);
  const marker = {
    action: resolved.key, label: resolved.spec.label, params: resolved.params, kind: resolved.spec.kind ?? 'ops',
    log: resolved.log, after: resolved.spec.after ?? null, incidents: Boolean(resolved.spec.incidents),
    status: 'running', via, startedAt: now.toISOString(), outOffset, errOffset, incidentsOffset: fileSize(INCIDENTS),
    runId: run?.id ?? process.env.PAPERCLIP_RUN_ID ?? null, issueId: issue?.id ?? null, issueIdentifier: issue?.identifier ?? null,
    pid: null, ...(opt['rescue-of'] ? { rescueOf: opt['rescue-of'] } : {}),
  };
  if (!claimMarker(date, key, marker)) {
    // 같은 순간 다른 쪽이 먼저 잡았다 — 그쪽에 붙는다.
    const other = readMarker(date, key);
    say(`↪ 다른 실행(${other?.via})이 먼저 잡았다`);
    if (other?.status === 'running') return ['done', 'guarded'].includes((await attach(date, key, other))?.status) ? 0 : 1;
    return 0;
  }

  if (via === 'deadman') {
    const healthy = await paperclipHealthy();
    const msg = `⚠️ <b>데드맨 실행</b> — ${resolved.spec.label} 회차가 정시에 시작되지 않아 launchd 가 직접 돌립니다 (페이퍼클립 ${healthy ? '응답함 — 루틴 상태 확인 필요' : '응답 없음'}).`;
    try { const { sendTelegramText } = await import('../notify.js'); await sendTelegramText(msg); } catch (e) { console.error(`⚠ 텔레그램 실패: ${e.message}`); }
  }

  const outFd = openSync(out, 'a');
  const errFd = openSync(err, 'a');
  writeSync(outFd, `\n=== [paperclip] ${now.toISOString()} ${resolved.key} via=${via} issue=${issue?.identifier ?? '-'} marker=${date}/${key}\n`);
  const exitFile = markerPath(date, key).replace(/\.json$/, '.exit');
  // 실행 토큰(PAPERCLIP_API_KEY 등)은 파이프라인에 넘기지 않는다 — 파이프라인은 페이퍼클립 실행 주체가 아니다.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PAPERCLIP_') || k === 'PAPERCLIP_DISABLED'));
  Object.assign(env, resolved.env, { BT_EXIT_FILE: exitFile, BT_DISPATCH_MARKER: `${date}/${key}` });
  if (resolved.spec.kind === 'production') env.BT_QUOTA_CLASS = 'production';   // 호출당 예산·한도선 — quota-cli.js
  const child = spawn('bash', ['-c', 'cd "$0" || exit 1; "$@"; rc=$?; printf "%s" "$rc" > "$BT_EXIT_FILE"; exit $rc', ROOT, ...resolved.cmd], {
    cwd: ROOT, detached: true, stdio: ['ignore', outFd, errFd], env,
  });
  const exited = exitPromise(child);
  closeSync(outFd);
  closeSync(errFd);
  updateMarker(date, key, { pid: child.pid });
  say(`▶ ${resolved.spec.label} (${resolved.key}) — pid ${child.pid} · via ${via} · 로그 ${out}`);
  // 운영자가 이 회차 주제를 정했으면 회차 이슈에도 남긴다 — 파이프라인(데스크·리서치)은 같은 파일을 읽는다.
  const directive = resolved.key.startsWith('slot:') ? readOperatorDirective(ROOT, date, resolved.key.slice(5)) : '';
  if (issue) await comment(issue.id, `▶ 시작 — \`${resolved.key}\` · pid ${child.pid} · 마커 \`${date}/${key}\``
    + (directive ? `\n\n📌 **운영자 지시 적용** (\`workspace/ops/directives/${date}-${resolved.key.slice(5)}.md\`)\n\n${directive}` : ''));

  const exitCode = await waitForExit(exited, out, outOffset);
  // 래퍼가 종료코드를 못 남겼으면(신호로 죽음) 여기서 남긴다.
  if (!existsSync(exitFile) && exitCode !== null) { const fd = openSync(exitFile, 'w'); writeSync(fd, String(exitCode)); closeSync(fd); }
  const r = await finalizeRun(date, key);
  return ['done', 'guarded', 'idle'].includes(r?.status) ? 0 : 1;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().then((code) => process.exit(code ?? 0)).catch((e) => {
    console.error(`❌ dispatch: ${e.stack || e.message}`);
    process.exit(1);
  });
}
