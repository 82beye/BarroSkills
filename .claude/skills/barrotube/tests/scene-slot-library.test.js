import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  THEME_TERMS, THEME_GRADE, ROLE_SLOTS, SATURATION_SHARE,
  allSlots, assignSlot, buildThemeScorer, normalizeObject, saturationOf,
  slotTarget, slotGrade, PALETTE_DIRECTION,
} from '../scripts/automation/lib/scene-slot-taxonomy.js';
import { buildLibrary } from '../scripts/automation/classify-scene-assets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 현행 계약(640자 + 캐릭터시트)을 만족하는 합성 프롬프트. */
function prompt(palette, object) {
  const p = `[palette:${palette}] 마시 the 바로경제 mascot (official character sheet for the `
    + `character only — large round head on a slim capsule body with thin stick limbs, white `
    + `mitten hands and rounded shoe-feet, big solid black eyes with white highlights, orange `
    + `(#FF9A1F) blush cheeks, no nose or ears), alert, standing before a ${object} in the `
    + `centre, face readable, planting its rounded shoe-feet while one white mitten hand grips `
    + `the nearest edge, the unified composition holding the viewer on the central object. `
    + `BACKGROUND: deep navy trading floor, faint grid texture at low contrast, soft rim light `
    + `separating the mascot from the field, bold illustrated line art, 9:16 vertical, `
    + `no readable text or numbers.`;
  assert.ok(p.length >= 640);
  return p;
}

function entry({ ep = 'EP-2026-0001', sceneId = '001', palette = 'bearish', role = 'hook',
  text = '', object = 'single balance scale', video = null, mtimeMs = 0 } = {}) {
  return {
    episodeId: ep, sceneId, role, palette, text,
    prompt: prompt(palette, object),
    image: `/tmp/${ep}-${sceneId}.png`, video, mtimeMs,
  };
}

test('슬롯은 11주제 × 3방향 + 역할 1 = 34개이고 목표 합이 102다', () => {
  const slots = allSlots();
  assert.equal(slots.length, 34);
  assert.equal(Object.keys(THEME_TERMS).length, 11);
  assert.equal(ROLE_SLOTS.length, 1);
  // hook 은 역할 슬롯이 아니다 — hook 씬은 그 회차 주제로 열리므로 주제 슬롯에 속한다.
  // 유령 슬롯을 남기면 체크리스트가 영구히 "비어 있음"을 표시해 신호가 죽는다.
  assert.ok(!slots.includes('hook/generic'));
  assert.equal(slots.reduce((a, s) => a + slotTarget(s), 0), 102);
});

test('주제는 프롬프트가 아니라 한국어 대사로 판정한다', () => {
  // 프롬프트는 "어떻게 보이나"를 적는다. 같은 저울 그림이 유가 대사와 금리 대사에
  // 각각 붙을 수 있고, 슬롯을 가르는 것은 대사다.
  const texts = ['코스피가 내렸습니다', '유가가 급락했습니다', '기준금리를 동결했습니다'];
  const score = buildThemeScorer(texts);

  const oil = assignSlot(entry({ palette: 'bearish', text: '유가가 급락했습니다' }), score);
  const rate = assignSlot(entry({ palette: 'bearish', text: '기준금리를 동결했습니다' }), score);
  assert.equal(oil.theme, 'energy');
  assert.equal(rate.theme, 'rates');
  // 프롬프트(객체)는 둘 다 같은데 슬롯이 갈렸다.
  assert.equal(oil.slot, 'energy/down');
  assert.equal(rate.slot, 'rates/down');
});

test('방향은 팔레트에서 읽고, 매핑에 없는 팔레트는 배정하지 않는다', () => {
  const score = buildThemeScorer(['코스피가 올랐습니다']);
  assert.equal(PALETTE_DIRECTION.bullish, 'up');
  assert.equal(PALETTE_DIRECTION.bearish, 'down');
  assert.equal(PALETTE_DIRECTION.explainer, 'neutral');

  const up = assignSlot(entry({ palette: 'bullish', role: 'hook', text: '코스피가 올랐습니다' }), score);
  assert.equal(up.slot, 'index/up');

  const weird = assignSlot(entry({ palette: 'dramatic_reveal', role: 'hook', text: '코스피가 올랐습니다' }), score);
  assert.equal(weird.slot, null);
  assert.match(weird.reason, /palette_unmapped/);
});

test('1·2위가 가까우면 추측하지 않고 미분류로 남긴다', () => {
  // 추측 배정은 없는 것보다 나쁘다 — 2026-09-22 실측에서 정상 점수로 배정된 컷이
  // 화풍을 깨뜨렸다. 모호하면 전체 조회로 떨어지는 편이 낫다.
  const texts = ['코스피와 반도체가 같이 움직였습니다', '코스피가 내렸습니다', '반도체가 올랐습니다'];
  const score = buildThemeScorer(texts);
  const r = assignSlot(entry({ palette: 'bearish', text: '코스피와 반도체가 같이 움직였습니다' }), score);
  assert.equal(r.slot, null);
  assert.match(r.reason, /^ambiguous:/);
});

test('cta 씬은 주제와 무관하게 역할 슬롯으로 간다', () => {
  const score = buildThemeScorer(['코스피가 내렸습니다']);
  const r = assignSlot(entry({ role: 'cta', palette: 'cta', text: '코스피 흐름을 더 보려면 팔로우' }), score);
  assert.equal(r.slot, 'cta/generic');
  assert.equal(r.reason, 'role');
});

test('객체 정규화가 같은 그림의 형용사 변형을 하나로 모은다', () => {
  // 실측: cta 슬롯 71컷 중 32컷이 아래 같은 변형으로 흩어진 "벨" 하나였다.
  const variants = [
    'a large glowing alarm bell', 'a bright notification bell',
    'a bell-shaped notification icon', 'a single ringing alarm bell',
  ].map((v) => `standing before ${v} in the centre`);
  const heads = variants.map(normalizeObject);
  assert.deepEqual(new Set(heads), new Set(['bell']), `변형이 안 모였다: ${heads}`);
  assert.equal(normalizeObject('before a single giant oil barrel in the centre'), 'barrel');
});

test('포화는 고유 종류 수가 아니라 최빈 객체의 점유율로 잰다', () => {
  // 초안은 "고유 종류 < 목표/2" 였는데 정작 문제 슬롯을 놓쳤다: cta 는 71컷에
  // 31종이라 통과했지만 실제로는 43% 가 벨 하나였다.
  const bellHeavy = [...Array(9).fill('bell'), 'calendar', 'ladder'];
  const spread = ['bell', 'calendar', 'ladder', 'compass', 'scale', 'chart'];

  assert.equal(new Set(bellHeavy).size, 3);
  assert.equal(saturationOf(bellHeavy).saturated, true);
  assert.equal(saturationOf(bellHeavy).top, 'bell');
  assert.ok(saturationOf(bellHeavy).share >= SATURATION_SHARE);
  assert.equal(saturationOf(spread).saturated, false);

  // 객체를 하나도 못 읽으면 판정하지 않는다 — 파싱 실패를 포화로 보고하면
  // 운영자가 없는 문제를 쫓는다.
  const unknown = saturationOf([null, null, null, null]);
  assert.equal(unknown.known, false);
  assert.equal(unknown.saturated, false);
});

test('구세대 화풍과 캐리커처는 라이브러리에 들어가지 않는다', () => {
  const legacy = { ...entry({ text: '코스피가 내렸습니다' }), prompt: 'vertical 9:16, cartoon stick figure, bold line art' };
  const face = entry({ text: '코스피가 내렸습니다' });
  face.prompt += ' WITH: a flat cartoon caricature of a middle-aged man with dark hair.';
  const ok = entry({ text: '코스피가 내렸습니다' });

  const lib = buildLibrary([legacy, face, ok], { now: 'T', probeClip: () => false });
  assert.equal(lib.totals.usable, 1);
  assert.equal(lib.totals.retired, 2);
  assert.equal(lib.retired_summary.legacy_era, 1);
  assert.equal(lib.retired_summary.caricature, 1);
});

test('라이브러리는 자산을 복사하지 않고 원위치를 참조한다', () => {
  // 스틸 1.04GB · 클립 2.85GB 를 복제하면 원본이 지워졌을 때 정본이 어느 쪽인지 모른다.
  const lib = buildLibrary([entry({ text: '코스피가 내렸습니다', video: '/tmp/x.mp4' })],
    { now: 'T', probeClip: () => true });
  const asset = lib.slots['index/down'].assets[0];
  assert.ok(asset.image, '이미지 경로가 없다');
  assert.ok(!('bytes' in asset) && !('data' in asset), '자산을 인라인했다');
  assert.equal(asset.real_motion, true);
});

test('gap 과 target 이 등급에서 일관되게 나온다', () => {
  assert.equal(slotGrade('index/up'), 'A');
  assert.equal(slotTarget('index/up'), 4);
  assert.equal(slotGrade('energy/down'), 'B');
  assert.equal(slotTarget('energy/down'), 3);
  assert.equal(slotGrade('metals/up'), 'C');
  assert.equal(slotTarget('metals/up'), 2);
  assert.equal(slotGrade('cta/generic'), 'R');
  assert.equal(slotTarget('cta/generic'), 6);
  for (const t of Object.keys(THEME_TERMS)) assert.ok(THEME_GRADE[t], `${t} 등급 없음`);
});

test('정책 정본 config 에 library·backfill 블록이 있고 상한이 생산을 굶기지 않는다', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'asset-reuse.json'), 'utf8'));
  assert.ok(cfg.library?.manifest && cfg.library?.obsidian_vault && cfg.library?.obsidian_dir);
  assert.ok(cfg.library?.root, '백필 산출물 위치가 정본에 있어야 한다');

  // 2026-09-25 Phase 3 구현으로 enabled 는 true 가 됐다. 이 테스트가 지키는 것은
  // "꺼져 있음"이 아니라 **생산을 굶기지 않는 안전값들**이다 — enabled 를 켜는 순간
  // 이쪽이 유일한 방어선이 된다.
  assert.equal(cfg.backfill.require_no_fallback_today, true);
  assert.equal(cfg.backfill.prefer_direction, 'up');
  assert.ok(cfg.backfill.daily_cap > 0 && cfg.backfill.daily_cap <= 5,
    '일일 상한은 에피소드 15컷의 1/3 이하여야 한다');
  assert.ok(cfg.backfill.pending_render_window_days > 0,
    '렌더 대기 가드의 관측 창이 없으면 버려진 초기 회차가 백필을 영구히 막는다');
});

test('옵시디언 렌더는 생성 표시를 달고 notes.md 를 소유하지 않는다', async () => {
  const src = readFileSync(join(ROOT, 'scripts', 'automation', 'sync-asset-obsidian.js'), 'utf8');
  // 생성 문서에 사람이 적은 내용이 조용히 사라지면 그 문서를 아무도 신뢰하지 않는다.
  assert.match(src, /자동 생성 — 손으로 고치지 마세요/);
  assert.ok(!/OWNED[\s\S]{0,200}notes\.md/.test(src), 'notes.md 가 렌더 소유 목록에 있다');
  assert.match(src, /if \(!existsSync\(notes\)\)/, 'notes.md 를 조건 없이 덮어쓴다');

  const { renderChecklist, renderGaps } = await import('../scripts/automation/sync-asset-obsidian.js');
  // index/down 목표는 4다 — 체크가 켜지려면 4컷이 있어야 한다.
  const filled = ['001', '002', '003', '004'].map((sceneId) =>
    entry({ sceneId, text: '코스피가 내렸습니다', object: `single object ${sceneId}` }));
  const lib = buildLibrary(filled, { now: 'T', probeClip: () => false });
  assert.equal(lib.slots['index/down'].count, 4);

  const md = renderChecklist(lib);
  assert.match(md, /^<!-- 자동 생성/);
  assert.match(md, /- \[x\] `index\/down`/);   // 목표 충족 → 체크
  assert.match(md, /- \[ \] `metals\/up`/);    // 비어 있는 슬롯 → 해제
  assert.match(renderGaps(lib), /\| 슬롯 \| 등급 \|/);
});
