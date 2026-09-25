#!/usr/bin/env node

/**
 * backfill-library.js — 빈 슬롯을 채울 컷을 굽는다 (PRD Phase 3, 2026-09-25)
 *
 * 이 스크립트의 가장 중요한 성질은 "굽는다"가 아니라 **"안 굽는다"** 다.
 * 백필이 에피소드 쿼터를 먹으면 본말이 전도된다 — 라이브러리를 채우려다 그날 회차가
 * 죽는다. PRD §5.3 의 5개 규칙이 전부 그 방지 장치이고 아래 GUARDS 가 그 구현이다.
 *
 * 굽고 끝내지 않는다. 구운 컷은 픽셀 QA(lib/image-quality.js)를 통과해야 라이브러리에
 * 들어간다. 통과 못 한 컷은 버린다 — 불량을 쌓아 두면 나중에 재사용 폴백이 그걸
 * 집어서 회차에 싣는다(2026-09-25 실측: EP-2026-0178 이 그렇게 2:3 규격 이탈 컷을
 * 받았다).
 *
 * Usage:
 *   node scripts/automation/backfill-library.js --dry-run     # 작업 지시서만 (무과금)
 *   node scripts/automation/backfill-library.js               # 가드 통과 시 생성
 *   node scripts/automation/backfill-library.js --force       # 가드 무시 (운영자 수동)
 *   node scripts/automation/backfill-library.js --limit 2     # 일일 상한 덮어쓰기
 *   node scripts/automation/backfill-library.js --slot metals/up
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYAML, parse as parseYAML } from 'yaml';

import { synthesizeScene, pickObjects, parseSlot } from './lib/backfill-prompt.js';
import { slotGrade, slotTarget } from './lib/scene-slot-taxonomy.js';
import { generateImageCodex } from './lib/image-engines/codex-imagegen.js';
import { checkImage, contactSheet, dHash, FAIL, WARN } from './lib/image-quality.js';
import { buildIndex, isCurrentEra, hasCaricature } from './lib/scene-asset-index.js';
import { LIBRARY_ROOT } from './reuse-scene-assets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'asset-reuse.json');
const MANIFEST = join(ROOT, 'workspace', 'assets', 'scene-library.json');
const EPISODES = join(ROOT, 'workspace', 'episodes');
const GRADE_ORDER = ['A', 'B', 'C', 'R'];

/** 한도 신호. 이걸 만나면 그 자리에서 멈춘다 (PRD §5.3 규칙 5). */
const QUOTA_SIGNAL = /usage limit|rate.?limit|insufficient_quota|quota|credit_balance|\b402\b|too many requests/i;

/** 원장은 {version, entries} 로도 배열로도 저장돼 왔다. 둘 다 받는다. */
const asLedgerEntries = (l) => (Array.isArray(l) ? l : (l && l.entries) || []);
const loadJSON = (p, fb = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * 오늘 도는 슬롯들을 routines.json 의 cron 에서 읽는다.
 * cron 표기는 `HH:MM` 또는 `Mon-Thu,Sat,Sun HH:MM` 두 가지다.
 */
export function slotsForDay(routines, date) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow = DAYS[date.getDay()];
  const out = [];
  for (const [name, cfg] of Object.entries(routines.slots || {})) {
    const m = String(cfg.cron || '').trim().match(/^(?:(\S+)\s+)?(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const [, daysSpec, hh, mm] = m;
    if (daysSpec && !matchesDay(daysSpec, dow, DAYS)) continue;
    out.push({ name, hour: Number(hh), minute: Number(mm) });
  }
  return out.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
}

function matchesDay(spec, dow, DAYS) {
  for (const part of spec.split(',')) {
    const range = part.split('-');
    if (range.length === 1) {
      if (range[0] === dow) return true;
    } else {
      const [a, b] = range.map((d) => DAYS.indexOf(d));
      const i = DAYS.indexOf(dow);
      if (a >= 0 && b >= 0 && i >= a && i <= b) return true;
    }
  }
  return false;
}

/**
 * PRD §5.3 의 5개 규칙 가운데 "언제 도는가"에 해당하는 것들을 판정한다.
 * 규칙 3(상한)·5(즉시 중단)은 생성 루프 안에 있다.
 */
export function evaluateGuards({ now, routines, ledger, inFlight, pendingRender, bakedToday, cap }) {
  const blocks = [];
  const slots = slotsForDay(routines, now);
  const last = slots[slots.length - 1];

  // 규칙 1 — 후순위 실행.
  if (inFlight.length) {
    blocks.push({ rule: 1, code: 'PIPELINE_IN_FLIGHT',
      message: `파이프라인이 돌고 있습니다 (${inFlight.join(', ')}). 그 회차가 쓸 쿼터를 먼저 남깁니다.` });
  }
  if (last) {
    const lastMs = new Date(now).setHours(last.hour, last.minute, 0, 0);
    if (now.getTime() < lastMs) {
      blocks.push({ rule: 1, code: 'SLOTS_REMAINING',
        message: `오늘 마지막 슬롯 ${last.name} (${String(last.hour).padStart(2, '0')}:${String(last.minute).padStart(2, '0')}) 이 아직입니다. 그 뒤에 돕니다.` });
    }
  }
  /**
   * 규칙 1의 확장. 렌더가 안 끝난 회차가 남아 있으면 그 컷이 아직 쿼터를 기다리는
   * 중이다. PRD 는 시각만 말하지만 halt 된 회차가 쌓이는 현실에서는 시각만으로
   * 부족하다 — 재개되면 곧바로 이미지를 요구한다.
   */
  if (pendingRender.length) {
    blocks.push({ rule: 1, code: 'EPISODES_PENDING_RENDER',
      message: `이미지가 덜 채워진 회차가 있습니다 (${pendingRender.join(', ')}). 재개되면 쿼터를 먼저 씁니다.` });
  }

  // 규칙 2 — 폴백 무발생. 폴백이 걸린 날은 이미 쿼터가 마른 날이다.
  const day = today();
  const usedToday = ledger.filter((r) => String(r.used_at || '').slice(0, 10) === day);
  if (usedToday.length) {
    blocks.push({ rule: 2, code: 'REUSE_FALLBACK_TODAY',
      message: `오늘 재사용 폴백이 ${usedToday.length}컷 돌았습니다. 쿼터가 마른 날로 봅니다.` });
  }

  // 규칙 3 — 일일 상한.
  const remaining = Math.max(0, cap - bakedToday);
  if (remaining === 0) {
    blocks.push({ rule: 3, code: 'DAILY_CAP_REACHED',
      message: `오늘 이미 ${bakedToday}컷 구웠습니다 (상한 ${cap}).` });
  }

  return { blocks, remaining, slots };
}

/** 규칙 4 — A→B→C→R, 같은 등급 안에서는 부족분 큰 쪽, 같으면 up 먼저. */
export function orderShortfall(manifest, { overrides = {} } = {}) {
  const rows = [];
  for (const [slot, s] of Object.entries(manifest.slots || {})) {
    const short = (s.target ?? slotTarget(slot)) - s.count;
    if (short <= 0) continue;
    if (overrides[slot]?.hold) continue;
    rows.push({
      slot, short, grade: slotGrade(slot), count: s.count,
      target: s.target ?? slotTarget(slot),
      direction: slot.split('/')[1],
      used: (s.assets || []).map((a) => a.object).filter(Boolean),
    });
  }
  return rows.sort((a, b) =>
    GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade)
    || b.short - a.short
    || (a.direction === 'up' ? -1 : b.direction === 'up' ? 1 : 0)
    || a.slot.localeCompare(b.slot));
}

/** 상한까지 컷 단위로 펼친다. 한 슬롯이 여러 컷 부족하면 그만큼 연속으로 잡는다. */
export function buildWorkOrder(rows, { limit, avoid = [] }) {
  const order = [];
  /**
   * 이번 지시서에서 이미 쓴 객체. 주제별로 누적한다 — metals/up 과 metals/neutral 이
   * 둘 다 ingot 을 받으면 팔레트만 다른 같은 그림이 두 장 나온다. 슬롯은 다르지만
   * 그림은 겹치므로 다양성 지표가 오르지 않는다.
   */
  const takenByTheme = new Map();
  for (const row of rows) {
    if (order.length >= limit) break;
    const need = Math.min(row.short, limit - order.length);
    const { theme } = parseSlot(row.slot);
    const taken = takenByTheme.get(theme) || [];
    const objects = pickObjects(row.slot, { used: row.used, avoid: [...avoid, ...taken], count: need });
    takenByTheme.set(theme, [...taken, ...objects.map((o) => o.noun)]);
    for (const o of objects) {
      order.push({ ...synthesizeScene(row.slot, o), grade: row.grade, shortfall: row.short, have: row.count, target: row.target });
    }
  }
  return order;
}

function runningPipelines() {
  try {
    const out = execSync("ps ax -o command= | grep -E 'auto-pipeline\\.sh|produce-episode\\.js' | grep -v grep", { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const slot = l.match(/--slot\s+(\S+)/);
      const ep = l.match(/(EP-\d{4}-\d{4})/);
      return slot ? `slot:${slot[1]}` : ep ? ep[1] : 'pipeline';
    });
  } catch {
    return [];
  }
}

/**
 * 대본은 있는데 씬 이미지가 덜 찬 회차. 렌더 대기열이다.
 *
 * **최근 것만 센다.** 초기 회차 30여 편은 대본만 남고 버려졌는데(EP-2026-0002 ~ 0163),
 * 그걸 전부 '대기열'로 보면 가드가 영구히 켜져 백필이 한 번도 못 돈다. 재개될 수 있는
 * 회차는 실질적으로 최근 것뿐이라 창(기본 7일)을 둔다.
 */
function episodesPendingRender(windowDays = 7) {
  const out = [];
  if (!existsSync(EPISODES)) return out;
  const cutoff = Date.now() - windowDays * 86400000;
  for (const ep of readdirSync(EPISODES)) {
    if (!/^EP-/.test(ep)) continue;
    const dirs = [join(EPISODES, ep)];
    const plat = join(EPISODES, ep, 'platforms');
    if (existsSync(plat)) for (const p of readdirSync(plat)) dirs.push(join(plat, p));
    for (const base of dirs) {
      const script = join(base, '30_script.md');
      if (!existsSync(script)) continue;
      if (statSync(script).mtimeMs < cutoff) continue;
      const raw = readFileSync(script, 'utf8');
      const ids = [...raw.matchAll(/^\s*-?\s*scene_id:\s*"?(\d+)"?/gm)].map((m) => m[1].padStart(3, '0'));
      if (!ids.length) continue;
      const imgs = join(base, '40_assets', 'images');
      const missing = ids.filter((id) => !existsSync(join(imgs, `scene_${id}.png`)));
      if (missing.length) { out.push(`${ep}(${missing.length}컷)`); break; }
    }
  }
  return out;
}

/** 배치 안에서 다음에 쓸 씬 번호. 대본과 디스크 양쪽의 최대값을 본다. */
export function nextSceneSeq(existingScenes, imgDir) {
  let max = 0;
  for (const s of existingScenes) {
    const n = Number(String(s.scene_id).replace(/\D/g, ''));
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  // 대본에서 지웠는데 파일이 남아 있을 수 있다. 디스크도 본다 — 덮어쓰기보다 구멍이 낫다.
  if (imgDir && existsSync(imgDir)) {
    for (const f of readdirSync(imgDir)) {
      const m = f.match(/^scene_(\d{3})\.png$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max;
}

function countBakedToday() {
  const dir = join(LIBRARY_ROOT, today(), '40_assets', 'images');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => /^scene_\d{3}\.png$/.test(f)).length;
}

function printOrder(order, { remaining, cap }) {
  console.log(`\n   📋 작업 지시서 — ${order.length}컷 (오늘 남은 상한 ${remaining}/${cap})\n`);
  console.log('   #  슬롯                 등급 보유/목표 객체        길이');
  order.forEach((o, i) => {
    console.log(`   ${String(i + 1).padStart(2)}  ${o.slot.padEnd(20)} ${o.grade}    ${String(o.have + '/' + o.target).padEnd(8)} ${o.object.padEnd(12)} ${o.length}자${o.withinBounds ? '' : ' ⚠ 계약 이탈'}`);
  });
}

/** 배치 대본을 읽어 온다. 같은 날 두 번 돌면 이어 붙인다 — 덮어쓰면 오전에 구운 컷이 사라진다. */
function readBatchScript(batchDir) {
  const p = join(batchDir, '30_script.md');
  if (!existsSync(p)) return { scenes: [] };
  const fm = readFileSync(p, 'utf8').match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { scenes: [] };
  try {
    return parseYAML(fm[1]) || { scenes: [] };
  } catch {
    return { scenes: [] };
  }
}

function writeBatchScript(batchDir, batch, scenes) {
  const meta = {
    episode_id: `LIB-${batch}`,
    channel_id: 'barro-economy',
    format: 'library',
    generated_by: 'backfill-library.js',
    note: '백필 라이브러리 배치. 발행되지 않는다 — 재사용 폴백이 고를 수 있게 대본 형태로 둔 것뿐이다.',
    scenes,
  };
  writeFileSync(join(batchDir, '30_script.md'),
    `---\n${stringifyYAML(meta)}---\n\n# 백필 라이브러리 ${batch}\n\n발행 대상이 아닙니다.\n`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      limit: { type: 'string' },
      slot: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });

  const cfg = loadJSON(CONFIG_PATH, {});
  const bf = cfg.backfill || {};
  const manifest = loadJSON(MANIFEST);
  if (!manifest) {
    console.error('❌ workspace/assets/scene-library.json 이 없습니다. 먼저 classify-scene-assets.js 를 돌리세요.');
    process.exit(2);
  }

  const cap = Number(values.limit || bf.daily_cap || 5);
  const bakedToday = countBakedToday();
  const now = new Date();

  console.log(`\n🎨 라이브러리 백필 — ${today()}`);
  if (bf.enabled === false && !values.force && !values['dry-run']) {
    console.log('   ⏸  config/asset-reuse.json 의 backfill.enabled=false — 멈춥니다 (--force 로 넘길 수 있습니다).');
    process.exit(0);
  }

  const guards = evaluateGuards({
    now,
    routines: loadJSON(join(ROOT, 'config', 'routines.json'), { slots: {} }),
    ledger: asLedgerEntries(loadJSON(join(ROOT, cfg.ledger || 'workspace/assets/scene-reuse-ledger.json'), [])),
    inFlight: runningPipelines(),
    pendingRender: episodesPendingRender(Number(bf.pending_render_window_days ?? 7)),
    bakedToday,
    cap,
  });

  let rows = orderShortfall(manifest, { overrides: bf.slot_overrides || {} });
  if (values.slot) rows = rows.filter((r) => r.slot === values.slot);
  if (!rows.length) {
    console.log('   ✅ 부족한 슬롯이 없습니다.');
    process.exit(0);
  }

  const totalShort = rows.reduce((a, r) => a + r.short, 0);
  console.log(`   부족 ${rows.length}슬롯 · ${totalShort}컷 · 상한 ${cap}/일 (오늘 ${bakedToday}컷 구움)`);

  // 이미 채널 전체에서 쏠린 객체는 피한다.
  const avoid = [];
  for (const s of Object.values(manifest.slots || {})) {
    const f = {};
    for (const a of s.assets || []) if (a.object) f[a.object] = (f[a.object] || 0) + 1;
    for (const [o, n] of Object.entries(f)) if (n >= 5) avoid.push(o);
  }

  const limit = Math.max(1, guards.remaining || cap);
  const order = buildWorkOrder(rows, { limit: values['dry-run'] ? Math.min(totalShort, 50) : limit, avoid });
  printOrder(order, { remaining: guards.remaining, cap });

  if (guards.blocks.length) {
    console.log('\n   🚧 가드 — 지금은 굽지 않습니다 (PRD §5.3)');
    for (const b of guards.blocks) console.log(`      규칙 ${b.rule} · ${b.code} — ${b.message}`);
  }

  if (values.json) {
    console.log(JSON.stringify({ order, guards: guards.blocks, remaining: guards.remaining, cap }, null, 2));
  }

  if (values['dry-run']) {
    console.log('\n   (--dry-run — 아무것도 굽지 않았습니다)\n');
    return;
  }
  if (guards.blocks.length && !values.force) {
    console.log('\n   멈춥니다. 강행하려면 --force.\n');
    process.exit(0);
  }

  // ── 생성 ───────────────────────────────────────────────────────────────
  const batch = today();
  const batchDir = join(LIBRARY_ROOT, batch);
  const imgDir = join(batchDir, '40_assets', 'images');
  mkdirSync(imgDir, { recursive: true });

  // 근접중복 비교용 코퍼스. 새로 구운 컷이 기존 그림의 복제면 구운 의미가 없다.
  const corpus = [];
  for (const e of buildIndex(EPISODES, {}).filter((x) => isCurrentEra(x.prompt) && !hasCaricature(x.prompt))) {
    try { corpus.push({ hash: await dHash(e.image), label: `${e.episodeId}/${e.sceneId}` }); } catch { /* 읽을 수 없는 컷은 건너뛴다 */ }
  }

  const existing = readBatchScript(batchDir).scenes || [];
  /**
   * 다음 씬 번호는 **개수가 아니라 최대 번호 다음**이다.
   *
   * 2026-09-25 실측 버그: 육안 검수에서 불량 4컷을 빼고 다시 구웠더니 남은 씬이 10개가
   * 되어 seq 가 10 에서 시작했고, 이미 있던 scene_011.png 를 덮어쓰기 직전이었다.
   * 번호에 구멍이 나는 것은 정상이고(삭제는 정상 운영이다) 재사용은 파일명을 키로
   * 쓰므로 연속일 필요가 없다. 덮어쓰면 대본의 슬롯 표기와 그림이 어긋난다.
   */
  let seq = nextSceneSeq(existing, imgDir);
  const accepted = [];
  const rejected = [];

  for (const item of order.slice(0, limit)) {
    seq += 1;
    const sceneId = String(seq).padStart(3, '0');
    const outPath = join(imgDir, `scene_${sceneId}.png`);
    process.stdout.write(`   [${sceneId}] ${item.slot} · ${item.object} … `);

    try {
      generateImageCodex({ prompt: item.prompt, outPath, channel: 'barro-economy' });
    } catch (err) {
      const msg = String(err.message || err);
      if (QUOTA_SIGNAL.test(msg)) {
        // 규칙 5 — 한도 신호는 재시도하지 않는다. 오늘은 여기까지다.
        console.log('⛔ 한도');
        console.log(`\n   한도 신호를 만나 중단합니다 — 내일 이어서 합니다.\n   ${msg.slice(0, 200)}\n`);
        break;
      }
      console.log(`✗ ${msg.slice(0, 80)}`);
      rejected.push({ ...item, sceneId, reason: msg.slice(0, 200) });
      continue;
    }

    const qa = await checkImage(outPath, corpus);
    if (qa.verdict === FAIL) {
      console.log(`✗ QA ${qa.issues.map((i) => i.code).join(',')}`);
      unlinkSync(outPath);
      rejected.push({ ...item, sceneId, reason: qa.issues.map((i) => i.message).join(' / ') });
      seq -= 1;
      continue;
    }

    console.log(`✓ ${qa.width}x${qa.height} ${qa.verdict}${qa.verdict === WARN ? ' — ' + qa.issues.map((i) => i.code).join(',') : ''}`);
    writeFileSync(join(imgDir, `scene_${sceneId}.prompt.txt`), `${item.prompt}\n`);
    corpus.push({ hash: qa.hash, label: `LIB-${batch}/${sceneId}` });
    accepted.push({
      scene_id: sceneId,
      role: 'explain',
      slot: item.slot,
      narration: item.narration,
      subtitle_text: '',
      image_prompt: item.prompt,
      qa: qa.verdict,
      qa_visual: 'pending',
      baked_at: new Date().toISOString(),
    });
  }

  if (accepted.length) {
    writeBatchScript(batchDir, batch, [...existing, ...accepted]);
    const sheetPaths = accepted.map((s) => join(imgDir, `scene_${s.scene_id}.png`));
    const sheet = join(batchDir, '60_qa_frames.png');
    await contactSheet(sheetPaths, sheet, { cols: Math.min(4, sheetPaths.length) });
    console.log(`\n   ✅ ${accepted.length}컷 채택 · ${rejected.length}컷 버림`);
    console.log(`   콘택트시트: ${relative(ROOT, sheet)} — 캐릭터 규격은 눈으로 봐야 합니다`);
    try {
      execSync(`node ${join(__dirname, 'classify-scene-assets.js')}`, { cwd: ROOT, stdio: 'inherit' });
    } catch { console.warn('   ⚠ 재분류 실패 — 수동으로 classify-scene-assets.js 를 돌리세요.'); }
  } else {
    console.log(`\n   채택 0컷 · 버림 ${rejected.length}컷`);
  }
  for (const r of rejected) console.log(`      ✗ ${r.slot}/${r.object}: ${r.reason}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
