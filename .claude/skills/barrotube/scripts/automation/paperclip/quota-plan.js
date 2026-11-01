/**
 * quota-plan.js — 바로조(barrojo models)가 매일 쓰는 모델 배분 계획을 관제가 읽는 곳.
 *
 * 바로조가 공급자별 주간 사용 속도로 역할마다 모델·노력 사다리를 정해 ~/.barrojo/alloc/plan.json 에 쓰고,
 * quota-switch.js 가 그 사다리 순서대로 승인 가능한 칸을 고른다. 에이전트 설정을 쓰는 곳은 여전히 이 관제 하나다.
 * 계획이 없거나 낡거나 형식이 틀리면 지금의 역할 고정표로 돌아간다 — 계획은 선택을 바꿀 뿐 승인(65%)은 그대로다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';

export const planFile = () => process.env.BARROJO_ALLOC_PLAN || join(userInfo().homedir, '.barrojo/alloc/plan.json');

// 계획이 고를 수 있는 모델(강한 것부터)·노력·검수 역할. barrojo 는 상태 파일의 planContract 로 이것을 읽는다.
export const PLAN_CONTRACT = Object.freeze({
  schema: 'barrojo.alloc.plan/v1',
  models: { claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], codex: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'] },
  efforts: { claude: ['low', 'medium', 'high'], codex: ['low', 'medium', 'high'] },
  reviewerRoles: ['qa', 'qa-reviewer', 'fact-checker'],
  maxChangesPerDay: 2,
});
const DAY_MS = 86_400_000;
const STEP_UP_MS = 60 * 60_000;
const PLANNED_SWITCH_MS = DAY_MS;

/** 계획을 읽는다. 예외를 던지지 않는다 — {status: absent|invalid|expired|stale|shadow|applied, plan, error}. */
export function loadPlan({ now = Date.now(), file = planFile(), lastRev = null } = {}) {
  let plan;
  try { plan = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { return e.code === 'ENOENT' ? { status: 'absent', plan: null, error: null } : { status: 'invalid', plan: null, error: 'unreadable' }; }
  if (plan?.schema !== PLAN_CONTRACT.schema || !Number.isInteger(plan.rev) || !plan.agents || typeof plan.agents !== 'object') {
    return { status: 'invalid', plan: null, error: 'schema' };
  }
  if (Number.isInteger(lastRev) && plan.rev < lastRev) return { status: 'invalid', plan: null, error: `older rev ${plan.rev} < ${lastRev}` };
  const valid = Date.parse(plan.validUntil), hard = Date.parse(plan.hardExpiry), made = Date.parse(plan.generatedAt);
  if (![valid, hard, made].every(Number.isFinite) || made > now + 5 * 60_000) return { status: 'invalid', plan: null, error: 'timestamps' };
  if (now > hard) return { status: 'expired', plan: null, error: null };
  if (now > valid) return { status: 'stale', plan, error: null };
  return { status: plan.mode === 'auto' ? 'applied' : 'shadow', plan, error: null };
}

/** 회사 범위 안의 에이전트 사다리 — 허용 모델·노력만, 검수 역할은 원래 계열만. 없으면 null. */
export function ladderFor(plan, agent, { reviewerFamily = null } = {}) {
  const scope = plan?.scope?.companies;
  if (Array.isArray(scope) && !scope.includes(agent.companyId)) return null;
  const entry = plan?.agents?.[agent.id];
  if (!entry || !Array.isArray(entry.ladder)) return null;
  const seen = new Set();
  const rungs = [];
  for (const r of entry.ladder) {
    if (!r || !PLAN_CONTRACT.models[r.provider]?.includes(r.model) || !PLAN_CONTRACT.efforts[r.provider]?.includes(r.effort)) continue;
    if (reviewerFamily && r.provider !== reviewerFamily) continue;
    const key = `${r.provider}/${r.model}/${r.effort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rungs.push({ provider: r.provider, model: r.model, effort: r.effort });
    if (rungs.length === 8) break;
  }
  return rungs.length ? rungs : null;
}

/** 계획 보류 — 상급자가 없는 에이전트(CEO)는 계획으로 보류하지 않는다(바로조 막힘 지휘가 늘 깨울 수 있어야 한다). */
export function holdFor(plan, agent, now = Date.now()) {
  const hold = plan?.agents?.[agent.id]?.hold;
  if (!hold || !agent.reportsTo) return null;
  const until = Date.parse(hold.until);
  if (!Number.isFinite(until) || until <= now) return null;
  return { until: new Date(Math.min(until, now + DAY_MS)).toISOString(), reason: `barrojo plan hold: ${String(hold.reason || '').slice(0, 160)}` };
}

/**
 * 한 번도 돌지 않은 더 싼 모델은 계열 최악값(2026-10-28 Claude 12.6%·Codex 10.4%)을 예약해 내림을 벌준다.
 * 바로 위(더 강한) 모델의 실측 예산을 빌려 준다. 더 비싼 미시도 모델은 그대로 둔다.
 */
export function seedColdStart(estimates) {
  for (const [provider, ranks] of Object.entries(PLAN_CONTRACT.models)) {
    const models = estimates?.[provider]?.models;
    if (!models) continue;
    let above = null;
    for (const model of ranks) {
      if (models[model]) { above = { model, value: models[model] }; continue; }
      if (above) models[model] = { ...above.value, samples: 0, budgetSource: `seeded-from-${above.model}` };
    }
  }
  return estimates;
}

const kstDay = (now) => new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
const same = (a, b) => a && b && a.provider === b.provider && a.model === b.model && a.effort === b.effort;

/**
 * 사다리에서 고른다. assess(rung) 는 assessCandidate 결과({allow, usedPercent, modelBudgetPercent, admissionLimitPercent, reason}).
 *  - 진행 중 예약 때문에만 막힌 칸은 고를 수 있다(래퍼가 실행마다 미룬다). 측정이 없으면 지금 설정을 지킨다.
 *  - 계획에 따른 계열 전환은 하루 한 번, 한 칸 위로 올리기는 직전 변경 60분 뒤, 변경은 하루 maxChangesPerDay 번까지.
 */
export function pickRung(current, home, rungs, assess, record = {}, now = Date.now()) {
  const day = kstDay(now);
  const changes = record.planChangesDay === day ? record.planChanges || 0 : 0;
  const assessed = rungs.map((r, index) => {
    const a = assess(r);
    const usageOnly = [a.usedPercent, a.modelBudgetPercent, a.admissionLimitPercent].every(Number.isFinite)
      ? a.usedPercent + a.modelBudgetPercent > a.admissionLimitPercent : null;
    const unmeasured = !a.allow && /unavailable-or-stale/.test(a.reason || '');
    return { ...r, ...a, index, usable: a.allow || usageOnly === false, unmeasured };
  });
  const keep = assessed.find((r) => same(r, current));
  const result = (selected, why) => ({ selected, candidates: assessed, sticky: `plan:${why}` });
  if (assessed.some((r) => r.unmeasured && r.provider === home)) return result(keep || null, 'measurement-unavailable');
  const lastSwitch = Date.parse(record.lastSwitchAt);
  const lastChange = Date.parse(record.lastPlanChangeAt);
  const keepUsable = keep?.usable ? keep : null;
  for (const r of assessed) {
    if (!r.usable) continue;
    if (same(r, current)) return result(r, 'current');
    if (changes >= PLAN_CONTRACT.maxChangesPerDay) return result(keepUsable, 'daily-change-cap');
    if (r.provider !== home) {
      const homeSpent = assessed.filter((x) => x.provider === home).every((x) => !x.usable);
      const cooldown = homeSpent ? 60 * 60_000 : PLANNED_SWITCH_MS;
      if (Number.isFinite(lastSwitch) && now - lastSwitch < cooldown) continue;
    }
    if (keepUsable && r.index < keepUsable.index && Number.isFinite(lastChange) && now - lastChange < STEP_UP_MS) return result(keepUsable, 'step-up-wait');
    return result(r, r.index === 0 ? 'top' : 'fallback');
  }
  return result(null, 'no-usable-rung');
}
