import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameHookPatterns } from '../scripts/automation/analyze-competitors.js';

const OUTLIERS = Array.from({ length: 5 }, (_, i) => ({
  title: `[속보] 사건 ${i}`, multiple: 4 + i, channel: '슈카월드', length_bucket: 'mid',
}));
const FEATURES = [{ feature: 'has_bracket', direction: 'positive', lift: 1.63 }];

/** globalThis.fetch 를 갈아끼우고 원복한다. */
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const geminiOk = (payload) => async () => ({
  ok: true, status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 400 },
  }),
});

test('LLM is skipped below the outlier threshold — no call, no cost', async () => {
  let called = false;
  await withFetch(async () => { called = true; throw new Error('must not be called'); }, async () => {
    const r = await nameHookPatterns(OUTLIERS.slice(0, 2), FEATURES);
    assert.equal(r.used, false);
    assert.deepEqual(r.patterns, []);
    assert.match(r.note, /3건 미만/);
  });
  assert.equal(called, false, 'fewer than 3 outliers must not reach the network');
});

test('a well-formed response is parsed, capped at 5 and normalised', async () => {
  const payload = {
    hook_patterns: Array.from({ length: 8 }, (_, i) => ({
      pattern: `패턴 ${i}`,
      evidence_titles: ['a', 'b', 'c', 'd'],
      applicable_to_us: i !== 1,
      why_not: i === 1 ? '3분 포맷에 안 맞음' : undefined,
    })),
  };
  await withFetch(geminiOk(payload), async () => {
    const r = await nameHookPatterns(OUTLIERS, FEATURES);
    assert.equal(r.used, true);
    assert.equal(r.patterns.length, 5, 'capped at 5');
    assert.equal(r.patterns[0].evidence_titles.length, 3, 'evidence capped at 3');
    assert.equal(r.patterns[1].applicable_to_us, false);
    assert.equal(r.patterns[1].why_not, '3분 포맷에 안 맞음');
    assert.equal(r.patterns[0].why_not, null, 'why_not only when inapplicable');
  });
});

test('malformed entries are dropped rather than propagated', async () => {
  const payload = { hook_patterns: [
    { pattern: '진짜 패턴' },
    { evidence_titles: ['x'] },          // pattern 없음
    { pattern: 123 },                     // 문자열 아님
    null,
  ] };
  await withFetch(geminiOk(payload), async () => {
    const r = await nameHookPatterns(OUTLIERS, FEATURES);
    assert.equal(r.patterns.length, 1);
    assert.equal(r.patterns[0].pattern, '진짜 패턴');
  });
});

test('429 is retried once and then fails soft without throwing', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return { ok: false, status: 429 }; }, async () => {
    const r = await nameHookPatterns(OUTLIERS, FEATURES);
    assert.equal(r.used, false);
    assert.deepEqual(r.patterns, [], 'analysis must survive a rate limit');
    assert.match(r.note, /429/);
  });
  assert.equal(calls, 2, 'exactly one retry');
});

test('non-JSON output fails soft', async () => {
  const bad = async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json at all' }] } }] }),
  });
  await withFetch(bad, async () => {
    const r = await nameHookPatterns(OUTLIERS, FEATURES);
    assert.equal(r.used, false);
    assert.match(r.note, /JSON/);
  });
});

test('a network throw never escapes — the analysis keeps going', async () => {
  await withFetch(async () => { throw new Error('socket hang up'); }, async () => {
    const r = await nameHookPatterns(OUTLIERS, FEATURES);
    assert.equal(r.used, false);
    assert.match(r.note, /socket hang up/);
  });
});
