#!/usr/bin/env node
/**
 * title-summary.js — 거부창 알림에 붙일 제목 요약 (2026-09-26)
 *
 * 거부창 알림은 "reject window 시작, 취소하려면 /reject" 뿐이었다. 운영자에게 30분 안에
 * 판단하라고 하면서 무엇을 판단할지(제목)를 보여 주지 않았다. 제목·유형과, 차선으로
 * 골랐거나 최근 제목과 수치가 겹칠 때의 경고를 한 번에 붙인다.
 *
 * 실패해도 아무것도 출력하지 않고 0 으로 끝난다 — 요약 하나 때문에 거부창이 안 열리면
 * 사람 게이트가 통째로 빠진다.
 *
 * Usage: node scripts/automation/title-summary.js --episode EP-2026-0183
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { summaryLines } from './lib/title-select.js';

const ROOT = resolve(import.meta.dirname, '../..');

export function findMeta(episodeId, root = ROOT) {
  const ep = join(root, 'workspace', 'episodes', episodeId);
  const plat = join(ep, 'platforms');
  const dirs = [...(existsSync(plat) ? readdirSync(plat).map((p) => join(plat, p)) : []), ep];
  for (const d of dirs) {
    const p = join(d, '70_publish_meta.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const i = process.argv.indexOf('--episode');
    const id = i > 0 ? process.argv[i + 1] : '';
    if (/^EP-\d{4}-\d{4}$/.test(id)) process.stdout.write(summaryLines(findMeta(id)).join('\n'));
  } catch { /* 요약은 선택 사항 — 거부창을 막지 않는다 */ }
}
