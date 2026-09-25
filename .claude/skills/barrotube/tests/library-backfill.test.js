import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  THEME_SCENES, NARRATION, DIRECTION_PALETTE,
  parseSlot, synthesizePrompt, pickObjects, synthesizeScene,
} from '../scripts/automation/lib/backfill-prompt.js';
import { checkImagePrompt, BOUNDS } from '../scripts/automation/lib/image-prompt-contract.js';
import {
  normalizeObject, buildThemeScorer, assignSlot, THEME_TERMS, GENERIC_OBJECTS,
} from '../scripts/automation/lib/scene-slot-taxonomy.js';
import { isCurrentEra, hasCaricature } from '../scripts/automation/lib/scene-asset-index.js';
import {
  measureImage, judge, dHash, hamming, THRESHOLDS, contactSheet,
} from '../scripts/automation/lib/image-quality.js';
import {
  orderShortfall, buildWorkOrder, evaluateGuards, slotsForDay,
} from '../scripts/automation/backfill-library.js';

const ALL = [];
for (const theme of Object.keys(THEME_SCENES)) {
  for (const dir of ['up', 'down', 'neutral']) {
    for (const o of THEME_SCENES[theme].objects) ALL.push({ slot: `${theme}/${dir}`, o });
  }
}

// ── 프롬프트 합성 ──────────────────────────────────────────────────────────

test('합성 프롬프트가 image_prompt 계약을 어기지 않는다', () => {
  for (const { slot, o } of ALL) {
    const p = synthesizePrompt(slot, o);
    const v = checkImagePrompt(p);
    assert.equal(v.filter((x) => x.severity === 'BLOCK').length, 0,
      `${slot}/${o.noun} BLOCK: ${JSON.stringify(v)}`);
    assert.equal(v.filter((x) => x.severity === 'WARN').length, 0,
      `${slot}/${o.noun} WARN: ${JSON.stringify(v)}`);
  }
});

test('합성 프롬프트가 계약 길이 밴드 안에 있다', () => {
  for (const { slot, o } of ALL) {
    const len = synthesizePrompt(slot, o).length;
    assert.ok(len >= BOUNDS.minChars && len <= BOUNDS.maxChars, `${slot}/${o.noun} ${len}자`);
  }
});

test('합성 프롬프트에서 중앙 객체가 의도한 낱말로 추출된다', () => {
  // 이게 깨지면 다양성 집계가 엉뚱한 낱말을 세고 포화 판정이 무너진다.
  for (const { slot, o } of ALL) {
    assert.equal(normalizeObject(synthesizePrompt(slot, o)), o.noun, `${slot}/${o.noun}`);
  }
});

test('합성 프롬프트가 현행 화풍으로 판정되고 캐리커처로 오인되지 않는다', () => {
  for (const { slot, o } of ALL) {
    const p = synthesizePrompt(slot, o);
    assert.ok(isCurrentEra(p), `${slot}/${o.noun} 구세대 판정`);
    assert.ok(!hasCaricature(p), `${slot}/${o.noun} 캐리커처 오판`);
  }
});

test('객체 어휘에 범용 객체가 섞이지 않는다', () => {
  // 범용 구도는 2차 완주 배정이 쓰는 몫이다. 백필까지 거기로 쏠리면 다양성이 안 는다.
  for (const theme of Object.keys(THEME_SCENES)) {
    for (const o of THEME_SCENES[theme].objects) {
      assert.ok(!GENERIC_OBJECTS.some((g) => o.noun.includes(g)), `${theme}/${o.noun} 는 범용 객체`);
    }
  }
});

test('합성 대사가 목표 슬롯으로 분류된다', () => {
  // 분류는 프롬프트가 아니라 대사를 본다. 여기가 깨지면 구운 컷이 unclassified 로
  // 떨어져 목표 슬롯은 그대로 비어 있다 — 백필이 아무 일도 안 한 셈이 된다.
  const rows = ALL.map(({ slot, o }) => ({ ...synthesizeScene(slot, o), want: slot }));
  const score = buildThemeScorer(rows.map((r) => r.narration));
  for (const r of rows) {
    const got = assignSlot({ text: r.narration, palette: r.palette, prompt: r.prompt, role: 'explain' }, score);
    assert.equal(got?.slot, r.want, `${r.want} → ${got?.slot} (${got?.reason})`);
  }
});

test('대사가 그 주제의 용어를 실제로 담는다', () => {
  for (const theme of Object.keys(NARRATION)) {
    for (const dir of Object.keys(NARRATION[theme])) {
      const hit = THEME_TERMS[theme].filter((t) => NARRATION[theme][dir].includes(t));
      assert.ok(hit.length >= 2, `${theme}/${dir} 주제어 ${hit.length}개 — 2개 이상이어야 한다`);
    }
  }
});

test('방향이 팔레트로 정확히 매핑된다', () => {
  assert.equal(DIRECTION_PALETTE.up, 'bullish');
  assert.equal(DIRECTION_PALETTE.down, 'bearish');
  assert.equal(DIRECTION_PALETTE.neutral, 'explainer');
  for (const { slot, o } of ALL) {
    const { direction } = parseSlot(slot);
    assert.ok(synthesizePrompt(slot, o).startsWith(`[palette:${DIRECTION_PALETTE[direction]}]`));
  }
});

test('pickObjects 는 이미 쓴 객체를 피하고, 동나면 조용히 넘어가지 않는다', () => {
  const [a] = pickObjects('metals/up', { count: 1 });
  const [b] = pickObjects('metals/up', { used: [a.noun], count: 1 });
  assert.notEqual(a.noun, b.noun);

  const all = THEME_SCENES.metals.objects.map((o) => o.noun);
  assert.throws(() => pickObjects('metals/up', { used: all, count: 1 }), /객체가 0개뿐/);
});

test('슬롯 표기가 틀리면 예외로 세운다', () => {
  assert.throws(() => parseSlot('nope/up'), /무대 정의가 없는/);
  assert.throws(() => parseSlot('metals/sideways'), /방향이 아닙니다/);
});

// ── 우선순위·상한 ──────────────────────────────────────────────────────────

const MANIFEST = {
  slots: {
    'index/up': { grade: 'A', target: 4, count: 4, assets: [] },
    'rates/up': { grade: 'A', target: 4, count: 2, assets: [{ object: 'tower' }] },
    'semis/down': { grade: 'A', target: 4, count: 1, assets: [] },
    'labor/up': { grade: 'B', target: 3, count: 0, assets: [] },
    'labor/down': { grade: 'B', target: 3, count: 2, assets: [] },
    'fx/up': { grade: 'B', target: 3, count: 2, assets: [] },
    'metals/up': { grade: 'C', target: 2, count: 0, assets: [] },
  },
};

test('규칙 4 — A→B→C, 등급 안에서는 부족분 큰 쪽, 같으면 up 먼저', () => {
  const rows = orderShortfall(MANIFEST);
  assert.deepEqual(rows.map((r) => r.slot),
    ['semis/down', 'rates/up', 'labor/up', 'fx/up', 'labor/down', 'metals/up']);
  assert.ok(!rows.some((r) => r.slot === 'index/up'), '충족된 슬롯은 빠져야 한다');
});

test('slot_overrides 의 hold 는 백필에서 빠진다', () => {
  const rows = orderShortfall(MANIFEST, { overrides: { 'labor/up': { hold: true } } });
  assert.ok(!rows.some((r) => r.slot === 'labor/up'));
});

test('작업 지시서가 일일 상한을 넘지 않는다', () => {
  assert.equal(buildWorkOrder(orderShortfall(MANIFEST), { limit: 5 }).length, 5);
  assert.equal(buildWorkOrder(orderShortfall(MANIFEST), { limit: 1 }).length, 1);
});

test('한 주제 안에서 같은 객체를 두 번 잡지 않는다', () => {
  // metals/up 과 metals/neutral 이 둘 다 ingot 을 받으면 팔레트만 다른 같은 그림이 된다.
  const m = { slots: {
    'metals/up': { grade: 'C', target: 2, count: 0, assets: [] },
    'metals/neutral': { grade: 'C', target: 2, count: 0, assets: [] },
  } };
  const order = buildWorkOrder(orderShortfall(m), { limit: 4 });
  const nouns = order.map((o) => o.object);
  assert.equal(new Set(nouns).size, nouns.length, `중복: ${nouns.join(',')}`);
});

test('이미 그 슬롯에 있는 객체는 다시 굽지 않는다', () => {
  const m = { slots: { 'rates/up': { grade: 'A', target: 4, count: 2, assets: [{ object: 'ratchet' }] } } };
  const order = buildWorkOrder(orderShortfall(m), { limit: 2 });
  assert.ok(!order.some((o) => o.object === 'ratchet'));
});

// ── 가드 ──────────────────────────────────────────────────────────────────

const ROUTINES = { slots: {
  'us-close': { cron: '06:00' },
  'kr-close': { cron: '16:00' },
  omnibus: { cron: 'Mon-Thu,Sat,Sun 10:00' },
  realestate: { cron: 'Fri 10:00' },
} };

const base = { routines: ROUTINES, ledger: [], inFlight: [], pendingRender: [], bakedToday: 0, cap: 5 };
const atHour = (h) => { const d = new Date(); d.setHours(h, 30, 0, 0); return d; };
const codes = (g) => g.blocks.map((b) => b.code);

test('요일별 슬롯 — 금요일은 realestate, 목요일은 omnibus', () => {
  const fri = new Date('2026-09-25T09:00:00');
  const thu = new Date('2026-09-24T09:00:00');
  assert.ok(slotsForDay(ROUTINES, fri).some((s) => s.name === 'realestate'));
  assert.ok(!slotsForDay(ROUTINES, fri).some((s) => s.name === 'omnibus'));
  assert.ok(slotsForDay(ROUTINES, thu).some((s) => s.name === 'omnibus'));
});

test('규칙 1 — 파이프라인이 돌고 있으면 막는다', () => {
  const g = evaluateGuards({ ...base, now: atHour(23), inFlight: ['slot:kr-close'] });
  assert.ok(codes(g).includes('PIPELINE_IN_FLIGHT'));
});

test('규칙 1 — 그날 마지막 슬롯 전에는 막는다', () => {
  assert.ok(codes(evaluateGuards({ ...base, now: atHour(11) })).includes('SLOTS_REMAINING'));
  assert.ok(!codes(evaluateGuards({ ...base, now: atHour(23) })).includes('SLOTS_REMAINING'));
});

test('규칙 1 — 렌더가 덜 끝난 회차가 있으면 막는다', () => {
  const g = evaluateGuards({ ...base, now: atHour(23), pendingRender: ['EP-2026-0181(5컷)'] });
  assert.ok(codes(g).includes('EPISODES_PENDING_RENDER'));
});

test('규칙 2 — 오늘 재사용 폴백이 돌았으면 막는다', () => {
  const day = new Date().toISOString().slice(0, 10);
  const g = evaluateGuards({ ...base, now: atHour(23), ledger: [{ used_at: `${day}T01:00:00.000Z` }] });
  assert.ok(codes(g).includes('REUSE_FALLBACK_TODAY'));
  const old = evaluateGuards({ ...base, now: atHour(23), ledger: [{ used_at: '2020-01-01T00:00:00.000Z' }] });
  assert.ok(!codes(old).includes('REUSE_FALLBACK_TODAY'));
});

test('규칙 3 — 상한을 채웠으면 막고, 남은 수량을 정확히 센다', () => {
  const g = evaluateGuards({ ...base, now: atHour(23), bakedToday: 5, cap: 5 });
  assert.ok(codes(g).includes('DAILY_CAP_REACHED'));
  assert.equal(g.remaining, 0);
  assert.equal(evaluateGuards({ ...base, now: atHour(23), bakedToday: 2, cap: 5 }).remaining, 3);
});

test('조건이 다 맞으면 가드가 비어 있다', () => {
  assert.deepEqual(evaluateGuards({ ...base, now: atHour(23) }).blocks, []);
});

// ── 픽셀 QA ───────────────────────────────────────────────────────────────

/**
 * 시험용 PNG.
 *
 * 화소 단위 난수는 쓰지 않는다 — 32x32 로 줄이면 평균으로 뭉개져 편차가 0에 가까워지고
 * 정상 그림까지 FLAT_IMAGE 로 판정된다(축소가 고주파를 지우기 때문이다). 축소에도
 * 살아남는 **큰 구조**가 필요하므로 대각 그라디언트를 쓴다.
 */
async function png(dir, name, { w = 941, h = 1672, flat = false, level = 60, flip = false } = {}) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = flip ? 1 - x / w : x / w;
      const v = flat ? level : Math.round(fx * 128 + (y / h) * 127);
      const i = (y * w + x) * 3;
      px[i] = v; px[i + 1] = v; px[i + 2] = v;
    }
  }
  const p = join(dir, name);
  await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toFile(p);
  return p;
}

test('픽셀 QA — 비율·해상도·평면·노출을 판정한다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-qa-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(judge(await measureImage(await png(dir, 'ok.png'))).verdict, 'PASS');

  const wide = judge(await measureImage(await png(dir, 'wide.png', { w: 1024, h: 1536 })));
  assert.equal(wide.verdict, 'FAIL');
  assert.ok(wide.issues.some((i) => i.code === 'ASPECT_OFF_SPEC'));

  const small = judge(await measureImage(await png(dir, 'small.png', { w: 720, h: 1280 })));
  assert.ok(small.issues.some((i) => i.code === 'TOO_SMALL'));

  const flat = judge(await measureImage(await png(dir, 'flat.png', { flat: true, level: 60 })));
  assert.ok(flat.issues.some((i) => i.code === 'FLAT_IMAGE'), '단색은 생성 실패다');

  const black = judge(await measureImage(await png(dir, 'black.png', { flat: true, level: 2 })));
  assert.ok(black.issues.some((i) => i.code === 'EXPOSURE_BROKEN'));
});

test('픽셀 QA — 근접중복은 FAIL, 다른 그림은 통과', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-dup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const a = await png(dir, 'a.png');
  const m = await measureImage(a);
  assert.equal(judge(m, [{ hash: m.hash, label: '자기 자신' }]).verdict, 'FAIL');
  assert.ok(judge(m, [{ hash: m.hash, label: 'x' }]).issues.some((i) => i.code === 'NEAR_DUPLICATE'));

  // 코퍼스를 안 주면(= 기존 컷 재사용 복사) 중복으로 보지 않는다.
  assert.equal(judge(m).verdict, 'PASS');
});

test('dHash 는 크기가 달라도 같은 그림을 같게 본다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-hash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const big = await png(dir, 'big.png', { w: 941, h: 1672 });
  const resized = join(dir, 'resized.png');
  await sharp(big).resize(470, 836).png().toFile(resized);
  assert.ok(hamming(await dHash(big), await dHash(resized)) <= THRESHOLDS.dupHamming);
});

test('콘택트시트는 준 컷 수를 그대로 담는다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-sheet-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = [await png(dir, '1.png'), await png(dir, '2.png'), await png(dir, '3.png')];
  const out = join(dir, 'sheet.png');
  const r = await contactSheet(paths, out, { cols: 2, cell: 80 });
  assert.equal(r.count, 3);
  assert.equal(r.rows, 2);
  const md = await sharp(out).metadata();
  assert.equal(md.width, 160);
});

test('씬 번호는 개수가 아니라 최대 번호 다음에서 이어진다', async (t) => {
  // 불량 컷을 빼면 개수와 최대 번호가 어긋난다. 개수로 채번하면 남아 있는 파일을
  // 덮어쓰고 대본의 슬롯 표기와 그림이 갈린다 (2026-09-25 실측).
  const { nextSceneSeq } = await import('../scripts/automation/backfill-library.js');
  const dir = mkdtempSync(join(tmpdir(), 'bt-seq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const scenes = [{ scene_id: '001' }, { scene_id: '004' }, { scene_id: '011' }];
  assert.equal(nextSceneSeq(scenes, null), 11);
  assert.equal(nextSceneSeq([], null), 0);

  // 대본에서 지웠지만 파일이 남은 경우도 덮지 않는다.
  await png(dir, 'scene_014.png');
  assert.equal(nextSceneSeq(scenes, dir), 14);
});
