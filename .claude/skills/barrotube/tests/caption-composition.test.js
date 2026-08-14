import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCaptionComposition, layoutPhrase, markWords, splitPhrases, STYLE, wordMargin,
} from '../scripts/automation/lib/caption-composition.js';

const TEXT = '삼성전자·SK하이닉스 강세 + 외국인 3조원 순매수, 5거래일 연속 상승';
const build = (over = {}) => buildCaptionComposition({
  text: TEXT, durationSec: 14.4, emphasis: ['외국인', '3조원'],
  fontRel: 'assets/kr.otf', gsapRel: 'assets/gsap.min.js', ...over,
});

const spans = html => [...html.matchAll(/<span id="([^"]+)" class="w( em)?"[^>]*>([^<]*)<\/span>/g)]
  .map(m => ({ id: m[1], em: !!m[2], text: m[3] }));
const sweeps = html => [...html.matchAll(/tl\.to\("#([^"]+)", \{ color: "([^"]+)", scale: ([\d.]+)[^}]*\}, ([\d.]+)\)/g)]
  .map(m => ({ id: m[1], color: m[2], scale: Number(m[3]), at: Number(m[4]) }));

test('색 3종이 레퍼런스 실측값과 같다', () => {
  // ddFFtFylJZE 프레임 실측(1920x1080): 미발화 RGB(252,252,247) / 활성 RGB(148,197,222)
  // / 고정 키워드 RGB(233,221,158). 활성색이 노랑이라고 착각하기 쉬운데 하늘색이다.
  assert.equal(STYLE.base, '#FCFCF7');
  assert.equal(STYLE.active, '#94C5DE');
  assert.equal(STYLE.emphasis, '#FAE477');
});

test('발화가 지나간 단어까지 누적으로 활성화된다', () => {
  const html = build();
  const w = spans(html);
  const s = sweeps(html);
  assert.equal(s.length, w.length, '모든 단어에 활성 시점이 있어야 한다');
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i].at >= s[i - 1].at, `스윕 시점이 뒤로 가면 안 된다: ${s[i - 1].at} → ${s[i].at}`);
  }
  // 되돌리는 트윈이 없어야 "지나간 구간이 그대로 남는다".
  assert.doesNotMatch(html, new RegExp(`color: "${STYLE.base}"`), '활성 후 흰색으로 되돌리면 안 된다');
});

test('고정 키워드는 스윕이 지나가도 노랑을 유지한다', () => {
  const html = build();
  const byId = Object.fromEntries(spans(html).map(x => [x.id, x]));
  for (const s of sweeps(html)) {
    const expected = byId[s.id].em ? STYLE.emphasis : STYLE.active;
    assert.equal(s.color, expected, `${byId[s.id].text} 의 활성색`);
  }
  assert.deepEqual(spans(html).filter(x => x.em).map(x => x.text), ['외국인', '3조원', '5거래일']);
});

test('활성 확대가 옆 단어를 덮지 않는다', () => {
  // 2026-08-14: transform-origin 50% 로 확대하면 단어 폭의 (scale-1)/2 만큼 양옆으로 번진다.
  // 11자 단어를 1.08 배 하면 한쪽으로 0.44em — 공백 한 칸(0.16em)을 덮어
  // "삼성전자·SK하이닉스강세" 로 붙어 보였다. 글자수에 비례한 margin 으로 상쇄한다.
  const spread = n => ((STYLE.activeScale - 1) / 2) * n;
  for (const n of [2, 5, 11, 20]) {
    assert.ok(wordMargin(n) >= spread(n) - 1e-9, `${n}자 단어: margin ${wordMargin(n)} < 번짐 ${spread(n)}`);
  }
  assert.ok(wordMargin(1) >= 0.15, '짧은 단어도 공백 한 칸은 유지');

  // 간격을 공백 문자로 되돌리면 같은 버그가 재발한다.
  const html = build();
  assert.match(html, /<\/span><span id=/, '단어 사이에 공백 문자를 넣으면 안 된다');
  assert.match(html, /style="margin:0 [\d.]+em"/, '단어마다 계산된 margin 이 붙어야 한다');
});

test('강조 판정은 문구 단위다 — 줄마다 리드 폴백이 또 돌면 안 된다', () => {
  // 줄 단위로 판정하면 키워드가 없는 줄에서 첫 단어가 억지로 노랗게 되어
  // 한 문구에 노란 덩어리가 두 개 생긴다.
  const html = build();
  const em = spans(html).filter(x => x.em).map(x => x.text);
  assert.ok(!em.includes('삼성전자·SK하이닉스'), '키워드가 아닌 줄 첫 단어가 강조되면 안 된다');
});

test('강조가 하나도 없으면 앞머리를 올리되 한 글자는 건너뛴다', () => {
  const m = markWords('미 PPI 예상 하회', []);
  assert.equal(m.find(x => x.emphasis).text, 'PPI', '"미" 같은 한 글자는 리드로 쓰지 않는다');
});

test('한 씬 안에서 글자 크기가 문구마다 달라지지 않는다', () => {
  const html = build();
  const sizes = new Set([...html.matchAll(/style="font-size:(\d+)px"/g)].map(m => m[1]));
  assert.equal(sizes.size, 1, `문구마다 크기가 다르면 눈에 띈다: ${[...sizes].join(', ')}`);
});

test('알약은 텍스트 폭만큼만 늘어난다', () => {
  // 레퍼런스는 풀와이드 바가 아니라 글자를 감싸는 알약이다.
  const html = build();
  assert.match(html, /\.pill \{[^}]*display: inline-block/);
  assert.match(html, /\.pill \{[^}]*border-radius: 999px/);
  assert.doesNotMatch(html, /-webkit-text-stroke/, '레퍼런스는 외곽선이 없다 — 대비는 알약이 만든다');
});

test('긴 문구는 두 줄까지 쪼개되 크기를 먼저 낮춘다', () => {
  const short = layoutPhrase('코스피 상승');
  assert.equal(short.lines.length, 1);
  assert.equal(short.fontSize, 72);
  const long = layoutPhrase('삼성전자·SK하이닉스 강세 + 외국인 3조원 순매수,');
  assert.ok(long.lines.length <= 2, `두 줄을 넘으면 안 된다: ${long.lines.length}`);
});

test('문구 분리에 · 를 쓰지 않는다', () => {
  // "기본 칩 · 메모리 32GB" 처럼 레퍼런스도 한 문구 안에서 쓴다. 여기서 자르면 "삼성전자·" 같은
  // 조각이 알약 하나를 차지한다.
  const ph = splitPhrases(TEXT, 14.4);
  assert.ok(!ph.some(p => p.text.endsWith('·')), ph.map(p => p.text).join(' | '));
});

test('타임라인 등록이 있어야 렌더가 돈다', () => {
  assert.match(build(), /window\.__timelines\["main"\] = tl;/);
});
