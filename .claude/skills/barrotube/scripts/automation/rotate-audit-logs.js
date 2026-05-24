#!/usr/bin/env node

/**
 * rotate-audit-logs.js — Audit log 불변성 강제 + 90일 보존 정책
 *
 * Critical Rule #6 (CLAUDE.md:69): 감사 로그 90일 보존, 불변(immutable)
 *
 * 동작:
 *   1) logs/audit/YYYY-MM-DD.jsonl 중 오늘 날짜를 제외한 모든 파일 → chmod 0444
 *      (append 방지. 오늘 파일은 진행 중이므로 건드리지 않음)
 *   2) 90일 초과 파일 → 삭제
 *
 * Usage:
 *   node scripts/automation/rotate-audit-logs.js
 *   node scripts/automation/rotate-audit-logs.js --dry-run
 *   node scripts/automation/rotate-audit-logs.js --retention-days 180
 *
 * Cron/launchd 등록 권장 (매일 00:05 KST).
 */

import { readdirSync, statSync, chmodSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const AUDIT_DIR = join(ROOT, 'logs/audit');
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(aISO, bISO) {
  const a = Date.parse(aISO + 'T00:00:00Z');
  const b = Date.parse(bISO + 'T00:00:00Z');
  return Math.round((a - b) / 86400000);
}

function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'retention-days': { type: 'string', default: '90' },
    },
  });

  const dryRun = values['dry-run'];
  const retentionDays = parseInt(values['retention-days'], 10);
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    console.error(`❌ --retention-days must be a positive integer`);
    process.exit(1);
  }

  const today = todayISO();
  let files;
  try {
    files = readdirSync(AUDIT_DIR).filter(f => FILE_RE.test(f)).sort();
  } catch (e) {
    if (e.code === 'ENOENT') { console.log(`⏭  ${AUDIT_DIR} 없음 (skip)`); return; }
    throw e;
  }

  const summary = { frozen: [], kept: [], deleted: [], errors: [] };

  for (const f of files) {
    const m = FILE_RE.exec(f);
    const date = m[1];
    const full = join(AUDIT_DIR, f);
    const age = daysBetween(today, date);

    if (age > retentionDays) {
      if (dryRun) {
        summary.deleted.push({ file: f, age });
      } else {
        try {
          chmodSync(full, 0o644);
          unlinkSync(full);
          summary.deleted.push({ file: f, age });
        } catch (e) {
          summary.errors.push({ file: f, op: 'delete', error: e.message });
        }
      }
      continue;
    }

    if (date < today) {
      const mode = statSync(full).mode & 0o777;
      if (mode === 0o444) {
        summary.kept.push({ file: f, already_frozen: true });
      } else {
        if (dryRun) {
          summary.frozen.push({ file: f, from_mode: mode.toString(8) });
        } else {
          try {
            chmodSync(full, 0o444);
            summary.frozen.push({ file: f, from_mode: mode.toString(8), to_mode: '444' });
          } catch (e) {
            summary.errors.push({ file: f, op: 'chmod', error: e.message });
          }
        }
      }
    } else {
      summary.kept.push({ file: f, reason: 'active_today' });
    }
  }

  console.log(JSON.stringify({
    dry_run: dryRun,
    today,
    retention_days: retentionDays,
    ...summary,
  }, null, 2));

  if (summary.errors.length > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
