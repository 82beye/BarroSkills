/**
 * paperclip/lib.js — 페이퍼클립 관제와 로컬 파이프라인 사이의 공용 조각
 *
 * 2026-10-07 운영자가 자동화를 페이퍼클립으로 옮겼다. 역할 분담:
 *   - 페이퍼클립: 언제(루틴 cron)·누가(에이전트)·얼마나(토큰)·무엇이 깨졌나(이슈)
 *   - 로컬 파이프라인: 실제로 무엇을 하는가 (결정론 스크립트, 그대로)
 * 이 파일은 그 경계에서 쓰는 것만 둔다 — 액션 허용 목록 해석, 회차 마커, API 호출, 장애 이슈.
 *
 * 순수 함수(해석·키·분류)는 테스트가 직접 부른다. 파일·네트워크를 만지는 함수는 얇게 둔다.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../../..');
export const OPS = join(ROOT, 'workspace', 'ops');
export const GROWTH = join(ROOT, 'workspace', 'growth');

const EP_RE = /^EP-\d{4}-\d{4}$/;

export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

/** 쓰는 도중 읽는 쪽이 반쪽 파일을 보지 않게 rename 으로 바꿔 끼운다. */
export function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

// ── 시간 (KST) ────────────────────────────────────────────────────────────
// 회차 키는 운영자의 하루(KST)로 자른다. 서버 TZ 가 무엇이든 같은 키가 나와야 한다.
export function kstParts(now = new Date()) {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  const date = k.toISOString().slice(0, 10);
  return { date, hour: k.getUTCHours(), minute: k.getUTCMinutes(), weekday: k.getUTCDay() };
}

// ── 액션 허용 목록 ────────────────────────────────────────────────────────
export function loadActions(path = join(ROOT, 'config', 'paperclip', 'actions.json')) {
  return readJson(path)?.actions ?? {};
}

export function knownSlots(path = join(ROOT, 'config', 'routines.json')) {
  return Object.keys(readJson(path)?.slots ?? {});
}

function fill(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    if (params[k] === undefined) throw new Error(`액션 템플릿 인자 누락: ${k}`);
    return String(params[k]);
  });
}

/**
 * 액션 이름 + 인자 → 실행 명세. 허용 목록 밖이면 던진다.
 * 인자는 형식을 검증한 뒤에만 명령에 들어간다 — 페이퍼클립 이슈 본문은 사람·에이전트가 쓰는 자유 텍스트다.
 */
export function resolveAction(key, rawParams = {}, { actions = loadActions(), slots = knownSlots() } = {}) {
  const spec = actions[key];
  if (!spec) throw new Error(`허용 목록에 없는 액션: ${key}`);
  const params = {};
  for (const name of spec.params ?? []) {
    const v = String(rawParams[name] ?? '').trim();
    if (name === 'slot' && !slots.includes(v)) throw new Error(`알 수 없는 슬롯: ${v || '(없음)'}`);
    if (name === 'ep' && !EP_RE.test(v)) throw new Error(`EP 형식이 아니다: ${v || '(없음)'}`);
    params[name] = v;
  }
  if (params.ep) params.epnum = params.ep.slice(-4);
  return {
    key,
    spec,
    params,
    cmd: spec.cmd.map((a) => fill(a, params)),
    env: Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, fill(v, params)])),
    log: fill(spec.log, params),
    base: spec.key ? fill(spec.key, params) : key.replace(/[^\w.-]+/g, '_'),
  };
}

/**
 * 이슈 본문에서 액션을 읽는다. 형식은 줄 단위 `이름: 값` — 루틴 설명이 그대로 이슈 본문이 된다.
 *   action: slot:us-close
 *   ep: EP-2026-0215
 */
export function parseIssueAction(text = '') {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^\s*(action|slot|ep|rerun)\s*:\s*`?([^`\s]+)`?\s*$/i.exec(line);
    if (m && out[m[1].toLowerCase()] === undefined) out[m[1].toLowerCase()] = m[2];
  }
  if (!out.action) return null;
  const { action, ...params } = out;
  return { action, params };
}

/** 같은 회차를 두 번 돌리지 않기 위한 키. attempt 는 앞 시도 수를 받아 다음 번호를 붙인다. */
export function markerKeyFor(resolved, { now = new Date(), attempt = 1, rerun = false } = {}) {
  const { spec, base } = resolved;
  const { hour } = kstParts(now);
  switch (spec.idempotency) {
    case 'daily': return rerun ? `${base}#${attempt}` : base;
    case 'twice-daily': return `${base}@${hour < 12 ? 'am' : 'pm'}${rerun ? `#${attempt}` : ''}`;
    case 'attempt': return `${base}#${attempt}`;
    case 'none': return `${base}@${now.getTime()}`;
    default: throw new Error(`알 수 없는 idempotency: ${spec.idempotency}`);
  }
}

// ── 회차 마커 ─────────────────────────────────────────────────────────────
// workspace/ops/runs/<KST 날짜>/<키>.json — 페이퍼클립 루틴과 launchd 데드맨이 같은 마커를 본다.
// 선점은 O_EXCL 로 한다: 덮개를 열자마자 두 쪽이 동시에 깨어나도 한쪽만 이긴다.
export function markerPath(date, key) {
  return join(OPS, 'runs', date, `${key.replace(/[/\\]/g, '_')}.json`);
}

export function readMarker(date, key) {
  return readJson(markerPath(date, key));
}

export function claimMarker(date, key, data) {
  const path = markerPath(date, key);
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') return null;
    throw e;
  }
  try { writeSync(fd, `${JSON.stringify(data, null, 2)}\n`); } finally { closeSync(fd); }
  return path;
}

export function updateMarker(date, key, patch) {
  const path = markerPath(date, key);
  const cur = readJson(path, {});
  const next = { ...cur, ...patch };
  writeJsonAtomic(path, next);
  return next;
}

/** 앞 시도들을 훑어 다음 attempt 번호와 마지막 시도를 돌려준다. */
export function lastAttempt(date, resolved, opts = {}) {
  let n = 1;
  let last = null;
  for (; n < 50; n += 1) {
    const m = readMarker(date, markerKeyFor(resolved, { ...opts, attempt: n }));
    if (!m) break;
    last = m;
  }
  return { next: n, last };
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ── 결과 분류 ─────────────────────────────────────────────────────────────
// auto-pipeline 은 사람을 부를 때(halt_for_human) exit 0 으로 끝난다 — 다음 스케줄을 막지 않으려고.
// 그래서 종료코드만 보면 멈춘 회차가 「성공」으로 보인다. 실행 중에 새로 붙은 장애 기록으로 가른다.
export function classifyOutcome({ exitCode, newIncidents = [] }) {
  if (exitCode === null || exitCode === undefined) return 'lost';
  if (exitCode !== 0) return 'failed';
  if (newIncidents.some((r) => r.kind === 'halt' || r.kind === 'fail')) return 'halted';
  return 'done';
}

/** 로그 조각에서 이 실행이 다룬 EP 를 찾는다 (DRYRUN 제외, 마지막 언급). */
export function findEp(text = '') {
  const all = [...String(text).matchAll(/EP-\d{4}-\d{4}/g)].map((m) => m[0]);
  return all.length ? all[all.length - 1] : null;
}

export function readTailSince(path, offset = 0, maxBytes = 400_000) {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const start = Math.max(offset, size - maxBytes);
  if (size <= start) return '';
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf-8');
  } finally { closeSync(fd); }
}

export function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

/** incidents.jsonl 에서 offset 뒤에 붙은 장애 기록(처리 기록 제외)만. */
export function incidentsSince(offset, path = join(GROWTH, 'incidents.jsonl')) {
  return readTailSince(path, offset).split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.type !== 'resolution' && r.id);
}

export function allIncidents(path = join(GROWTH, 'incidents.jsonl')) {
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, 'utf-8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const resolved = new Set(rows.filter((r) => r.type === 'resolution').map((r) => r.id));
  return rows.filter((r) => r.type !== 'resolution' && r.id).map((r) => ({ ...r, resolved: resolved.has(r.id) }));
}

// ── 페이퍼클립 API ────────────────────────────────────────────────────────
// local_trusted 모드라 같은 기계에서는 토큰 없이 board 권한이다. 실행 중인 에이전트는
// PAPERCLIP_API_KEY(실행 토큰)를 받는다 — 댓글은 그걸로 남겨야 그 실행의 댓글로 인정된다
// (안 그러면 페이퍼클립이 「댓글 없는 실행」으로 보고 다시 깨운다).
// 반대로 장애 이슈 생성·상태 변경은 board 로 한다: 실행 토큰으로는 일시정지된 에이전트에게
// 배정할 수 없고(409), 남을 blocked 해제 담당으로 지정할 수 없다(403) — 2026-10-07 실측.
export function apiBase() {
  return (process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
}

export async function api(method, path, body, { timeoutMs = 15_000, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && process.env.PAPERCLIP_API_KEY) headers.Authorization = `Bearer ${process.env.PAPERCLIP_API_KEY}`;
  const res = await fetch(`${apiBase()}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error || data?.message || text.slice(0, 200);
    throw new Error(`paperclip ${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

export async function paperclipHealthy() {
  try { return (await api('GET', '/health', undefined, { timeoutMs: 5000, auth: false }))?.status === 'ok'; } catch { return false; }
}

/** setup.js 가 남긴 ID 지도. 없으면 페이퍼클립 연동 없이 로컬만 돈다. */
export function paperclipIds() {
  return readJson(join(OPS, 'paperclip-ids.json'));
}

// ── 장애 → SRE 이슈 ───────────────────────────────────────────────────────
const INCIDENT_MAP = () => join(OPS, 'paperclip-incidents.json');

export function incidentIssueBody(inc, { action, log, slotIssue } = {}) {
  const lines = [
    'action: repair',
    `incident: ${inc.id}`,
    inc.ep ? `ep: ${inc.ep}` : null,
    inc.slot ? `slot: ${inc.slot}` : null,
    '',
    `- 종류: ${inc.kind ?? '?'} · 단계: ${inc.stage ?? '?'} · 분류: **${inc.class ?? '미분석'}**${inc.confidence ? ` (확신 ${inc.confidence})` : ''}`,
    action ? `- 실행: \`${action}\`${slotIssue ? ` · 원 이슈 ${slotIssue}` : ''}` : null,
    inc.root_cause ? `- 원인(자동 분석): ${String(inc.root_cause).slice(0, 600)}` : null,
    inc.files?.length ? `- 고칠 자리 후보: ${inc.files.map((f) => `\`${f}\``).join(', ')}` : null,
    existsSync(join(GROWTH, 'incidents', `${inc.id}.md`)) ? `- 설계서: \`${join(GROWTH, 'incidents', `${inc.id}.md`)}\`` : null,
    log ? `- 로그: \`${join(ROOT, 'logs', 'cron', `${log}.log`)}\` (.err 함께)` : null,
    '',
    '처리 절차는 지침(AGENTS.md)의 「장애 처리」를 따른다. 재개가 필요하면 Producer 에게 `action: resume` 이슈를 만든다.',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

/** 숫자만 바뀌는 재발(시각·나이·건수)을 같은 것으로 본다. EP 번호는 원인의 일부라 그대로 둔다. */
function normCause(s) {
  return String(s).split(/(EP-\d{4}-\d{4})/)
    .map((p, i) => (i % 2 ? p : p.toLowerCase().replace(/\d+(?:\.\d+)?/g, '#')))
    .join('').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function jsonText(s) {
  try { return JSON.parse(`"${s}"`); } catch { return s; }
}

/**
 * 같은 원인의 재발을 가르는 지문. dispatch 가 대신 만든 기록(PX-)만 — 장애 분석기 기록(IR-)은 회차마다 새 장애다.
 * doctor 처럼 검사 결과를 찍는 잡은 RED 항목 묶음이, 나머지는 액션·EP·마지막 로그 줄이 지문이다.
 * 2026-10-19: EP-2026-0219 업로드 락 하나로 doctor 가 10-09~10-19 매일 실패했고, 그때마다 새 SRE 이슈가 열려
 * Opus 가 같은 진단을 11번 했다. 루트 이슈(YOU-322)가 닫히면 거기 막힌 11건이 한꺼번에 SRE 를 깨울 참이었다.
 */
export function incidentSignature(inc, { action, text = '' } = {}) {
  if (!String(inc?.id ?? '').startsWith('PX-')) return null;
  const act = action ?? inc.stage ?? '?';
  const red = [...String(text).matchAll(/"([\w-]+)":\s*\{"status":\s*"RED",\s*"detail":\s*"((?:[^"\\]|\\.)*)"/g)]
    .map(([, name, detail]) => `${name}=${normCause(jsonText(detail))}`);
  if (red.length) return `${act}|${[...new Set(red)].sort().join(';')}`;
  const last = String(inc.root_cause ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  return `${act}|${inc.ep ?? '-'}|${normCause(last)}`;
}

/** 같은 지문으로 열려 있는 장애 이슈(가장 최근 것). 닫혔으면 새로 연다 — 고친 뒤 다시 났으면 새 장애다. */
async function openRootFor(sig, map) {
  const roots = Object.entries(map)
    .filter(([, v]) => v?.issueId && !v.duplicateOf && (v.sigs ?? []).includes(sig))
    .sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)));
  for (const [key, v] of roots) {
    try {
      const issue = await api('GET', `/issues/${v.issueId}`, undefined, { auth: false });
      if (!['done', 'cancelled'].includes(issue?.status)) return { key, ...v, identifier: issue.identifier ?? v.identifier };
    } catch { /* 못 읽으면 새로 연다 — 놓치는 것보다 중복이 낫다 */ }
  }
  return null;
}

/**
 * 새 장애마다 SRE 이슈 하나. 같은 장애로 두 번 만들지 않는다(로컬 지도 + 제목 접두사).
 * 같은 원인이 다시 나면(지문이 같고 그 이슈가 아직 열려 있으면) 새 이슈 없이 거기에 묶는다 — SRE 를 깨우지 않는다.
 * 페이퍼클립이 꺼져 있거나 ID 지도가 없으면 아무것도 안 한다 — 로컬 회차를 막지 않는 게 먼저다.
 */
export async function openIncidentIssues(incidents, ctx = {}) {
  const ids = paperclipIds();
  if (!ids?.agents?.sre || !incidents.length) return [];
  const map = readJson(INCIDENT_MAP(), {});
  const made = [];
  for (const inc of incidents) {
    if (map[inc.id]) {
      if (map[inc.id].issueId) made.push({ incident: inc.id, issue: map[inc.id].identifier ?? map[inc.id].issueId, issueId: map[inc.id].issueId, existed: true });
      continue;
    }
    // 자동 재개 시도의 장애는 원 회차의 장애 이슈에 묶는다. 그 이슈가 이미 닫혔으면 새 장애로 연다.
    if (ctx.rootIssue?.issueId) {
      let open = false;
      try { open = !['done', 'cancelled'].includes((await api('GET', `/issues/${ctx.rootIssue.issueId}`, undefined, { auth: false }))?.status); } catch { /* 못 읽으면 새로 연다 */ }
      if (open) {
        map[inc.id] = { issueId: ctx.rootIssue.issueId, identifier: ctx.rootIssue.issue, at: new Date().toISOString(), duplicateOf: ctx.rootIssue.rootIncident ?? ctx.rootIssue.incident };
        writeJsonAtomic(INCIDENT_MAP(), map);
        made.push({ incident: inc.id, issue: ctx.rootIssue.issue, issueId: ctx.rootIssue.issueId, existed: true, rootIncident: ctx.rootIssue.rootIncident ?? ctx.rootIssue.incident });
        continue;
      }
    }
    const sig = incidentSignature(inc, ctx);
    const root = sig ? await openRootFor(sig, map) : null;
    if (root) {
      const recurrences = (map[root.key].recurrences ?? 0) + 1;
      const at = new Date().toISOString();
      map[root.key] = { ...map[root.key], recurrences, lastRecurrenceAt: at };
      map[inc.id] = { issueId: root.issueId, identifier: root.identifier, at, duplicateOf: root.key };
      writeJsonAtomic(INCIDENT_MAP(), map);
      made.push({ incident: inc.id, issue: root.identifier ?? root.issueId, issueId: root.issueId, existed: true, recurrence: recurrences, rootIncident: root.key });
      continue;
    }
    const body = {
      title: `[장애] ${inc.id}${inc.ep ? ` ${inc.ep}` : ''} — ${inc.stage ?? ctx.action ?? '실패'}`.slice(0, 200),
      description: incidentIssueBody(inc, ctx),
      status: 'todo',
      priority: ctx.production ? 'high' : 'medium',
      assigneeAgentId: ids.agents.sre,
      projectId: ids.projects?.reliability ?? null,
      parentId: ctx.slotIssueId ?? null,
    };
    try {
      const issue = await api('POST', `/companies/${ids.companyId}/issues`, body, { auth: false });
      map[inc.id] = { issueId: issue.id, identifier: issue.identifier, at: new Date().toISOString(), ...(sig ? { sigs: [sig] } : {}) };
      writeJsonAtomic(INCIDENT_MAP(), map);
      made.push({ incident: inc.id, issue: issue.identifier ?? issue.id, issueId: issue.id });
    } catch (e) {
      console.error(`⚠ 장애 이슈 생성 실패 (${inc.id}): ${e.message}`);
    }
  }
  return made;
}

/** 처음 연결할 때 지난 장애로 이슈 폭탄이 나지 않게 현재 장애를 「본 것」으로 표시한다. */
export function baselineIncidents() {
  const map = readJson(INCIDENT_MAP(), {});
  let n = 0;
  for (const inc of allIncidents()) {
    if (!map[inc.id]) { map[inc.id] = { baseline: true, at: new Date().toISOString() }; n += 1; }
  }
  writeJsonAtomic(INCIDENT_MAP(), map);
  return n;
}

/** 아직 이슈가 없는 미처리 장애 (최근 maxAgeH 시간). 거버너 순회가 쓴다. */
export function pendingIncidents({ maxAgeH = 48, now = Date.now() } = {}) {
  const map = readJson(INCIDENT_MAP(), {});
  return allIncidents().filter((inc) => {
    if (inc.resolved || map[inc.id]) return false;
    const m = /^IR-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(inc.id);
    const made = m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`) : Date.parse(inc.at);
    return Number.isFinite(made) && now - made <= maxAgeH * 3600 * 1000;
  });
}

/**
 * 실패 회차 이슈(루틴이 만들고 dispatch 가 배정을 푼 것)인데, 막던 이슈가 모두 닫혔는데도 blocked 로 남았는가.
 * 페이퍼클립은 막힘이 풀리면 담당자만 깨운다 — 담당이 없으면 이슈는 blocked 그대로 남는다(2026-10-19 YOU-429·430).
 */
export function runIssueSettled(issue) {
  if (issue?.status !== 'blocked' || issue.assigneeAgentId || issue.assigneeUserId) return false;
  if (!/routine/i.test(issue.originKind ?? '')) return false;
  const blockers = issue.blockedBy ?? [];
  return blockers.length > 0 && blockers.every((b) => ['done', 'cancelled'].includes(b.status));
}

/**
 * 실패 회차 이슈인데 같은 루틴의 더 새 회차가 이미 done 인가. 장애 이슈가 in_review(보드 질문)로 남으면
 * 막던 이슈가 영영 안 닫혀 회차 이슈가 blocked 로 쌓였다(2026-10-28 YOU-701·687·675 등) — 다음 회차가
 * 성공했다면 그 실패는 대체된 것이다. 실패 회차를 다시 돌리지는 않는다.
 */
export function runIssueSuperseded(issue, latestDoneByRoutine = {}) {
  if (issue?.status !== 'blocked' || issue.assigneeAgentId || issue.assigneeUserId) return null;
  if (!/routine/i.test(issue.originKind ?? '') || !issue.originId) return null;
  const later = latestDoneByRoutine[issue.originId];
  return later && Date.parse(later.createdAt) > Date.parse(issue.createdAt) ? later : null;
}

/** 거버너 순회가 부른다 — 위 두 조건의 회차 이슈를 done 으로 닫는다. 닫힌 이슈의 댓글은 아무도 깨우지 않는다. */
export async function settleRunIssues(ids) {
  const list = await api('GET', `/companies/${ids.companyId}/issues?status=blocked&limit=200`, undefined, { auth: false });
  const items = (Array.isArray(list) ? list : list?.items ?? [])
    .filter((i) => !i.assigneeAgentId && !i.assigneeUserId && /routine/i.test(i.originKind ?? ''));
  if (!items.length) return [];
  const done = await api('GET', `/companies/${ids.companyId}/issues?status=done&limit=200`, undefined, { auth: false });
  const latestDoneByRoutine = {};
  for (const d of Array.isArray(done) ? done : done?.items ?? []) {
    if (!/routine/i.test(d.originKind ?? '') || !d.originId) continue;
    const seen = latestDoneByRoutine[d.originId];
    if (!seen || Date.parse(d.createdAt) > Date.parse(seen.createdAt)) latestDoneByRoutine[d.originId] = d;
  }
  const settled = [];
  for (const i of items) {
    const full = await api('GET', `/issues/${i.id}`, undefined, { auth: false });
    const later = runIssueSuperseded(full, latestDoneByRoutine);
    if (!runIssueSettled(full) && !later) continue;
    const by = (full.blockedBy ?? []).map((b) => b.identifier ?? b.id).join(', ');
    await api('PATCH', `/issues/${i.id}`, later ? {
      status: 'done', blockedByIssueIds: [],
      comment: `🧹 같은 루틴의 후속 회차 ${later.identifier ?? later.id} 가 성공해 이 실패 회차를 정리한다${by ? ` (막던 이슈 ${by} 연결 해제)` : ''}. 실패한 회차를 다시 돌리지는 않는다.`,
    } : {
      status: 'done',
      comment: `🧹 막던 이슈(${by})가 모두 닫혀 이 회차 이슈를 정리한다. 실패한 회차를 다시 돌리지는 않는다 — 재개는 SRE 가 재개 이슈로 따로 연다.`,
    }, { auth: false });
    settled.push(full.identifier ?? i.id);
  }
  return settled;
}

// ── 에이전트 어댑터 (setup.js · token-governor.js 공용) ─────────────────────
const BUNDLE_KEYS = ['instructionsFilePath', 'instructionsRootPath', 'instructionsEntryFile', 'instructionsBundleMode'];

export function loadCompany(path = join(ROOT, 'config', 'paperclip', 'company.json')) {
  return readJson(path);
}

/** 변형의 공급자 — 어댑터 종류로 가른다. */
export function providerOf(variantSpec) {
  return variantSpec?.adapterType === 'codex_local' ? 'codex' : variantSpec?.adapterType === 'claude_local' ? 'claude' : null;
}

/** 거버너가 고른 변형(primary·economy·alternate). 없으면 primary. */
export function chosenVariant(key, state = readJson(join(OPS, 'token-state.json'), {})) {
  const v = state?.agents?.[key]?.variant;
  return ['primary', 'economy', 'alternate'].includes(v) ? v : 'primary';
}

/** 역할 명세 + 변형 → 페이퍼클립 어댑터 설정. 지침 번들 경로는 기존 값을 이어받는다. */
export function adapterFor(spec, variant, existingConfig = {}, env = {}) {
  const keep = Object.fromEntries(BUNDLE_KEYS.filter((k) => existingConfig[k] !== undefined).map((k) => [k, existingConfig[k]]));
  if (spec.kind === 'process') {
    return {
      adapterType: 'process',
      adapterConfig: { ...keep, command: spec.process.command, args: spec.process.args, cwd: spec.cwd, env, timeoutSec: spec.process.timeoutSec, graceSec: spec.process.graceSec },
    };
  }
  const v = spec[variant] ?? spec.primary;
  // engine cli: 페이퍼클립 기본(ACP) 경로는 자체 번들 Claude Code(2.1.257)를 써서 claude-opus-5-5 를 400 으로 거부했다
  // (2.1.280+ 필요, 2026-10-07 실측). 로컬 CLI(claude 2.1.292·codex)는 파이프라인과 같은 판이라 모델 검증도 같다.
  const cfg = { ...keep, engine: 'cli', model: v.model, cwd: spec.cwd, env, timeoutSec: spec.timeout_sec, graceSec: 15 };
  if (readJson(join(OPS, 'quota-switch-state.json'), {}).enabled) {
    cfg.command = join(ROOT, 'scripts', 'automation', 'paperclip', 'quota-bin', v.adapterType === 'claude_local' ? 'claude' : 'codex');
  }
  if (v.adapterType === 'claude_local') {
    Object.assign(cfg, { effort: v.effort, maxTurnsPerRun: spec.max_turns, dangerouslySkipPermissions: true });
  } else {
    // 페이퍼클립은 codex_local 에 샌드박스 우회를 기본으로 켠다(2026-10-07 실측). 쓰기 범위가 작업 폴더면 되는
    // 역할(리뷰어·CMO·CEO)은 샌드박스 안에서 돌게 명시적으로 끈다. SRE 만 운영 트리 반영 때문에 켠다.
    // 작업 폴더(workspace/ops/repairs·growth)는 git 밖이라 codex CLI 가 「신뢰된 디렉터리 아님」으로 거부한다(2026-10-07 실측).
    // 2026-10-19 실측 두 가지 — CMO 메모 2편이 프로젝트 폴더(_default)에 갇히고 리뷰 판정·댓글이 기록되지 않았다:
    //   · 운영자 ~/.codex 의 shell_environment_policy inherit="core" 가 셸에서 PAPERCLIP_API_* 를 지운다 → 실행 환경을 그대로 넘긴다.
    //   · 프로젝트에 묶인 이슈는 페이퍼클립이 작업 폴더를 프로젝트 폴더로 바꾼다 → 자기 폴더(cwd)는 어디서 깨든 쓰기 허용.
    const extraArgs = ['--skip-git-repo-check', '-c', 'shell_environment_policy.inherit="all"'];
    if (!spec.codex_bypass) extraArgs.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([spec.cwd])}`);
    Object.assign(cfg, { modelReasoningEffort: v.modelReasoningEffort, dangerouslyBypassApprovalsAndSandbox: Boolean(spec.codex_bypass), extraArgs });
  }
  return { adapterType: v.adapterType, adapterConfig: cfg };
}

export function runtimeFor(spec) {
  return {
    heartbeat: {
      enabled: Boolean(spec.timer_sec),
      intervalSec: spec.timer_sec ?? 0,
      wakeOnDemand: Boolean(spec.wake_on_demand),
      maxConcurrentRuns: spec.max_concurrent ?? 1,
      cooldownSec: 10,
    },
  };
}


/** 키 순서와 무관한 비교용 문자열. */
export function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** 서버가 돌려주는 어댑터 설정과 우리가 원하는 설정을 비교할 모양으로. env 값은 가려져 오므로 키만 본다. */
export function comparableAdapterConfig(cfg = {}) {
  const { paperclipSkillSync, env, ...rest } = cfg;
  return canon({ ...rest, envKeys: Object.keys(env ?? {}).sort() });
}
