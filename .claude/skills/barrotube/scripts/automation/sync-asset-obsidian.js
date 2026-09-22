#!/usr/bin/env node

/**
 * sync-asset-obsidian.js — 슬롯 라이브러리를 옵시디언 체크리스트로 렌더한다 (2026-09-22)
 *
 * 무과금·무네트워크. scene-library.json 을 읽어 볼트의 06-Assets/ 아래에 쓴다.
 *
 * **이 스크립트가 쓰는 파일은 전부 생성물이다.** 손으로 고치면 다음 렌더에서 사라진다.
 * 자유 메모는 notes.md 에 두고, 이 스크립트는 그 파일을 절대 건드리지 않는다 —
 * 생성 문서에 사람이 적은 내용이 조용히 없어지면 그 문서를 아무도 신뢰하지 않게 된다.
 *
 * 기존 볼트 동기화(_legacy_paperclip/lifecycle-bridge.js)는 2026-05-23 이후 멈춰 있고
 * 폐기 경로다. 여기에 의존하지 않고 자체적으로 쓴다.
 *
 * Usage:
 *   node scripts/automation/sync-asset-obsidian.js
 *   node scripts/automation/sync-asset-obsidian.js --dry-run
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const GENERATED = '<!-- 자동 생성 — 손으로 고치지 마세요. 메모는 notes.md 에. -->';
/** 렌더가 소유하는 파일. 이 목록 밖의 파일은 지우지도 덮지도 않는다. */
const OWNED = ['MOC-assets.md', 'coverage-checklist.md', 'gaps.md', 'retired.md'];

function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function loadConfig() {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'asset-reuse.json'), 'utf8'));
  const lib = cfg.library || {};
  return {
    manifest: join(ROOT, lib.manifest || 'workspace/assets/scene-library.json'),
    vault: expandHome(lib.obsidian_vault || ''),
    dir: lib.obsidian_dir || '06-Assets',
  };
}

const GRADE_LABEL = {
  A: 'A등급 — 핵심 (주제 비중 30%+)',
  B: 'B등급 — 상시 (8~13%)',
  C: 'C등급 — 간헐 (6% 이하)',
  R: 'R등급 — 역할',
};

function slotLine(slot, s) {
  const done = s.gap === 0;
  const box = done ? '[x]' : '[ ]';
  const bits = [`${s.count}/${s.target}`];
  if (s.gap > 0) bits.push(s.count === 0 ? '🔴 **비어 있음**' : `🔴 **${s.gap}컷 부족**`);
  else if (s.saturated) bits.push(`🟡 **포화** — \`${s.top_object}\` 가 ${Math.round(s.top_share * 100)}%`);
  else if (!s.object_parse_ok) bits.push('⚪ 객체 미상');
  else bits.push('✅');
  bits.push(`다양성 ${s.diversity}`);
  bits.push(`실모션 ${s.real_motion}`);
  return `- ${box} \`${slot}\` — ${bits.join(' · ')} · [[slot-${slot.replace('/', '-')}]]`;
}

export function renderChecklist(lib) {
  const slots = Object.entries(lib.slots);
  const gaps = slots.filter(([, s]) => s.gap > 0);
  const sat = slots.filter(([, s]) => s.saturated);
  const shortfall = gaps.reduce((a, [, s]) => a + s.gap, 0);
  const t = lib.totals;

  const out = [
    GENERATED,
    '---',
    'type: asset-coverage',
    `synced_at: ${lib.built_at}`,
    `usable_assets: ${t.usable}`,
    `classified: ${t.classified}`,
    `unclassified: ${t.unclassified}`,
    `covered_slots: ${slots.length - gaps.length}`,
    `total_slots: ${slots.length}`,
    `shortfall: ${shortfall}`,
    '---',
    '',
    '# 🗂 씬 자산 커버리지',
    '',
    `> 사용 가능 **${t.usable}컷** · 슬롯 충족 **${slots.length - gaps.length}/${slots.length}** · 부족 **${shortfall}컷** · 포화 **${sat.length}**`,
    `> 미분류 ${t.unclassified}컷 (${Math.round((t.unclassified / Math.max(t.usable, 1)) * 100)}%) · 폐기 ${t.retired}컷 → [[retired]]`,
    '',
    '부족한 슬롯만 보려면 [[gaps]].',
    '',
  ];

  for (const grade of ['A', 'B', 'C', 'R']) {
    const rows = slots.filter(([, s]) => s.grade === grade)
      .sort((a, b) => b[1].gap - a[1].gap || a[0].localeCompare(b[0]));
    if (rows.length === 0) continue;
    out.push(`## ${GRADE_LABEL[grade]}`, '');
    for (const [slot, s] of rows) out.push(slotLine(slot, s));
    out.push('');
  }

  if (t.unclassified > 0) {
    out.push('## 미분류', '',
      `- \`unclassified\` — ${t.unclassified}컷. 주제어가 안 걸렸거나 1·2위가 모호했다.`,
      '  주제 사전(`lib/scene-slot-taxonomy.js` 의 `THEME_TERMS`) 보강 후보다.', '');
  }
  return out.join('\n');
}

export function renderGaps(lib) {
  const gaps = Object.entries(lib.slots)
    .filter(([, s]) => s.gap > 0)
    .sort((a, b) => 'ABCR'.indexOf(a[1].grade) - 'ABCR'.indexOf(b[1].grade) || b[1].gap - a[1].gap);

  const out = [
    GENERATED, '---', 'type: asset-gaps', `synced_at: ${lib.built_at}`,
    `slots: ${gaps.length}`, `shortfall: ${gaps.reduce((a, [, s]) => a + s.gap, 0)}`, '---', '',
    '# 🔴 비어 있는 슬롯', '',
    '백필이 채울 대상이다. 같은 등급 안에서는 부족분이 큰 쪽, 같은 부족분이면 `up` 방향을 먼저 굽는다.', '',
    '| 슬롯 | 등급 | 보유 | 목표 | 부족 | 실모션 |', '|---|---|---|---|---|---|',
  ];
  for (const [slot, s] of gaps) {
    out.push(`| \`${slot}\` | ${s.grade} | ${s.count} | ${s.target} | **${s.gap}** | ${s.real_motion} |`);
  }
  const up = gaps.filter(([slot]) => slot.endsWith('/up'));
  out.push('', `상승 방향 슬롯이 ${up.length}/${gaps.length} 를 차지한다 — 채널이 하락 서사를 더 많이 써 온 결과다.`, '');
  return out.join('\n');
}

export function renderRetired(lib) {
  const r = lib.retired_summary || {};
  return [
    GENERATED, '---', 'type: asset-retired', `synced_at: ${lib.built_at}`, '---', '',
    '# 🗄 라이브러리에서 제외된 자산', '',
    '| 사유 | 컷 | 설명 |', '|---|---|---|',
    `| \`legacy_era\` | ${r.legacy_era || 0} | 현행 image_prompt 계약(640자 + 캐릭터시트) 미달. 구세대 평면 화풍이라 섞이면 한 영상 안에서 그림체가 갈린다. |`,
    `| \`caricature\` | ${r.caricature || 0} | 실존 인물 캐리커처 포함. 다른 인물을 말하는 대본에 붙으면 오귀속이다. |`,
    '',
    '판정 기준은 `lib/image-prompt-contract.js` 의 `BOUNDS` · `CARICATURE` 계약에 위임돼 있다.',
    '계약이 바뀌면 이 목록도 따라 움직인다.', '',
  ].join('\n');
}

export function renderMoc(lib) {
  const slots = Object.entries(lib.slots);
  const gaps = slots.filter(([, s]) => s.gap > 0);
  const t = lib.totals;
  return [
    GENERATED, '---', 'type: index', 'name: MOC-assets', `synced_at: ${lib.built_at}`, '---', '',
    '# 🗺 씬 자산 라이브러리', '',
    '이미지 생성 쿼터가 마른 날에도 에피소드를 내기 위한 자산 재고. 설계는 `docs/asset-library-prd.md`.', '',
    '## 지금 상태', '',
    `- 사용 가능 **${t.usable}컷** (인덱스 ${t.indexed} 중, 폐기 ${t.retired})`,
    `- 슬롯 충족 **${slots.length - gaps.length}/${slots.length}** · 부족 **${gaps.reduce((a, [, s]) => a + s.gap, 0)}컷**`,
    `- 미분류 ${t.unclassified}컷`, '',
    '## 문서', '',
    '- [[coverage-checklist]] — 슬롯별 충족 현황 (매일 보는 화면)',
    '- [[gaps]] — 비어 있는 슬롯만',
    '- [[retired]] — 제외된 자산과 사유',
    '- [[notes]] — 운영자 자유 메모 *(렌더가 건드리지 않는 유일한 파일)*', '',
    '## 규약', '',
    '이 폴더의 문서는 `notes.md` 를 빼고 전부 생성물이다. 손으로 고치면 다음 렌더에서 사라진다.',
    '운영자 의도(슬롯 보류·우선순위)는 `config/asset-reuse.json` 의 `backfill.slot_overrides` 에 적는다.', '',
  ].join('\n');
}

export function renderSlot(slot, s) {
  const out = [
    GENERATED, '---', 'type: asset-slot', `name: slot-${slot.replace('/', '-')}`,
    `slot: "${slot}"`, `grade: ${s.grade}`, `count: ${s.count}`, `target: ${s.target}`,
    `diversity: ${s.diversity}`, '---', '',
    `# \`${slot}\``, '',
    `등급 ${s.grade} · 보유 ${s.count}/${s.target} · 다양성 ${s.diversity} · 실제 모션 클립 ${s.real_motion}`, '',
  ];
  if (s.gap > 0) out.push(`> 🔴 ${s.count === 0 ? '비어 있다' : `${s.gap}컷 부족하다`}.`, '');
  else if (s.saturated) out.push(`> 🟡 포화 — \`${s.top_object}\` 가 ${Math.round(s.top_share * 100)}% 를 차지한다. 백필 대상이 아니다.`, '');

  if (s.assets.length) {
    out.push('| 원본 | 씬 | 객체 | 팔레트 | 클립 |', '|---|---|---|---|---|');
    for (const a of s.assets.slice(0, 40)) {
      out.push(`| ${a.source_episode} | ${a.source_scene} | ${a.object || '—'} | ${a.palette} | ${a.real_motion ? '실모션' : a.clip ? 'HyperFrames' : '—'} |`);
    }
    if (s.assets.length > 40) out.push(`| … | | 외 ${s.assets.length - 40}컷 | | |`);
    out.push('');
  }
  return out.join('\n');
}

function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' } } });
  const cfg = loadConfig();

  if (!existsSync(cfg.manifest)) {
    throw new Error(`라이브러리 명세가 없습니다: ${cfg.manifest}\n   먼저 classify-scene-assets.js 를 실행하세요.`);
  }
  if (!cfg.vault || !existsSync(cfg.vault)) {
    throw new Error(`옵시디언 볼트를 찾지 못했습니다: ${cfg.vault || '(미설정)'}\n   config/asset-reuse.json 의 library.obsidian_vault 를 확인하세요.`);
  }

  const lib = JSON.parse(readFileSync(cfg.manifest, 'utf8'));
  const base = join(cfg.vault, cfg.dir);
  const slotsDir = join(base, 'slots');

  const files = [
    ['MOC-assets.md', renderMoc(lib)],
    ['coverage-checklist.md', renderChecklist(lib)],
    ['gaps.md', renderGaps(lib)],
    ['retired.md', renderRetired(lib)],
  ];
  for (const [slot, s] of Object.entries(lib.slots)) {
    files.push([join('slots', `slot-${slot.replace('/', '-')}.md`), renderSlot(slot, s)]);
  }

  if (values['dry-run']) {
    console.log(`[DRY_RUN] ${base} 에 ${files.length}개 파일`);
    for (const [name] of files.slice(0, 6)) console.log(`   ${name}`);
    console.log(`   … 외 ${files.length - 6}개`);
    return;
  }

  mkdirSync(slotsDir, { recursive: true });
  // 슬롯 파일은 슬롯이 사라지면 같이 지워야 한다. 렌더가 소유한 prefix 만 지운다.
  for (const f of readdirSync(slotsDir)) {
    if (f.startsWith('slot-') && f.endsWith('.md')) rmSync(join(slotsDir, f));
  }
  for (const [name, body] of files) writeFileSync(join(base, name), `${body}\n`);

  // notes.md 는 운영자 소유다. 없으면 한 번 만들어 주되 있으면 절대 건드리지 않는다.
  const notes = join(base, 'notes.md');
  if (!existsSync(notes)) {
    writeFileSync(notes, '# 운영자 메모\n\n이 파일은 자동 렌더가 건드리지 않는다. 자유롭게 적어도 된다.\n');
  }

  console.log(`🗂  옵시디언 동기화 — ${files.length}개 파일`);
  console.log(`   ${base}`);
  console.log(`   충족 ${Object.values(lib.slots).filter((s) => s.gap === 0).length}/${Object.keys(lib.slots).length} · 부족 ${Object.values(lib.slots).reduce((a, s) => a + s.gap, 0)}컷`);
  console.log(`   notes.md 는 건드리지 않았습니다 (운영자 소유)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
}
