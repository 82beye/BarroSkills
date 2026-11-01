import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN_CONTRACT, loadPlan, ladderFor, holdFor, seedColdStart, pickRung } from '../scripts/automation/paperclip/quota-plan.js';

const NOW = Date.parse('2026-10-29T03:00:00Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const plan = (extra = {}) => ({ schema: PLAN_CONTRACT.schema, rev: 3, mode: 'auto', day: '2026-10-29',
  generatedAt: iso(-60_000), validUntil: iso(26 * 3_600_000), hardExpiry: iso(48 * 3_600_000), agents: {}, ...extra });

function planFile(t, value) {
  const dir = mkdtempSync(join(tmpdir(), 'barrojo-plan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'plan.json');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

test('loading a plan never throws and labels every failure', (t) => {
  assert.equal(loadPlan({ now: NOW, file: '/nonexistent/plan.json' }).status, 'absent');
  assert.equal(loadPlan({ now: NOW, file: planFile(t, '{broken') }).status, 'invalid');
  assert.equal(loadPlan({ now: NOW, file: planFile(t, { ...plan(), schema: 'other' }) }).status, 'invalid');
  assert.equal(loadPlan({ now: NOW, file: planFile(t, plan()), lastRev: 4 }).error, 'older rev 3 < 4');
  assert.equal(loadPlan({ now: NOW, file: planFile(t, plan({ generatedAt: iso(3_600_000) })) }).status, 'invalid', '미래 시각');
  assert.equal(loadPlan({ now: NOW + 49 * 3_600_000, file: planFile(t, plan()) }).status, 'expired');
  assert.equal(loadPlan({ now: NOW + 27 * 3_600_000, file: planFile(t, plan()) }).status, 'stale');
  assert.equal(loadPlan({ now: NOW, file: planFile(t, plan({ mode: 'shadow' })) }).status, 'shadow');
  assert.equal(loadPlan({ now: NOW, file: planFile(t, plan()) }).status, 'applied');
});

test('ladders keep only allowlisted rungs, the reviewer family, and the company scope', () => {
  const ladder = [
    { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    { provider: 'claude', model: 'claude-fable-5-1', effort: 'high' },
    { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'xhigh' },
    { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
    { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  ];
  const p = plan({ agents: { a: { ladder } }, scope: { companies: ['co1'] } });
  assert.deepEqual(ladderFor(p, { id: 'a', companyId: 'co1' }), [ladder[0], ladder[3]], 'Fable·허용 밖 노력·중복 제외');
  assert.deepEqual(ladderFor(p, { id: 'a', companyId: 'co1' }, { reviewerFamily: 'codex' }), [ladder[3]]);
  assert.equal(ladderFor(p, { id: 'a', companyId: 'co2' }), null, '범위 밖 회사');
  assert.equal(ladderFor(p, { id: 'missing', companyId: 'co1' }), null);
});

test('plan holds never apply to managerless agents and last at most a day', () => {
  const p = plan({ agents: { ceo: { hold: { until: iso(3_600_000), reason: 'x' } }, eng: { hold: { until: iso(5 * 86_400_000), reason: '긴축' } } } });
  assert.equal(holdFor(p, { id: 'ceo' }, NOW), null);
  assert.equal(holdFor(p, { id: 'eng', reportsTo: 'ceo' }, NOW).until, iso(86_400_000));
  assert.equal(holdFor(plan({ agents: { eng: { hold: { until: iso(-1) } } } }), { id: 'eng', reportsTo: 'ceo' }, NOW), null);
});

test('untried cheaper models borrow the nearest stronger budget instead of the family maximum', () => {
  const est = { claude: { models: { 'claude-opus-5-5': { percentBudget: 5, samples: 70 }, 'claude-sonnet-5-5': { percentBudget: 1.2, samples: 18 } }, maxBudgetPercent: 12.6 },
    codex: { models: { 'gpt-6.1-sol': { percentBudget: 5, samples: 100 } }, maxBudgetPercent: 10.4 } };
  seedColdStart(est);
  assert.equal(est.claude.models['claude-haiku-5-5'].percentBudget, 1.2);
  assert.equal(est.codex.models['gpt-6.1-terra'].percentBudget, 5);
  assert.equal(est.codex.models['gpt-6-luna'].budgetSource, 'seeded-from-gpt-6.1-sol');
  assert.equal(est.codex.models['gpt-6-astra'], undefined, '더 비싼 미시도 모델은 그대로');
});

test('picking follows the ladder but keeps the current rung through in-flight swings, gaps, caps and cooldowns', () => {
  const opus = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
  const sonnet = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' };
  const sol = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
  const ok = { allow: true, usedPercent: 10, modelBudgetPercent: 5, admissionLimitPercent: 65 };
  const spent = { allow: false, usedPercent: 63, modelBudgetPercent: 5, admissionLimitPercent: 65, reason: 'projected-use-exceeds-buffer' };
  const inflight = { allow: false, usedPercent: 20, modelBudgetPercent: 5, admissionLimitPercent: 65, pendingPercent: 45, reason: 'projected-use-exceeds-buffer' };
  const pick = (current, assess, record = {}) => pickRung(current, 'claude', [opus, sonnet, sol], (r) => assess(r), record, NOW);
  assert.deepEqual(pick(opus, () => ok).selected.model, 'claude-opus-5-5');
  assert.equal(pick(sonnet, () => ok).selected.model, 'claude-opus-5-5', '위 칸으로 — 직전 변경 없음');
  assert.equal(pick(sonnet, () => ok, { lastPlanChangeAt: iso(-10 * 60_000) }).sticky, 'plan:step-up-wait');
  assert.equal(pick(opus, () => inflight).selected.model, 'claude-opus-5-5', '진행 중 예약만이면 그대로');
  assert.equal(pick(opus, () => ({ allow: false, reason: 'weekly-quota-unavailable-or-stale' })).sticky, 'plan:measurement-unavailable');
  const claudeSpent = (r) => (r.provider === 'claude' ? spent : ok);
  assert.equal(pick(opus, claudeSpent).selected.provider, 'codex', '홈이 바닥나면 다른 계열');
  assert.equal(pick(opus, claudeSpent, { lastSwitchAt: iso(-30 * 60_000) }).selected, null, '바닥나도 전환은 60분에 한 번');
  const day = new Date(NOW + 9 * 3_600_000).toISOString().slice(0, 10);
  assert.equal(pick(sonnet, () => ok, { planChangesDay: day, planChanges: 2 }).sticky, 'plan:daily-change-cap');
  assert.equal(pickRung(sonnet, 'claude', [sol, sonnet], () => ok, { lastSwitchAt: iso(-3 * 3_600_000) }, NOW).selected.model, 'claude-sonnet-5-5',
    '계획에 따른 계열 전환은 하루에 한 번 — 그사이에는 같은 계열 칸');
});
