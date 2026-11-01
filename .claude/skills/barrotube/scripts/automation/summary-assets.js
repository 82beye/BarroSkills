#!/usr/bin/env node

/**
 * summary-assets.js — 「미국 증시 요약」 마시 컷을 자산 라이브러리에서 **먼저** 채운다.
 *
 * 쇼츠 경로에서 재사용(reuse-scene-assets.js)은 생성이 전부 막혔을 때만 도는 마지막 폴백이다.
 * 요약 포맷은 반대로 간다(운영자 지시 2026-10-01): 채널에 쌓인 마시 컷을 먼저 쓰고,
 * 맞는 컷이 없는 씬만 Phase 7 이 대본의 범용 프롬프트로 굽는다. 구운 컷은 다음 분류
 * (classify-scene-assets.js)에서 라이브러리에 들어가 다음 회차가 다시 쓴다.
 *
 * 「맞는 컷」의 기준은 재사용기의 판정 그대로다 — 시각 매칭이 약하거나(weak) 신선도를 풀어
 * 채운 완주용 배정(filled_generic)은 쓰지 않고 비워 둔다. 쿨다운·원본당 상한·화풍 세대·
 * 캐리커처·팔레트 모순 가드도 재사용기가 그대로 건다.
 *
 * 씬 1(지수 요약 카드)은 render-summary-cards.js 가 먼저 구워 두므로 여기서 건너뛴다.
 *
 * Usage: node summary-assets.js --script <30_script.md> [--dry-run]
 * 종료코드 0 — 비는 씬이 있어도 실패가 아니다(Phase 7 이 채운다).
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { parse as parseYAML } from 'yaml';

import { reuseSceneAssets } from './reuse-scene-assets.js';

/** 재사용 판정 → 쓸 씬 / 비울 씬. */
export function splitPicks(picks) {
  const keep = picks.filter((p) => !p.weak && !p.filled_generic).map((p) => p.sceneId);
  const gaps = picks.filter((p) => p.weak || p.filled_generic).map((p) => p.sceneId);
  return { keep, gaps };
}

async function main() {
  const { values } = parseArgs({ options: { script: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  if (!values.script) { console.error('Usage: summary-assets.js --script <30_script.md> [--dry-run]'); process.exit(1); }
  const fm = parseYAML(readFileSync(values.script, 'utf-8').match(/^---\n([\s\S]*?)\n---/)[1]);
  const mascot = fm.scenes.filter((s) => !s.card).map((s) => s.scene_id);

  console.log(`♻︎  요약 마시 컷 — 라이브러리 먼저 (${mascot.length}컷 대상)`);
  const plan = await reuseSceneAssets({ scriptPath: values.script, only: mascot.join(','), dryRun: true, mode: 'primary' });
  const { keep, gaps } = splitPicks(plan.picks);
  const missing = [...gaps, ...plan.unmatched];
  if (keep.length && !values['dry-run']) {
    await reuseSceneAssets({ scriptPath: values.script, only: keep.join(','), mode: 'primary' });
  }
  console.log(`✅ 라이브러리 ${keep.length}컷${values['dry-run'] ? ' (dry-run)' : ''} · 새로 구울 씬 ${missing.length}개${missing.length ? ` (${missing.join(', ')}) — 범용 프롬프트로 Phase 7 이 굽는다` : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
