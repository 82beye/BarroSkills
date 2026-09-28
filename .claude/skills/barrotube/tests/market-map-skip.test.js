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
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('직전 판은 mtime 이 아니라 날짜로 고른다 — 지난 판을 다시 만들어도 안 흔들린다', () => {
  // 예전 구현은 mtime 최대값을 직전 판으로 삼았다. 오늘 판을 만드는 중에는 미래 판이
  // 없어서 맞아떨어졌지만, 지난 판을 백필·수정하면 그 판의 mtime 이 가장 커져서
  // **자기보다 나중 판**을 직전으로 집는다. 2026-09-23 에 테스트가 이 상태로 깨졌다.
  const root = mkdtempSync(join(tmpdir(), 'mm-prior-'));
  try {
    const put = (date, krDate, ageMs) => {
      const dir = join(root, date, 'evening');
      mkdirSync(dir, { recursive: true });
      const p = join(dir, 'data.json');
      writeFileSync(p, JSON.stringify({ krSession: { date: krDate } }));
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(p, t, t);
      return p;
    };
    // 09-19 를 가장 나중에 만졌지만(mtime 최신) 기준일 09-21 의 직전은 09-20 이다.
    put('2026-09-18', 'K18', 90_000);
    put('2026-09-20', 'K20', 60_000);
    const self = put('2026-09-21', 'K21', 30_000);
    put('2026-09-19', 'K19', 0);
    // 기준일보다 나중 판이 있어도 무시해야 한다.
    put('2026-09-22', 'K22', 10_000);

    const prior = priorLeadSession(root, 'evening', self);
    assert.equal(prior.date, '2026-09-20', `mtime 에 끌려갔다: ${prior.date}`);
    assert.equal(prior.session, 'K20');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selfPath 가 없으면 전체에서 가장 나중 판을 본다', () => {
  // 운영 호출은 항상 selfPath 를 준다. 없을 때 죽지 않는지만 확인한다.
  const root = mkdtempSync(join(tmpdir(), 'mm-prior2-'));
  try {
    for (const [d, k] of [['2026-09-18', 'K18'], ['2026-09-20', 'K20']]) {
      mkdirSync(join(root, d, 'evening'), { recursive: true });
      writeFileSync(join(root, d, 'evening', 'data.json'), JSON.stringify({ krSession: { date: k } }));
    }
    const prior = priorLeadSession(root, 'evening', null);
    assert.equal(prior.date, '2026-09-20');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
