#!/usr/bin/env node

/**
 * classify-scene-assets.js — 씬 자산을 슬롯에 배정해 라이브러리 명세를 만든다 (2026-09-22)
 *
 * 무과금·무네트워크다. 기존 에피소드 자산을 읽어 `<주제군>/<방향>` 슬롯으로 나누고
 * 보유량·다양성·클립 보유를 세어 workspace/assets/scene-library.json 에 쓴다.
 * 설계 근거는 docs/asset-library-prd.md.
 *
 * 자산은 **복사하지 않고 원위치를 참조한다.** 스틸 1.04GB · 클립 2.85GB 를 복제하면
 * 4GB 가 두 벌이 되고, 원본이 지워졌을 때 어느 쪽이 정본인지 모르게 된다.
 *
 * Usage:
 *   node scripts/automation/classify-scene-assets.js
 *   node scripts/automation/classify-scene-assets.js --json   # 요약만 JSON 으로
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, isCurrentEra, hasCaricature } from './lib/scene-asset-index.js';
import { isRealMotionClip } from './reuse-scene-assets.js';
import {
  assignSlot, buildThemeScorer, normalizeObject, saturationOf,
  allSlots, slotTarget, slotGrade,
} from './lib/scene-slot-taxonomy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const EPISODES = join(ROOT, 'workspace', 'episodes');
export const LIBRARY_PATH = join(ROOT, 'workspace', 'assets', 'scene-library.json');

/**
 * 라이브러리를 만든다. 순수 계산이라 테스트가 디스크 없이 돌 수 있도록
 * 인덱스를 주입받는다.
 */
export function buildLibrary(entries, { now = null, probeClip = isRealMotionClip } = {}) {
  const retired = [];
  const usable = [];
  for (const e of entries) {
    if (!isCurrentEra(e.prompt)) { retired.push({ ...e, reason: 'legacy_era' }); continue; }
    if (hasCaricature(e.prompt)) { retired.push({ ...e, reason: 'caricature' }); continue; }
    usable.push(e);
  }

  const scoreThemes = buildThemeScorer(usable.map((e) => e.text));
  const slots = {};
  for (const slot of allSlots()) {
    slots[slot] = {
      grade: slotGrade(slot), target: slotTarget(slot),
      count: 0, diversity: 0, real_motion: 0, assets: [],
    };
  }
  const unclassified = [];

  for (const e of usable) {
    const { slot, theme, direction, reason } = assignSlot(e, scoreThemes);
    const asset = {
      source_episode: e.episodeId,
      source_scene: e.sceneId,
      image: relative(ROOT, e.image),
      clip: e.video ? relative(ROOT, e.video) : null,
      real_motion: e.video ? !!probeClip(e.video) : false,
      object: normalizeObject(e.prompt),
      palette: e.palette,
      role: e.role,
      created_at: new Date(e.mtimeMs).toISOString(),
    };
    if (!slot) {
      unclassified.push({ ...asset, reason });
      continue;
    }
    // hook 역할은 주제 슬롯에도 들어가지만, 주제가 안 잡힌 hook 은 역할 슬롯이 받는다.
    slots[slot].assets.push({ ...asset, theme, direction });
  }

  for (const [, s] of Object.entries(slots)) {
    s.count = s.assets.length;
    s.diversity = new Set(s.assets.map((a) => a.object).filter(Boolean)).size;
    s.real_motion = s.assets.filter((a) => a.real_motion).length;
    s.gap = Math.max(0, s.target - s.count);
    // 한 객체가 슬롯을 쏠아 가지면 수량이 차 있어도 쿨다운에서 같은 그림이 돌아온다.
    // 여기에는 백필을 더 굽지 않고, 작가 쪽에서 다른 오브제를 쓰게 유도한다.
    const sat = saturationOf(s.assets.map((a) => a.object));
    s.saturated = sat.saturated;
    s.top_object = sat.top;
    s.top_share = Number(sat.share.toFixed(2));
    s.object_parse_ok = sat.known;
  }

  return {
    version: 1,
    built_at: now || new Date().toISOString(),
    totals: {
      indexed: entries.length,
      usable: usable.length,
      classified: usable.length - unclassified.length,
      unclassified: unclassified.length,
      retired: retired.length,
    },
    slots,
    unclassified,
    retired_summary: retired.reduce((acc, r) => {
      acc[r.reason] = (acc[r.reason] || 0) + 1;
      return acc;
    }, {}),
  };
}

function main() {
  const { values } = parseArgs({ options: { json: { type: 'boolean' } } });

  const entries = buildIndex(EPISODES, {});
  const lib = buildLibrary(entries);

  mkdirSync(dirname(LIBRARY_PATH), { recursive: true });
  writeFileSync(LIBRARY_PATH, `${JSON.stringify(lib, null, 2)}\n`);

  if (values.json) {
    console.log(JSON.stringify(lib.totals, null, 2));
    return;
  }

  const t = lib.totals;
  const unPct = Math.round((t.unclassified / Math.max(t.usable, 1)) * 100);
  console.log('🗂  씬 자산 슬롯 분류');
  console.log(`   인덱스 ${t.indexed} → 사용 가능 ${t.usable} (폐기 ${t.retired}: ${JSON.stringify(lib.retired_summary)})`);
  console.log(`   배정 ${t.classified} · 미분류 ${t.unclassified} (${unPct}%)`);

  const rows = Object.entries(lib.slots).sort((a, b) => {
    const g = 'ABCR'.indexOf(a[1].grade) - 'ABCR'.indexOf(b[1].grade);
    return g || b[1].gap - a[1].gap;
  });
  console.log('\n   슬롯                보유/목표  다양성  실모션  상태');
  for (const [slot, s] of rows) {
    const state = s.gap > 0 ? (s.count === 0 ? '🔴 비어있음' : `🔴 ${s.gap}컷 부족`)
      : s.saturated ? `🟡 포화 ${s.top_object} ${Math.round(s.top_share * 100)}%`
      : !s.object_parse_ok ? '⚪ 객체 미상' : '✅';
    console.log(`   ${slot.padEnd(20)} ${String(s.count).padStart(3)}/${String(s.target).padEnd(3)} ${String(s.diversity).padStart(5)} ${String(s.real_motion).padStart(6)}   ${state}`);
  }

  const gaps = rows.filter(([, s]) => s.gap > 0);
  const sat = rows.filter(([, s]) => s.saturated);
  console.log(`\n   부족 슬롯 ${gaps.length}/${rows.length} · 총 부족분 ${gaps.reduce((a, [, s]) => a + s.gap, 0)}컷 · 포화 ${sat.length}`);
  console.log(`   → ${relative(ROOT, LIBRARY_PATH)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
}
