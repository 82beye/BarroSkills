#!/usr/bin/env node
/**
 * ensure-caricature.js — 공인 인물 캐리커처 보강 CLI (lib/ensure-caricature.js)
 *
 * 대본이 CHARACTERIZE 인물을 불렀는데 캐리커처 씬이 없으면 이미지를 굽기 전에 채운다.
 * auto-pipeline 이 팩트체크(Phase 6) 뒤·브라우저(Phase 7) 전에 부른다.
 *
 * Usage:
 *   node scripts/automation/ensure-caricature.js --episode <dir> [--platform shorts] [--dry-run]
 *   종료코드: 0 = 정합(또는 보강 완료) · 1 = 보강 뒤에도 정책에 걸림 · 2 = 입력 오류
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ensureCaricature } from './lib/ensure-caricature.js';

const { values } = parseArgs({ options: {
  episode: { type: 'string' },
  platform: { type: 'string', default: 'shorts' },
  'dry-run': { type: 'boolean', default: false },
} });
if (!values.episode) {
  console.error('Usage: ensure-caricature.js --episode <dir> [--platform shorts] [--dry-run]');
  process.exit(2);
}

const r = ensureCaricature({ epDir: resolve(values.episode), platform: values.platform, write: !values['dry-run'] });
if (!r.needed) {
  console.log('🎭 공인 인물 캐리커처 정합 — 보강 불필요');
  process.exit(0);
}
for (const c of r.changes) {
  console.log(`🎭 씬 ${c.sceneId}: ${c.figureId} 캐리커처 절 추가${values['dry-run'] ? ' (dry-run)' : ''} — 정책 §2 CHARACTERIZE`);
}
if (!r.resolved) {
  console.error('⚠ 보강 뒤에도 정책 §6.2.1(캐리커처 씬 0개)에 걸린다 — QA 가 막을 것이다');
  process.exit(1);
}
