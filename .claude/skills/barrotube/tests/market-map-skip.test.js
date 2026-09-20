/**
 * 같은 마감을 두 번 싣지 않는다.
 *
 * 2026-09-19~20 주말에 금요일(9/18) 마감이 네 번 나갈 뻔했다 — 토 석간·일 조간·일 석간이
 * 전부 같은 세션이었다. 숫자는 거짓이 아니지만 구독자는 같은 카드를 반복해 받는다.
 * 달력으로 막지 않는다: 선도 시장(조간=미국, 석간=코스피) 세션이 직전 같은 판과 같으면 거른다.
 * 휴장일·연휴와 「월요일 조간」(미국은 아직 금요일 마감)도 같은 규칙에 걸린다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { priorLeadSession } from '../scripts/automation/market-map.js';
import { EDITIONS } from '../scripts/automation/lib/market-map.js';

const ROOT = resolve(import.meta.dirname, '..');
const CFG = JSON.parse(readFileSync(join(ROOT, 'config', 'market-map.json'), 'utf-8'));
const OUT = join(ROOT, CFG.output_dir);
const leadOf = (d, ed) => (EDITIONS[ed].leads === 'us' ? d.usSession : d.krSession?.date);
const load = (date, ed) => JSON.parse(readFileSync(join(OUT, date, ed, 'data.json'), 'utf-8'));

test('판 종류마다 선도 시장이 정해져 있다', () => {
  assert.equal(EDITIONS.morning.leads, 'us');
  assert.equal(EDITIONS.evening.leads, 'kr');
});

test('주말 석간은 금요일 코스피 마감을 되싣는다 — 걸러야 하는 조건', () => {
  const fri = load('2026-09-18', 'evening');
  const sat = load('2026-09-19', 'evening');
  assert.equal(leadOf(fri, 'evening'), leadOf(sat, 'evening'),
    '금·토 석간의 코스피 세션이 달라졌다면 이 회귀 테스트의 전제를 다시 봐야 한다');
});

test('토요일 조간은 금요일 미국 마감이라 살려야 한다', () => {
  const fri = load('2026-09-18', 'morning');
  const sat = load('2026-09-19', 'morning');
  assert.notEqual(leadOf(fri, 'morning'), leadOf(sat, 'morning'),
    '토요일 조간까지 걸러 버리면 금요일 미국 마감이 통째로 빠진다');
});

test('priorLeadSession 은 같은 종류의 직전 판만 본다', () => {
  const selfPath = join(OUT, '2026-09-20', 'evening', 'data.json');
  const prior = priorLeadSession(OUT, 'evening', selfPath);
  assert.ok(prior, '직전 석간을 못 찾았다');
  // 석간끼리 비교해야 한다 — 조간은 미국을 싣기 때문에 섞으면 판정이 뒤집힌다.
  const sat = load('2026-09-19', 'evening');
  assert.equal(prior.session, leadOf(sat, 'evening'));
});

test('크론은 종료코드 10 을 실패가 아니라 「거른 판」으로 다룬다', () => {
  const sh = readFileSync(join(ROOT, 'lib', 'market-map-cron.sh'), 'utf-8');
  assert.match(sh, /RC.*-eq 10.*exit 0|if \[ "\$RC" -eq 10 \]; then exit 0; fi/,
    '거른 판이 크론 실패로 잡히면 매 주말 실패 알림이 온다');
});
