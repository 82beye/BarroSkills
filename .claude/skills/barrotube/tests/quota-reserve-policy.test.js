import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeQuota, modelEstimates, assessCandidate, PIPELINE_CALL_PERCENT } from '../scripts/automation/paperclip/quota-reserve-policy.js';

const NOW = Date.parse('2026-10-26T03:15:00Z');
const stamp = (offset = 0) => new Date(NOW + offset).toISOString();
const WEEK = stamp(6 * 86_400_000);
const quota = (used = 20, extra = {}) => ({ weekUsedPercent: used, weekResetAt: WEEK, sessionUsedPercent: 10, measuredAt: stamp(), source: 'test', modelWindows: [], ...extra });
const assess = (used, extra = {}) => assessCandidate({ provider: 'codex', model: 'gpt-6.1-sol', providers: { codex: quota(used) }, now: NOW, ...extra });
const row = (windows, extra = {}) => ({ provider: 'openai', ok: true, windows, ...extra });
const window = (label, usedPercent = 20, resetsAt = WEEK, extra = {}) => ({ label, usedPercent, resetsAt, ...extra });
const run = (model, input, extra = {}) => ({ status: 'succeeded', createdAt: stamp(-60_000), usageJson: { model, inputTokens: input, outputTokens: 0 }, ...extra });

test('weekly label and explicit duration stay weekly near reset; session alone does not invent weekly room', () => {
  const near = stamp(60 * 60_000);
  assert.equal(normalizeQuota([row([window('Current week', 69, near)])], { now: NOW }).codex.weekUsedPercent, 69);
  assert.equal(normalizeQuota([row([window('5h limit', 68, near, { windowMinutes: 10080 })])], { now: NOW }).codex.weekUsedPercent, 68);
  const session = normalizeQuota([row([window('Current session', 8, near)])], { now: NOW });
  assert.equal(session.codex.weekUsedPercent, null);
  assert.equal(assessCandidate({ provider: 'codex', model: 'gpt-6.1-sol', providers: session, now: NOW }).allow, false);
});

test('legacy mislabelled 5h week needs distant reset or remembered weekly identity, never generic reset guesses', () => {
  const result = normalizeQuota([row([window('5h limit')])], { now: NOW });
  assert.equal(result.codex.weekUsedPercent, 20);
  assert.match(result.codex.source, /legacy-5h-week/);
  assert.equal(normalizeQuota([row([window('Unknown limit')])], { now: NOW }).codex.weekUsedPercent, null);
  const near = stamp(60 * 60_000);
  const remembered = normalizeQuota([row([window('5h limit', 60, near)])], { now: NOW, accountEvidence: { codex: { weekResetAt: near } } });
  assert.equal(remembered.codex.weekUsedPercent, 60);
  assert.match(remembered.codex.source, /remembered-week/);
});

test('invalid, stale, future and reset-expired snapshots cannot authorize; fresh fallback keeps model buckets', () => {
  const snapshot = { updatedAt: stamp(), rate_limits: { seven_day: { used_percentage: 55, resets_at: WEEK }, seven_day_sonnet: { used_percentage: 67, resets_at: WEEK } } };
  const fresh = normalizeQuota([], { now: NOW, claudeSnapshot: snapshot });
  assert.equal(fresh.claude.weekUsedPercent, 55);
  assert.equal(fresh.claude.modelWindows[0].model, 'sonnet');
  for (const updatedAt of [stamp(-15 * 60_000 - 1), stamp(1), 'invalid']) {
    assert.equal(normalizeQuota([], { now: NOW, claudeSnapshot: { ...snapshot, updatedAt } }).claude.weekUsedPercent, null);
  }
  assert.equal(normalizeQuota([], { now: NOW, claudeSnapshot: { ...snapshot, rate_limits: { seven_day: { used_percentage: 0, resets_at: stamp() } } } }).claude.weekUsedPercent, null);
  assert.equal(normalizeQuota([row([window('Current week')], { measuredAt: stamp(-16 * 60_000) })], { now: NOW }).codex.weekUsedPercent, null);
});

test('Codex snapshot supports explicit window duration and invalid percentages are ignored', () => {
  const codexSnapshot = { updatedAt: stamp(), rate_limits: { secondary: { used_percent: 42, window_minutes: 10080, resets_at: WEEK }, primary: { used_percent: 12, window_minutes: 300, resets_at: stamp(3_600_000) } } };
  assert.equal(normalizeQuota([], { now: NOW, codexSnapshot }).codex.weekUsedPercent, 42);
  for (const used of [-1, 101, NaN, '5']) assert.equal(normalizeQuota([row([window('Current week', used)])], { now: NOW }).codex.weekUsedPercent, null);
});

test('fresh same-window observations keep the higher usage and newer reset does not borrow old allowance', () => {
  const providers = normalizeQuota([row([window('Current week', 60)], { measuredAt: stamp(-60_000) })], { now: NOW, codexSnapshot: { updatedAt: stamp(), week: 58, weekResetAt: WEEK } });
  assert.equal(providers.codex.weekUsedPercent, 60);
  assert.equal(providers.codex.measuredAt, stamp());
});

test('default admission includes 30 reserve plus 5 buffer and 5 cold-start budget', () => {
  assert.equal(assess(60).allow, true);
  assert.equal(assess(60).projectedUsedPercent, 65);
  assert.equal(assess(60.001).allow, false);
  for (const used of [65, 70, 88]) assert.equal(assess(used).allow, false);
  assert.equal(assess(70).reason, 'weekly-reserve-reached');
  assert.equal(assess(70, { p0: true }).allow, false);
  assert.equal(assess(10, { reservePercent: 15 }).allow, false);
});

test('1pp model floor admits exactly projected65, refuses stale/future/reset data', () => {
  const estimates = { codex: { models: { 'gpt-6.1-sol': { percentBudget: 1 } } } };
  assert.equal(assess(64, { estimates }).allow, true);
  assert.equal(assess(64.01, { estimates }).allow, false);
  for (const extra of [{ measuredAt: stamp(-15 * 60_000 - 1) }, { measuredAt: stamp(1) }, { weekResetAt: stamp() }, { weekUsedPercent: null }]) {
    assert.equal(assess(20, { providers: { codex: quota(20, extra) } }).allow, false);
  }
});

test('all same-provider pending work reserves room, duplicate id counted once, explicit releases alone free it', () => {
  const reservations = [{ id: 'a', provider: 'codex', percent: 3, status: 'running', expiresAt: stamp(-1) }, { id: 'a', provider: 'codex', percent: 3 }, { provider: 'codex', percent: 3 }, { provider: 'claude', percent: 99 }, { provider: 'codex', percent: 99, status: 'released' }];
  assert.equal(assess(55, { reservations }).pendingPercent, 6);
  assert.equal(assess(55, { reservations }).allow, false);
  assert.equal(assess(54, { reservations }).allow, true);
  assert.equal(assess(10, { reservations: [{ provider: 'codex', percent: null }] }).allow, false);
});

test('applicable model weekly buckets use maximum versus account and ignore unrelated models', () => {
  const providers = { claude: quota(30, { modelWindows: [{ model: 'sonnet', ...quota(61) }, { model: 'sonnet', ...quota(58) }, { model: 'opus', ...quota(99) }] }) };
  const result = assessCandidate({ provider: 'claude', model: 'claude-sonnet-5-5', providers, now: NOW });
  assert.equal(result.usedPercent, 61);
  assert.equal(result.projectedUsedPercent, 66);
  assert.equal(result.allow, false);
});

test('actual-model P95 normalizes provider-specific cache accounting and retains reported costs only', () => {
  const estimates = modelEstimates([
    run('claude-sonnet-5-5', 100, { usageJson: { model: 'claude-sonnet-5-5', inputTokens: 100, cachedInputTokens: 900, outputTokens: 10, costUsd: 2 } }),
    run('gpt-6.1-sol', 1000, { usageJson: { model: 'gpt-6.1-sol', inputTokens: 1000, cachedInputTokens: 900, outputTokens: 10 } }),
  ], { now: NOW });
  assert.equal(estimates.claude.models['claude-sonnet-5-5'].freshInputTokensP95, 100);
  assert.equal(estimates.codex.models['gpt-6.1-sol'].freshInputTokensP95, 100);
  assert.equal(estimates.claude.models['claude-sonnet-5-5'].totalTokensP95, 1010);
  assert.equal(estimates.codex.models['gpt-6.1-sol'].totalTokensP95, 1010);
  assert.equal(estimates.claude.models['claude-sonnet-5-5'].reportedCostUsdP95, 2);
  assert.equal(estimates.codex.models['gpt-6.1-sol'].reportedCostUsdP95, null);
});

test('high-consumption model reserves more, unknown model keeps at least cold-start or family max, budgets floor1', () => {
  const estimates = modelEstimates([run('gpt-small', 10), run('gpt-middle', 1000), run('gpt-heavy', 10000)], { now: NOW });
  assert.equal(estimates.codex.models['gpt-small'].percentBudget, 1);
  assert.equal(estimates.codex.models['gpt-middle'].percentBudget, 5);
  assert.equal(estimates.codex.models['gpt-heavy'].percentBudget, 50);
  assert.equal(assess(10, { model: 'gpt-unseen', estimates }).modelBudgetPercent, 50);
  assert.equal(assess(10, { estimates: modelEstimates([], { now: NOW }) }).modelBudgetPercent, 5);
});

test('raw usage model is accepted, future/old/running/zero or duplicated history cannot bias the model sample', () => {
  const raw = { id: 'one', createdAt: stamp(-60_000), resultJson: { model: 'claude-sonnet-5-5', usage: { input_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 2 } } };
  const estimates = modelEstimates([raw, raw, run('gpt-future', 1000, { createdAt: stamp(1) }), run('gpt-old', 1000, { createdAt: stamp(-8 * 86_400_000) }), run('gpt-running', 1000, { status: 'running' }), run('gpt-failed', 0, { status: 'failed' })], { now: NOW });
  assert.equal(estimates.claude.models['claude-sonnet-5-5'].samples, 1);
  assert.equal(estimates.claude.models['claude-sonnet-5-5'].freshInputTokensP95, 40);
  assert.deepEqual(estimates.codex.models, {});
});

test('weekly observed delta is used only with explicit exclusive same-window evidence, never from USD', () => {
  const evidence = { exclusive: true, beforeUsedPercent: 20, afterUsedPercent: 29, beforeResetAt: WEEK, afterResetAt: WEEK };
  const estimates = modelEstimates([run('gpt-measured', 100, { quotaEvidence: evidence }), run('gpt-costly', 100, { usageJson: { model: 'gpt-costly', inputTokens: 100, costUsd: 999 }, quotaEvidence: { ...evidence, exclusive: false } }), run('gpt-reset', 100, { quotaEvidence: { ...evidence, beforeResetAt: stamp(86_400_000) } })], { now: NOW });
  assert.equal(estimates.codex.models['gpt-measured'].percentBudget, 9);
  assert.equal(estimates.codex.models['gpt-costly'].percentBudget, 5);
  assert.equal(estimates.codex.models['gpt-reset'].observedPercentP95, null);
});

test('malformed collector rows are ignored and malformed pending state cannot grant allowance', () => {
  assert.equal(normalizeQuota([null, row([null, window('Current week')])], { now: NOW }).codex.weekUsedPercent, 20);
  assert.deepEqual(modelEstimates([null], { now: NOW }).codex.models, {});
  assert.equal(assess(10, { reservations: [null] }).allow, false);
  assert.equal(assess(10, { safetyBufferPercent: 0 }).allow, false);
});

test('partial normalized usage preserves raw actual token evidence and P95 is a quantile', () => {
  const partial = { createdAt: stamp(-60_000), usageJson: { model: 'claude-sonnet-5-5' }, resultJson: { usage: { input_tokens: 30, cache_read_input_tokens: 70, output_tokens: 2 } } };
  const runs = [partial, ...Array.from({ length: 20 }, (_, i) => run('gpt-p95', i + 1))];
  const result = modelEstimates(runs, { now: NOW });
  assert.equal(result.claude.models['claude-sonnet-5-5'].totalTokensP95, 102);
  assert.equal(result.codex.models['gpt-p95'].totalTokensP95, 19);
});

test('fresh explicit weekly quota without a reset preserves null and enforces the reserve boundary', () => {
  for (const [label, extra] of [['Current week (all models)', {}], ['Unclassified limit', { durationMinutes: 10080 }]]) {
    for (const used of [60, 60.01, 90]) {
      const providers = normalizeQuota([row([window(label, used, null, extra)])], { now: NOW });
      assert.equal(providers.codex.weekResetAt, null);
      assert.equal(providers.codex.weeklyWindowVerified, true);
      assert.equal(providers.codex.weekUsedPercent, used);
      const result = assessCandidate({ provider: 'codex', model: 'gpt-6.1-sol', providers, now: NOW });
      assert.equal(result.allow, used === 60);
    }
  }
});

test('missing reset is never a substitute for explicit weekly classification or fresh evidence', () => {
  for (const entry of [window('Unclassified limit', 10, null), window('5h limit', 10, null), window('Current session', 10, null), window('Unclassified limit', 10, null, { durationMinutes: 10000 })]) {
    const providers = normalizeQuota([row([entry])], { now: NOW });
    assert.equal(providers.codex.weekUsedPercent, null);
    assert.equal(assessCandidate({ provider: 'codex', model: 'gpt-6.1-sol', providers, now: NOW }).allow, false);
  }
  assert.equal(assess(10, { providers: { codex: quota(10, { weekResetAt: null }) } }).allow, false);
  for (const measuredAt of [stamp(1), stamp(-15 * 60_000 - 1)]) {
    const providers = normalizeQuota([row([window('Current week', 10, null)], { measuredAt })], { now: NOW });
    assert.equal(providers.codex.weekUsedPercent, null);
  }
});

test('explicit invalid or expired resets still deny even with verified weekly classification', () => {
  for (const resetsAt of ['', 'invalid', stamp(), stamp(-1)]) {
    const providers = normalizeQuota([row([window('Current week', 10, resetsAt, { durationMinutes: 10080 })])], { now: NOW });
    assert.equal(providers.codex.weekUsedPercent, null);
    assert.equal(assess(10, { providers: { codex: quota(10, { weekResetAt: resetsAt, weeklyWindowVerified: true }) } }).allow, false);
  }
});

test('snapshot support needs explicit known weekly fields, and applicable model buckets enforce missing-reset limits', () => {
  const snapshot = { updatedAt: stamp(), rate_limits: { seven_day: { used_percentage: 30, resets_at: null }, seven_day_sonnet: { used_percentage: 61, resets_at: null } } };
  const providers = normalizeQuota([], { now: NOW, claudeSnapshot: snapshot });
  assert.equal(providers.claude.weeklyWindowVerified, true);
  assert.equal(providers.claude.weekResetAt, null);
  assert.equal(providers.claude.modelWindows[0].weeklyWindowVerified, true);
  const result = assessCandidate({ provider: 'claude', model: 'claude-sonnet-5-5', providers, now: NOW });
  assert.equal(result.usedPercent, 61);
  assert.equal(result.allow, false);
  assert.equal(normalizeQuota([], { now: NOW, claudeSnapshot: { updatedAt: stamp(), rate_limits: { ambiguous: { used_percentage: 10, resets_at: null } } } }).claude.weekUsedPercent, null);
});

test('a production call pays its own small budget and may use the safety band, never the 30% reserve', () => {
  const estimates = { codex: { models: { 'gpt-6.1-sol': { percentBudget: 5.6 } }, maxBudgetPercent: 8.3 } };
  assert.equal(assess(62, { estimates }).allow, false);
  const production = assess(62, { estimates, pipeline: true });
  assert.equal(production.allow, true);
  assert.equal(production.modelBudgetPercent, PIPELINE_CALL_PERCENT);
  assert.equal(production.budgetSource, 'pipeline-call');
  assert.equal(production.admissionLimitPercent, 70);
  assert.equal(assess(69, { pipeline: true }).allow, true);
  assert.equal(assess(69.5, { pipeline: true }).allow, false);
  assert.equal(assess(70, { pipeline: true }).reason, 'weekly-reserve-reached');
});

test('the agent admission line does not move', () => {
  assert.equal(assess(59).allow, true);
  assert.equal(assess(61).allow, false);
  assert.equal(assess(59).admissionLimitPercent, 65);
});

test('a production call is still refused on stale evidence or an exhausted session', () => {
  assert.equal(assess(10, { pipeline: true, providers: { codex: quota(10, { sessionUsedPercent: 100 }) } }).reason, 'session-exhausted');
  assert.equal(assess(10, { pipeline: true, providers: { codex: quota(10, { measuredAt: stamp(-16 * 60_000) }) } }).reason, 'weekly-quota-unavailable-or-stale');
});
