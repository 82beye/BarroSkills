/** Pure quota admission. Percent budgets are conservative operating allowances, not token→subscription conversions. */
const MAX_AGE_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const COLD_START_PERCENT = 5;
// 생산 회차의 LLM 호출 한 건 예산. 에이전트 실행(P95 500만 토큰 = 5%)과 같은 눈금으로 재면 호출 P95 55만 토큰은
// 0.56% 다(llm-ledger 10-24~ 147건). 에이전트 눈금을 그대로 쓰면 호출 몇 건이 몰린 것만으로 예약이 15~25% 쌓여,
// 주간 사용률이 절반을 넘긴 뒤 회차가 스스로 막혔다 (2026-11-01 EP-0272 재작성 3회가 모델 시작 전에 전부 거부).
export const PIPELINE_CALL_PERCENT = 0.6;
const families = ['claude', 'codex'];
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const percent = (value) => finite(value) && value >= 0 && value <= 100;
const familyOf = (name = '') => /^(claude|anthropic)$/.test(name) ? 'claude' : /^(codex|openai)$/.test(name) ? 'codex' : null;
const time = (value) => value instanceof Date ? value.getTime() : typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN;
const fresh = (value, now) => Number.isFinite(time(value)) && time(value) <= now && now - time(value) <= MAX_AGE_MS;
const future = (value, now) => Number.isFinite(time(value)) && time(value) > now;
const missingReset = (value) => value === null || value === undefined;
const validWeeklyReset = (window, now) => missingReset(window.weekResetAt)
  ? window.weeklyWindowVerified === true : future(window.weekResetAt, now);
const iso = (value) => new Date(time(value)).toISOString();
const p95 = (values) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : 0;
};

function windowType(window, now, evidence = {}) {
  const label = window.label ?? '';
  const minutes = window.windowMinutes ?? window.durationMinutes ?? (finite(window.windowSeconds) ? window.windowSeconds / 60 : null);
  if (finite(minutes)) {
    if (minutes >= 6 * 1440 && minutes <= 8 * 1440) return 'week';
    if (minutes > 0 && minutes <= 360) return 'session';
    return null;
  }
  if (/week|seven.?day|7.?day/i.test(label)) return 'week';
  if (future(evidence.weekResetAt, now) && time(window.resetsAt) === time(evidence.weekResetAt)) return 'remembered-week';
  if (/5\s*h(?:our)?(?:s)?\b|5.hour/i.test(label) && time(window.resetsAt) - now > DAY_MS) return 'legacy-5h-week';
  if (/session|5\s*h(?:our)?(?:s)?\b|5.hour/i.test(label) && time(window.resetsAt) - now <= 6 * 3_600_000) return 'session';
  return null;
}

function readWindows(windows, measuredAt, source, now, evidence) {
  if (!fresh(measuredAt, now)) return null;
  const result = { weekUsedPercent: null, weekResetAt: null, weeklyWindowVerified: false, sessionUsedPercent: null, measuredAt: iso(measuredAt), source, modelWindows: [] };
  for (const window of Array.isArray(windows) ? windows : []) {
    if (!window || !percent(window.usedPercent)) continue;
    const type = windowType(window, now, evidence);
    const minutes = window.windowMinutes ?? window.durationMinutes ?? (finite(window.windowSeconds) ? window.windowSeconds / 60 : null);
    // Some native subscription collectors prove the weekly window but omit its
    // reset. Preserve that absence; classification is not a fabricated reset.
    const weeklyWindowVerified = type === 'week' && (minutes === 10080 || /week|seven.?day|7.?day/i.test(window.label ?? ''));
    if (!future(window.resetsAt, now) && !(missingReset(window.resetsAt) && weeklyWindowVerified)) continue;
    const model = window.model ?? window.modelId ?? (/\b(opus|sonnet|haiku)\b/i.exec(window.label ?? '')?.[1]?.toLowerCase());
    if (type === 'session') result.sessionUsedPercent = Math.max(result.sessionUsedPercent ?? 0, window.usedPercent);
    else if (type) {
      const marker = type === 'week' ? source : `${source}:${type}`;
      const weekResetAt = missingReset(window.resetsAt) ? null : iso(window.resetsAt);
      if (model) result.modelWindows.push({ model, weekUsedPercent: window.usedPercent, weekResetAt, weeklyWindowVerified, measuredAt: iso(measuredAt), source: marker });
      else if (result.weekUsedPercent === null || window.usedPercent >= result.weekUsedPercent) {
        result.weekUsedPercent = window.usedPercent;
        result.weekResetAt = weekResetAt;
        result.weeklyWindowVerified = weeklyWindowVerified;
        result.source = marker;
      }
    }
  }
  return result;
}

function snapshotWindows(snapshot, family) {
  if (!snapshot || snapshot.ok === false) return [];
  const rates = snapshot.rate_limits ?? snapshot.rateLimits;
  if (rates) {
    return Object.entries(rates).flatMap(([key, value]) => {
      if (!value || typeof value !== 'object') return [];
      const model = /^seven_day_(.+)$/.exec(key)?.[1];
      return [{ label: key === 'five_hour' ? 'Current session' : key.startsWith('seven_day') ? 'Current week' : key,
        usedPercent: value.used_percentage ?? value.used_percent, resetsAt: value.resets_at,
        windowMinutes: value.window_minutes, ...(model ? { model } : {}) }];
    });
  }
  const provider = snapshot.providers?.[family] ?? snapshot;
  if (provider.ok === false) return [];
  return [
    { label: 'Current week', usedPercent: provider.weekUsedPercent ?? provider.week, resetsAt: provider.weekResetAt },
    { label: 'Current session', usedPercent: provider.sessionUsedPercent ?? provider.session, resetsAt: provider.sessionResetAt },
    ...(provider.modelWindows ?? []).map((window) => ({ label: 'Current week', model: window.model, usedPercent: window.weekUsedPercent, resetsAt: window.weekResetAt })),
  ];
}

/** Raw quota is a fresh fetch unless it carries a timestamp; accountEvidence[family] can supply measuredAt and a known weekly reset. */
export function normalizeQuota(quota = [], { now = Date.now(), claudeSnapshot, codexSnapshot, accountEvidence = {} } = {}) {
  now = time(now);
  const result = {};
  for (const family of families) {
    const evidence = accountEvidence[family] ?? {};
    const candidates = [];
    for (const row of Array.isArray(quota) ? quota : []) {
      if (!row || familyOf(row.provider) !== family || row.ok !== true) continue;
      const measuredAt = row.measuredAt ?? row.fetchedAt ?? row.updatedAt ?? evidence.measuredAt ?? now;
      const value = readWindows(row.windows, measuredAt, 'paperclip', now, evidence);
      if (value) candidates.push(value);
    }
    const snapshot = family === 'claude' ? claudeSnapshot : codexSnapshot;
    if (snapshot) {
      const value = readWindows(snapshotWindows(snapshot, family), snapshot.measuredAt ?? snapshot.updatedAt ?? snapshot.fetchedAt,
        family === 'claude' ? 'claude-snapshot' : 'codex-snapshot', now, evidence);
      if (value) candidates.push(value);
    }
    const complete = candidates.filter((value) => value.weekUsedPercent !== null);
    const selected = [...(complete.length ? complete : candidates)].sort((a, b) => time(b.measuredAt) - time(a.measuredAt))[0];
    result[family] = selected ?? { weekUsedPercent: null, weekResetAt: null, weeklyWindowVerified: false, sessionUsedPercent: null, measuredAt: null, source: 'unavailable', modelWindows: [] };
    if (selected) {
      const sameWindow = complete.filter((value) => value.weekResetAt === selected.weekResetAt);
      if (sameWindow.length) result[family].weekUsedPercent = Math.max(...sameWindow.map((value) => value.weekUsedPercent));
      result[family].modelWindows = candidates.flatMap((value) => value.modelWindows);
    }
  }
  return result;
}

function usageFor(run) {
  let raw = run.resultJson ?? run.rawResult ?? {};
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  if (!raw || typeof raw !== 'object') raw = {};
  const usage = { ...(raw.usageJson ?? raw.usage ?? raw), ...(run.usageJson ?? {}) };
  const model = usage.model ?? raw.model ?? Object.keys(raw.modelUsage ?? {})[0];
  const provider = familyOf(usage.provider ?? run.provider) ?? (/^claude-/.test(model ?? '') ? 'claude' : /^gpt-/.test(model ?? '') ? 'codex' : null);
  if (!provider || !model) return null;
  const input = usage.inputTokens ?? usage.input_tokens ?? usage.rawInputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.rawCachedInputTokens ?? 0;
  const output = usage.outputTokens ?? usage.output_tokens ?? usage.rawOutputTokens ?? 0;
  const created = usage.cache_creation_input_tokens ?? 0;
  if (![input, cached, output, created].every((n) => finite(n) && n >= 0)) return null;
  const freshInput = provider === 'codex' ? Math.max(0, input - cached) : input + created;
  const total = freshInput + cached + output;
  if (total === 0) return null;
  const cost = usage.cacheAdjustedCostUsd ?? usage.costUsd ?? raw.total_cost_usd;
  return { provider, model, input, cached, output, freshInput, total, cost: finite(cost) && cost >= 0 ? cost : null };
}

function observedPercent(run, now) {
  const evidence = run.quotaEvidence;
  if (!evidence?.exclusive || !percent(evidence.beforeUsedPercent) || !percent(evidence.afterUsedPercent)
      || !Number.isFinite(time(evidence.afterResetAt)) || time(evidence.beforeResetAt) !== time(evidence.afterResetAt)
      || evidence.afterUsedPercent < evidence.beforeUsedPercent) return null;
  return evidence.afterUsedPercent - evidence.beforeUsedPercent;
}

/** Model load uses observed processed tokens, including cache. It is not an API pricing or weekly quota conversion. */
export function modelEstimates(runs = [], { now = Date.now() } = {}) {
  now = time(now);
  const samples = { claude: {}, codex: {} };
  const seen = new Set();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== 'object') continue;
    if (run.id && seen.has(run.id)) continue;
    if (run.id) seen.add(run.id);
    if (['running', 'queued'].includes(run.status)) continue;
    const at = time(run.finishedAt ?? run.createdAt ?? run.at);
    if (!Number.isFinite(at) || at > now || now - at > 7 * DAY_MS) continue;
    const usage = usageFor(run);
    if (!usage) continue;
    (samples[usage.provider][usage.model] ??= []).push({ ...usage, observedPercent: observedPercent(run, now) });
  }
  return Object.fromEntries(families.map((provider) => {
    const models = {};
    for (const [model, rows] of Object.entries(samples[provider])) {
      models[model] = { samples: rows.length, inputTokensP95: p95(rows.map((r) => r.input)),
        cachedInputTokensP95: p95(rows.map((r) => r.cached)), outputTokensP95: p95(rows.map((r) => r.output)),
        freshInputTokensP95: p95(rows.map((r) => r.freshInput)), totalTokensP95: p95(rows.map((r) => r.total)),
        reportedCostUsdP95: p95(rows.map((r) => r.cost).filter((n) => n !== null)),
        observedPercentP95: p95(rows.map((r) => r.observedPercent).filter((n) => n !== null)) };
    }
    const medianTokenLoad = median(Object.values(models).map((model) => model.totalTokensP95));
    for (const model of Object.values(models)) {
      // shortcut: token load is an operating estimate; use attributable per-model quota evidence when available.
      const scaled = COLD_START_PERCENT * model.totalTokensP95 / medianTokenLoad;
      model.percentBudget = Math.min(100, Math.max(1, scaled, model.observedPercentP95 ?? 0));
      model.budgetSource = model.observedPercentP95 !== null ? 'observed-quota-and-token-load' : 'token-load-operating-budget';
    }
    return [provider, { models, medianTokenLoad, maxBudgetPercent: Math.max(COLD_START_PERCENT, ...Object.values(models).map((model) => model.percentBudget)) }];
  }));
}

const matchingModel = (bucket, model) => bucket === model || ['opus', 'sonnet', 'haiku'].includes(bucket) && model.includes(bucket);

/** Reservations: {id?, provider, model?, percent, status?}; only an explicit terminal/released status releases a reservation. */
export function assessCandidate({ provider, model, providers = {}, estimates = {}, reservations = [], now = Date.now(), reservePercent = 30, safetyBufferPercent = 5, pipeline = false }) {
  now = time(now);
  // 30% 보존선은 생산도 넘지 못한다. 에이전트만 5%p 앞에서 멈춰, 그 구간을 발행 회차 몫으로 남긴다.
  const admissionLimitPercent = 100 - reservePercent - (pipeline ? 0 : safetyBufferPercent);
  const result = { allow: false, reason: null, provider, model, admissionLimitPercent, modelBudgetPercent: null, pendingPercent: 0, projectedUsedPercent: null };
  const deny = (reason) => ({ ...result, reason });
  if (!families.includes(provider) || typeof model !== 'string' || !model) return deny('unknown-provider-or-model');
  if (!percent(reservePercent) || reservePercent < 30 || !percent(safetyBufferPercent) || safetyBufferPercent < 5 || admissionLimitPercent <= 0) return deny('invalid-reserve-policy');
  const quota = providers[provider];
  if (!quota || !percent(quota.weekUsedPercent) || !validWeeklyReset(quota, now) || !fresh(quota.measuredAt, now)) return deny('weekly-quota-unavailable-or-stale');
  if (percent(quota.sessionUsedPercent) && quota.sessionUsedPercent >= 100) return deny('session-exhausted');
  const estimate = estimates[provider]?.models?.[model];
  result.modelBudgetPercent = pipeline ? PIPELINE_CALL_PERCENT
    : estimate ? estimate.percentBudget : Math.max(COLD_START_PERCENT, estimates[provider]?.maxBudgetPercent ?? COLD_START_PERCENT);
  if (!percent(result.modelBudgetPercent) || (!pipeline && result.modelBudgetPercent < 1)) return deny('invalid-model-budget');
  result.budgetSource = pipeline ? 'pipeline-call' : estimate?.budgetSource ?? 'cold-start-or-family-maximum';
  if (!Array.isArray(reservations)) return deny('invalid-pending-reservation');
  const seen = new Set();
  for (const reservation of reservations) {
    if (!reservation || typeof reservation !== 'object') return deny('invalid-pending-reservation');
    if (reservation.provider !== provider || ['released', 'completed', 'succeeded', 'failed', 'cancelled'].includes(reservation.status)) continue;
    if (reservation.id && seen.has(reservation.id)) continue;
    if (reservation.id) seen.add(reservation.id);
    if (!percent(reservation.percent) || reservation.percent <= 0) return deny('invalid-pending-reservation');
    result.pendingPercent += reservation.percent;
  }
  let used = quota.weekUsedPercent;
  if (quota.modelWindows != null && !Array.isArray(quota.modelWindows)) return deny('model-quota-unavailable-or-stale');
  for (const window of quota.modelWindows ?? []) {
    if (!window || typeof window !== 'object') return deny('model-quota-unavailable-or-stale');
    if (!matchingModel(window.model, model)) continue;
    if (!percent(window.weekUsedPercent) || !validWeeklyReset(window, now) || !fresh(window.measuredAt, now)) return deny('model-quota-unavailable-or-stale');
    used = Math.max(used, window.weekUsedPercent);
  }
  result.usedPercent = used;
  result.projectedUsedPercent = used + result.pendingPercent + result.modelBudgetPercent;
  result.allow = result.projectedUsedPercent <= admissionLimitPercent;
  result.reason = result.allow ? 'within-reserve-and-buffer' : used >= 100 - reservePercent ? 'weekly-reserve-reached' : 'projected-use-exceeds-buffer';
  return result;
}
