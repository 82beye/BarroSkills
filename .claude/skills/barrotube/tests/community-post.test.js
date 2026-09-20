/**
 * 커뮤니티 게시글 본문 — 카드와 같은 facts() 를 쓰는지, 판에 맞는 시장을 앞세우는지.
 *
 * 이 글은 카드와 함께 채널에 나간다. 숫자가 조용히 비면 「+undefined%」 같은 게
 * 그대로 발행된다 — 2026-09-18 조간이 코스피 전 종목 +0.00% 로 나갈 뻔한 것과 같은 계열.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { facts } from '../scripts/automation/market-magazine.js';
import { postBody } from '../scripts/automation/community-post.js';

const ROOT = resolve(import.meta.dirname, '..');
const CFG = JSON.parse(readFileSync(join(ROOT, 'config', 'market-map.json'), 'utf-8'));
const load = (date, ed) => JSON.parse(readFileSync(
  join(ROOT, CFG.output_dir, date, ed, 'data.json'), 'utf-8'));

const bodyFor = (date, ed) => postBody(facts(load(date, ed), new Date(`${date}T08:00:00+09:00`), ed));

test('조간은 미국장을, 석간은 코스피를 앞세운다', () => {
  const morning = bodyFor('2026-09-18', 'morning');
  const evening = bodyFor('2026-09-17', 'evening');
  assert.match(morning.split('\n')[0], /미국장 마감/);
  assert.match(evening.split('\n')[0], /코스피 마감/);
  // 반대쪽 시장도 한 줄은 들어간다 — 두 시장을 한 판에 싣는 게 이 카드뉴스의 골자다.
  assert.match(morning, /같은 시각 코스피/);
  assert.match(evening, /직전 미국장/);
});

test('빈 수치를 발행하지 않는다', () => {
  for (const [date, ed] of [['2026-09-18', 'morning'], ['2026-09-17', 'evening']]) {
    const b = bodyFor(date, ed);
    assert.doesNotMatch(b, /undefined|NaN|null/, `${date} ${ed} 에 빈 값이 있다`);
    // 등락률은 부호를 달고 나온다. 「0.00%」 가 전부인 판은 다시 나오면 안 된다.
    assert.ok(/[+-]\d+\.\d\d%/.test(b), `${date} ${ed} 에 등락률이 없다`);
    assert.ok(!/^(?:.*[+-]0\.00%.*){6,}$/s.test(b), `${date} ${ed} 가 전부 보합이다 — 장 시작 전 값을 실었다`);
  }
});

test('본문 숫자는 카드가 쓰는 facts() 에서 그대로 온다', () => {
  const f = facts(load('2026-09-18', 'morning'), new Date(), 'morning');
  const b = postBody(f);
  const pct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
  assert.ok(b.includes(`${f.usLead.name} ${pct(f.usLead.pct)}`), '대표 상승 업종이 카드와 다르다');
  assert.ok(b.includes(`${f.usTail.name} ${pct(f.usTail.pct)}`), '대표 하락 업종이 카드와 다르다');
  assert.ok(b.includes(`${f.usTop[0].t} ${pct(f.usTop[0].pct)}`), '최상위 종목이 카드와 다르다');
});

test('게시 확인은 「없던 링크」로 새 글을 찾는다 — 맨 위를 믿지 않는다', () => {
  // 새 글이 목록에 뜨기 전의 맨 위는 직전 판이고 그것도 카드 10장짜리다. 맨 위만 보면
  // 게시가 실패해도 통과한다 — 2026-09-18 석간이 그렇게 조간 URL 을 기록했다.
  const src = readFileSync(join(ROOT, 'scripts', 'automation', 'community-post.js'), 'utf-8');
  assert.match(src, /known\.indexOf\(href\)\s*>=\s*0/, '게시 전 링크 스냅샷과 대조하지 않는다');
  assert.match(src, /const known = evalJSON\(tab, jsLinks\);[\s\S]{0,200}jsClick\('게시'\)/,
    '링크 스냅샷을 「게시」 클릭 전에 찍지 않는다');
});

test('게시 확인은 DOM 으로 이미지를 센다 — __data 만 믿지 않는다', () => {
  // __data.data 는 게시 직후 그 순간에만 채워진다. 새로 로드한 페이지에서는 0 이라
  // 그것만 보면 「게시는 됐는데 검증 실패」가 되고, posted.json 이 안 남아 다음 실행이
  // 같은 판을 또 올린다. 2026-09-18 실측으로 확인한 함정이라 회귀를 막아 둔다.
  const src = readFileSync(join(ROOT, 'scripts', 'automation', 'community-post.js'), 'utf-8');
  const verify = src.slice(src.indexOf('const jsVerifyNew'), src.indexOf('/* ── 실행'));
  assert.match(verify, /querySelectorAll\('ytd-backstage-image-renderer'\)/,
    '게시 확인이 DOM 으로 이미지를 세지 않는다');
});
