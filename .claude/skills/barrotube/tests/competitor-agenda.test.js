import assert from 'node:assert/strict';
import test from 'node:test';

import { agendaTokens, competitorAgenda } from '../scripts/automation/lib/competitor-agenda.js';

/**
 * 2026-09-16 운영자 지적의 회귀 방지.
 * 같은 날 경쟁사 3곳이 「10년물 금리 5% 터치」를 헤드라인으로 냈는데 우리 토픽 선정이 못 봤다.
 * 기존 분석은 토큰 빈도 갭이라 「이렇게·겁니다·1부」를 상위로 내놨다.
 */
const ch = (name, competes, titles, base = '2026-09-15T00:00:00Z') => ({
  resolved: { name, competes_with: competes },
  recent_videos: titles.map((t, i) => ({
    title: t, publishedAt: new Date(Date.parse(base) + i * 3600_000).toISOString(),
  })),
});

test('수치+단위는 쪼개지 않고 한 토큰으로 잡는다', () => {
  const toks = agendaTokens('10년물 금리 5% 터치');
  assert.ok(toks.includes('5%'), '「5%」가 통째로 남아야 한다');
  assert.equal(toks.includes('5'), false, '단위 없는 숫자만 따로 세지 않는다');
});

test('흔한 말은 의제가 아니다', () => {
  const toks = agendaTokens('지금 안 팔면 이렇게 됩니다');
  for (const junk of ['이렇게', '됩니다', '지금']) assert.equal(toks.includes(junk), false, `${junk} 는 걸러야 한다`);
});

test('한 채널이 반복한 건 사건이 아니고, 여러 채널이 말한 게 사건이다', () => {
  const snap = { fetched_at: '2026-09-15T06:00:00Z', channels: {
    0: ch('A', ['us-close'], ['10년물 금리 5% 터치, 연준 결정은', '국채금리 5% 돌파, 시장 반응은']),
    1: ch('B', ['us-close'], ['금리 5% 뚫렸다, 반도체 약세']),
    2: ch('C', ['us-close'], ['오늘도 삼겹살 먹방 특집입니다']),
  } };
  const r = competitorAgenda(snap, new Date('2026-09-15T06:00:00Z'), { minChannels: 2, slot: 'us-close' });
  assert.equal(r.agenda[0].token, '5%', `1순위가 5% 여야 한다 — 실제 ${JSON.stringify(r.agenda.slice(0,2))}`);
  assert.equal(r.agenda[0].channels, 2, '서로 다른 채널 2곳');
  assert.equal(r.agenda.some((a) => a.token === '삼겹살'), false, '한 채널만 말한 건 의제가 아니다');
});

test('슬롯이 다른 채널은 세지 않는다 — 부동산 21곳이 us-close 의제를 먹지 않게', () => {
  const snap = { fetched_at: '2026-09-15T06:00:00Z', channels: {
    0: ch('시장A', ['us-close'], ['10년물 금리 5% 터치']),
    1: ch('시장B', ['us-close'], ['금리 5% 돌파']),
    2: ch('부동A', ['realestate'], ['집값 전망 이렇게 됩니다 집값']),
    3: ch('부동B', ['realestate'], ['집값 폭락 시나리오, 집값']),
    4: ch('부동C', ['realestate'], ['집값 바닥은 언제, 집값']),
  } };
  const us = competitorAgenda(snap, new Date('2026-09-15T06:00:00Z'), { minChannels: 2, slot: 'us-close' });
  assert.equal(us.agenda[0].token, '5%');
  assert.equal(us.agenda.some((a) => a.token === '집값'), false, '부동산 채널은 us-close 에 안 섞인다');

  const re = competitorAgenda(snap, new Date('2026-09-15T06:00:00Z'), { minChannels: 2, slot: 'realestate' });
  assert.equal(re.agenda[0].token, '집값');
});

test('수집 시점보다 오래된 영상은 창 밖이다', () => {
  const snap = { fetched_at: '2026-09-15T06:00:00Z', channels: {
    0: ch('A', ['us-close'], ['금리 5% 터치'], '2026-09-01T00:00:00Z'),
    1: ch('B', ['us-close'], ['금리 5% 돌파'], '2026-09-01T00:00:00Z'),
  } };
  const r = competitorAgenda(snap, new Date('2026-09-15T06:00:00Z'), { minChannels: 2, windowHours: 30 });
  assert.equal(r.videos_scanned, 0, '2주 전 영상은 오늘 의제가 아니다');
  assert.equal(r.agenda.length, 0);
});
