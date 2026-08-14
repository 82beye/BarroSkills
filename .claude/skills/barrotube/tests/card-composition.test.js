import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildCardComposition, layoutTitle, loadCardConfig, markupTitle, treatmentCss, CARD_STYLE,
} from '../scripts/automation/lib/card-composition.js';
import { toCardText, deriveIntro, deriveOutro } from '../scripts/automation/generate-cards.js';

const ROOT = join(import.meta.dirname, '..');
const PRODUCE = readFileSync(join(ROOT, 'scripts/automation/produce-episode.js'), 'utf-8');

const build = (over = {}) => buildCardComposition({
  variants: [{ title: '사상 최고치인데|AMD는 왜|**8% 빠졌나**', sub: '실적은 다 이겼는데' }],
  imageRel: 'assets/bg.png', gsapRel: 'assets/gsap.min.js',
  fontFamily: 'BM DoHyeon OTF', treatment: { stroke: 14, shadow: 'hard' }, ...over,
});

test('타이포 정본은 config/cards.json 이다', () => {
  // 폰트를 스크립트마다 박아 두면 인트로와 아웃트로가 갈라진다.
  const intro = loadCardConfig('intro');
  const outro = loadCardConfig('outro');
  assert.equal(intro.fontFamily, 'BM DoHyeon OTF', '2026-08-14 운영자 채택 폰트');
  assert.equal(intro.treatment.stroke, 14);
  assert.equal(outro.fontFamily, intro.fontFamily, '두 카드가 같은 타이포여야 한다');
  assert.ok(Array.isArray(outro.cta) && outro.cta.length, '아웃트로에는 CTA 가 있어야 한다');
});

test('줄바꿈이 살아 있어야 한다', () => {
  // 2026-08-14: .tline 을 inline-block 으로 두는 바람에 줄들이 나란히 붙어
  // "사상 최고치인데AMD는 왜" 가 됐다. 폰트 폭이 좁을수록 잘 터진다.
  const html = build();
  assert.match(html, /\.tline \{\s*display: block;/,
    'display:block 이 아니면 줄바꿈이 사라진다');
  assert.equal((html.match(/class="tline"/g) || []).length, 3, '| 로 나눈 3줄');
});

test('볼드는 외곽선으로 낸다 — 배민 폰트는 font-weight 가 안 먹는다', () => {
  const html = build();
  assert.match(html, /-webkit-text-stroke: 14px/);
  assert.match(html, /paint-order: stroke fill/, '획 안쪽을 먹지 않게 해야 한다');
});

test('강조는 색으로만 감싸고 원문을 바꾸지 않는다', () => {
  assert.equal(markupTitle('**8%** 빠졌나', '#FFC53D'),
    '<em style="color:#FFC53D">8%</em> 빠졌나');
  assert.equal(markupTitle('강조 없음', '#FFC53D'), '강조 없음');
});

test('칩은 글자를 덮지 않는다', () => {
  const { extra } = treatmentCss({ chip: true }, CARD_STYLE.accent);
  assert.match(extra, /display: inline-block/);
  assert.match(extra, /padding: \.04em \.2em \.1em/, '세로 여백이 있어야 글자가 안 잘린다');
});

test('아웃트로에만 CTA 가 붙는다', () => {
  const withCta = build({ cta: ['구독', '좋아요', '알림'], ctaLead: '이 영상이 도움됐다면' });
  assert.match(withCta, /class="cta-btn primary">구독</, '첫 항목만 채운다');
  assert.match(withCta, /이 영상이 도움됐다면/);
  // CSS 규칙(.cta-row{…})은 항상 스타일시트에 있으므로 **노드** 존재로 판정한다.
  assert.match(withCta, /<div id="cta"/);
  assert.doesNotMatch(build(), /<div id="cta"/, '인트로에는 CTA 노드가 없어야 한다');
});

test('타이틀이 길면 크기를 줄인다', () => {
  const short = layoutTitle('짧다');
  const long = layoutTitle('아주 긴 타이틀이 여기에 들어가면 어떻게 되는가 보자');
  assert.ok(short.fontSize > long.fontSize, `${short.fontSize} > ${long.fontSize}`);
  assert.ok(long.fontSize >= 56, '최소 크기 아래로는 안 내려간다');
});

// ── 문안 파생 ────────────────────────────────────────────────────────────

test('카드 문안은 문장부호로 끝나지 않고 수치를 강조한다', () => {
  const t = toCardText('코스피 +2.42%, 7000선 턱밑');
  assert.ok(!/[.,·]$/.test(t), t);
  assert.match(t, /\*\*/, '수치 하나는 강조돼야 한다');
});

test('brief 지정이 대본 파생보다 우선한다', () => {
  const scenes = [{ role: 'hook', subtitle_text: '대본에서 온 문장' },
    { role: 'insight', subtitle_text: '통찰 문장' }];
  const brief = { thumbnail: { intro_headline_text: '지정 타이틀', outro_definition: '지정 정의' } };
  assert.equal(deriveIntro(brief, scenes).title, '지정 타이틀');
  assert.equal(deriveOutro(brief, scenes).title, '지정 정의');
});

test('아웃트로 폴백은 cta 씬을 쓰지 않는다', () => {
  // "팔로우하세요" 는 정의가 아니다.
  const scenes = [
    { role: 'hook', subtitle_text: '훅' },
    { role: 'insight', subtitle_text: '진짜 동력은 환율이었다' },
    { role: 'cta', subtitle_text: '매일 신호 놓치기 싫으면 팔로우하세요' },
  ];
  assert.match(deriveOutro({}, scenes).title, /환율/);
});

test('S7 이전에 카드 단계가 파이프라인에 들어 있다', () => {
  assert.match(PRODUCE, /BT_CARD_ENGINE \|\| 'hyperframes'/, '기본이 HyperFrames 여야 한다');
  assert.match(PRODUCE, /generate-cards\.js/);
  const card = PRODUCE.indexOf('generate-cards.js');
  const render = PRODUCE.indexOf('S7 Render');
  assert.ok(card > 0 && card < render, '카드는 렌더보다 먼저 만들어져야 한다');
});
