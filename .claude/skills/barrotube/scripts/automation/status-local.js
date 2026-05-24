#!/usr/bin/env node

/**
 * status-local.js — BarroSkills 로컬 상태 조회 (Paperclip 대체)
 *
 * 모든 EP의 .episode_status.json + 최근 audit log를 종합하여
 * 진행 중·완료·blocked·cancelled EP 분포를 보고한다.
 *
 * Usage:
 *   node status-local.js --all                            전체 EP 요약
 *   node status-local.js --episode EP-YYYY-NNNN           단일 EP 상세
 *   node status-local.js --status in_progress             특정 상태만 필터
 *   node status-local.js --since 7d                       최근 7일 변경된 것만
 *   node status-local.js --json                           JSON 출력
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const EPISODES_DIR = join(ROOT, 'workspace/episodes');
const AUDIT_DIR = join(ROOT, 'logs/audit');

const TERMINAL_STATUSES = new Set(['published', 'cancelled', 'done', 'archived']);
const ACTIVE_STATUSES = new Set(['in_progress', 'awaiting_approval', 'planning', 'in_review']);

function loadEpisodeStatus(epDir) {
  const statusFile = join(EPISODES_DIR, epDir, '.episode_status.json');
  if (!existsSync(statusFile)) return null;
  try {
    const data = JSON.parse(readFileSync(statusFile, 'utf-8'));
    const mtime = statSync(statusFile).mtime;
    return { ...data, _mtime: mtime, _dir: epDir };
  } catch (e) {
    return { episode_id: epDir, _error: e.message, _dir: epDir };
  }
}

function allEpisodes() {
  if (!existsSync(EPISODES_DIR)) return [];
  return readdirSync(EPISODES_DIR)
    .filter(d => d.startsWith('EP-'))
    .map(loadEpisodeStatus)
    .filter(Boolean);
}

function summarize(episodes, opts = {}) {
  const counts = {};
  for (const ep of episodes) {
    const s = ep.status || ep.current_stage || 'unknown';
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

function recentAudit(days = 1) {
  if (!existsSync(AUDIT_DIR)) return [];
  const cutoff = Date.now() - days * 86400 * 1000;
  const lines = [];
  const files = readdirSync(AUDIT_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse()
    .slice(0, 7);
  for (const f of files) {
    const path = join(AUDIT_DIR, f);
    try {
      const content = readFileSync(path, 'utf-8');
      for (const ln of content.split('\n')) {
        if (!ln.trim()) continue;
        try {
          const obj = JSON.parse(ln);
          const t = obj.at ? new Date(obj.at).getTime() : 0;
          if (t >= cutoff) lines.push(obj);
        } catch {}
      }
    } catch {}
  }
  return lines;
}

async function main() {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean', default: false },
      episode: { type: 'string' },
      status: { type: 'string' },
      since: { type: 'string', default: '7d' },
      json: { type: 'boolean', default: false },
    },
  });

  let episodes = allEpisodes();

  if (values.status) {
    episodes = episodes.filter(ep => (ep.status || ep.current_stage) === values.status);
  }

  if (values.since) {
    const days = parseInt(values.since.replace(/[^0-9]/g, ''));
    if (days > 0) {
      const cutoff = Date.now() - days * 86400 * 1000;
      episodes = episodes.filter(ep => ep._mtime && ep._mtime.getTime() >= cutoff);
    }
  }

  if (values.episode) {
    const ep = episodes.find(e => (e.episode_id || e._dir) === values.episode);
    if (!ep) {
      console.error(`❌ ${values.episode} not found`);
      process.exit(1);
    }
    if (values.json) {
      console.log(JSON.stringify(ep, null, 2));
    } else {
      console.log(`📺 ${ep.episode_id || ep._dir}`);
      console.log(`   channel: ${ep.channel_id || 'unknown'}`);
      console.log(`   created: ${(ep.created_at || '').slice(0, 19)}`);
      console.log(`   current_stage: ${ep.current_stage || '?'}`);
      console.log(`   status: ${ep.status || '?'}`);
      console.log(`   updated: ${ep._mtime ? ep._mtime.toISOString().slice(0, 19) : '?'}`);
      if (ep.stage_history && ep.stage_history.length) {
        console.log(`   stage_history (${ep.stage_history.length} entries):`);
        for (const sh of ep.stage_history.slice(-5)) {
          console.log(`     ${sh.stage} ${sh.status} @ ${(sh.timestamp || '').slice(0, 19)} by ${sh.actor || '?'}`);
        }
      }
    }
    return;
  }

  // --all 또는 기본
  if (values.json) {
    const result = {
      total: episodes.length,
      summary: summarize(episodes),
      episodes: episodes.map(ep => ({
        id: ep.episode_id || ep._dir,
        status: ep.status,
        current_stage: ep.current_stage,
        channel: ep.channel_id,
        updated: ep._mtime?.toISOString(),
      })),
      recent_audit: recentAudit(parseInt(values.since.replace(/[^0-9]/g, '')) || 1).slice(-10),
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`📊 BarroSkills Status — ${new Date().toISOString().slice(0, 19)} UTC`);
  console.log(`   Workspace: ${EPISODES_DIR}`);
  console.log();
  console.log(`Total EPs: ${episodes.length}`);
  const sm = summarize(episodes);
  for (const [k, v] of Object.entries(sm).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }

  const active = episodes.filter(ep => {
    const s = ep.status || ep.current_stage;
    return !TERMINAL_STATUSES.has(s);
  });

  if (active.length > 0) {
    console.log();
    console.log(`▸ Active (${active.length}):`);
    for (const ep of active.slice(0, 10)) {
      const id = ep.episode_id || ep._dir;
      const stage = ep.current_stage || '?';
      const status = ep.status || '?';
      const upd = ep._mtime ? ep._mtime.toISOString().slice(0, 10) : '?';
      console.log(`  ${id} | ${stage} ${status} (updated ${upd})`);
    }
  }

  const auditEntries = recentAudit(1);
  console.log();
  console.log(`▸ Audit (last 24h): ${auditEntries.length} entries`);
  if (auditEntries.length > 0) {
    const eventCounts = {};
    for (const a of auditEntries) {
      const e = a.event || '?';
      eventCounts[e] = (eventCounts[e] || 0) + 1;
    }
    for (const [k, v] of Object.entries(eventCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`  ${k}: ${v}`);
    }
  }

  // in-flight lock 확인
  const lockFile = join(ROOT, 'workspace/.in-flight.json');
  console.log();
  if (existsSync(lockFile)) {
    try {
      const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
      console.log(`▸ In-flight lock: ${lock.episode_id} (PID ${lock.pid})`);
    } catch {
      console.log(`▸ In-flight lock: present but unparseable`);
    }
  } else {
    console.log(`▸ In-flight lock: 🟢 clear`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
