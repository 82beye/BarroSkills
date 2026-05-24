#!/usr/bin/env node
/**
 * heartbeat-effectiveness.js
 *
 * Heartbeat dispatcher가 실제로 에이전트를 깨우고, 에이전트가 실제로
 * 작업했는지 검증한다.
 *
 * 측정:
 *   1) 최근 N분 동안 heartbeat-orchestrator가 dispatch한 에이전트 수 (X)
 *      — logs/heartbeat.log 파싱
 *   2) 같은 N분 동안 이슈 status가 변경된(updatedAt이 최근) 에이전트 수 (Y)
 *      — PaperClip API
 *   3) 비율 Y/X < 0.3이면 alert (logs/autonomy/effectiveness-alerts.jsonl)
 *
 * Usage:
 *   node heartbeat-effectiveness.js              # 30분 윈도우 (기본)
 *   node heartbeat-effectiveness.js --window 60  # 60분
 *   node heartbeat-effectiveness.js --threshold 0.5
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const LOG_DIR = join(ROOT, 'logs', 'autonomy');
const ALERT_LOG = join(LOG_DIR, 'effectiveness-alerts.jsonl');
const HEARTBEAT_LOG = join(ROOT, 'logs', 'heartbeat.log');
const COMPANY_ID = '46041d31-43ca-4135-8db6-8a84ba0d22de';
const API_BASE = 'http://localhost:3100';

function log(msg) {
  const line = `[${new Date().toISOString()}] [heartbeat-effectiveness] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'heartbeat-effectiveness.log'), line + '\n', 'utf-8');
  } catch {}
}

async function api(path) {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}

function parseDispatched({ windowMs }) {
  // logs/heartbeat.log lines like:
  // [2026-04-28T12:37:11.111Z] ✅ <Name> → heartbeat dispatched
  if (!existsSync(HEARTBEAT_LOG)) return new Set();
  const since = Date.now() - windowMs;
  const dispatched = new Set();
  const lines = readFileSync(HEARTBEAT_LOG, 'utf-8').split('\n');
  for (const l of lines) {
    const m = l.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*?(?:✅|✅|dispatched)\s*([\w\s]+?)\s*(?:→|->)\s*heartbeat\s*dispatched/i);
    if (m) {
      const t = new Date(m[1]).getTime();
      if (t >= since) dispatched.add(m[2].trim());
    } else {
      // alt pattern: "    ✅ Producer → heartbeat dispatched"
      const m2 = l.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\][^✅]*✅\s*(.+?)\s*→\s*heartbeat\s*dispatched/);
      if (m2) {
        const t = new Date(m2[1]).getTime();
        if (t >= since) dispatched.add(m2[2].trim());
      }
    }
  }
  return dispatched;
}

async function loadAgentSnapshot() {
  const list = await api(`/api/companies/${COMPANY_ID}/issues?limit=300`);
  const items = (Array.isArray(list) ? list : (list.items || [])).filter((x) => !x.hiddenAt);
  const agents = await api(`/api/companies/${COMPANY_ID}/agents`);
  const idToName = {};
  for (const a of agents) idToName[a.id] = a.name;

  // queueByName: name → { open, hasOpen }
  const OPEN = new Set(['todo', 'backlog', 'in_progress', 'in_review', 'blocked']);
  const queueByName = {};
  for (const a of agents) queueByName[a.name] = { open: 0, done: 0 };
  for (const i of items) {
    if (!i.assigneeAgentId) continue;
    const name = idToName[i.assigneeAgentId];
    if (!name) continue;
    queueByName[name] = queueByName[name] || { open: 0, done: 0 };
    if (OPEN.has(i.status)) queueByName[name].open++;
    if (i.status === 'done') queueByName[name].done++;
  }
  return { items, idToName, queueByName };
}

async function workedAgents({ windowMs, snapshot }) {
  const since = Date.now() - windowMs;
  const worked = new Set();
  for (const i of snapshot.items) {
    const t = new Date(i.updatedAt || i.lastActivityAt || 0).getTime();
    if (t >= since && i.assigneeAgentId) {
      worked.add(snapshot.idToName[i.assigneeAgentId] || i.assigneeAgentId);
    }
  }
  return worked;
}

async function main() {
  const { values } = parseArgs({
    options: {
      window: { type: 'string', default: '30' },
      threshold: { type: 'string', default: '0.3' },
    },
  });
  const windowMs = parseInt(values.window) * 60 * 1000;
  const threshold = parseFloat(values.threshold);

  const dispatched = parseDispatched({ windowMs });
  const snapshot = await loadAgentSnapshot();
  const worked = await workedAgents({ windowMs, snapshot });

  // 큐 비어 있는 dispatched 에이전트는 정상 idle (false-positive 제외)
  const dispatchedArr = [...dispatched];
  const withQueue = dispatchedArr.filter((n) => (snapshot.queueByName[n]?.open || 0) > 0);
  const emptyQueue = dispatchedArr.filter((n) => (snapshot.queueByName[n]?.open || 0) === 0);

  const X = dispatched.size;
  const Xq = withQueue.length; // 분모: 큐가 있는 dispatched만
  const Y = [...dispatched].filter((n) => worked.has(n)).length;
  const Yq = withQueue.filter((n) => worked.has(n)).length;
  const rawRatio = X === 0 ? null : Y / X;
  const realRatio = Xq === 0 ? null : Yq / Xq;

  log(`window=${values.window}min dispatched=${X} withQueue=${Xq} emptyQueue=${emptyQueue.length} worked=${Y} workedWithQueue=${Yq} rawRatio=${rawRatio === null ? 'n/a' : rawRatio.toFixed(2)} realRatio=${realRatio === null ? 'n/a' : realRatio.toFixed(2)} threshold=${threshold}`);

  if (X === 0) {
    log('no dispatched agents in window — nothing to evaluate');
    return;
  }
  if (Xq === 0) {
    log(`all ${X} dispatched agents have empty queue — normal idle, no alert`);
    return;
  }

  if (realRatio < threshold) {
    const alert = {
      at: new Date().toISOString(),
      window_min: parseInt(values.window),
      dispatched: dispatchedArr,
      with_queue: withQueue,
      empty_queue_normal_idle: emptyQueue,
      worked_of_with_queue: withQueue.filter((n) => worked.has(n)),
      idle_with_pending_queue: withQueue.filter((n) => !worked.has(n)),
      raw_ratio: rawRatio,
      real_ratio: realRatio,
      threshold,
      severity: realRatio < 0.1 ? 'high' : 'medium',
      reason: 'real_ratio = (worked AND has open queue) / (dispatched AND has open queue)',
    };
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(ALERT_LOG, JSON.stringify(alert) + '\n', 'utf-8');
    log(`ALERT: real effectiveness ${(realRatio * 100).toFixed(0)}% < threshold ${(threshold * 100).toFixed(0)}% (큐가 있는데 일 안 한 에이전트만 카운트)`);
    log(`  idle with pending queue: ${alert.idle_with_pending_queue.join(', ') || '(none)'}`);
    process.exit(10);
  } else {
    log(`OK: real effectiveness ${(realRatio * 100).toFixed(0)}% >= threshold ${(threshold * 100).toFixed(0)}%`);
  }
}

main().catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });
