import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOUNDS, CANONICAL_TAIL, TEMPLATE, KNOWN_PALETTES, MASCOT_CLAUSE,
  checkImagePrompt, checkEpisodePrompts, profile,
} from '../scripts/automation/lib/image-prompt-contract.js';

// 계약은 EP-2026-0069(발행본) vs EP-2026-0070(구석 스티커)의 A/B 에서 역산했다.
// 아래 픽스처는 두 EP의 실제 프롬프트를 축약한 것 — 실 데이터(~/BarroTubeData)에
// 의존하면 CI 에서 못 돌리므로 형태만 보존해 담는다.

const MASCOT_FULL =
  '마시 the 바로경제 mascot (official character sheet for the character only — large round head ' +
  'on a separate rounded pear-shaped body, white mitten hands and rounded shoe-feet, big solid ' +
  'black eyes with white highlights, orange (#FF9A1F) blush cheeks, no nose or ears)';

/**
 * 기준점: EP-2026-0091 발행본 씬1 — 실제로 정상 이미지를 만든 프롬프트다.
 *
 * 이전 기준점(EP-0069)은 스테이징 문구가 없었고, 그 형태를 따라간 EP-0092 는
 * 마시가 정장을 입고 화면 30% 로 줄고 배경이 회화풍으로 채워졌다(2026-08-14 실측).
 * 발행본 5컷이 100% 갖고 있던 문구를 기준점으로 올린다.
 */
const GOOD =
  `[palette:bearish] ${MASCOT_FULL}, alarmed, standing before a single monumental split market ` +
  'dial in the centre, face readable, planting its rounded shoe-feet while one white mitten hand ' +
  'points toward the uneven needle, the unified dial rising in a bright stepped arc on one side ' +
  'and barely dipping on the other. BACKGROUND: deep navy abstract exchange hall, alert red ' +
  `accent on the dial rim, faint paper-grain texture at low contrast, ${CANONICAL_TAIL}`;

/** 0070 형태: 마스코트를 서술 대상으로 밀어냄 + 금지문 + 프레임% + 시트에 없는 의상 */
const BAD =
  '[palette:bearish] Use the attached official character sheet as the exact identity reference ' +
  'for Masi. Create a single vertical 9:16 cinematic editorial illustration with a wide-angle ' +
  '24mm look. Masi is the dominant protagonist, full body and about 42-46% of frame height. ' +
  'Wardrobe: a short dark-navy analyst waistcoat with orange piping. Two steep luminous market ' +
  'lines crash toward a metallic countdown clock. Masi must be the first thing the viewer sees, ' +
  'not a corner accent or watermark. No other people, no logos, no readable text, no watermark.';

const codes = vs => new Set(vs.map(v => v.code));

test('기준점 형태(EP-0069)는 통과한다', () => {
  assert.ok(GOOD.length >= BOUNDS.minChars && GOOD.length <= BOUNDS.maxChars,
    `픽스처 길이 ${GOOD.length} 가 계약 범위 밖 — 픽스처를 고쳐야 한다`);
  assert.deepEqual(checkImagePrompt(GOOD), []);
});

test('EP-0070 형태는 실제 실패 원인을 코드로 잡아낸다', () => {
  const c = codes(checkImagePrompt(BAD));
  // 렌더에서 실제로 터진 것들
  assert.ok(c.has('MASCOT_NOT_SUBJECT') || c.has('MASCOT_CLAUSE_MISSING'), '마스코트가 주어가 아님');
  assert.ok(c.has('TOO_MANY_NEGATIONS'), '금지문 과다 — 5컷 전부 그대로 렌더됐다');
  assert.ok(c.has('FRAME_RATIO_SPEC'), '프레임 비율 지정 — 무시되고 12%로 나왔다');
  assert.ok(c.has('WARDROBE_OFF_SHEET'), '시트에 없는 의상(waistcoat)');
  assert.ok(c.has('BACKGROUND_MISSING'), 'BACKGROUND 구간 없음');
  assert.ok(c.has('TAIL_MISSING'), '고정 꼬리 없음');
});

test('마스코트 절이 있어도 씬 동사가 없으면 주어가 아니다', () => {
  const p = `[palette:cta] ${MASCOT_FULL}, calm. A giant fork splits into two glowing paths. ` +
    `BACKGROUND: deep navy horizon, orange-gold halo, low-contrast textures, ${CANONICAL_TAIL}`;
  assert.ok(codes(checkImagePrompt(p)).has('MASCOT_NOT_SUBJECT'));
});

test('고정 꼬리의 "no readable text or numbers" 는 금지어로 세지 않는다', () => {
  // 꼬리를 금지어로 세면 모든 정상 프롬프트가 실패한다 — 0069 가 실제로 그 형태다.
  assert.ok(!codes(checkImagePrompt(GOOD)).has('TOO_MANY_NEGATIONS'));
});

test('의상은 EP 전체에서 1컷까지만', () => {
  const suited = GOOD.replace('alarmed',
    'wearing the dark navy business suit and tie from the sheet, worried');
  const one = checkEpisodePrompts([{ sceneId: 'S1', prompt: suited }, { sceneId: 'S2', prompt: GOOD }]);
  assert.ok(!codes(one.violations).has('WARDROBE_OVERUSE'));

  const two = checkEpisodePrompts([{ sceneId: 'S1', prompt: suited }, { sceneId: 'S2', prompt: suited }]);
  assert.ok(codes(two.violations).has('WARDROBE_OVERUSE'));
});

test('알 수 없는 팔레트 태그는 경고로 잡는다 (조용히 무시되므로)', () => {
  const p = GOOD.replace('[palette:bearish]', '[palette:doomer]');
  const v = checkImagePrompt(p).find(x => x.code === 'PALETTE_TAG_UNKNOWN');
  assert.ok(v && v.severity === 'WARN');
  assert.ok(KNOWN_PALETTES.includes('bearish'));
});

test('BLOCK 이 하나라도 있으면 EP 는 ok=false', () => {
  assert.equal(checkEpisodePrompts([{ sceneId: 'S1', prompt: GOOD }]).ok, true);
  assert.equal(checkEpisodePrompts([{ sceneId: 'S1', prompt: BAD }]).ok, false);
});

test('프로파일이 기준점 지표를 재현한다', () => {
  const good = profile([GOOD]);
  assert.ok(good.subjectShare >= 50, `마스코트가 주어인 비율 ${good.subjectShare}% — 기준점 58%`);
  assert.equal(good.frameRatioSpecs, 0);

  const bad = profile([BAD]);
  assert.ok(bad.subjectShare < 30, `0070 형태는 낮아야 한다 (실측 26%), got ${bad.subjectShare}%`);
  assert.equal(bad.frameRatioSpecs, 1);
});

test('템플릿이 고정 꼬리를 포함한다 — 문서와 코드가 갈라지지 않도록', () => {
  assert.ok(TEMPLATE.endsWith(CANONICAL_TAIL));
  assert.ok(TEMPLATE.includes('BACKGROUND:'));
});

test('빈 프롬프트는 EMPTY 로 막는다', () => {
  assert.ok(codes(checkImagePrompt('')).has('EMPTY'));
  assert.ok(codes(checkImagePrompt(null)).has('EMPTY'));
});

// 2026-07-29 회귀: generate-script.js 가 character-dna.md 첫 블록(1001자·금지표현 8개)을
// image_prompt 안에 verbatim 으로 넣게 지시하고 있었다. 계약 상한이 780자·금지어 1개라
// 만족이 원천적으로 불가능했고, EP-0072 가 10건 BLOCK 으로 멈췄다.
// 대본용 마스코트 절은 스스로 계약을 통과해야 한다.
test('MASCOT_CLAUSE 는 계약 안에서 실제로 사용 가능하다', () => {
  const built = `[palette:bearish] ${MASCOT_CLAUSE}, shocked and worried, standing before a ` +
    'single glowing index board in the centre, face readable, planting its rounded shoe-feet ' +
    'while one white mitten hand points at the falling line, the unified board splitting into ' +
    'one rising and one bleeding half. BACKGROUND: deep navy abstract newsroom, alert red ' +
    `accent on the falling line, faint candlestick texture at low contrast, ${CANONICAL_TAIL}`;

  assert.ok(built.length <= BOUNDS.maxChars,
    `조립 결과 ${built.length}자 — 상한 ${BOUNDS.maxChars}자를 넘으면 모든 컷이 BLOCK 된다`);
  assert.deepEqual(checkImagePrompt(built), [],
    '정본 마스코트 절로 만든 프롬프트가 계약을 통과하지 못하면 생성기가 만족시킬 수 없다');
});

test('MASCOT_CLAUSE 는 캐릭터 DNA 의 핵심 시각 요소를 유지한다', () => {
  // DNA 가 v13 으로 바뀌었는데 이 절만 낡으면 컷 간 캐릭터가 드리프트한다.
  //
  // 2026-08-14: 'pear-shaped' 를 'slim capsule' 로 교체했다. 배 모양은 아래가 불룩한
  // 형태라 모델이 마시를 뚱뚱하게 그렸는데(EP-0092 전 컷), 정본 캐릭터시트
  // (docs/바로경제_캐릭터시트.png §1·§2)의 몸통은 좁은 캡슐이고 팔다리는 막대처럼 가늘다.
  // 즉 이 테스트가 잘못된 체형을 고정하고 있었다.
  for (const token of ['마시', '바로경제', 'round head', 'slim capsule', 'thin stick limbs', 'mitten', '#FF9A1F']) {
    assert.ok(MASCOT_CLAUSE.includes(token), `마스코트 절에 "${token}" 가 없다`);
  }
});
