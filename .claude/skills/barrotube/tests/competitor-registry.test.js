import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CONFIG = join(ROOT, 'config', 'competitor-channels.json');
const ROUTINES = join(ROOT, 'config', 'routines.json');
const AUTOMATION = join(ROOT, 'scripts', 'automation');

const policy = JSON.parse(readFileSync(CONFIG, 'utf-8'));
// 슬롯 목록을 여기 박아 두면 새 슬롯을 열 때마다 이 파일도 같이 고쳐야 한다.
// 2026-08-30 realestate 슬롯 개설이 정확히 그 이유로 실패했다 — routines.json 에서 파생시킨다.
const VALID_SLOTS = Object.keys(JSON.parse(readFileSync(ROUTINES, 'utf-8')).slots);

test('competitor policy is v3.0 with a static channel list', () => {
  assert.equal(policy.version, '3.0');
  assert.ok(Array.isArray(policy.channels), 'channels[] must be the source of truth');
  assert.ok(policy.channels.length >= 6, `expected >= 6 channels, got ${policy.channels.length}`);
});

test('every channel carries the fields collection depends on', () => {
  for (const c of policy.channels) {
    assert.ok(c.id, `missing id: ${JSON.stringify(c)}`);
    assert.ok(c.name, `missing name for ${c.id}`);
    assert.ok(c.handle?.startsWith('@'), `handle must start with @: ${c.id} → ${c.handle}`);
    assert.ok(Array.isArray(c.competes_with), `competes_with must be an array: ${c.id}`);
    for (const slot of c.competes_with) {
      assert.ok(VALID_SLOTS.includes(slot), `unknown slot "${slot}" on ${c.id} (routines.json 의 슬롯: ${VALID_SLOTS.join(', ')})`);
    }
    assert.ok(['core', 'watch'].includes(c.tier), `unknown tier "${c.tier}" on ${c.id}`);
  }
});

test('channelId is either a well-formed UC id or explicitly null', () => {
  for (const c of policy.channels) {
    if (c.channelId === null) continue;
    assert.match(c.channelId, /^UC[\w-]{22}$/, `malformed channelId on ${c.id}: ${c.channelId}`);
  }
});

test('channel ids and UC ids are unique', () => {
  const ids = policy.channels.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate channel id');

  const ucs = policy.channels.map((c) => c.channelId).filter(Boolean);
  assert.equal(new Set(ucs).size, ucs.length, 'duplicate UC id — two entries point at one channel');
});

test('quota policy self-limits well below the free daily allowance', () => {
  assert.ok(policy.quota?.daily_cap_units > 0);
  assert.ok(policy.quota.daily_cap_units <= 10000, 'cap must sit inside the free quota');
  const active = policy.channels.filter((c) => c.active !== false).length;
  assert.ok(active * 3 < policy.quota.daily_cap_units, 'a normal scan must never approach the cap');
});

test('marketing-report extraction is demoted to opt-in discovery', () => {
  assert.equal(policy.discovery?.enabled, false, 'discovery must not feed collection');
  assert.ok(Array.isArray(policy.discovery?.channel_name_patterns), 'v2.0 regexes are preserved for --suggest');
  assert.equal(policy.extraction, undefined, 'v2.0 extraction block must not drive v3.0');
});

test('loadCompetitorChannels resolves the static list without network access', async () => {
  const { resolveCompetitorChannels } = await import('../scripts/automation/resolve-competitor-channels.js');
  const r = await resolveCompetitorChannels({ accessToken: null, allowResolve: false });

  assert.equal(r.reports.length, 0, 'v3.0 must not read marketing reports');
  const activeCount = policy.channels.filter((c) => c.active !== false).length;
  assert.equal(r.channels.length, activeCount, 'inactive channels are excluded');

  for (const c of r.channels) {
    assert.ok(['config', 'cache', 'manual_override', 'unresolved'].includes(c.resolved_via));
    assert.ok(Array.isArray(c.sources), 'sources must stay an array — CLI joins it');
  }
});

test('no automation script references the ghost paperclip/ directory', () => {
  // 2026-05-24~08-13 의 80일 무음 실패 원인. 회귀하면 수집이 다시 조용히 죽는다.
  const offenders = [];
  for (const f of readdirSync(AUTOMATION).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(AUTOMATION, f), 'utf-8');
    // 코드 경로만 본다 — 주석 안의 설명 문구는 허용
    const codeHits = src
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      // 'paperclip' 세그먼트 · 'paperclip/…' · '../../paperclip/…' 를 모두 잡는다
      .filter((line) => /(['"`]|\/)paperclip(['"`]|\/)/.test(line));
    if (codeHits.length) offenders.push(`${f}: ${codeHits[0].trim()}`);
  }
  assert.deepEqual(offenders, [], `ghost paperclip/ path in code:\n${offenders.join('\n')}`);
});
