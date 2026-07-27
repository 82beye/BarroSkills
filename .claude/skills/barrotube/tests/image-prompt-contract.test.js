import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOUNDS, CANONICAL_TAIL, TEMPLATE, KNOWN_PALETTES,
  checkImagePrompt, checkEpisodePrompts, profile,
} from '../scripts/automation/lib/image-prompt-contract.js';

// 계약은 EP-2026-0069(발행본) vs EP-2026-0070(구석 스티커)의 A/B 에서 역산했다.
// 아래 픽스처는 두 EP의 실제 프롬프트를 축약한 것 — 실 데이터(~/BarroTubeData)에
// 의존하면 CI 에서 못 돌리므로 형태만 보존해 담는다.

const MASCOT_FULL =
  '마시 the 바로경제 mascot (official character sheet for the character only — large round head ' +
  'on a separate rounded pear-shaped body, white mitten hands and rounded shoe-feet, big solid ' +
  'black eyes with white highlights, orange (#FF9A1F) blush cheeks, no nose or ears)';

/** 0069 형태: 마스코트가 씬 동작의 주어 */
const GOOD =
  `[palette:bearish] ${MASCOT_FULL}, shocked and worried, standing in front of a giant glowing ` +
  'stock chart where a tall green record-high bar is immediately followed by a steep red arrow ' +
  'crashing straight down. BACKGROUND: deep dark navy-indigo (#1E3A5F) cinematic financial ' +
  'newsroom, red (#E63946) warning glow on the crashing arrow, orange-gold (#F4A261) accent on ' +
  `the record bar, faint candlestick textures at low contrast, ${CANONICAL_TAIL}`;

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
  const suited = GOOD.replace('shocked and worried',
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
